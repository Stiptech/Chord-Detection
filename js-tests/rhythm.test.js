import test from 'node:test';
import assert from 'node:assert/strict';
import { beatSeconds, planClicks } from '../web/js/rhythm.js';
import { snapSegments } from '../web/js/edit-logic.js';

const beatsAt = (n, iv = 1, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + i * iv);

test('planClicks: waktu bunyi memperhitungkan kecepatan putar dan jam AudioContext', () => {
  const beats = beatsAt(10, 1, 0);
  const plan = planClicks({ beats, meter: 4, phase: 0, from: 2.0, to: 4.5, mediaNow: 2.0, rate: 0.5, ctxNow: 100 });
  assert.deepEqual(plan.map((p) => p.t), [2, 3, 4]);
  assert.deepEqual(plan.map((p) => p.when), [100, 102, 104]); // 1 dtk lagu = 2 dtk nyata pada 0.5x
  assert.deepEqual(plan.map((p) => p.accent), [false, false, true]); // indeks 4 adalah downbeat (t=4)
  assert.deepEqual(planClicks({ beats, meter: 4, phase: 0, from: 20, to: 30, mediaNow: 20, rate: 1, ctxNow: 0 }), []);
});

test('planClicks: jendela berurutan tidak menggandakan atau melewatkan klik', () => {
  const beats = beatsAt(40, 0.5, 0);
  const got = [];
  let next = 0;
  for (let now = 0; now < 19; now += 0.13) { // tick tak selaras dengan ketukan
    const to = now + 0.25;
    got.push(...planClicks({ beats, meter: 4, phase: 0, from: Math.max(next, now), to, mediaNow: now, rate: 1, ctxNow: 0 }).map((p) => p.t));
    next = to;
  }
  assert.deepEqual(got, beats.filter((b) => b < next));
});

test('beatSeconds', () => {
  assert.equal(beatSeconds(120, 1), 0.5);
  assert.equal(beatSeconds(120, 0.5), 1);
  assert.ok(Number.isFinite(beatSeconds(0, 0)));
});

test('snapSegments: batas bersambung dirapatkan ke ketukan terdekat dalam jarak maksimum', () => {
  const beats = [1, 2, 3, 4, 5, 6];
  const segs = [
    { start: 0.5, end: 2.07, label: 'C' },   // -> 2
    { start: 2.07, end: 3.6, label: 'G' },   // 3.6 jauh dari 3 dan 4 (>0.15) -> tetap
    { start: 3.6, end: 5.1, label: 'Am' },   // 5.1 -> 5
    { start: 5.1, end: 6.4, label: 'F' },
  ];
  const r = snapSegments(segs, beats, 0.15);
  assert.equal(r.changed, 2);
  assert.deepEqual(r.segs.map((s) => [s.start, s.end]), [[0.5, 2], [2, 3.6], [3.6, 5], [5, 6.4]]);
  assert.equal(segs[0].end, 2.07, 'masukan tidak diubah');
});

test('snapSegments: tidak membuat segmen lebih pendek dari batas minimum; awal & akhir lagu tetap', () => {
  const beats = [1, 1.05, 2];
  const segs = [{ start: 0.97, end: 1.04, label: 'C' }, { start: 1.04, end: 2.01, label: 'G' }];
  const r = snapSegments(segs, beats, 0.15);
  assert.equal(r.changed, 0); // menggeser batas 1.04 ke 1.05 membuat C hanya 0.08 dtk
  assert.deepEqual(r.segs, segs);
  const whole = snapSegments([{ start: 0.2, end: 3.9, label: 'C' }], beats, 0.5);
  assert.deepEqual(whole.segs, [{ start: 0.2, end: 3.9, label: 'C' }]);
});

test('snapSegments: segmen yang tidak bersambung (ada celah) dibiarkan', () => {
  const segs = [{ start: 0, end: 1.9, label: 'C' }, { start: 2.1, end: 4, label: 'G' }];
  assert.equal(snapSegments(segs, [2], 0.3).changed, 0);
});

// ---------- lembar chord dengan palang birama ----------
import { barChords, buildGrid } from '../web/js/beats.js';
import { barLinesFromBars, layoutSheet, resolveTimes, parseLyrics } from '../web/js/sheet-logic.js';

const gridBars = (segs, n = 16) => barChords(buildGrid(beatsAt(n * 4 + 1, 1, 0), 4, 0), segs);
const barSegs = [
  { start: 0, end: 8, label: 'Bb' }, { start: 8, end: 12, label: 'F' }, { start: 12, end: 14, label: 'Gm' },
  { start: 14, end: 16, label: 'F' }, { start: 16, end: 64, label: 'C' },
];

test('barLinesFromBars: palang birama, chord bertahan jadi •, dua chord dalam satu birama', () => {
  const bars = gridBars(barSegs);
  assert.deepEqual(barLinesFromBars(bars, 0, 16), ['| Bb | • | F | Gm F |']);
  assert.deepEqual(barLinesFromBars(bars, 0, 20), ['| Bb | • | F | Gm F |', '| C |']);
  assert.deepEqual(barLinesFromBars(bars, 0, 4, (l) => l.replace('b', '♭')), ['| B♭ |']);
});

test('barLinesFromBars: birama pertama bagian selalu menyebut chordnya, bukan •; rentang kosong -> []', () => {
  const bars = gridBars(barSegs);
  assert.deepEqual(barLinesFromBars(bars, 4, 12), ['| Bb | F |']); // birama 2 melanjutkan Bb, tapi awal bagian
  assert.deepEqual(barLinesFromBars(bars, 1000, 2000), []);
});

test('layoutSheet: bagian tanpa lirik memakai birama sungguhan bila ada, jatuh ke 4-chord-per-baris bila tidak', () => {
  const items = resolveTimes(parseLyrics('Intro'), { 's|Intro|0': 0 }); // hanya penanda bagian
  const withBars = layoutSheet(items, barSegs, { endTime: 16, bars: gridBars(barSegs) });
  const without = layoutSheet(items, barSegs, { endTime: 16 });
  const lines = (blocks) => blocks.filter((b) => b.kind === 'bars').flatMap((b) => b.lines);
  assert.deepEqual(lines(withBars), ['| Bb | • | F | Gm F |']);
  assert.deepEqual(lines(without), ['| Bb  F  Gm  F |']);
});
