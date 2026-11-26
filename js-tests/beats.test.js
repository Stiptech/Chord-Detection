import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barChords, barIndexAt, bpmFromBeats, buildGrid, doubleTempo, estimateTempo, halveTempo, melFilterbank, metronomeClicks,
  nearestBeat, onsetStrength, pickMeter, pickPhase, trackBeats,
} from '../web/js/beats.js';

const SR = 22050;
const lcg = (seed) => { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5; };

/** Lagu perkusi sintetis: kick tiap ketukan, snare di ketukan genap, hi-hat tiap setengah ketukan, plus pad sustain. */
function drumTrack({ bpm, beats = 64, startDelay = 0.3, drift = 0, seed = 1, hats = true }) {
  const rnd = lcg(seed);
  const times = [];
  let t = startDelay;
  for (let i = 0; i < beats; i++) { times.push(t); t += (60 / bpm) * (1 + drift * Math.sin(i / 7)); }
  const total = Math.ceil((t + 1) * SR);
  const y = new Float32Array(total);
  const burst = (at, len, fn) => { const s = Math.round(at * SR); for (let i = 0; i < len && s + i < total; i++) y[s + i] += fn(i / SR, i / len); };
  times.forEach((bt, i) => {
    burst(bt, Math.round(0.15 * SR), (u, p) => 0.9 * Math.sin(2 * Math.PI * (55 + 80 * (1 - p) ** 3) * u) * (1 - p) ** 2); // kick
    if (i % 2 === 1) burst(bt, Math.round(0.12 * SR), (u, p) => 0.35 * rnd() * 2 * (1 - p) ** 2); // snare
    if (hats) {
      burst(bt, Math.round(0.03 * SR), (u, p) => 0.12 * rnd() * 2 * (1 - p));
      if (i + 1 < times.length) burst((bt + times[i + 1]) / 2, Math.round(0.03 * SR), (u, p) => 0.12 * rnd() * 2 * (1 - p));
    }
  });
  for (let i = 0; i < total; i++) y[i] += 0.12 * Math.sin(2 * Math.PI * 261.63 * i / SR) + 0.1 * Math.sin(2 * Math.PI * 329.63 * i / SR); // pad
  return { y, times };
}

/** Berapa persen ketukan sebenarnya yang ditemukan dalam `tol`, dan berapa persen ketukan terlacak yang benar. */
function accuracy(tracked, truth, tol = 0.04) {
  const near = (a, list) => list.some((b) => Math.abs(a - b) <= tol);
  const lo = tracked[0] ?? 0, hi = tracked.at(-1) ?? 0;
  const inRange = truth.filter((t) => t >= lo - tol && t <= hi + tol);
  return {
    recall: inRange.length ? inRange.filter((t) => near(t, tracked)).length / inRange.length : 0,
    precision: tracked.length ? tracked.filter((t) => near(t, truth)).length / tracked.length : 0,
  };
}

// ---------- komponen ----------

test('melFilterbank: filter segitiga tidak negatif, berurutan, dan menutup rentang', () => {
  const bank = melFilterbank(SR, 2048, 64, 30, 8000);
  assert.equal(bank.length, 64);
  bank.forEach((f, i) => {
    assert.ok(f.w.every((v) => v >= 0 && v <= 1.0001));
    assert.ok(f.w.some((v) => v > 0.5), `filter ${i} punya puncak`);
    if (i) assert.ok(f.from >= bank[i - 1].from);
  });
});

test('onsetStrength: sunyi menghasilkan nol, klik menghasilkan puncak di waktunya', () => {
  const { env: flat } = onsetStrength(new Float32Array(SR * 2), SR);
  assert.ok(flat.every((v) => Number.isFinite(v)) && Math.max(...flat) < 1e-6 + 1);
  const y = new Float32Array(SR * 3);
  for (let i = 0; i < 400; i++) y[Math.round(1.5 * SR) + i] = Math.sin(i * 0.4) * (1 - i / 400);
  const { env, fps } = onsetStrength(y, SR);
  const peak = env.indexOf(Math.max(...env));
  assert.ok(Math.abs(peak / fps - 1.5) < 0.06, `puncak di ${(peak / fps).toFixed(3)} dtk`);
});

// ---------- tempo & ketukan ----------

for (const bpm of [66, 72, 96, 120]) {
  test(`trackBeats: ${bpm} BPM (kick + snare + hi-hat + pad) -> tempo dan ketukan benar`, () => {
    const { y, times } = drumTrack({ bpm, beats: 48 });
    const r = trackBeats(y, SR);
    // "oktaf tempo" (setengah atau tepat) memang ambigu: hi-hat per setengah ketukan terdengar seperti tempo 2x. UI menyediakan x2/÷2.
    const exact = Math.abs(r.bpm - bpm) / bpm < 0.02;
    const half = Math.abs(r.bpm - bpm / 2) / (bpm / 2) < 0.02;
    assert.ok(exact || half, `bpm ${r.bpm} bukan ${bpm} maupun ${bpm / 2}`);
    const a = accuracy(r.beats, times);
    assert.ok(a.precision > 0.9, `presisi ${a.precision.toFixed(2)}`); // setiap ketukan terlacak jatuh pada ketukan sebenarnya
    if (exact) assert.ok(a.recall > 0.9, `recall ${a.recall.toFixed(2)}`);
  });
}

test('trackBeats: tempo sedikit bergoyang (±3%) dan derau tetap terlacak', () => {
  const { y, times } = drumTrack({ bpm: 84, beats: 56, drift: 0.03, seed: 5 });
  for (let i = 0; i < y.length; i++) y[i] += 0.05 * lcg(i + 9)();
  const r = trackBeats(y, SR);
  const a = accuracy(r.beats, times, 0.06);
  assert.ok(Math.abs(r.bpm - 84) / 84 < 0.05, `bpm ${r.bpm}`);
  assert.ok(a.recall > 0.85 && a.precision > 0.85, `recall ${a.recall.toFixed(2)} presisi ${a.precision.toFixed(2)}`);
});

test('trackBeats: tanpa hi-hat (hanya kick/snare) dan keheningan tidak membuat error', () => {
  const { y, times } = drumTrack({ bpm: 78, beats: 40, hats: false });
  const a = accuracy(trackBeats(y, SR).beats, times);
  assert.ok(a.recall > 0.9);
  assert.doesNotThrow(() => trackBeats(new Float32Array(SR * 4), SR));
  assert.doesNotThrow(() => trackBeats(new Float32Array(100), SR));
  assert.deepEqual(trackBeats(new Float32Array(SR * 4), SR).beats.length < 3, true);
});

test('estimateTempo: kandidat dibatasi rentang dan prior memilih oktaf yang wajar', () => {
  const { y } = drumTrack({ bpm: 72, beats: 48 });
  const { env, fps } = onsetStrength(y, SR);
  const t = estimateTempo(env, fps);
  assert.ok(t.candidates[0].bpm >= 55 && t.candidates.at(-1).bpm <= 190);
  assert.ok(Math.abs(t.bpm - 72) < 2, `bpm ${t.bpm}`);
});

test('bpmFromBeats, halveTempo, doubleTempo', () => {
  const beats = [0, 1, 2, 3, 4, 5];
  assert.equal(bpmFromBeats(beats), 60);
  assert.deepEqual(halveTempo(beats), [0, 2, 4]);
  assert.deepEqual(doubleTempo([0, 1, 2]), [0, 0.5, 1, 1.5, 2]);
  assert.equal(bpmFromBeats(doubleTempo(beats)), 120);
  assert.equal(bpmFromBeats([]), 0);
});

// ---------- birama ----------

const beatsAt = (n, iv = 1, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + i * iv);
/** chord berganti tiap `every` ketukan mulai dari ketukan `phase` */
function chordsEvery(beats, every, phase) {
  const segs = [];
  const labels = ['C', 'G', 'Am', 'F'];
  let k = 0;
  for (let i = phase; i < beats.length; i += every) {
    segs.push({ start: i === phase && phase > 0 ? 0 : beats[i], end: (beats[i + every] ?? beats.at(-1) + 1), label: labels[k++ % 4] });
  }
  return segs;
}

test('pickPhase/pickMeter: chord berganti tiap 3 ketukan -> birama 3 dengan fase yang benar', () => {
  const beats = beatsAt(60, 0.88, 0.4);
  const segs = chordsEvery(beats, 3, 2);
  const p = pickPhase(beats, segs, 3);
  assert.equal(p.phase, 2);
  assert.ok(p.confidence > 0.5, `keyakinan ${p.confidence}`);
  assert.ok(pickPhase(beats, segs, 4).confidence < p.confidence);
  const m = pickMeter(beats, segs);
  assert.deepEqual([m.meter, m.phase], [3, 2]);
});

test('pickMeter: chord berganti tiap 4 ketukan -> birama 4; batas chord meleset ±50 ms tetap benar', () => {
  const beats = beatsAt(64, 0.75, 0.2);
  const segs = chordsEvery(beats, 4, 1).map((s, i) => ({ ...s, start: s.start === 0 ? 0 : s.start + (i % 2 ? 0.05 : -0.05) }));
  const m = pickMeter(beats, segs);
  assert.deepEqual([m.meter, m.phase], [4, 1]);
});

test('pickMeter: tanpa bukti (tanpa chord / sedikit ketukan) kembali ke 4/4, fase 0', () => {
  assert.deepEqual(pickMeter([], []), { meter: 4, phase: 0, confidence: 0 });
  const b = beatsAt(40);
  assert.equal(pickMeter(b, [{ start: 0, end: 40, label: 'C' }]).meter, 4);
});

test('buildGrid: anakrusis (birama 0), nomor birama, dan ujung terakhir', () => {
  const beats = beatsAt(11, 1, 5); // 5..15
  const bars = buildGrid(beats, 4, 2); // downbeat di ketukan ke-3: 7, 11, 15
  assert.deepEqual(bars.map((b) => [b.n, b.start, b.end, b.beats.length]), [[0, 5, 7, 2], [1, 7, 11, 4], [2, 11, 15, 4], [3, 15, 16, 1]]);
  assert.deepEqual(buildGrid(beats, 3, 0).map((b) => b.n), [1, 2, 3, 4]);
  assert.deepEqual(buildGrid([1], 4, 0), []);
  assert.equal(buildGrid(beatsAt(8), 4, 0).length, 2);
  assert.equal(buildGrid(beatsAt(8), 4, 5)[0].n, 0); // fase > meter dilipat
});

test('barIndexAt', () => {
  const bars = buildGrid(beatsAt(9, 1, 2), 4, 0); // [2,6) [6,10) [10,11]
  assert.equal(barIndexAt(bars, 1), -1);
  assert.equal(barIndexAt(bars, 2), 0);
  assert.equal(barIndexAt(bars, 5.99), 0);
  assert.equal(barIndexAt(bars, 6), 1);
  assert.equal(barIndexAt(bars, 100), -1);
});

test('barChords: chord per birama, setengah birama, hold, N, dan toleran terhadap batas meleset', () => {
  const beats = beatsAt(17, 1, 0); // 4 birama 4 ketukan (+1)
  const bars = buildGrid(beats, 4, 0);
  const segs = [
    { start: 0, end: 7.95, label: 'C' },           // birama 1 dan 2 (C bertahan)
    { start: 7.95, end: 9.97, label: 'G' },        // G mulai 0.05 sebelum ketukan 8 (batas meleset), tahan sampai pertengahan birama 3
    { start: 9.97, end: 12, label: 'Am' },
    { start: 12, end: 14, label: 'N' },
    { start: 14, end: 20, label: 'F' },
  ];
  const bc = barChords(bars, segs);
  assert.deepEqual(bc.slice(0, 4).map((b) => b.chords), [['C'], ['C'], ['G', 'Am'], ['F']]); // birama 4: N lalu F
  assert.deepEqual(bc.slice(0, 2).map((b) => b.hold), [false, true]); // birama 2 hanya melanjutkan C
  assert.equal(bc[2].hold, false);
});

// ---------- metronom & rapatkan ----------

test('metronomeClicks: aksen di ketukan pertama tiap birama sesuai fase, hanya dalam jendela', () => {
  const beats = beatsAt(12, 0.5, 0);
  const clicks = metronomeClicks(beats, 4, 1, 1, 3.1); // ketukan di 1, 1.5, 2, 2.5, 3
  assert.deepEqual(clicks.map((c) => c.t), [1, 1.5, 2, 2.5, 3]);
  // ketukan ke-i beraksen bila (i - fase) habis dibagi meter; fase 1 -> indeks 1, 5, 9 -> hanya t=2.5 dalam jendela
  assert.deepEqual(clicks.map((c) => c.accent), [false, false, false, true, false]);
  assert.deepEqual(metronomeClicks(beats, 4, 0, 1, 3.1).map((c) => c.accent), [false, false, true, false, false]); // indeks 4 -> t=2
});

test('nearestBeat: terdekat, dengan batas jarak', () => {
  const beats = [1, 2, 3.5];
  assert.equal(nearestBeat(beats, 2.4), 2);
  assert.equal(nearestBeat(beats, 2.8), 3.5);
  assert.equal(nearestBeat(beats, 0), 1);
  assert.equal(nearestBeat(beats, 10), 3.5);
  assert.equal(nearestBeat(beats, 10, 1), null);
  assert.equal(nearestBeat([], 1), null);
});
