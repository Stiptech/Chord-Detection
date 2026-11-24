import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_SEG, setLabelAt, replaceAll, countLabel, splitAt, mergeWith, deleteAt, moveStart, moveEnd,
  diffMarks, pickerFromLabel, labelFromPicker, History, QUALITY_OPTIONS, qualityLabel,
} from '../web/js/edit-logic.js';
import { validateSegments } from '../web/js/labels.js';

const mk = () => [
  { start: 0, end: 2, label: 'C' },
  { start: 2, end: 5, label: 'Dsus2' },
  { start: 5, end: 8, label: 'G' },
  { start: 8, end: 10, label: 'Dsus2' },
];
const frozen = (segs) => JSON.stringify(segs);

test('semua operasi tidak mengubah masukan', () => {
  const s = mk(), before = frozen(s);
  setLabelAt(s, 0, 'Am'); replaceAll(s, 'Dsus2', 'D'); splitAt(s, 1, 3); mergeWith(s, 1, 1);
  deleteAt(s, 1); moveStart(s, 1, 2.5); moveEnd(s, 1, 4.5);
  assert.equal(frozen(s), before);
});

test('setLabelAt dan replaceAll', () => {
  assert.equal(setLabelAt(mk(), 2, 'Gsus4')[2].label, 'Gsus4');
  const { segs, count } = replaceAll(mk(), 'Dsus2', 'D');
  assert.equal(count, 2);
  assert.deepEqual(segs.map((s) => s.label), ['C', 'D', 'G', 'D']);
  assert.equal(replaceAll(mk(), 'Xx', 'D').count, 0);
  assert.equal(countLabel(mk(), 'Dsus2'), 2);
  assert.throws(() => setLabelAt(mk(), 9, 'C'), /tidak ditemukan/);
});

test('splitAt: dua segmen berlabel sama, bersambung di titik pecah', () => {
  const { segs, index } = splitAt(mk(), 1, 3.5);
  assert.equal(index, 1);
  assert.deepEqual(segs.slice(1, 3), [{ start: 2, end: 3.5, label: 'Dsus2' }, { start: 3.5, end: 5, label: 'Dsus2' }]);
  assert.equal(segs.length, 5);
  // batas minimum dari tepi
  assert.throws(() => splitAt(mk(), 1, 2.05), /minimal/);
  assert.throws(() => splitAt(mk(), 1, 4.95), /minimal/);
  assert.throws(() => splitAt(mk(), 1, 7), /minimal/); // di luar segmen
  assert.doesNotThrow(() => splitAt(mk(), 1, 2 + MIN_SEG));
  assert.equal(splitAt(mk(), 1, 3.12345).segs[1].end, 3.123); // dibulatkan ke milidetik
});

test('mergeWith: memakai label segmen terpilih, menutup gap, menjaga indeks', () => {
  let r = mergeWith(mk(), 1, 1); // Dsus2 + G -> Dsus2
  assert.deepEqual(r.segs[1], { start: 2, end: 8, label: 'Dsus2' });
  assert.equal(r.index, 1);
  r = mergeWith(mk(), 2, -1); // G + Dsus2(sebelumnya) -> G
  assert.deepEqual(r.segs[1], { start: 2, end: 8, label: 'G' });
  assert.equal(r.index, 1);
  const withGap = [{ start: 0, end: 1, label: 'C' }, { start: 3, end: 4, label: 'G' }];
  assert.deepEqual(mergeWith(withGap, 0, 1).segs, [{ start: 0, end: 4, label: 'C' }]);
  assert.throws(() => mergeWith(mk(), 0, -1), /sebelumnya/);
  assert.throws(() => mergeWith(mk(), 3, 1), /berikutnya/);
});

test('deleteAt: waktu diserap tetangga; tidak boleh menghapus segmen terakhir yang tersisa', () => {
  let r = deleteAt(mk(), 2);
  assert.deepEqual(r.segs[1], { start: 2, end: 8, label: 'Dsus2' }); // diserap yang sebelumnya
  assert.equal(r.index, 1);
  r = deleteAt(mk(), 0);
  assert.deepEqual(r.segs[0], { start: 0, end: 5, label: 'Dsus2' }); // yang pertama: diserap berikutnya
  assert.equal(r.index, 0);
  assert.throws(() => deleteAt([{ start: 0, end: 1, label: 'C' }], 0), /Minimal/);
});

test('moveStart: menggeser batas bersama tetangga, dijepit oleh minimum durasi', () => {
  let s = moveStart(mk(), 1, 2.5); // batas C|Dsus2
  assert.deepEqual([s[0].end, s[1].start], [2.5, 2.5]);
  s = moveStart(mk(), 1, 0); // tidak boleh membuat C < MIN_SEG
  assert.equal(s[1].start, MIN_SEG);
  s = moveStart(mk(), 1, 99); // tidak boleh melewati ujung segmen sendiri
  assert.equal(s[1].start, 5 - MIN_SEG);
  s = moveStart(mk(), 0, -3); // segmen pertama: tidak boleh < 0
  assert.equal(s[0].start, 0);
  s = moveStart(mk(), 0, 1.5);
  assert.equal(s[0].start, 1.5);
});

test('moveEnd: batas akhir, jepitan, dan segmen terakhir dibatasi maxEnd', () => {
  let s = moveEnd(mk(), 1, 4.5);
  assert.deepEqual([s[1].end, s[2].start], [4.5, 4.5]);
  s = moveEnd(mk(), 1, 2); // < MIN_SEG dari awal
  assert.equal(s[1].end, 2 + MIN_SEG);
  s = moveEnd(mk(), 1, 99);
  assert.equal(s[1].end, 8 - MIN_SEG);
  s = moveEnd(mk(), 3, 99, 12); // terakhir, maxEnd = durasi audio
  assert.equal(s[3].end, 12);
  s = moveEnd(mk(), 3, 99); // tanpa maxEnd
  assert.equal(s[3].end, 99);
  const gap = [{ start: 0, end: 1, label: 'C' }, { start: 3, end: 4, label: 'G' }]; // ada gap: tidak menyeret tetangga
  s = moveEnd(gap, 0, 2.5);
  assert.deepEqual(s, [{ start: 0, end: 2.5, label: 'C' }, { start: 3, end: 4, label: 'G' }]);
  assert.equal(moveEnd(gap, 0, 9)[0].end, 3);
});

test('acak: 600 operasi berturut-turut selalu menghasilkan segmen yang lolos validasi', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let segs = mk();
  const labels = ['C', 'G', 'Am', 'F', 'Dsus2', 'N', 'G/B'];
  for (let n = 0; n < 600; n++) {
    const i = Math.floor(rnd() * segs.length);
    const op = Math.floor(rnd() * 7);
    try {
      if (op === 0) segs = setLabelAt(segs, i, labels[Math.floor(rnd() * labels.length)]);
      else if (op === 1) segs = splitAt(segs, i, segs[i].start + rnd() * (segs[i].end - segs[i].start)).segs;
      else if (op === 2) segs = mergeWith(segs, i, rnd() < 0.5 ? -1 : 1).segs;
      else if (op === 3) segs = deleteAt(segs, i).segs;
      else if (op === 4) segs = moveStart(segs, i, segs[i].start + (rnd() - 0.5) * 3);
      else if (op === 5) segs = moveEnd(segs, i, segs[i].end + (rnd() - 0.5) * 3, 10);
      else segs = replaceAll(segs, segs[i].label, labels[Math.floor(rnd() * labels.length)]).segs;
    } catch { continue; } // operasi yang ditolak dengan pesan jelas memang tidak mengubah apa pun
    assert.doesNotThrow(() => validateSegments(segs), `setelah operasi ${op} (langkah ${n})`);
    assert.ok(segs.every((s) => s.end - s.start >= MIN_SEG - 1e-9 || s.end - s.start > 0));
  }
  assert.ok(segs.length >= 1);
});

test('diffMarks: menandai segmen yang labelnya berbeda di titik tengah', () => {
  const auto = [{ start: 0, end: 4, label: 'C' }, { start: 4, end: 8, label: 'Dsus2' }];
  const fixed = [{ start: 0, end: 4, label: 'C' }, { start: 4, end: 6, label: 'D' }, { start: 6, end: 8, label: 'Dsus2' }];
  const d = diffMarks(auto, fixed);
  assert.deepEqual(d.a, [false, true]); // Dsus2 (4-8) hanya sebagian (4-6) yang sama -> berbeda
  assert.deepEqual(d.b, [false, true, false]); // hanya 'D' (4-6) yang tak punya padanan
  // selisih di bawah toleransi (50 ms) diabaikan
  assert.deepEqual(diffMarks([{ start: 0, end: 4, label: 'C' }], [{ start: 0.03, end: 4, label: 'C' }]), { a: [false], b: [false] });
  assert.deepEqual(diffMarks(auto, auto), { a: [false, false], b: [false, false] });
  assert.deepEqual(diffMarks([{ start: 0, end: 2, label: 'C' }], [{ start: 5, end: 6, label: 'C' }]), { a: [true], b: [true] }); // tak ada padanan
});

test('picker: label <-> bagian-bagian, termasuk slash, N, dan ejaan', () => {
  assert.deepEqual(pickerFromLabel('Dsus2'), { n: false, rootPc: 2, suffix: 'sus2', bassPc: null });
  assert.deepEqual(pickerFromLabel('G/B'), { n: false, rootPc: 7, suffix: '', bassPc: 11 });
  assert.deepEqual(pickerFromLabel('N'), { n: true });
  assert.equal(pickerFromLabel('Cxyz'), null); // jenis tak dikenal -> input manual
  assert.equal(pickerFromLabel('???'), null);
  assert.equal(labelFromPicker({ n: false, rootPc: 10, suffix: 'm7', bassPc: null }, 'flat'), 'Bbm7');
  assert.equal(labelFromPicker({ n: false, rootPc: 10, suffix: 'm7', bassPc: null }, 'sharp'), 'A#m7');
  assert.equal(labelFromPicker({ n: false, rootPc: 7, suffix: '', bassPc: 11 }), 'G/B');
  assert.equal(labelFromPicker({ n: false, rootPc: 7, suffix: '', bassPc: 7 }), 'G'); // bass = root: bukan slash
  assert.equal(labelFromPicker({ n: true }), 'N');
  for (const [l, spelling] of [['Cmaj7', 'sharp'], ['F#m7b5', 'sharp'], ['D/F#', 'sharp'], ['Eb', 'flat'], ['Cadd9', 'sharp'], ['Bb/D', 'flat']]) {
    assert.equal(labelFromPicker(pickerFromLabel(l), spelling), l);
  }
  assert.ok(QUALITY_OPTIONS.includes('') && QUALITY_OPTIONS.includes('sus2') && QUALITY_OPTIONS.includes('add9'));
  assert.equal(qualityLabel(''), 'maj');
});

test('History: undo/redo minimal 20 langkah, redo terpotong oleh perubahan baru, batas ukuran', () => {
  const h = new History(100);
  h.reset([0]);
  for (let i = 1; i <= 25; i++) h.push([i]);
  assert.equal(h.current[0], 25);
  for (let i = 24; i >= 5; i--) assert.equal(h.undo()[0], i); // 20 langkah mundur
  assert.equal(h.current[0], 5);
  assert.equal(h.redo()[0], 6);
  h.push([99]); // perubahan baru membuang redo
  assert.equal(h.canRedo, false);
  assert.equal(h.undo()[0], 6);
  const small = new History(3);
  small.reset([0]);
  for (let i = 1; i <= 10; i++) small.push([i]);
  assert.equal(small.states.length, 3);
  assert.equal(small.undo()[0], 9);
  assert.equal(small.undo()[0], 8);
  assert.equal(small.undo(), null);
  const same = [1];
  small.reset(same);
  small.push(same); // keadaan yang sama tidak menambah riwayat
  assert.equal(small.canUndo, false);
});
