// CQT untuk detector saraf BTC: tiruan `librosa.cqt(n_bins=144, bins_per_octave=24, hop_length=2048, sr=22050)`
// (algoritma sub-sampling rekursif Schoerkhuber & Klapuri 2010, sama seperti librosa), plus pemotongan audio per 10 detik
// dan log-magnitudo persis seperti `audio_file_to_features` milik BTC. Hanya magnitudo yang dipakai, jadi konvensi fase bebas.
//
// Bedanya dengan librosa: penurun laju (soxr) diganti tapis FIR setengah-pita sendiri. Itu cukup karena semua filter yang
// dipakai berada jauh di bawah Nyquist tiap tahap. Kecocokan diuji terhadap librosa di js-tests/cqt.test.js.
import { FFT } from './fft.js';

export const CQT = Object.freeze({
  sr: 22050,
  nBins: 144,
  binsPerOctave: 24,
  hop: 2048,
  fmin: 32.70319566257483, // C1
  chunkSeconds: 10,
  sparsity: 0.01,
  // lebar pita jendela hann (tabel librosa.filters.window_bandwidth), dipakai menentukan penurunan laju awal
  hannBandwidth: 1.50018310546875,
  floor: 1e-6,
});

/** Tapis penurun laju 2x: Kaiser-windowed sinc, setengah-pita (koefisien genap = 0). Gain DC = 1. */
const HALF_TAPS = 32; // tap di tiap sisi tengah
function kaiserBeta9(n, len) { // jendela Kaiser beta=9; n dari -len..len
  const bessel = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const r = n / len;
  return bessel(9 * Math.sqrt(Math.max(0, 1 - r * r))) / bessel(9);
}
const HALF_BAND = (() => {
  const h = new Float64Array(2 * HALF_TAPS + 1);
  let sum = 0;
  for (let m = -HALF_TAPS; m <= HALF_TAPS; m++) {
    const ideal = m === 0 ? 0.5 : (m % 2 === 0 ? 0 : Math.sin(Math.PI * m / 2) / (Math.PI * m));
    h[m + HALF_TAPS] = ideal * kaiserBeta9(m, HALF_TAPS + 1);
    sum += h[m + HALF_TAPS];
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  return h;
})();

/** Turunkan laju 2x (sama seperti `resample(y, orig_sr=2, target_sr=1, scale=True)`: energi dijaga, jadi dikali sqrt(2)). */
export function halve(y) {
  const n = y.length;
  const m = Math.ceil(n / 2);
  const out = new Float32Array(m);
  const gain = Math.SQRT2;
  const odd = [];
  for (let k = 1; k <= HALF_TAPS; k += 2) odd.push([k, HALF_BAND[HALF_TAPS + k]]); // koefisien simetris
  for (let j = 0; j < m; j++) {
    const c = 2 * j;
    let s = HALF_BAND[HALF_TAPS] * y[c];
    for (const [k, w] of odd) {
      const a = c - k, b = c + k;
      s += w * ((a >= 0 ? y[a] : 0) + (b < n ? y[b] : 0));
    }
    out[j] = s * gain;
  }
  return out;
}

function hannPeriodic(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Frekuensi tengah, urut naik. */
export function cqtFrequencies(nBins = CQT.nBins, bpo = CQT.binsPerOctave, fmin = CQT.fmin) {
  return Float64Array.from({ length: nBins }, (_, k) => fmin * 2 ** (k / bpo));
}

/** `librosa.filters._relative_bandwidth`. */
function relativeBandwidth(freqs) {
  const n = freqs.length;
  const logf = Array.from(freqs, Math.log2);
  const bpo = new Float64Array(n);
  bpo[0] = 1 / (logf[1] - logf[0]);
  bpo[n - 1] = 1 / (logf[n - 1] - logf[n - 2]);
  for (let i = 1; i < n - 1; i++) bpo[i] = 2 / (logf[i + 1] - logf[i - 1]);
  return Float64Array.from(bpo, (b) => (2 ** (2 / b) - 1) / (2 ** (2 / b) + 1));
}

/** Panjang filter (sampel, pecahan) pada laju `sr`: Q * sr / f dengan Q = 1/alpha. */
function filterLengths(freqs, alpha, sr) {
  return Float64Array.from(freqs, (f, i) => (sr / f) / alpha[i]);
}

function numTwoFactors(x) { let n = 0; while (x > 0 && x % 2 === 0) { n++; x /= 2; } return n; }

/** Basis FFT jarang untuk satu oktaf (`__vqt_filter_fft` + `filters.wavelet`), pada laju `sr`. */
function octaveBasis(freqs, alpha, sr, scale) {
  const lengths = filterLengths(freqs, alpha, sr);
  let maxLen = 0;
  for (const l of lengths) maxLen = Math.max(maxLen, l);
  const nFft = 2 ** Math.ceil(Math.log2(maxLen));
  const fft = new FFT(nFft);
  const half = nFft / 2 + 1;
  const rows = [];
  for (let k = 0; k < freqs.length; k++) {
    const ilen = lengths[k];
    const start = Math.floor(-ilen / 2), stop = Math.floor(ilen / 2);
    const n = stop - start;
    const win = hannPeriodic(n);
    let norm = 0;
    for (let i = 0; i < n; i++) norm += win[i]; // |fasor| = 1, jadi norma L1 = jumlah jendela
    const re = new Float64Array(nFft), im = new Float64Array(nFft);
    const lpad = Math.floor((nFft - n) / 2);
    const gain = (ilen / nFft) / norm; // normalisasi L1 lalu skala panjang/n_fft
    for (let i = 0; i < n; i++) {
      const ang = (start + i) * 2 * Math.PI * freqs[k] / sr;
      re[lpad + i] = Math.cos(ang) * win[i] * gain;
      im[lpad + i] = Math.sin(ang) * win[i] * gain;
    }
    fft.transform(re, im);
    // sparsify: buang entri terkecil yang jumlahnya < sparsity dari total magnitudo
    const mags = new Float64Array(half);
    let total = 0;
    for (let j = 0; j < half; j++) { mags[j] = Math.hypot(re[j], im[j]); total += mags[j]; }
    const sorted = Float64Array.from(mags).sort();
    let cum = 0, thresh = sorted[0];
    for (let j = 0; j < half; j++) { cum += sorted[j] / total; if (!(cum < CQT.sparsity)) { thresh = sorted[j]; break; } }
    const idx = [], br = [], bi = [];
    for (let j = 0; j < half; j++) if (mags[j] >= thresh) { idx.push(j); br.push(re[j] * scale); bi.push(im[j] * scale); }
    rows.push({ idx: Int32Array.from(idx), re: Float64Array.from(br), im: Float64Array.from(bi) });
  }
  return { nFft, rows };
}

let plan = null; // basis tidak bergantung pada audio: hitung sekali

/** Rencana CQT: urutan oktaf, laju, hop, dan basis (`librosa.vqt`, tanpa isinya yang tidak dipakai). */
function getPlan() {
  if (plan) return plan;
  const { sr, nBins, binsPerOctave: bpo, hop, hannBandwidth } = CQT;
  const freqs = cqtFrequencies();
  const alpha = relativeBandwidth(freqs);
  const nyquist = sr / 2;
  let fCutoff = 0;
  for (let i = 0; i < nBins; i++) fCutoff = Math.max(fCutoff, freqs[i] * (1 + 0.5 * hannBandwidth * alpha[i]));
  const nOctaves = Math.ceil(nBins / bpo);

  // penurunan laju awal (`__early_downsample_count`)
  const count1 = Math.max(0, Math.ceil(Math.log2(nyquist / fCutoff)) - 1 - 1);
  const count2 = Math.max(0, numTwoFactors(hop) - nOctaves + 1);
  const early = Math.min(count1, count2);
  const srEarly = sr / 2 ** early;
  let myHop = hop / 2 ** early;
  let mySr = srEarly;

  const octaves = [];
  for (let i = 0; i < nOctaves; i++) {
    const lo = nBins - bpo * (i + 1), hi = nBins - bpo * i;
    const basis = octaveBasis(freqs.subarray(lo, hi), alpha.subarray(lo, hi), mySr, Math.sqrt(srEarly / mySr));
    octaves.push({ lo, hop: myHop, ...basis, downsampleAfter: false });
    if (i < nOctaves - 1) {
      const fMaxNext = freqs[lo - 1];
      if (myHop % 2 === 0 && fMaxNext <= mySr / 5) {
        octaves[i].downsampleAfter = true;
        myHop /= 2;
        mySr /= 2;
      }
    }
  }
  const lengths = filterLengths(freqs, alpha, srEarly);
  plan = { early, octaves, invSqrtLen: Float64Array.from(lengths, (l) => 1 / Math.sqrt(l)), fft: new Map() };
  return plan;
}

/** Respons satu oktaf: STFT berjendela "ones" (pad nol, terpusat) lalu proyeksi ke basis jarang. Hasil [bin][frame]. */
function octaveResponse(y, oct, p) {
  const { nFft, rows, hop } = oct;
  const nFrames = 1 + Math.floor(y.length / hop);
  if (!p.fft.has(nFft)) p.fft.set(nFft, new FFT(nFft));
  const fft = p.fft.get(nFft);
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  const out = rows.map(() => new Float64Array(nFrames));
  const pad = nFft >> 1;
  for (let t = 0; t < nFrames; t++) {
    const s0 = t * hop - pad;
    for (let i = 0; i < nFft; i++) { const s = s0 + i; re[i] = s >= 0 && s < y.length ? y[s] : 0; im[i] = 0; }
    fft.transform(re, im);
    for (let k = 0; k < rows.length; k++) {
      const { idx, re: br, im: bi } = rows[k];
      let sr_ = 0, si = 0;
      for (let q = 0; q < idx.length; q++) { const j = idx[q]; sr_ += br[q] * re[j] - bi[q] * im[j]; si += br[q] * im[j] + bi[q] * re[j]; }
      out[k][t] = Math.hypot(sr_, si);
    }
  }
  return out;
}

/**
 * Magnitudo CQT satu potongan audio. Hasil: { frames, data } dengan data berukuran frames*nBins, urut waktu lalu bin (bin 0 = terendah).
 * @param {Float32Array} y audio mono pada CQT.sr
 */
export function cqtMagnitude(y) {
  const p = getPlan();
  let cur = y;
  for (let i = 0; i < p.early; i++) cur = halve(cur);
  const { nBins } = CQT;
  const resp = [];
  for (const oct of p.octaves) {
    resp.push(octaveResponse(cur, oct, p));
    if (oct.downsampleAfter) cur = halve(cur);
  }
  const frames = Math.min(...resp.map((r) => r[0].length));
  const data = new Float32Array(frames * nBins);
  p.octaves.forEach((oct, o) => {
    resp[o].forEach((col, k) => {
      const bin = oct.lo + k;
      const w = p.invSqrtLen[bin];
      for (let t = 0; t < frames; t++) data[t * nBins + bin] = col[t] * w;
    });
  });
  return { frames, data };
}

/**
 * Fitur BTC untuk seluruh lagu: potong per 10 dtk (seperti `audio_file_to_features`), CQT tiap potongan, lalu log(|C| + 1e-6).
 * @param {Float32Array} samples mono, CQT.sr
 * @param {{onProgress?: (done:number,total:number)=>void}} [opts]
 * @returns {{frames:number, data:Float32Array}} data = frames*nBins (waktu dulu)
 */
export function btcFeatures(samples, opts = {}) {
  const chunk = CQT.sr * CQT.chunkSeconds;
  const bounds = [];
  let cur = 0;
  while (samples.length > cur + chunk) { bounds.push([cur, cur + chunk]); cur += chunk; }
  bounds.push([cur, samples.length]); // sisa (bisa penuh bila panjang pas kelipatan)
  const parts = bounds.map(([a, b], i) => {
    const r = cqtMagnitude(samples.subarray(a, b));
    opts.onProgress?.(i + 1, bounds.length);
    return r;
  });
  const frames = parts.reduce((s, p) => s + p.frames, 0);
  const data = new Float32Array(frames * CQT.nBins);
  let off = 0;
  for (const p of parts) {
    for (let i = 0; i < p.data.length; i++) data[off + i] = Math.log(p.data[i] + CQT.floor);
    off += p.data.length;
  }
  return { frames, data };
}
