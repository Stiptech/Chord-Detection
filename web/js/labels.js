// Baca/tulis .lab dan konversi notasi chord aplikasi <-> Harte. Port dari app/labels.py.
//
// Notasi aplikasi : C, Dm, Dsus2, C7, Cmaj7, Am7, Cadd9, G/B, N
// Notasi Harte    : C:maj, D:min, D:sus2, C:7, C:maj7, A:min7, C:maj(9), G:maj/3, N

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NATURAL_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// suffix aplikasi -> [kualitas Harte, interval semiton dari root]. Map (bukan object) supaya
// suffix seperti "constructor" tidak ikut terbaca dari prototype.
export const CHORD_QUALITIES = new Map([
  ['', ['maj', [0, 4, 7]]],
  ['m', ['min', [0, 3, 7]]],
  ['sus2', ['sus2', [0, 2, 7]]],
  ['sus4', ['sus4', [0, 5, 7]]],
  ['7', ['7', [0, 4, 7, 10]]],
  ['maj7', ['maj7', [0, 4, 7, 11]]],
  ['m7', ['min7', [0, 3, 7, 10]]],
  ['add9', ['maj(9)', [0, 4, 7, 2]]],
  // Tidak dideteksi baseline, tapi boleh dipakai saat koreksi manual.
  ['madd9', ['min(9)', [0, 3, 7, 2]]],
  ['dim', ['dim', [0, 3, 6]]],
  ['aug', ['aug', [0, 4, 8]]],
  ['6', ['maj6', [0, 4, 7, 9]]],
  ['m6', ['min6', [0, 3, 7, 9]]],
  ['9', ['9', [0, 4, 7, 10, 2]]],
  ['maj9', ['maj9', [0, 4, 7, 11, 2]]],
  ['m9', ['min9', [0, 3, 7, 10, 2]]],
  ['m7b5', ['hdim7', [0, 3, 6, 10]]],
  ['dim7', ['dim7', [0, 3, 6, 9]]],
]);
const HARTE_TO_SUFFIX = new Map([...CHORD_QUALITIES].map(([suffix, [harte]]) => [harte, suffix]));

const SEMITONE_TO_DEGREE = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'];
const DEGREE_TO_SEMITONE = new Map(SEMITONE_TO_DEGREE.map((d, s) => [d, s]));
DEGREE_TO_SEMITONE.set('#4', 6);

const CHORD_RE = /^([A-G])([#b]?)([^/]*)(?:\/([A-G][#b]?))?$/;

let warn = (msg) => console.warn(msg);
/** Ganti penanganan peringatan fallback (mis. untuk tes atau UI). */
export function setWarnHandler(fn) {
  warn = fn;
}

function notePc(letter, acc) {
  return (NATURAL_PC[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + 12) % 12;
}

/** Urai nama chord. strict=true menolak suffix yang tidak dikenal. Lempar Error bila tidak valid. */
export function parseChord(name, strict = true) {
  const m = CHORD_RE.exec(name.trim());
  if (!m) throw new Error(`Nama chord tidak valid: '${name}'`);
  const [, letter, acc, suffix, bass] = m;
  if (strict && !CHORD_QUALITIES.has(suffix)) throw new Error(`Jenis chord tidak dikenal: '${name}'`);
  return {
    root: letter + acc,
    rootPc: notePc(letter, acc),
    suffix,
    bass: bass ?? null,
    bassPc: bass ? notePc(bass[0], bass.slice(1)) : null,
  };
}

export function isValidChord(name) {
  if (name === 'N') return true;
  try {
    parseChord(name);
    return true;
  } catch {
    return false;
  }
}

/** Notasi aplikasi -> Harte. Chord yang tak terpetakan jatuh ke triad terdekat. */
export function appToHarte(name) {
  if (name === 'N') return 'N';
  const p = parseChord(name, false);
  let quality;
  if (CHORD_QUALITIES.has(p.suffix)) {
    quality = CHORD_QUALITIES.get(p.suffix)[0];
  } else {
    // Fallback: minor kalau diawali "m" (bukan "maj"), selain itu mayor.
    quality = p.suffix.startsWith('m') && !p.suffix.startsWith('maj') ? 'min' : 'maj';
    warn(`Chord '${name}' tidak terpetakan ke Harte, dipakai triad ${quality}`);
  }
  let out = `${p.root}:${quality}`;
  if (p.bassPc !== null && p.bassPc !== p.rootPc) {
    out += '/' + SEMITONE_TO_DEGREE[(p.bassPc - p.rootPc + 12) % 12];
  }
  return out;
}

/** Harte -> notasi aplikasi. Ekstensi yang tak dikenal dibuang (triad terdekat). */
export function harteToApp(label) {
  label = label.trim();
  if (label === 'N' || label === 'X' || label === '') return 'N';
  const slash = label.indexOf('/');
  const main = slash >= 0 ? label.slice(0, slash) : label;
  const bassDegree = slash >= 0 ? label.slice(slash + 1) : '';
  const colon = main.indexOf(':');
  const root = colon >= 0 ? main.slice(0, colon) : main;
  const quality = (colon >= 0 ? main.slice(colon + 1) : '') || 'maj';
  const m = /^([A-G])([#b]?)$/.exec(root);
  if (!m) throw new Error(`Root Harte tidak valid: '${label}'`);
  const rootPc = notePc(m[1], m[2]);

  let suffix;
  if (HARTE_TO_SUFFIX.has(quality)) {
    suffix = HARTE_TO_SUFFIX.get(quality);
  } else {
    const base = quality.split('(')[0];
    suffix = HARTE_TO_SUFFIX.has(base) ? HARTE_TO_SUFFIX.get(base) : base.startsWith('min') ? 'm' : '';
    warn(`Harte '${label}' tidak terpetakan penuh, dipakai '${root + suffix}'`);
  }

  let out = root + suffix;
  if (bassDegree) {
    if (!DEGREE_TO_SEMITONE.has(bassDegree)) throw new Error(`Derajat bass tidak valid: '${label}'`);
    const semi = DEGREE_TO_SEMITONE.get(bassDegree);
    if (semi) {
      const names = root.includes('b') || root === 'F' ? FLAT_NAMES : SHARP_NAMES;
      out += '/' + names[(rootPc + semi) % 12];
    }
  }
  return out;
}

/** Baca teks .lab: tiap baris 'start<TAB>end<TAB>chord'. Baris kosong dan '#' dilewati. */
export function parseLab(text, sourceName = 'lab') {
  const segments = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split(/\s+/);
    if (parts.length < 3) throw new Error(`${sourceName}:${i + 1}: butuh 3 kolom (start, end, chord), dapat '${line}'`);
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`${sourceName}:${i + 1}: waktu bukan angka: '${line}'`);
    if (end < start) throw new Error(`${sourceName}:${i + 1}: end < start`);
    segments.push({ start, end, label: parts[2] });
  });
  return segments;
}

/**
 * Validasi + normalisasi segmen dari UI/impor (port validate_segments di Python).
 * Waktu dibulatkan ke milidetik (sama dengan isi .lab). Gap antar segmen diperbolehkan.
 * @returns {{start:number,end:number,label:string}[]} segmen baru; lempar Error berpesan jelas bila tidak valid
 */
export function validateSegments(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Minimal harus ada 1 segmen.');
  const out = [];
  items.forEach((it, i) => {
    const n = i + 1;
    if (!Number.isFinite(it?.start) || !Number.isFinite(it?.end)) throw new Error(`Segmen ${n}: waktu harus berupa angka biasa.`);
    const start = Math.round(it.start * 1000) / 1000;
    const end = Math.round(it.end * 1000) / 1000;
    const label = String(it.label ?? '').trim();
    if (start < 0) throw new Error(`Segmen ${n}: waktu mulai tidak boleh negatif.`);
    if (end <= start) throw new Error(`Segmen ${n}: waktu akhir harus setelah waktu mulai.`);
    if (!isValidChord(label)) throw new Error(`Segmen ${n}: chord '${label}' tidak valid.`);
    if (out.length && start < out[out.length - 1].end) {
      throw new Error(`Segmen ${n}: tumpang tindih atau tidak berurutan dengan segmen sebelumnya.`);
    }
    out.push({ start, end, label });
  });
  return out;
}

export function formatLab(segments) {
  return segments.map((s) => `${s.start.toFixed(3)}\t${s.end.toFixed(3)}\t${s.label}\n`).join('');
}
