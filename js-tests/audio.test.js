import test from 'node:test';
import assert from 'node:assert/strict';
import { downmixToMono, resampleLinear, sha256Hex } from '../web/js/audio.js';
import { detect } from '../web/js/baseline.js';
import { validateSegments } from '../web/js/labels.js';
import { chordTone, concat, labelsOf } from './helpers.js';

test('downmix: rata-rata kanal; mono tidak berubah', () => {
  const out = downmixToMono([Float32Array.of(1, 0, -1), Float32Array.of(0, 1, -1)]);
  assert.deepEqual(Array.from(out), [0.5, 0.5, -1]);
  assert.deepEqual(Array.from(downmixToMono([Float32Array.of(0.25, 0.5)])), [0.25, 0.5]);
});

test('resample: panjang benar dan tidak berubah bila rate sama', () => {
  const x = Float32Array.from({ length: 4410 }, (_, i) => Math.sin(i / 10));
  assert.equal(resampleLinear(x, 22050, 22050), x);
  assert.equal(resampleLinear(x, 44100, 22050).length, 2205);
  assert.equal(resampleLinear(x, 22050, 44100).length, 8820);
});

test('resample 44.1k -> 22.05k mempertahankan chord yang terdeteksi', () => {
  // Bangkitkan chord di 44.1 kHz, turunkan, lalu deteksi: hasil harus tetap C-Am.
  const sr = 44100;
  const tone = (notes) => {
    const f = { C: 261.63, E: 329.63, G: 392, A: 220 };
    const y = new Float32Array(sr * 2);
    for (const n of notes) for (let i = 0; i < y.length; i++) y[i] += 0.2 * Math.sin((2 * Math.PI * f[n] * i) / sr);
    return y;
  };
  const down = resampleLinear(concat(tone(['C', 'E', 'G']), tone(['A', 'C', 'E'])), sr, 22050);
  assert.deepEqual(labelsOf(detect(down, 22050)), ['C', 'Am']);
});

test('sha256Hex cocok dengan nilai standar', async () => {
  const buf = new TextEncoder().encode('abc').buffer;
  assert.equal(await sha256Hex(buf), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('validateSegments: normalisasi dan penolakan (padanan Python)', () => {
  const ok = validateSegments([{ start: 0, end: 1.00049, label: ' C ' }, { start: 1.0005, end: 2, label: 'G/B' }]);
  assert.deepEqual(ok, [{ start: 0, end: 1, label: 'C' }, { start: 1.001, end: 2, label: 'G/B' }]);
  // segmen yang bersentuhan dan gap boleh
  assert.equal(validateSegments([{ start: 0, end: 1, label: 'C' }, { start: 1, end: 2, label: 'N' }, { start: 3, end: 4, label: 'Am7' }]).length, 3);

  const bad = [
    [[], /Minimal/],
    [[{ start: 0, end: 2, label: 'C' }, { start: 1.5, end: 3, label: 'G' }], /tumpang tindih/],
    [[{ start: 2, end: 3, label: 'C' }, { start: 0, end: 1, label: 'G' }], /tumpang tindih/],
    [[{ start: 1, end: 1, label: 'C' }], /setelah/],
    [[{ start: 0, end: 0.0004, label: 'C' }], /setelah/],
    [[{ start: -1, end: 1, label: 'C' }], /negatif/],
    [[{ start: 0, end: 1, label: 'Hm' }], /tidak valid/],
    [[{ start: 0, end: 1, label: '' }], /tidak valid/],
    [[{ start: 'a', end: 1, label: 'C' }], /angka/],
    [[{ start: 0, end: Infinity, label: 'C' }], /angka/],
  ];
  for (const [input, re] of bad) assert.throws(() => validateSegments(input), re);
});
