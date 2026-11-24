import test from 'node:test';
import assert from 'node:assert/strict';
import { transposeChord, spellingForKey, estimateKey, keyName, noteName } from '../web/js/transpose.js';
import { findSegmentIndex, nextChordIndex, loopJump, fmtTime, clamp } from '../web/js/player-logic.js';
import { createApi } from '../web/js/api.js';

// ---------- transpose ----------

test('transposeChord: root, kualitas, dan slash bass ikut bergeser', () => {
  assert.equal(transposeChord('F', 2), 'G');
  assert.equal(transposeChord('Bb', -1), 'A');
  assert.equal(transposeChord('Csus4', 7), 'Gsus4');
  assert.equal(transposeChord('G/B', 2), 'A/C#');
  assert.equal(transposeChord('C7/E', 5, 'flat'), 'F7/A');
  assert.equal(transposeChord('Ebmaj7/D', 3, 'flat'), 'Gbmaj7/F');
  assert.equal(transposeChord('B', 1), 'C'); // melewati batas oktaf
  assert.equal(transposeChord('C', -1), 'B');
});

test('transposeChord: ejaan konsisten dan penggeseran 0 menormalkan ejaan', () => {
  assert.equal(transposeChord('C#m7', 1, 'flat'), 'Dm7');
  assert.equal(transposeChord('C', 1, 'sharp'), 'C#');
  assert.equal(transposeChord('C', 1, 'flat'), 'Db');
  assert.equal(transposeChord('A#', 0, 'flat'), 'Bb'); // detector menulis sharp; key berflat menampilkan flat
  assert.equal(noteName(13, 'sharp'), 'C#'); // pc dinormalkan modulo 12
  assert.equal(noteName(-1, 'sharp'), 'B');
});

test('transposeChord: N dan nama aneh tidak diubah', () => {
  assert.equal(transposeChord('N', 5), 'N');
  assert.equal(transposeChord('???', 5), '???');
  assert.equal(transposeChord('Cm13', 2), 'Dm13'); // suffix tak dikenal tetap dibawa
});

test('transposeChord: bolak-balik 12 semiton kembali ke chord semula', () => {
  for (const c of ['C', 'F#m7', 'Bbmaj7', 'G/B', 'Dsus2', 'E7']) {
    const sp = c.includes('b') ? 'flat' : 'sharp';
    assert.equal(transposeChord(transposeChord(c, 7, sp), -7, sp), c);
  }
});

test('spellingForKey: key berflat -> flat, selain itu sharp', () => {
  assert.equal(spellingForKey(5, 'major'), 'flat'); // F
  assert.equal(spellingForKey(10, 'major'), 'flat'); // Bb
  assert.equal(spellingForKey(7, 'major'), 'sharp'); // G
  assert.equal(spellingForKey(2, 'minor'), 'flat'); // Dm
  assert.equal(spellingForKey(9, 'minor'), 'sharp'); // Am
  assert.equal(spellingForKey(12 + 5, 'major'), 'flat'); // dinormalkan
});

// ---------- tebak key ----------

const seq = (labels, dur = 2) => labels.map((label, i) => ({ start: i * dur, end: (i + 1) * dur, label }));

test('estimateKey: lagu contoh pengguna (Ya Tuhan tiap jam) = F mayor', () => {
  const labels = ['Bb', 'F', 'Gm', 'F', 'Eb', 'Bb', 'C', 'F',
    'F', 'Bb', 'F', 'C', 'F', 'G', 'C', 'Dm', 'C',
    'F', 'C7', 'C', 'F', 'Bb', 'F', 'C7', 'F',
    'Eb', 'Bb', 'Csus4', 'C',
    'F', 'C7', 'F', 'F/A', 'Bb', 'F', 'C7/E', 'F', 'C/G', 'G7', 'C'];
  const key = estimateKey(seq(labels));
  assert.deepEqual([key.tonicPc, key.mode], [5, 'major']);
  assert.equal(keyName(key.tonicPc, key.mode, spellingForKey(key.tonicPc, key.mode)), 'F');
});

test('estimateKey: contoh mayor dan minor yang jelas', () => {
  const g = estimateKey(seq(['G', 'D', 'Em', 'C', 'G', 'D', 'C', 'G']));
  assert.deepEqual([g.tonicPc, g.mode], [7, 'major']);
  const dm = estimateKey(seq(['Dm', 'Gm', 'A7', 'Dm', 'Bb', 'A', 'Dm']));
  assert.deepEqual([dm.tonicPc, dm.mode], [2, 'minor']);
  assert.equal(keyName(2, 'minor', 'flat'), 'Dm');
});

test('estimateKey: tanpa chord (kosong / hanya N) -> null', () => {
  assert.equal(estimateKey([]), null);
  assert.equal(estimateKey([{ start: 0, end: 5, label: 'N' }]), null);
});

// ---------- logika pemutar ----------

const segs = [
  { start: 0, end: 2, label: 'C' }, { start: 2, end: 4, label: 'N' },
  { start: 5, end: 7, label: 'G' }, { start: 7, end: 9, label: 'Am' },
];

test('findSegmentIndex: di dalam, batas, gap, sebelum, dan setelah akhir', () => {
  assert.equal(findSegmentIndex(segs, 0), 0);
  assert.equal(findSegmentIndex(segs, 1.99), 0);
  assert.equal(findSegmentIndex(segs, 2), 1); // batas = segmen berikutnya
  assert.equal(findSegmentIndex(segs, 4.5), -1); // gap
  assert.equal(findSegmentIndex(segs, 5), 2);
  assert.equal(findSegmentIndex(segs, 8.5), 3);
  assert.equal(findSegmentIndex(segs, 9.03), 3); // toleransi di ujung terakhir
  assert.equal(findSegmentIndex(segs, 9.5), -1);
  assert.equal(findSegmentIndex(segs, -1), -1);
  assert.equal(findSegmentIndex([], 1), -1);
});

test('nextChordIndex: melewati N, menangani gap dan akhir lagu', () => {
  assert.equal(nextChordIndex(segs, 1), 2); // setelah C: N dilewati -> G
  assert.equal(nextChordIndex(segs, 3), 2); // sedang di N
  assert.equal(nextChordIndex(segs, 4.5), 2); // di gap
  assert.equal(nextChordIndex(segs, 6), 3);
  assert.equal(nextChordIndex(segs, 8), -1); // chord terakhir
});

test('loopJump: lompat ke A hanya saat t melewati B', () => {
  const loop = { a: 10, b: 20 };
  assert.equal(loopJump(19.9, loop), null);
  assert.equal(loopJump(20, loop), 10);
  assert.equal(loopJump(25, loop), 10);
  assert.equal(loopJump(25, null), null);
  assert.equal(loopJump(25, { a: 20, b: 20 }), null); // loop tak valid diabaikan
  assert.equal(loopJump(25, { a: 30, b: 20 }), null);
});

test('fmtTime dan clamp', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(65.9), '1:05');
  assert.equal(fmtTime(NaN), '0:00');
  assert.equal(fmtTime(-3), '0:00');
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(-5, 0, 10), 0);
});

// ---------- api.getSong ----------

test('getSong: mengembalikan baris atau null bila tidak ada', async () => {
  const sbWith = (data) => ({
    from: () => new Proxy({}, { get: (_, p) => (p === 'then' ? (r) => r({ data, error: null }) : () => sbWith(data).from()) }),
  });
  assert.deepEqual(await createApi(sbWith({ id: 's1', name: 'A' })).getSong('s1'), { id: 's1', name: 'A' });
  assert.equal(await createApi(sbWith(null)).getSong('x'), null);
});
