// Ketukan, tempo, dan grid birama. Algoritma klasik tanpa model (tanpa dependensi):
//   kekuatan onset (flux spektrum mel) -> tempo (autokorelasi + prior) -> pelacakan ketukan dengan pemrograman dinamis (Ellis 2007)
//   -> ketukan pertama tiap birama (downbeat) dari perpindahan chord + pilihan birama oleh pengguna.
// Logika murni (tanpa DOM), teruji di Node. Keterbatasan: lagu dengan tempo bebas/rubato kurang baik; downbeat hanya tebakan
// (pengguna bisa mengubah birama dan geser fasenya).
import { FFT } from './fft.js';

export const BEAT_DEFAULTS = {
  nFft: 2048,
  hop: 512, // ~43 frame/detik pada 22050 Hz
  nMels: 64,
  fmin: 30,
  fmax: 8000,
  minBpm: 55,
  maxBpm: 190,
  priorBpm: 85, // lagu worship cenderung lambat-sedang; prior log-normal ini memilih oktaf tempo yang wajar
  priorSigmaOct: 1.0,
  tightness: 100, // makin besar makin kaku terhadap tempo konstan
};

// ---------- kekuatan onset ----------

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

/** Filterbank segitiga mel: per filter {from, w:Float32Array} di atas bin 0..nFft/2. */
export function melFilterbank(sr, nFft, nMels, fmin, fmax) {
  const mels = Array.from({ length: nMels + 2 }, (_, i) => hzToMel(fmin) + ((hzToMel(Math.min(fmax, sr / 2)) - hzToMel(fmin)) * i) / (nMels + 1));
  const hz = mels.map(melToHz);
  const binHz = sr / nFft;
  const bank = [];
  for (let m = 1; m <= nMels; m++) {
    const [lo, mid, hi] = [hz[m - 1], hz[m], hz[m + 1]];
    const from = Math.max(0, Math.floor(lo / binHz));
    const to = Math.min(nFft / 2, Math.ceil(hi / binHz));
    const w = new Float32Array(to - from + 1);
    for (let k = from; k <= to; k++) {
      const f = k * binHz;
      w[k - from] = f <= lo || f >= hi ? 0 : f < mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
    }
    bank.push({ from, w });
  }
  return bank;
}

function reflect(i, len) {
  if (len === 1) return 0;
  const period = 2 * (len - 1);
  i = ((i % period) + period) % period;
  return i < len ? i : period - i;
}

/**
 * Kekuatan onset: rata-rata kenaikan energi (dB) tiap pita mel dari frame ke frame, dinormalkan ke simpangan baku 1.
 * @returns {{env: Float32Array, fps: number}}
 */
export function onsetStrength(samples, sr, opts = {}) {
  const c = { ...BEAT_DEFAULTS, ...opts };
  const { nFft, hop, nMels } = c;
  const n = 1 + Math.floor(samples.length / hop);
  const bank = melFilterbank(sr, nFft, nMels, c.fmin, c.fmax);
  const fft = new FFT(nFft);
  const win = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
  const re = new Float64Array(nFft), im = new Float64Array(nFft);
  const db = new Float32Array(n * nMels);
  let maxDb = -Infinity;

  for (let t = 0; t < n; t++) {
    const s0 = t * hop - nFft / 2;
    for (let i = 0; i < nFft; i++) { re[i] = samples[reflect(s0 + i, samples.length)] * win[i]; im[i] = 0; }
    fft.transform(re, im);
    for (let m = 0; m < nMels; m++) {
      const { from, w } = bank[m];
      let e = 0;
      for (let k = 0; k < w.length; k++) if (w[k] > 0) e += w[k] * (re[from + k] ** 2 + im[from + k] ** 2);
      const v = 10 * Math.log10(e + 1e-10);
      db[t * nMels + m] = v;
      if (v > maxDb) maxDb = v;
    }
  }
  const floor = maxDb - 80; // top_db = 80, seperti librosa
  const env = new Float32Array(n);
  for (let t = 1; t < n; t++) {
    let flux = 0;
    for (let m = 0; m < nMels; m++) {
      const d = Math.max(db[t * nMels + m], floor) - Math.max(db[(t - 1) * nMels + m], floor);
      if (d > 0) flux += d;
    }
    env[t] = flux / nMels;
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let varsum = 0;
  for (const v of env) varsum += (v - mean) ** 2;
  const sd = Math.sqrt(varsum / n) || 1;
  for (let t = 0; t < n; t++) env[t] /= sd;
  return { env, fps: sr / hop };
}

// ---------- tempo ----------

function autocorrelate(env, maxLag) {
  const n = env.length;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  const x = Float32Array.from(env, (v) => v - mean);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let t = 0; t + lag < n; t++) s += x[t] * x[t + lag];
    ac[lag] = s / (n - lag);
  }
  const ac0 = ac[0] || 1;
  return ac.map((v) => v / ac0);
}

function interp(arr, x) {
  if (x < 0 || x >= arr.length - 1) return 0;
  const i = Math.floor(x);
  return arr[i] + (arr[i + 1] - arr[i]) * (x - i);
}

/**
 * Tempo global dari autokorelasi: bukti di kelipatan periode (1x, 2x, 4x) dijumlahkan, lalu dibobot prior log-normal.
 * @returns {{bpm:number, score:number, candidates:{bpm:number, score:number}[]}}
 */
export function estimateTempo(env, fps, opts = {}) {
  const c = { ...BEAT_DEFAULTS, ...opts };
  const maxLag = Math.min(env.length - 2, Math.ceil((fps * 60 * 4) / c.minBpm) + 2); // sampai 4 periode terpanjang
  const ac = autocorrelate(env, maxLag);
  const cands = [];
  for (let bpm = c.minBpm; bpm <= c.maxBpm; bpm += 0.5) {
    const L = (fps * 60) / bpm;
    const evidence = interp(ac, L) + 0.5 * interp(ac, 2 * L) + 0.25 * interp(ac, 4 * L);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / c.priorBpm) / c.priorSigmaOct) ** 2);
    cands.push({ bpm, score: evidence * prior });
  }
  const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
  return { bpm: best.bpm, score: best.score, candidates: cands };
}

// ---------- pelacakan ketukan (Ellis 2007) ----------

/** Ketukan (detik) dari kekuatan onset dengan tempo perkiraan `bpm`. */
export function trackBeatsDP(env, fps, bpm, tightness = BEAT_DEFAULTS.tightness) {
  const n = env.length;
  const period = (fps * 60) / bpm;
  // skor lokal: onset diperhalus dengan jendela Gaussian selebar ~periode/32
  const half = Math.round(period);
  const kernel = Float32Array.from({ length: 2 * half + 1 }, (_, i) => Math.exp(-0.5 * (((i - half) * 32) / period) ** 2));
  const local = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = t + k;
      if (j >= 0 && j < n) s += env[j] * kernel[k + half];
    }
    local[t] = s;
  }

  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  let firstBeat = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity, bj = -1;
    for (let w = lo; w <= hi; w++) {
      const j = i - w;
      if (j < 0) break;
      const s = cum[j] - tightness * Math.log(w / period) ** 2;
      if (s > best) { best = s; bj = j; }
    }
    if (bj >= 0 && !firstBeat) { cum[i] = local[i] + best; back[i] = bj; }
    else { cum[i] = local[i]; back[i] = -1; if (local[i] > 0) firstBeat = false; }
  }

  // ketukan terakhir: puncak lokal cum yang cukup tinggi (>= setengah median puncak), paling akhir
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) peaks.push(i);
  if (!peaks.length) return [];
  const sorted = peaks.map((i) => cum[i]).sort((a, b) => a - b);
  const thresh = 0.5 * sorted[sorted.length >> 1];
  let last = peaks[0];
  for (const i of peaks) if (cum[i] >= thresh) last = i;

  const frames = [];
  for (let i = last; i >= 0; i = back[i]) frames.push(i);
  frames.reverse();

  // buang ketukan lemah di tepi (awal/akhir sunyi): onset lokal di bawah ambang
  const beatScores = frames.map((i) => local[i]);
  const cut = 0.01 * Math.max(...beatScores);
  const th = (() => { const s = [...beatScores].sort((a, b) => a - b); return Math.max(cut, 0.01 * s[s.length >> 1]); })();
  let a = 0, b = frames.length;
  while (a < b && local[frames[a]] <= th) a++;
  while (b > a && local[frames[b - 1]] <= th) b--;
  return frames.slice(a, b).map((i) => i / fps);
}

/** Median selang antar ketukan -> BPM. */
export function bpmFromBeats(beats) {
  if (beats.length < 2) return 0;
  const d = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  return 60 / d[d.length >> 1];
}

/**
 * Tempo + ketukan dari audio mono.
 * @returns {{bpm:number, beats:number[], fps:number, tempoScore:number}}
 */
export function trackBeats(samples, sr, opts = {}) {
  const c = { ...BEAT_DEFAULTS, ...opts };
  const { env, fps } = onsetStrength(samples, sr, c);
  const { bpm: guess, score } = estimateTempo(env, fps, c);
  const beats = trackBeatsDP(env, fps, guess, c.tightness).map((t) => Math.round(t * 1000) / 1000);
  return { bpm: beats.length > 1 ? Math.round(bpmFromBeats(beats) * 10) / 10 : guess, beats, fps, tempoScore: score };
}

// ---------- koreksi tempo ----------

/** Perbaikan "oktaf tempo": hapus tiap ketukan kedua (tempo ÷2). */
export const halveTempo = (beats) => beats.filter((_, i) => i % 2 === 0);

/** Sisipkan ketukan di tengah tiap selang (tempo ×2). */
export function doubleTempo(beats) {
  const out = [];
  beats.forEach((t, i) => {
    out.push(t);
    if (i + 1 < beats.length) out.push(Math.round(((t + beats[i + 1]) / 2) * 1000) / 1000);
  });
  return out;
}

// ---------- birama (downbeat) ----------

/**
 * Pilih fase birama: ketukan ke-berapa (mod `meter`) yang paling sering bertepatan dengan pergantian chord.
 * @param {number[]} beats
 * @param {{start:number, label:string}[]} segs chord terurut
 * @returns {{phase:number, confidence:number}} confidence 0..1 (selisih terbaik vs kedua dibagi total); 0 bila tidak ada data
 */
export function pickPhase(beats, segs, meter = 4, sigma = 0.08) {
  if (beats.length < meter * 2) return { phase: 0, confidence: 0 };
  const changes = segs.slice(1).filter((s, i) => s.label !== segs[i].label && s.label !== 'N').map((s) => s.start);
  const score = new Array(meter).fill(0);
  let j = 0;
  for (const ct of changes) {
    // ketukan terdekat dengan perpindahan chord ini
    while (j + 1 < beats.length && Math.abs(beats[j + 1] - ct) <= Math.abs(beats[j] - ct)) j++;
    const dt = beats[j] - ct;
    if (Math.abs(dt) <= 3 * sigma) score[j % meter] += Math.exp(-0.5 * (dt / sigma) ** 2);
  }
  const total = score.reduce((a, b) => a + b, 0);
  if (!total) return { phase: 0, confidence: 0 };
  const order = score.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
  return { phase: order[0][1], confidence: (order[0][0] - order[1][0]) / total };
}

/**
 * Pilih birama (3 atau 4 ketukan) dan fasenya: yang pergantian chordnya paling teratur terhadap siklus ketukan.
 * Bila bukti lemah, tetap 4/4. Pengguna selalu bisa mengubahnya.
 * @returns {{meter:number, phase:number, confidence:number}}
 */
export function pickMeter(beats, segs, candidates = [3, 4], minConfidence = 0.15) {
  const results = candidates.map((m) => ({ meter: m, ...pickPhase(beats, segs, m) }));
  const best = results.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  if (best.confidence < minConfidence) return { meter: 4, phase: results.find((r) => r.meter === 4)?.phase ?? 0, confidence: best.confidence };
  return best;
}

/**
 * Grid birama. Birama 0 = anakrusis (ketukan sebelum downbeat pertama), bila ada.
 * @returns {{n:number, start:number, end:number, beats:number[]}[]}
 */
export function buildGrid(beats, meter = 4, phase = 0) {
  if (beats.length < 2) return [];
  const interval = (beats.at(-1) - beats[0]) / (beats.length - 1);
  const bars = [];
  const starts = [];
  for (let i = phase % meter; i < beats.length; i += meter) starts.push(i);
  if (starts[0] > 0) bars.push({ n: 0, start: beats[0], end: beats[starts[0]], beats: beats.slice(0, starts[0]) });
  starts.forEach((s, k) => {
    const e = starts[k + 1];
    const slice = beats.slice(s, e ?? beats.length);
    bars.push({ n: k + 1, start: beats[s], end: e !== undefined ? beats[e] : beats.at(-1) + interval, beats: slice });
  });
  return bars;
}

/** Indeks birama yang memuat waktu t, atau -1. */
export function barIndexAt(bars, t) {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && t < bars[found].end ? found : -1;
}

/**
 * Chord tiap birama: chord yang berbunyi di tiap ketukan (dicuplik sedikit setelah ketukan, toleran terhadap batas yang meleset),
 * digabung bila berurutan sama. `hold` = chord yang sama dengan akhir birama sebelumnya (tidak berganti).
 * @returns {{n:number, start:number, end:number, chords:string[], hold:boolean}[]}
 */
export function barChords(bars, segs, { offset = 0.1 } = {}) {
  const at = (t) => {
    let lo = 0, hi = segs.length - 1, f = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].start <= t) { f = mid; lo = mid + 1; } else hi = mid - 1; }
    return f >= 0 && t < segs[f].end + 0.05 ? segs[f].label : 'N';
  };
  let prev = null;
  return bars.map((bar) => {
    const seq = [];
    for (const b of bar.beats) {
      const l = at(b + offset);
      if (l !== 'N' && seq.at(-1) !== l) seq.push(l);
    }
    const hold = seq.length > 0 && seq[0] === prev && seq.length === 1;
    if (seq.length) prev = seq.at(-1);
    return { n: bar.n, start: bar.start, end: bar.end, chords: seq, hold };
  });
}

// ---------- metronom & rapatkan ----------

/** Klik metronom yang jatuh di [from, to): [{t, accent}], accent = ketukan pertama birama. */
export function metronomeClicks(beats, meter, phase, from, to) {
  const out = [];
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] >= to) break;
    if (beats[i] >= from) out.push({ t: beats[i], accent: ((i - (phase % meter)) % meter + meter) % meter === 0 });
  }
  return out;
}

/** Ketukan terdekat dengan t, atau null bila lebih jauh dari maxDist. */
export function nearestBeat(beats, t, maxDist = Infinity) {
  if (!beats.length) return null;
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid; }
  const best = Math.abs(beats[lo] - t) <= Math.abs(beats[hi] - t) ? beats[lo] : beats[hi];
  return Math.abs(best - t) <= maxDist ? best : null;
}

// ---------- paket siap simpan ----------

/**
 * Seluruh analisis ketukan satu lagu, siap disimpan di kolom songs.beats.
 * `segs` (chord terdeteksi) dipakai untuk menebak birama dan fase downbeat; boleh kosong.
 * @returns {{v:number, bpm:number, meter:number, phase:number, confidence:number, beats:number[]}}
 */
export function analyzeBeatGrid(samples, sr, segs = [], opts = {}) {
  const { bpm, beats } = trackBeats(samples, sr, opts);
  const { meter, phase, confidence } = pickMeter(beats, segs);
  return { v: 1, bpm, meter, phase, confidence: Math.round(confidence * 100) / 100, beats };
}
