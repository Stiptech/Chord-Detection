import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { btcFeatures, cqtFrequencies, halve, CQT } from '../web/js/cqt.js';

const f32 = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

/** Sinyal yang sama persis dengan scripts/make_cqt_fixture.py. */
function fixtureSignal() {
  const sr = 22050, n = Math.floor(sr * 10.5);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tone = (Math.sin(2 * Math.PI * 261.63 * t) + 0.5 * Math.sin(2 * Math.PI * 329.63 * t) + 0.5 * Math.sin(2 * Math.PI * 392 * t)
      + 0.3 * Math.sin(2 * Math.PI * 130.81 * t)) * 0.15 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t));
    const noise = Number((BigInt(i) * 2654435761n) % 4294967296n) / 4294967296;
    y[i] = tone + 0.01 * (noise - 0.5);
  }
  return y;
}

test('cqtFrequencies: 144 bin, 24 per oktaf dari C1', () => {
  const f = cqtFrequencies();
  assert.equal(f.length, 144);
  assert.ok(Math.abs(f[0] - 32.7032) < 1e-3);
  assert.ok(Math.abs(f[24] / f[0] - 2) < 1e-9);
});

test('halve: gain DC = 1 dikali sqrt(2), frekuensi rendah lewat, frekuensi tinggi (alias) diredam', () => {
  const n = 4000, dc = new Float32Array(n).fill(1);
  const d = halve(dc);
  assert.equal(d.length, 2000);
  assert.ok(Math.abs(d[1000] - Math.SQRT2) < 1e-3);
  const hi = Float32Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 0.45 * i)); // di atas Nyquist baru
  const dh = halve(hi);
  let peak = 0; for (let i = 200; i < 1800; i++) peak = Math.max(peak, Math.abs(dh[i]));
  assert.ok(peak < 0.01, `bocor ${peak}`);
  assert.equal(halve(new Float32Array(5)).length, 3); // ceil(n/2), seperti librosa
});

test('btcFeatures cocok dengan librosa.cqt (fixture sintetis, dua potongan)', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/cqt.json', import.meta.url), 'utf8'));
  const ref = f32(fx.logCqt);
  const { frames, data } = btcFeatures(fixtureSignal());
  assert.equal(frames, fx.frames); // 108 + 6
  assert.equal(data.length, ref.length);
  // Selisih tersisa ada di tepi potongan 10 dtk (pad nol bertemu penurun laju soxr vs FIR kita) dan pada bin berenergi
  // sangat kecil (~1e-5). Bin berenergi nyata (log > -6) di bagian dalam potongan harus cocok rapat (< 0.05 dalam log).
  let sum = 0, big = 0, loud = 0, loudMax = 0, innerMax = 0, loudSum = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(data[i] - ref[i]);
    sum += d;
    if (d > 0.1) big++;
    if (ref[i] > -6) {
      loud++; loudSum += d; loudMax = Math.max(loudMax, d);
      const f = Math.floor(i / 144);
      if (f >= 4 && f < 104) innerMax = Math.max(innerMax, d);
    }
  }
  assert.ok(sum / ref.length < 0.01, `selisih rata-rata ${sum / ref.length}`);
  assert.ok(big / ref.length < 0.03, `terlalu banyak selisih besar: ${big}`);
  assert.ok(loud > 100, 'fixture harus punya bin berenergi');
  assert.ok(innerMax < 0.05, `bin berenergi di dalam potongan meleset ${innerMax}`);
  assert.ok(loudSum / loud < 0.02 && loudMax < 0.5, `bin berenergi: rata-rata ${loudSum / loud}, maks ${loudMax}`);
  assert.equal(CQT.nBins, 144);
});
