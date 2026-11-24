// Padanan tests/test_labels.py
import test from 'node:test';
import assert from 'node:assert/strict';
import { appToHarte, harteToApp, isValidChord, parseChord, parseLab, formatLab, setWarnHandler } from '../web/js/labels.js';

const HARTE_PAIRS = [
  ['C', 'C:maj'], ['Dm', 'D:min'], ['Dsus2', 'D:sus2'], ['Dsus4', 'D:sus4'],
  ['C7', 'C:7'], ['Cmaj7', 'C:maj7'], ['Am7', 'A:min7'], ['Cadd9', 'C:maj(9)'],
  ['G/B', 'G:maj/3'], ['D/F#', 'D:maj/3'], ['C/E', 'C:maj/3'], ['Am/G', 'A:min/b7'],
  ['Bb', 'Bb:maj'], ['Ebmaj7/D', 'Eb:maj7/7'], ['N', 'N'],
];

test('app -> Harte', () => {
  for (const [app, harte] of HARTE_PAIRS) assert.equal(appToHarte(app), harte, app);
});

test('Harte -> app', () => {
  for (const [app, harte] of HARTE_PAIRS) assert.equal(harteToApp(harte), app, harte);
});

test('slash dengan bass = root dianggap chord biasa', () => {
  assert.equal(appToHarte('C/C'), 'C:maj');
});

test('chord tak terpetakan jatuh ke triad dan dicatat', () => {
  const warnings = [];
  setWarnHandler((m) => warnings.push(m));
  assert.equal(appToHarte('Cm13'), 'C:min');
  assert.equal(appToHarte('C13'), 'C:maj');
  assert.equal(harteToApp('C:min7(b9)'), 'Cm7');
  assert.equal(harteToApp('C:minmaj7'), 'Cm');
  assert.equal(warnings.length, 4);
  setWarnHandler((m) => console.warn(m));
});

test('validasi chord', () => {
  for (const ok of ['C', 'C#m7', 'Bbmaj7', 'G/B', 'Dsus2', 'N', 'Cadd9']) assert.ok(isValidChord(ok), ok);
  for (const bad of ['', 'H', 'Cxyz', 'C/H', 'c', 'C//E', 'Cconstructor']) assert.ok(!isValidChord(bad), bad);
});

test('parseChord pitch class', () => {
  const p = parseChord('Bb/D');
  assert.deepEqual([p.rootPc, p.suffix, p.bassPc], [10, '', 2]);
  assert.equal(parseChord('C#m').rootPc, 1);
});

test('.lab roundtrip dan tab sebagai pemisah', () => {
  const segs = [{ start: 0, end: 1.5, label: 'C' }, { start: 1.5, end: 3.25, label: 'G/B' }, { start: 3.25, end: 4, label: 'N' }];
  const text = formatLab(segs);
  assert.equal(text.split('\n')[1], '1.500\t3.250\tG/B');
  assert.deepEqual(parseLab(text), segs);
});

test('.lab: baris kosong, komentar, CRLF dilewati/diterima', () => {
  const segs = parseLab('# komentar\r\n\r\n0.0 1.0 C\r\n1.0\t2.0\tAm7\r\n');
  assert.deepEqual(segs.map((s) => s.label), ['C', 'Am7']);
});

test('.lab: baris rusak ditolak', () => {
  for (const bad of ['0.0 1.0\n', 'a b C\n', '2.0 1.0 C\n']) assert.throws(() => parseLab(bad), Error, bad);
});
