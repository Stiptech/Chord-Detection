// Chroma dari STFT (FFT), pengganti chroma_cqt di versi Python.
// Keluaran: Float32Array frame-major (numFrames x 12), belum dinormalisasi.
// Frame t berpusat di t*hop (sama seperti librosa center=True), jadi jumlah frame = 1 + floor(N/hop).
//
// Pipeline per frame (streaming, hanya menyimpan beberapa frame di memori):
//   magnitudo FFT -> median sepanjang waktu per bin (penguat harmonik)
//   -> kurangi lantai broadband (median antar bin) -> pangkat -> lipat ke 12 pitch class.
// Tanpa pembersihan ini, rekaman nyata menghasilkan chroma datar dan hampir semuanya terbaca "N".
import { FFT } from './fft.js';
import { DEFAULTS } from './config.js';

function reflect(i, len) {
  if (len === 1) return 0;
  const period = 2 * (len - 1);
  i = ((i % period) + period) % period;
  return i < len ? i : period - i;
}

/** Peta bin FFT -> pitch class (0=C), -1 bila di luar [fmin, fmax]. Tuning diasumsikan A4=440 Hz. */
export function binToPitchClass(fftSize, sampleRate, fminHz, fmaxHz) {
  const map = new Int8Array(fftSize / 2 + 1).fill(-1);
  for (let k = 1; k < map.length; k++) {
    const f = (k * sampleRate) / fftSize;
    if (f < fminHz || f > fmaxHz) continue;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    map[k] = ((midi % 12) + 12) % 12;
  }
  return map;
}

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {object} [opts] timpa DEFAULTS; onProgress(0..1) dipanggil berkala
 */
export function computeChroma(samples, sampleRate, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const N = cfg.fftSize;
  const hop = cfg.hopLength;
  const numFrames = 1 + Math.floor(samples.length / hop);
  const chroma = new Float32Array(numFrames * 12);

  const fft = new FFT(N);
  const window = new Float64Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // Hann periodik
  const pcOfBin = binToPitchClass(N, sampleRate, cfg.fminHz, cfg.fmaxHz);
  let kLo = 1, kHi = N / 2;
  while (kLo < kHi && pcOfBin[kLo] < 0) kLo++;
  while (kHi > kLo && pcOfBin[kHi] < 0) kHi--;
  const K = kHi - kLo + 1;

  const win = Math.max(1, cfg.harmonicMedianFrames | 1); // paksa ganjil
  const half = win >> 1;
  const ring = Array.from({ length: win }, () => new Float32Array(K)); // magnitudo beberapa frame terakhir
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const row = new Float32Array(K);
  const tmp = new Float32Array(win);
  let computed = -1; // frame terakhir yang sudah dihitung FFT-nya

  const computeFrame = (t) => {
    const start = t * hop - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = samples[reflect(start + i, samples.length)] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const out = ring[t % win];
    for (let k = 0; k < K; k++) out[k] = Math.hypot(re[kLo + k], im[kLo + k]);
  };

  for (let t = 0; t < numFrames; t++) {
    const last = Math.min(numFrames - 1, t + half);
    while (computed < last) computeFrame(++computed); // lookahead untuk median waktu

    // 1. median sepanjang waktu per bin (jendela dipotong di tepi lagu)
    const from = Math.max(0, t - half);
    const n = last - from + 1;
    if (n === 1) row.set(ring[t % win]);
    else {
      for (let k = 0; k < K; k++) {
        for (let j = 0; j < n; j++) tmp[j] = ring[(from + j) % win][k];
        const s = tmp.subarray(0, n).sort();
        row[k] = s[n >> 1];
      }
    }

    // 2. buang lantai broadband
    if (cfg.whitenMult > 0) {
      const floor = Float32Array.from(row).sort()[K >> 1] * cfg.whitenMult;
      for (let k = 0; k < K; k++) row[k] = Math.max(0, row[k] - floor);
    }

    // 3. pangkat, lalu lipat ke pitch class
    const base = t * 12;
    for (let k = 0; k < K; k++) {
      const pc = pcOfBin[kLo + k];
      if (pc < 0) continue;
      chroma[base + pc] += cfg.chromaPower === 1 ? row[k] : row[k] ** cfg.chromaPower;
    }
    if (cfg.onProgress && t % 64 === 0) cfg.onProgress(t / numFrames);
  }
  if (cfg.onProgress) cfg.onProgress(1);
  return { chroma, numFrames };
}
