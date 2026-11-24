import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BITMAPS, CLASSES, METRICS, addEvaluation, canon, chordClass, classAccuracy, emptyEvaluation, evaluateSegments,
  mergeSegments, normalize, score, topConfusions,
} from '../web/js/evaluate.js';
import { setWarnHandler } from '../web/js/labels.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/eval-parity.json', import.meta.url), 'utf8'));
const S = (...rows) => rows.map(([start, end, label]) => ({ start, end, label }));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-7, `${msg}: ${a} != ${b}`);

// ---------- paritas dengan mir_eval ----------

test('tabel bitmap sama dengan yang dibangkitkan mir_eval', () => {
  assert.deepEqual(Object.fromEntries(BITMAPS), fixture.bitmaps);
  assert.deepEqual(METRICS, fixture.metrics);
  assert.deepEqual(CLASSES, fixture.classes);
});

test(`paritas: ${fixture.cases.length} kasus acak cocok dengan mir_eval (root, majmin, thirds, sevenths + per jenis + salah baca)`, () => {
  for (const [n, c] of fixture.cases.entries()) {
    const ev = evaluateSegments(c.ref, c.est);
    const x = c.expected;
    close(ev.seconds, x.seconds, `kasus ${n} durasi`);
    for (const m of METRICS) {
      close(ev.correct[m], x.correct[m], `kasus ${n} ${m} benar`);
      close(ev.comparable[m], x.comparable[m], `kasus ${n} ${m} terbandingkan`);
    }
    for (const k of CLASSES) {
      close(ev.clsTotal[k], x.clsTotal[k], `kasus ${n} total ${k}`);
      close(ev.clsExact[k], x.clsExact[k], `kasus ${n} persis ${k}`);
      close(ev.clsRoot[k], x.clsRoot[k], `kasus ${n} root ${k}`);
    }
    assert.equal(ev.confusions.size, x.confusions.length, `kasus ${n} jumlah salah-baca`);
    for (const [r, e, sec] of x.confusions) close(ev.confusions.get(`${r}\u0000${e}`) ?? -1, sec, `kasus ${n} ${r}->${e}`);
  }
});

test('fixture memang memuat variasi: ada metrik yang dikecualikan, kelas langka, dan acuan = mesin', () => {
  const some = (f) => fixture.cases.some(f);
  assert.ok(some((c) => c.expected.comparable.majmin < c.expected.seconds - 0.5), 'harus ada kasus majmin terkecualikan');
  assert.ok(some((c) => c.expected.clsTotal.sus > 0) && some((c) => c.expected.clsTotal.slash > 0) && some((c) => c.expected.clsTotal.add9 > 0));
  assert.ok(some((c) => JSON.stringify(c.ref) === JSON.stringify(c.est)));
  assert.ok(some((c) => c.expected.confusions.length > 5));
});

// ---------- perilaku (padanan tests/test_evaluate.py) ----------

test('label sama = skor 1; salah satu dari dua = 0.5', () => {
  const same = evaluateSegments(S([0, 2, 'C'], [2, 4, 'G'], [4, 6, 'Am7'], [6, 8, 'N']), S([0, 2, 'C'], [2, 4, 'G'], [4, 6, 'Am7'], [6, 8, 'N']));
  for (const m of METRICS) close(score(same, m), 1, m);
  const half = evaluateSegments(S([0, 4, 'C'], [4, 8, 'G']), S([0, 4, 'C'], [4, 8, 'Am']));
  for (const m of ['root', 'majmin', 'thirds']) close(score(half, m), 0.5, m);
  assert.deepEqual(topConfusions(half), [{ ref: 'G', est: 'Am', seconds: 4 }]);
});

test('sus vs mayor: thirds sama, majmin/sevenths mengecualikan acuan sus', () => {
  const ev = evaluateSegments(S([0, 4, 'Dsus2']), S([0, 4, 'D']));
  close(score(ev, 'root'), 1, 'root');
  close(score(ev, 'thirds'), 1, 'thirds');
  assert.equal(score(ev, 'majmin'), null);
  assert.equal(score(ev, 'sevenths'), null);
  assert.deepEqual(classAccuracy(ev, 'sus'), { exact: 0, root: 1, seconds: 4 });
});

test('mir_eval mengabaikan nada ke-9, akurasi persis tidak', () => {
  const ev = evaluateSegments(S([0, 4, 'Cadd9']), S([0, 4, 'C']));
  for (const m of METRICS) close(score(ev, m), 1, m);
  assert.deepEqual(classAccuracy(ev, 'add9'), { exact: 0, root: 1, seconds: 4 });
});

test('slash: G/B vs G sama untuk majmin; Am/G memicu sevenths (bass b7)', () => {
  const a = evaluateSegments(S([0, 4, 'G/B']), S([0, 4, 'G']));
  close(score(a, 'majmin'), 1, 'majmin');
  assert.deepEqual(classAccuracy(a, 'slash'), { exact: 0, root: 1, seconds: 4 });
  const b = evaluateSegments(S([0, 4, 'Am/G']), S([0, 4, 'Am']));
  close(score(b, 'majmin'), 1, 'majmin');
  close(score(b, 'sevenths'), 0, 'sevenths');
  assert.equal(b.comparable.sevenths, 4);
});

test('mesin dipotong/diisi N ke rentang acuan; celah menjadi N', () => {
  close(score(evaluateSegments(S([0, 8, 'C']), S([0, 4, 'C'])), 'root'), 0.5, 'pendek');
  const long = evaluateSegments(S([0, 4, 'C']), S([0, 4, 'C'], [4, 8, 'G']));
  close(score(long, 'root'), 1, 'panjang');
  assert.equal(long.seconds, 4);
  const gap = evaluateSegments(S([0, 2, 'C'], [4, 6, 'C']), S([0, 6, 'C']));
  close(score(gap, 'root'), 4 / 6, 'celah');
  assert.equal(gap.clsTotal.N, 2);
});

test('normalize dan mergeSegments', () => {
  assert.deepEqual(normalize(S([1, 3, 'C'], [2, 5, 'G'], [7, 9, 'F']), 0, 8),
    S([0, 1, 'N'], [1, 3, 'C'], [3, 5, 'G'], [5, 7, 'N'], [7, 8, 'F']));
  assert.deepEqual(normalize([], 0, 4), S([0, 4, 'N']));
  assert.deepEqual(mergeSegments(normalize(S([0, 4, 'C']), 0, 6), normalize(S([0, 2, 'C'], [2, 6, 'G']), 0, 6)),
    [[2, 'C', 'C'], [2, 'C', 'G'], [2, 'N', 'G']]);
});

test('ejaan enharmonik bukan kesalahan; nama baku', () => {
  const ev = evaluateSegments(S([0, 4, 'Bb'], [4, 8, 'Ebm']), S([0, 4, 'A#'], [4, 8, 'D#m']));
  for (const m of ['root', 'majmin', 'thirds']) close(score(ev, m), 1, m);
  assert.equal(ev.confusions.size, 0);
  assert.deepEqual([canon('Bb'), canon('A#'), canon('G/G'), canon('N'), canon('???')], ['A#', 'A#', 'G', 'N', '???']);
});

test('kelas chord', () => {
  const cases = { C: 'maj', Dm: 'min', Dsus2: 'sus', Gsus4: 'sus', Cadd9: 'add9', C7: 'seventh', Am7: 'seventh', Cmaj7: 'seventh', 'G/B': 'slash', 'C/C': 'maj', Cdim: 'other', C6: 'other', N: 'N', '???': 'other' };
  for (const [l, k] of Object.entries(cases)) assert.equal(chordClass(l), k, l);
});

test('rata-rata mikro: berbobot durasi, dan salah-baca dijumlahkan', () => {
  const a = evaluateSegments(S([0, 4, 'C']), S([0, 4, 'C']));
  const b = evaluateSegments(S([0, 6, 'C'], [6, 12, 'G']), S([0, 6, 'C'], [6, 12, 'D']));
  const total = addEvaluation(addEvaluation(emptyEvaluation(), a), b);
  close(score(total, 'root'), 10 / 16, 'root');
  assert.equal(total.seconds, 16);
  assert.deepEqual(topConfusions(total, 5), [{ ref: 'G', est: 'D', seconds: 6 }]);
});

test('acuan kosong ditolak; sufiks tak dikenal jatuh ke triad (paritas dengan app_to_harte)', () => {
  assert.throws(() => evaluateSegments([], S([0, 1, 'C'])), /acuan/);
  setWarnHandler(() => {});
  const ev = evaluateSegments(S([0, 4, 'Cm13']), S([0, 4, 'Cm']));
  close(score(ev, 'majmin'), 1, 'm13 diperlakukan sebagai minor');
  setWarnHandler((m) => console.warn(m));
});

test('topConfusions menyembunyikan selisih batas < 0.1 dtk', () => {
  const ev = evaluateSegments(S([0, 3, 'C'], [3, 6, 'G']), S([0, 3.04, 'C'], [3.04, 6, 'D']));
  // mesin menganggap C sampai 3.04: G->C hanya 0.04 dtk (selisih batas); G->D 2.96 dtk (salah baca sungguhan)
  const all = [...ev.confusions.values()].sort((a, b) => a - b);
  assert.ok(all[0] < 0.1, 'harus ada selisih kecil');
  assert.ok(topConfusions(ev).every((c) => c.seconds >= 0.1));
  assert.deepEqual(topConfusions(ev).map((c) => `${c.ref}>${c.est}`), ['G>D']);
  assert.equal(topConfusions(ev, 15, 0).length, all.length); // minSeconds=0 menampilkan semuanya
});
