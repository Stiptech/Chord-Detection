// Transpose chord, ejaan sharp/flat yang konsisten, dan tebakan key. Hanya mengubah nama yang DITAMPILKAN.
import { CHORD_QUALITIES, SHARP_NAMES, FLAT_NAMES, parseChord } from './labels.js';

// Tonik mayor/minor yang lazimnya ditulis dengan flat (F, Bb, Eb, Ab, Db / Dm, Gm, Cm, Fm, Bbm).
const FLAT_MAJOR_TONICS = new Set([5, 10, 3, 8, 1]);
const FLAT_MINOR_TONICS = new Set([2, 7, 0, 5, 10]);

export function noteName(pc, spelling = 'sharp') {
  return (spelling === 'flat' ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
}

/** Ejaan yang dipakai untuk sebuah key: key berflat -> 'flat', selain itu 'sharp'. */
export function spellingForKey(tonicPc, mode = 'major') {
  const flats = mode === 'minor' ? FLAT_MINOR_TONICS : FLAT_MAJOR_TONICS;
  return flats.has(((tonicPc % 12) + 12) % 12) ? 'flat' : 'sharp';
}

/**
 * Geser chord sebanyak `semitones` dan tulis ulang dengan ejaan `spelling`.
 * 'N' dan nama yang tak bisa diurai dikembalikan apa adanya.
 */
export function transposeChord(label, semitones, spelling = 'sharp') {
  if (label === 'N') return 'N';
  let p;
  try {
    p = parseChord(label, false);
  } catch {
    return label;
  }
  const bass = p.bassPc !== null ? '/' + noteName(p.bassPc + semitones, spelling) : '';
  return noteName(p.rootPc + semitones, spelling) + p.suffix + bass;
}

// Profil Krumhansl-Kessler (kekuatan tiap pitch class terhadap tonik).
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Tebak key dari chord yang berbunyi: histogram nada chord (root dihitung dobel, dibobot durasi)
 * dicocokkan dengan profil Krumhansl-Kessler. Hasil hanya tebakan; pengguna bisa mengoreksi.
 * @returns {{tonicPc:number, mode:'major'|'minor', score:number}|null}
 */
export function estimateKey(segments) {
  const hist = new Array(12).fill(0);
  let total = 0;
  for (const s of segments) {
    if (s.label === 'N') continue;
    let p;
    try { p = parseChord(s.label, false); } catch { continue; }
    const intervals = (CHORD_QUALITIES.get(p.suffix) ?? CHORD_QUALITIES.get(''))[1];
    const dur = Math.max(0, s.end - s.start);
    intervals.forEach((iv, i) => { hist[(p.rootPc + iv) % 12] += dur * (i === 0 ? 2 : 1); });
    total += dur;
  }
  if (!total) return null;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', KK_MAJOR], ['minor', KK_MINOR]]) {
      const rotated = profile.map((_, pc) => profile[(pc - tonic + 12) % 12]);
      const score = correlation(hist, rotated);
      if (!best || score > best.score) best = { tonicPc: tonic, mode, score };
    }
  }
  return best;
}

/** Nama key untuk ditampilkan: "F" atau "Dm". */
export function keyName(tonicPc, mode, spelling) {
  return noteName(tonicPc, spelling) + (mode === 'minor' ? 'm' : '');
}
