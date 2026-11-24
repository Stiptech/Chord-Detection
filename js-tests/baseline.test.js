// Padanan tests/test_baseline.py + tes komponen (FFT, Viterbi, chroma).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../web/js/fft.js';
import { binToPitchClass, computeChroma } from '../web/js/chroma.js';
import { buildTemplates, detect, mergeShortSegments, viterbiLoop, VOCAB_SUFFIXES } from '../web/js/baseline.js';
import { SR, chordTone, concat, silence, labelsOf } from './helpers.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} tidak dekat ${b} (±${tol})`);

// ---------- komponen ----------

test('FFT cocok dengan DFT naif', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + (i % 5));
  const im = new Float64Array(n);
  const expected = [];
  for (let k = 0; k < n; k++) {
    let r = 0, m = 0;
    for (let i = 0; i < n; i++) {
      r += re[i] * Math.cos((2 * Math.PI * k * i) / n);
      m -= re[i] * Math.sin((2 * Math.PI * k * i) / n);
    }
    expected.push([r, m]);
  }
  new FFT(n).transform(re, im);
  for (let k = 0; k < n; k++) { near(re[k], expected[k][0], 1e-9); near(im[k], expected[k][1], 1e-9); }
  assert.throws(() => new FFT(100));
});

test('pitch class bin: A4=440 -> 9, C4 -> 0', () => {
  const map = binToPitchClass(8192, SR, 65, 3000);
  const bin = (f) => Math.round((f * 8192) / SR);
  assert.equal(map[bin(440)], 9);
  assert.equal(map[bin(261.63)], 0);
  assert.equal(map[bin(50)], -1);
  assert.equal(map[bin(5000)], -1);
});

test('chroma nada tunggal puncak di pitch class benar', () => {
  const { chroma, numFrames } = computeChroma(chordTone(['E']), SR);
  assert.equal(numFrames, 1 + Math.floor((2 * SR) / 2048));
  const mid = Math.floor(numFrames / 2) * 12;
  const row = Array.from(chroma.slice(mid, mid + 12));
  assert.equal(row.indexOf(Math.max(...row)), 4);
});

test('template: 85 state, ter-L2-normalisasi, urutan sama dengan Python', () => {
  const tpl = buildTemplates();
  assert.equal(tpl.numStates, VOCAB_SUFFIXES.length * 12 + 1);
  assert.equal(tpl.labels[0], 'C');
  assert.equal(tpl.labels[12], 'Cm');
  assert.equal(tpl.labels[12 * 6 + 9], 'Am7');
  assert.equal(tpl.labels.at(-1), 'N');
  for (let s = 0; s < tpl.numStates; s++) {
    let sum = 0;
    for (let c = 0; c < 12; c++) sum += tpl.templates[s * 12 + c] ** 2;
    near(sum, 1, 1e-12);
  }
});

test('Viterbi efisien sama dengan versi brute-force', () => {
  const T = 40, S = 6, pStay = 0.8;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const probs = new Float64Array(T * S);
  for (let t = 0; t < T; t++) {
    let tot = 0;
    for (let s = 0; s < S; s++) tot += probs[t * S + s] = rnd() ** 3 + 1e-3;
    for (let s = 0; s < S; s++) probs[t * S + s] /= tot;
  }
  // brute force: semua transisi i->j dicoba
  const lt = (i, j) => Math.log(i === j ? pStay : (1 - pStay) / (S - 1));
  let score = Array.from({ length: S }, (_, s) => Math.log(probs[s]));
  const back = [];
  for (let t = 1; t < T; t++) {
    const next = [], bp = [];
    for (let j = 0; j < S; j++) {
      let bi = 0, bv = -Infinity;
      for (let i = 0; i < S; i++) if (score[i] + lt(i, j) > bv) { bv = score[i] + lt(i, j); bi = i; }
      next.push(bv + Math.log(probs[t * S + j])); bp.push(bi);
    }
    score = next; back.push(bp);
  }
  let s = score.indexOf(Math.max(...score));
  const expected = [s];
  for (let t = T - 2; t >= 0; t--) { s = back[t][s]; expected.unshift(s); }
  assert.deepEqual(Array.from(viterbiLoop(probs, T, S, pStay)), expected);
});

test('gabung segmen pendek: kedip diserap', () => {
  const out = mergeShortSegments([
    { start: 0, end: 2, label: 'C' }, { start: 2, end: 2.1, label: 'F' },
    { start: 2.1, end: 4, label: 'C' }, { start: 4, end: 6, label: 'G' },
  ], 0.3);
  assert.deepEqual(out, [{ start: 0, end: 4, label: 'C' }, { start: 4, end: 6, label: 'G' }]);
});

test('gabung segmen pendek: waktu tetap kontigu dan semua >= minimum', () => {
  const out = mergeShortSegments([
    { start: 0, end: 1, label: 'C' }, { start: 1, end: 1.1, label: 'D' },
    { start: 1.1, end: 1.2, label: 'E' }, { start: 1.2, end: 3, label: 'G' },
  ], 0.3);
  assert.equal(out[0].start, 0);
  assert.equal(out.at(-1).end, 3);
  out.slice(1).forEach((s, i) => assert.equal(s.start, out[i].end));
  out.forEach((s) => assert.ok(s.end - s.start >= 0.3));
});

// ---------- deteksi ujung ke ujung ----------

test('progresi triad C-Am-F-G', () => {
  const y = concat(chordTone(['C', 'E', 'G']), chordTone(['A', 'C', 'E']), chordTone(['F', 'A', 'C']), chordTone(['G', 'B', 'D']));
  const segs = detect(y, SR);
  assert.deepEqual(labelsOf(segs), ['C', 'Am', 'F', 'G']);
  [0, 2, 4, 6].forEach((t, i) => near(segs[i].start, t, 0.25));
  near(segs.at(-1).end, 8, 0.1);
});

test('chord ke-7: Cmaj7-Dm7-G7-Am', () => {
  const y = concat(chordTone(['C', 'E', 'G', 'B']), chordTone(['D', 'F', 'A', 'C']), chordTone(['G', 'B', 'D', 'F']), chordTone(['A', 'C', 'E']));
  assert.deepEqual(labelsOf(detect(y, SR)), ['Cmaj7', 'Dm7', 'G7', 'Am']);
});

test('hening di antara chord jadi N', () => {
  const y = concat(chordTone(['C', 'E', 'G']), silence(2), chordTone(['G', 'B', 'D']));
  assert.deepEqual(labelsOf(detect(y, SR)), ['C', 'N', 'G']);
});

test('audio kosong dan sangat pendek tidak error', () => {
  assert.deepEqual(detect(new Float32Array(0), SR), []);
  const segs = detect(chordTone(['C', 'E', 'G'], 0.05), SR);
  assert.equal(segs.length, 1);
});

test('seluruh audio hening -> satu segmen N', () => {
  assert.deepEqual(labelsOf(detect(silence(3), SR)), ['N']);
});

test('onProgress dipanggil dan berakhir di 1', () => {
  const seen = [];
  detect(chordTone(['C', 'E', 'G']), SR, { onProgress: (p) => seen.push(p) });
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.every((p, i) => i === 0 || p >= seen[i - 1]));
});
