// Detector baseline: chroma -> template matching -> softmax -> Viterbi -> segmen.
// Port dari app/detectors/baseline.py; urutan state dan angka default sama.
//
// Keterbatasan yang disadari (sama dengan versi Python):
// - sus2 dan sus4 punya nada sama (Dsus4 = Gsus2), root tak bisa dibedakan dari chroma saja.
// - Slash chord tidak dideteksi (butuh estimasi bass).
// - Berbeda dari Python: tanpa pemisahan harmonik/perkusif (HPSS), dan chroma dari FFT, bukan CQT.
import { DEFAULTS } from './config.js';
import { computeChroma } from './chroma.js';
import { CHORD_QUALITIES, SHARP_NAMES } from './labels.js';

// Kosakata awal (urutan menentukan state; N paling akhir).
export const VOCAB_SUFFIXES = ['', 'm', 'sus2', 'sus4', '7', 'maj7', 'm7'];
export const NO_CHORD = 'N';

/** @returns {{labels: string[], templates: Float64Array, bias: Float64Array, numStates: number}} template [state x 12] ter-L2-normalisasi */
export function buildTemplates(cfg = DEFAULTS) {
  const numStates = VOCAB_SUFFIXES.length * 12 + 1;
  const labels = [];
  const templates = new Float64Array(numStates * 12);
  const bias = new Float64Array(numStates);
  let s = 0;
  for (const suffix of VOCAB_SUFFIXES) {
    const intervals = CHORD_QUALITIES.get(suffix)[1];
    for (let root = 0; root < 12; root++, s++) {
      const norm = Math.sqrt(intervals.length);
      for (const iv of intervals) templates[s * 12 + ((root + iv) % 12)] = 1 / norm;
      labels.push(SHARP_NAMES[root] + suffix);
      bias[s] = cfg.qualityBias[suffix] ?? 0;
    }
  }
  templates.fill(1 / Math.sqrt(12), s * 12, s * 12 + 12); // N = chroma datar
  labels.push(NO_CHORD);
  bias[s] = cfg.noChordBias;
  return { labels, templates, bias, numStates };
}

/** Persentil dengan interpolasi linear (sama dengan numpy.percentile default). */
export function percentile(values, q) {
  const sorted = Float64Array.from(values).sort();
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** chroma mentah (frame-major, T x 12) -> probabilitas state, frame-major (T x S). */
export function chromaToProbs(chroma, numFrames, tpl, cfg = DEFAULTS) {
  const { templates, bias, numStates: S } = tpl;
  const norms = new Float64Array(numFrames);
  for (let t = 0; t < numFrames; t++) {
    let sum = 0;
    for (let c = 0; c < 12; c++) sum += chroma[t * 12 + c] ** 2;
    norms[t] = Math.sqrt(sum);
  }
  const silenceFloor = Math.max(cfg.silenceRatio * percentile(norms, 95), 1e-8);

  const probs = new Float64Array(numFrames * S);
  const x = new Float64Array(12);
  for (let t = 0; t < numFrames; t++) {
    const silent = norms[t] <= silenceFloor;
    if (silent) {
      probs[t * S + S - 1] = 1; // frame hening: pasti N (state terakhir); N tidak dipilih dari chroma datar
      continue;
    }
    for (let c = 0; c < 12; c++) x[c] = chroma[t * 12 + c] / Math.max(norms[t], 1e-8);
    let max = -Infinity;
    for (let s = 0; s < S; s++) {
      let dot = 0;
      for (let c = 0; c < 12; c++) dot += templates[s * 12 + c] * x[c];
      const z = (dot + bias[s]) / cfg.softmaxTemperature;
      probs[t * S + s] = z;
      if (z > max) max = z;
    }
    let total = 0;
    for (let s = 0; s < S; s++) {
      const e = Math.exp(probs[t * S + s] - max); // stabilitas numerik
      probs[t * S + s] = e;
      total += e;
    }
    for (let s = 0; s < S; s++) probs[t * S + s] /= total;
  }
  return probs;
}

/**
 * Viterbi dengan transisi "loop": bertahan = pStay, pindah ke state lain seragam.
 * Kompleksitas O(T*S): kandidat pindah terbaik cukup dari dua skor terbaik langkah sebelumnya.
 * @returns {Int32Array} state per frame
 */
export function viterbiLoop(probs, numFrames, numStates, pStay) {
  const S = numStates;
  const logStay = Math.log(pStay);
  const logMove = Math.log((1 - pStay) / (S - 1));
  const back = new Int32Array(numFrames * S);
  let prev = new Float64Array(S);
  let cur = new Float64Array(S);
  const logp = (t, s) => Math.log(Math.max(probs[t * S + s], 1e-300));

  for (let s = 0; s < S; s++) prev[s] = logp(0, s);
  for (let t = 1; t < numFrames; t++) {
    let best = 0;
    let second = -1;
    for (let s = 1; s < S; s++) {
      if (prev[s] > prev[best]) { second = best; best = s; }
      else if (second < 0 || prev[s] > prev[second]) second = s;
    }
    for (let s = 0; s < S; s++) {
      const stay = prev[s] + logStay;
      const from = best !== s ? best : second;
      const move = prev[from] + logMove;
      if (stay >= move) { cur[s] = stay + logp(t, s); back[t * S + s] = s; }
      else { cur[s] = move + logp(t, s); back[t * S + s] = from; }
    }
    [prev, cur] = [cur, prev];
  }
  const states = new Int32Array(numFrames);
  let s = 0;
  for (let i = 1; i < S; i++) if (prev[i] > prev[s]) s = i;
  for (let t = numFrames - 1; t >= 0; t--) {
    states[t] = s;
    if (t > 0) s = back[t * S + s];
  }
  return states;
}

/** Gabung frame berurutan berlabel sama. Frame t berpusat di t*hop, jadi batas ada di (t-0.5)*hop. */
export function statesToSegments(states, labels, hopLength, sampleRate, duration) {
  const n = states.length;
  if (n === 0) return [];
  const frameSec = hopLength / sampleRate;
  const segs = [];
  let s = 0;
  for (let t = 1; t <= n; t++) {
    if (t === n || states[t] !== states[s]) {
      const t0 = s === 0 ? 0 : (s - 0.5) * frameSec;
      const t1 = t === n ? duration : (t - 0.5) * frameSec;
      segs.push({ start: t0, end: Math.min(t1, duration), label: labels[states[s]] });
      s = t;
    }
  }
  return segs;
}

function joinEqual(segs) {
  const out = [];
  for (const s of segs) {
    if (out.length && out[out.length - 1].label === s.label) out[out.length - 1].end = s.end;
    else out.push(s);
  }
  return out;
}

/** Segmen terpendek yang < minLen diserap tetangga yang lebih panjang; ulangi. `minLenOf(seg)` boleh memberi batas berbeda per segmen. */
export function mergeShortSegments(segs, minLen, minLenOf = () => minLen) {
  let out = joinEqual(segs.map((s) => ({ ...s })));
  const dur = (s) => s.end - s.start;
  while (out.length > 1) {
    let i = -1;
    for (let k = 0; k < out.length; k++) {
      if (dur(out[k]) < minLenOf(out[k]) && (i < 0 || dur(out[k]) < dur(out[i]))) i = k;
    }
    if (i < 0) break;
    let j;
    if (i === 0) j = 1;
    else if (i === out.length - 1) j = i - 1;
    else j = dur(out[i - 1]) >= dur(out[i + 1]) ? i - 1 : i + 1;
    if (j < i) out[j].end = out[i].end;
    else out[j].start = out[i].start;
    out.splice(i, 1);
    out = joinEqual(out);
  }
  return out;
}

/**
 * Deteksi chord dari audio mono.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {object} [opts] timpa DEFAULTS; onProgress(0..1)
 * @returns {{start:number,end:number,label:string}[]}
 */
export function detect(samples, sampleRate, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (samples.length === 0) return [];
  const duration = samples.length / sampleRate;
  const { chroma, numFrames } = computeChroma(samples, sampleRate, cfg);
  const tpl = buildTemplates(cfg);
  const probs = chromaToProbs(chroma, numFrames, tpl, cfg);
  const states = viterbiLoop(probs, numFrames, tpl.numStates, cfg.transitionLoop);
  const segs = statesToSegments(states, tpl.labels, cfg.hopLength, sampleRate, duration);
  // sus yang hanya sebentar biasanya bukan chord yang dimainkan (nada penyambung/sisa dengung chord sebelumnya): serap ke tetangga
  const minLenOf = (s) => (s.label.includes('sus') ? Math.max(cfg.minSegmentSec, cfg.minSusSec) : cfg.minSegmentSec);
  return mergeShortSegments(segs, cfg.minSegmentSec, minLenOf);
}
