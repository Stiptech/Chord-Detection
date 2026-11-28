import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBtcWeights, btcLogits, btcPredict, framesToSegments, BTC } from '../web/js/btc.js';

const f32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const weights = readFileSync(new URL('../web/models/btc-large-voca.bin', import.meta.url));
const model = parseBtcWeights(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.length));
const fx = JSON.parse(readFileSync(new URL('./fixtures/btc_model.json', import.meta.url), 'utf8'));

test('bobot: 170 kelas, label dalam notasi proyek', () => {
  assert.equal(model.numClasses, 170);
  assert.equal(model.labels[169], 'N');
  assert.ok(model.labels.includes('Dsus2') && model.labels.includes('Bm') && model.labels.includes('G'));
  assert.ok(model.labels.every((l) => !l.includes(':')));
});

test('btcLogits cocok dengan PyTorch (bobot fp16, fixture fp32)', () => {
  const input = f32(fx.input), want = f32(fx.logits), T = BTC.timestep, n = model.numClasses;
  let maxd = 0, same = 0;
  for (let b = 0; b < fx.batch; b++) {
    const lg = btcLogits(model, input.subarray(b * T * 144, (b + 1) * T * 144));
    for (let i = 0; i < lg.length; i++) maxd = Math.max(maxd, Math.abs(lg[i] - want[b * T * n + i]));
    for (let t = 0; t < T; t++) {
      let a = 0;
      for (let c = 1; c < n; c++) if (lg[t * n + c] > lg[t * n + a]) a = c;
      if (a === fx.argmax[b * T + t]) same++;
    }
  }
  assert.ok(maxd < 0.05, `selisih logit ${maxd}`); // fp16 menambah galat ~3e-3
  assert.ok(same / (fx.batch * T) > 0.99, `argmax sama ${same}`);
});

test('btcPredict: blok terakhir diisi nol dan dipotong kembali', () => {
  const frames = 120; // 1 blok penuh + 12 bingkai
  const data = Float32Array.from({ length: frames * 144 }, (_, i) => model.mean + 0.1 * Math.sin(i));
  const pred = btcPredict(model, data, frames);
  assert.equal(pred.length, frames);
  assert.ok(pred.every((c) => c < model.numClasses));
});

test('framesToSegments: gabung bingkai sama, label sama bertetangga, batas dalam kelipatan 10/108 dtk', () => {
  const labels = ['C', 'G', 'N'];
  const segs = framesToSegments(Uint8Array.from([0, 0, 1, 1, 1, 0]), labels);
  assert.deepEqual(segs.map((s) => s.label), ['C', 'G', 'C']);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, Math.round((10 / 108) * 2 * 1000) / 1000);
  assert.equal(segs[2].end, Math.round((10 / 108) * 6 * 1000) / 1000);
  // dua kelas berbeda yang dipetakan ke label proyek sama harus menyatu
  assert.equal(framesToSegments(Uint8Array.from([0, 1, 0]), ['Am', 'Am']).length, 1);
});
