import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barLines, isChordOnly, layoutSheet, needsTime, nextUnsynced, parseLyrics, placeChords, pruneTimes, resolveTimes, sheetToText,
} from '../web/js/sheet-logic.js';
import { transposeChord } from '../web/js/transpose.js';

// Lirik dari lembar contoh pengguna ("Ya Tuhan tiap jam"), lengkap dengan judul bagian
const LYRICS = `Intro

Verse 1
Ya Tuhan tiap jam
Ku memerlukanMu
Engkaulah yang memb'ri
Sejahtera penuh.

Chorus
Setiap jam ya Tuhan
Dikau kuperlukan
Ku datang Jurus'lamat
Berkati-lah.

Instrumen

Verse 2
Ya Tuhan, tiap jam,
Di suka-dukaku
Jikalau Tuhan jauh,
Percuma hidupku.`;

// ---------- parseLyrics ----------

test('parseLyrics: judul bagian dan baris lirik dari lembar contoh', () => {
  const items = parseLyrics(LYRICS);
  assert.deepEqual(items.map((i) => i.type === 'section' ? `#${i.name}` : i.text), [
    '#Intro', '#Verse 1', 'Ya Tuhan tiap jam', 'Ku memerlukanMu', "Engkaulah yang memb'ri", 'Sejahtera penuh.',
    '#Chorus', 'Setiap jam ya Tuhan', 'Dikau kuperlukan', "Ku datang Jurus'lamat", 'Berkati-lah.',
    '#Instrumen', '#Verse 2', 'Ya Tuhan, tiap jam,', 'Di suka-dukaku', 'Jikalau Tuhan jauh,', 'Percuma hidupku.',
  ]);
});

test('parseLyrics: variasi penulisan judul, baris kosong, dan spasi', () => {
  const items = parseLyrics('  [bridge]  \nverse   2:\nreff\nBait 3.\n\n\n   satu   dua  \nBridge ke atas nama-Mu');
  assert.deepEqual(items.map((i) => i.type === 'section' ? `#${i.name}` : i.text),
    ['#Bridge', '#Verse 2', '#Reff', '#Bait 3', 'satu dua', 'Bridge ke atas nama-Mu']); // kalimat berawalan kata judul tetap lirik
  assert.deepEqual(parseLyrics(''), []);
  assert.deepEqual(parseLyrics(null), []);
});

test('parseLyrics: key stabil dan unik untuk baris yang berulang', () => {
  const items = parseLyrics('Chorus\nHalleluya\nHalleluya\nVerse 1\nHalleluya');
  const keys = items.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(items[1].key, 'l|Halleluya|0');
  assert.equal(items[2].key, 'l|Halleluya|1');
  assert.equal(items[4].key, 'l|Halleluya|2');
  assert.deepEqual(parseLyrics('Chorus\nHalleluya\nHalleluya').map((i) => i.key), keys.slice(0, 3)); // menambah baris di akhir tidak mengubah key awal
});

test('bagian tanpa lirik = bagian chord; waktu dibutuhkan untuk baris dan bagian chord saja', () => {
  const items = parseLyrics(LYRICS);
  const chordOnly = items.filter((_, i) => isChordOnly(items, i)).map((i) => i.name);
  assert.deepEqual(chordOnly, ['Intro', 'Instrumen']);
  assert.equal(items.filter((_, i) => needsTime(items, i)).length, 2 + 12); // 2 bagian chord + 12 baris
  assert.ok(!needsTime(items, 1)); // "Verse 1" mengikuti waktu baris pertamanya
});

test('resolveTimes dan nextUnsynced', () => {
  const items = parseLyrics('Intro\nVerse 1\nsatu\ndua');
  assert.equal(nextUnsynced(items, {}), 0); // Intro dulu
  const times = { 's|Intro|0': 0, 'l|satu|0': 10 };
  const r = resolveTimes(items, times);
  assert.deepEqual(r.map((i) => i.t), [0, 10, 10, undefined]); // judul Verse 1 ikut baris pertamanya
  assert.equal(nextUnsynced(items, times), 3);
  assert.equal(nextUnsynced(items, { ...times, 'l|dua|0': 14 }), -1);
  assert.equal(resolveTimes(items, { 's|Intro|0': NaN })[0].t, undefined);
});

// ---------- penempatan chord ----------

test('placeChords: chord pertama di awal baris, berikutnya di kata terdekat menurut waktu', () => {
  const text = 'Ya Tuhan tiap jam'; // kata mulai di 0, 3, 9, 14
  const r = placeChords(text, [{ label: 'F', t: 8 }, { label: 'Bb', t: 10.5 }], 8, 12);
  assert.equal(r.chordLine, 'F        Bb');
  assert.deepEqual(r.placed.map((p) => p.pos), [0, 9]);
});

test('placeChords: tidak saling menimpa; mendorong ke kanan dengan sisa satu spasi', () => {
  const r = placeChords('Ya Tuhan', [{ label: 'Cmaj7', t: 0 }, { label: 'G', t: 0.4 }, { label: 'Am7', t: 0.5 }], 0, 4);
  assert.deepEqual(r.placed.map((p) => p.pos), [0, 6, 8]);
  assert.equal(r.chordLine, 'Cmaj7 G Am7');
});

test('placeChords: label dilewatkan lewat show() (transpose) dan baris tanpa chord kosong', () => {
  const show = (l) => transposeChord(l, 3, 'flat');
  assert.equal(placeChords('Halleluya', [{ label: 'D', t: 0 }], 0, 4, show).chordLine, 'F');
  assert.equal(placeChords('Halleluya', [], 0, 4).chordLine, '');
  assert.equal(placeChords('', [{ label: 'C', t: 0 }], 0, 4).chordLine, 'C'); // teks kosong tidak error
  // rentang terlalu pendek: semua di awal, tetap tidak menimpa
  assert.equal(placeChords('Hai', [{ label: 'C', t: 0 }, { label: 'G', t: 0.1 }], 0, 0.15).chordLine, 'C G');
});

test('barLines: empat chord per baris', () => {
  const c = (l) => ({ label: l });
  assert.deepEqual(barLines(['Bb', 'F', 'Gm', 'F', 'Eb', 'Bb'].map(c)), ['| Bb  F  Gm  F |', '| Eb  Bb |']);
  assert.deepEqual(barLines([]), []);
});

// ---------- lembar utuh ----------

function songFixture() {
  const items = resolveTimes(parseLyrics('Intro\nVerse 1\nYa Tuhan tiap jam\nKu memerlukanMu\nChorus\nSetiap jam ya Tuhan\nInstrumen'), {
    's|Intro|0': 0, 'l|Ya Tuhan tiap jam|0': 8, 'l|Ku memerlukanMu|0': 12, 'l|Setiap jam ya Tuhan|0': 16, 's|Instrumen|0': 20,
  });
  const segs = [
    { start: 0, end: 2, label: 'Bb' }, { start: 2, end: 4, label: 'F' }, { start: 4, end: 6, label: 'Gm' }, { start: 6, end: 8, label: 'F' },
    { start: 8, end: 10.5, label: 'F' }, { start: 10.5, end: 13, label: 'Bb' }, // ke baris 2 sebagai chord yang sedang berbunyi
    { start: 13, end: 15.8, label: 'F' },
    { start: 15.8, end: 18, label: 'C' }, // mulai 0.2 dtk sebelum baris 3: antisipasi
    { start: 18, end: 19, label: 'N' }, { start: 19, end: 20, label: 'F' }, // baris 3: C, lalu hening, lalu F (<0.35 dtk dari akhir? tidak: 1 dtk)
    { start: 20, end: 22, label: 'Eb' }, { start: 22, end: 24, label: 'Bb' }, { start: 24, end: 26, label: 'Csus4' }, { start: 26, end: 28, label: 'C' },
  ];
  return { items, segs };
}

test('layoutSheet: urutan blok, bagian chord, penempatan, antisipasi, dan hening', () => {
  const { items, segs } = songFixture();
  const blocks = layoutSheet(items, segs, { endTime: 28 });
  assert.deepEqual(blocks.map((b) => b.kind), ['section', 'bars', 'section', 'lyric', 'lyric', 'section', 'lyric', 'section', 'bars']);
  assert.deepEqual(blocks[1].lines, ['| Bb  F  Gm  F |']); // Intro 0..8
  assert.equal(blocks[3].text, 'Ya Tuhan tiap jam');
  assert.equal(blocks[3].chordLine, 'F        Bb'); // F di awal, Bb (10.5) di "tiap"
  assert.equal(blocks[4].chordLine, 'Bb F'); // Bb masih berbunyi saat baris mulai, F di 13 -> kata kedua; C (15.8) = antisipasi, tidak tampil di sini
  // baris 3 "Setiap jam ya Tuhan" (16..20): C aktif di awal, N dilewati, F di detik 19 -> 3/4 baris = indeks 14, awal kata "Tuhan"
  assert.equal(blocks[6].chordLine, 'C' + ' '.repeat(13) + 'F');
  assert.deepEqual(blocks[8].lines, ['| Eb  Bb  Csus4  C |']); // Instrumen 20..akhir
});

test('layoutSheet: batas segmen yang meleset puluhan milidetik tidak membuat chord tetangga bocor', () => {
  // Kegagalan nyata: deteksi menaruh batas chord ~0.03-0.05 dtk dari waktu sebenarnya, sehingga chord sebelumnya
  // ikut tampil di awal baris/bagian berikutnya (mis. Intro 'C G Am' padahal hanya C dan G).
  const { items, segs } = songFixture();
  const exact = layoutSheet(items, segs, { endTime: 28 });
  const jittered = segs.map((s) => ({ ...s }));
  for (let i = 0; i < jittered.length - 1; i++) {
    const d = i % 2 ? -0.04 : 0.04; // batas antar segmen digeser bergantian maju/mundur
    jittered[i].end += d;
    jittered[i + 1].start += d;
  }
  assert.deepEqual(layoutSheet(items, jittered, { endTime: 28 }), exact);
});

test('layoutSheet: transpose lewat show(), dan chord yang sama berturut-turut digabung', () => {
  const { items, segs } = songFixture();
  segs.splice(4, 0, { start: 8, end: 8.5, label: 'F' }); // pecahan segmen berlabel sama
  segs[5] = { start: 8.5, end: 10.5, label: 'F' };
  const show = (l) => transposeChord(l, 2, 'sharp');
  const blocks = layoutSheet(items, segs, { endTime: 28, show });
  assert.deepEqual(blocks[1].lines, ['| C  G  Am  G |'].map((s) => s)); // Bb F Gm F +2
  assert.equal(blocks[3].chordLine, 'G        C'); // tidak ada 'G G' ganda
});

test('layoutSheet: baris yang belum disinkron tetap tampil tanpa chord; batas akhir melewati item yang belum bertanda', () => {
  const items = resolveTimes(parseLyrics('Verse 1\nsatu dua\ntiga empat\nlima enam'), { 'l|satu dua|0': 0, 'l|lima enam|0': 8 });
  const segs = [{ start: 0, end: 4, label: 'C' }, { start: 4, end: 8, label: 'G' }, { start: 8, end: 12, label: 'Am' }];
  const blocks = layoutSheet(items, segs, { endTime: 12 });
  // "satu dua" mencakup 0..8 karena "tiga empat" belum bertanda; G di detik 4 = tengah baris (indeks 4) -> awal kata terdekat, "dua" (indeks 5)
  assert.equal(blocks[1].chordLine, 'C    G');
  assert.equal(blocks[2].synced, false);
  assert.equal(blocks[2].chordLine, '');
  assert.equal(blocks[3].chordLine, 'Am');
});

test('layoutSheet: bagian chord yang belum disinkron kosong; tanpa chord sama sekali tidak error', () => {
  const items = resolveTimes(parseLyrics('Intro\nVerse 1\nsatu'), {});
  const blocks = layoutSheet(items, []);
  assert.equal(blocks[1].synced, false);
  assert.deepEqual(blocks[1].lines, []);
  assert.doesNotThrow(() => layoutSheet([], []));
});

test('layoutSheet: waktu tidak berurutan (salah ketuk) tidak membuat rentang negatif atau crash', () => {
  const items = resolveTimes(parseLyrics('satu\ndua\ntiga'), { 'l|satu|0': 10, 'l|dua|0': 4, 'l|tiga|0': 12 });
  const segs = [{ start: 0, end: 14, label: 'C' }];
  const blocks = layoutSheet(items, segs, { endTime: 14 });
  assert.equal(blocks.length, 3);
  assert.ok(blocks.every((b) => typeof b.chordLine === 'string'));
});

test('sheetToText: judul, Key, bagian, dan baris chord/lirik', () => {
  const { items, segs } = songFixture();
  const text = sheetToText(layoutSheet(items, segs, { endTime: 28 }), { title: 'Ya Tuhan Tiap Jam', keyText: 'Key: F' });
  assert.equal(text.split('\n').slice(0, 9).join('\n'), [
    'Ya Tuhan Tiap Jam', 'Key: F', '', '[Intro]', '| Bb  F  Gm  F |', '', '[Verse 1]', 'F        Bb', 'Ya Tuhan tiap jam',
  ].join('\n'));
  assert.ok(text.endsWith('\n') && !text.includes('\n\n\n'));
  assert.equal(sheetToText([], {}), '\n');
});

test('pruneTimes: hanya waktu yang key-nya masih ada dan valid', () => {
  const items = parseLyrics('Verse 1\nsatu\ndua');
  assert.deepEqual(pruneTimes(items, { 'l|satu|0': 3, 'l|hilang|0': 5, 'l|dua|0': NaN, 's|Verse 1|0': 1 }), { 'l|satu|0': 3, 's|Verse 1|0': 1 });
});
