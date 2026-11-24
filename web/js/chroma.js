// Chroma dari STFT (FFT), pengganti chroma_cqt di versi Python.
// Keluaran: Float32Array frame-major (numFrames x 12), magnitudo linear belum dinormalisasi.
// Frame t berpusat di t*hop (sama seperti librosa center=True), jadi jumlah frame = 1 + floor(N/hop).
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
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  for (let t = 0; t < numFrames; t++) {
    const start = t * hop - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = samples[reflect(start + i, samples.length)] * window[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    const base = t * 12;
    for (let k = 1; k <= N / 2; k++) {
      const pc = pcOfBin[k];
      if (pc >= 0) chroma[base + pc] += Math.hypot(re[k], im[k]);
    }
    if (cfg.onProgress && t % 64 === 0) cfg.onProgress(t / numFrames);
  }
  if (cfg.onProgress) cfg.onProgress(1);
  return { chroma, numFrames };
}
