// Evaluasi: label mesin vs label koreksi (acuan). Port dari app/evaluate.py; hasilnya dibuktikan sama dengan
// mir_eval lewat js-tests/evaluate.test.js (fixture dibangkitkan oleh scripts/make_eval_fixture.py).
//
// Empat skor standar (berbobot durasi): root, majmin, thirds, sevenths. PENTING: mir_eval mengabaikan nada ke-9,
// jadi add9 = mayor, 9 = 7, maj9 = maj7, m9 = m7, madd9 = minor. Karena itu ada juga akurasi "persis sama" per
// jenis chord dan daftar salah-baca yang membedakan chord sampai ke sufiksnya.
// Rentang evaluasi = rentang acuan; mesin dipotong/diisi 'N'; celah di kedua sisi diisi 'N'.
import { parseChord, SHARP_NAMES } from './labels.js';

export const METRICS = ['root', 'majmin', 'thirds', 'sevenths'];
export const CLASSES = ['maj', 'min', 'sus', 'add9', 'seventh', 'slash', 'other', 'N'];
export const CLASS_NAMES = {
  maj: 'Mayor', min: 'Minor', sus: 'sus2 / sus4', add9: 'add9', seventh: '7th (7, maj7, m7, …)',
  slash: 'Slash (G/B)', other: 'Lainnya (dim, aug, 6)', N: 'Tanpa chord (N)',
};
const SEVENTH_SUFFIXES = new Set(['7', 'maj7', 'm7', '9', 'maj9', 'm9', 'm7b5', 'dim7']);
const EPS = 1e-9;

// Bitmap 12 nada relatif ke root untuk tiap sufiks aplikasi, persis seperti mir_eval.chord.encode
// (tanpa mereduksi chord extended, sehingga 9 tidak muncul). Diverifikasi oleh tes paritas.
export const BITMAPS = new Map(Object.entries({
  '': '100010010000', m: '100100010000', sus2: '101000010000', sus4: '100001010000',
  7: '100010010010', maj7: '100010010001', m7: '100100010010', add9: '100010010000',
  madd9: '100100010000', dim: '100100100000', aug: '100010001000', 6: '100010010100',
  m6: '100100010100', 9: '100010010010', maj9: '100010010001', m9: '100100010010',
  m7b5: '100100100010', dim7: '100100100100',
}));
const bitsOf = (s) => Array.from(s, Number);
const MAJ8 = bitsOf(BITMAPS.get('')).slice(0, 8).join('');
const MIN8 = bitsOf(BITMAPS.get('m')).slice(0, 8).join('');
const SEVENTH_VALID = new Set(['', 'm', 'maj7', '7', 'm7'].map((q) => BITMAPS.get(q)).concat(['000000000000']));

// ---------- label ----------

export function chordClass(label) {
  if (label === 'N') return 'N';
  let p;
  try { p = parseChord(label, false); } catch { return 'other'; }
  if (p.bassPc !== null && p.bassPc !== p.rootPc) return 'slash';
  const s = p.suffix;
  if (s === '') return 'maj';
  if (s === 'm') return 'min';
  if (s === 'sus2' || s === 'sus4') return 'sus';
  if (s === 'add9' || s === 'madd9') return 'add9';
  if (SEVENTH_SUFFIXES.has(s)) return 'seventh';
  return 'other';
}

/** Nama baku (ejaan sharp; slash dengan bass = root dibuang) supaya Bb dan A# dianggap sama. */
export function canon(label) {
  if (label === 'N') return 'N';
  let p;
  try { p = parseChord(label, false); } catch { return label; }
  const bass = p.bassPc !== null && p.bassPc !== p.rootPc ? '/' + SHARP_NAMES[p.bassPc] : '';
  return SHARP_NAMES[p.rootPc] + p.suffix + bass;
}

function rootPc(label) {
  if (label === 'N') return null;
  try { return parseChord(label, false).rootPc; } catch { return null; }
}

/** {root, bits:string12}. Sufiks tak dikenal jatuh ke triad (minor bila diawali "m" bukan "maj"), seperti app_to_harte. */
function encode(label) {
  if (label === 'N') return { root: -1, bits: '000000000000' };
  const p = parseChord(label, false);
  let bm = BITMAPS.get(p.suffix);
  if (bm === undefined) bm = p.suffix.startsWith('m') && !p.suffix.startsWith('maj') ? BITMAPS.get('m') : BITMAPS.get('');
  const bits = bitsOf(bm);
  if (p.bassPc !== null) bits[(p.bassPc - p.rootPc + 12) % 12] = 1;
  return { root: p.rootPc, bits: bits.join('') };
}

/** Nilai perbandingan: 1 benar, 0 salah, -1 dikecualikan (acuan di luar kosakata metrik itu). */
function compare(metric, ref, est) {
  const eqRoot = ref.root === est.root;
  switch (metric) {
    case 'root': return eqRoot ? 1 : 0;
    case 'thirds': return eqRoot && ref.bits[3] === est.bits[3] ? 1 : 0;
    case 'majmin': {
      const r8 = ref.bits.slice(0, 8);
      const valid = r8 === MAJ8 || r8 === MIN8 || (ref.root < 0 && /^0+$/.test(ref.bits));
      return !valid ? -1 : eqRoot && r8 === est.bits.slice(0, 8) ? 1 : 0;
    }
    case 'sevenths':
      return !SEVENTH_VALID.has(ref.bits) ? -1 : eqRoot && ref.bits === est.bits ? 1 : 0;
    default: throw new Error(`Metrik tidak dikenal: ${metric}`);
  }
}

// ---------- segmen ----------

/** Segmen berurutan yang menutupi [t0, t1] tanpa celah: dipotong ke rentang, celah diisi 'N'. */
export function normalize(segs, t0, t1) {
  const out = [];
  let cursor = t0;
  for (const s of [...segs].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = Math.max(s.start, t0, cursor);
    const end = Math.min(s.end, t1);
    if (end - start <= EPS) continue;
    if (start - cursor > EPS) out.push({ start: cursor, end: start, label: 'N' });
    out.push({ start, end, label: s.label });
    cursor = end;
  }
  if (t1 - cursor > EPS) out.push({ start: cursor, end: t1, label: 'N' });
  return out.length ? out : [{ start: t0, end: t1, label: 'N' }];
}

/** [[durasi, labelAcuan, labelMesin], ...] untuk tiap interval antar batas gabungan (keduanya sudah dinormalkan). */
export function mergeSegments(ref, est) {
  const r9 = (v) => Math.round(v * 1e9) / 1e9;
  const bounds = [...new Set([...ref, ...est].flatMap((s) => [r9(s.start), r9(s.end)]))].sort((a, b) => a - b);
  const out = [];
  let i = 0, j = 0;
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [t0, t1] = [bounds[k], bounds[k + 1]];
    while (ref[i].end <= t0 + EPS && i < ref.length - 1) i++;
    while (est[j].end <= t0 + EPS && j < est.length - 1) j++;
    if (t1 - t0 > EPS) out.push([t1 - t0, ref[i].label, est[j].label]);
  }
  return out;
}

// ---------- evaluasi ----------

const zeros = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));

export function emptyEvaluation() {
  return {
    seconds: 0,
    correct: zeros(METRICS), comparable: zeros(METRICS),
    clsTotal: zeros(CLASSES), clsExact: zeros(CLASSES), clsRoot: zeros(CLASSES),
    confusions: new Map(), // "acuan\u0000mesin" -> detik
  };
}

/** @returns evaluasi dalam satuan detik (bukan rasio) supaya bisa dijumlahkan antar lagu. */
export function evaluateSegments(ref, est) {
  if (!ref.length) throw new Error('Tidak ada label acuan (koreksi) untuk dievaluasi.');
  const t0 = Math.min(...ref.map((s) => s.start));
  const t1 = Math.max(...ref.map((s) => s.end));
  if (t1 - t0 <= EPS) throw new Error('Label acuan tidak punya durasi.');
  const ev = emptyEvaluation();
  ev.seconds = t1 - t0;

  for (const [d, r, e] of mergeSegments(normalize(ref, t0, t1), normalize(est, t0, t1))) {
    const er = encode(r), ee = encode(e);
    for (const m of METRICS) {
      const c = compare(m, er, ee);
      if (c >= 0) ev.comparable[m] += d;
      if (c === 1) ev.correct[m] += d;
    }
    const cls = chordClass(r);
    ev.clsTotal[cls] += d;
    if (canon(r) === canon(e)) {
      ev.clsExact[cls] += d;
      ev.clsRoot[cls] += d;
    } else {
      const key = `${canon(r)}\u0000${canon(e)}`;
      ev.confusions.set(key, (ev.confusions.get(key) ?? 0) + d);
      const rr = rootPc(r);
      if (rr !== null && rr === rootPc(e)) ev.clsRoot[cls] += d;
    }
  }
  return ev;
}

/** Jumlahkan `other` ke `total` (rata-rata mikro berbobot durasi). */
export function addEvaluation(total, other) {
  total.seconds += other.seconds;
  for (const m of METRICS) { total.correct[m] += other.correct[m]; total.comparable[m] += other.comparable[m]; }
  for (const c of CLASSES) {
    total.clsTotal[c] += other.clsTotal[c];
    total.clsExact[c] += other.clsExact[c];
    total.clsRoot[c] += other.clsRoot[c];
  }
  for (const [k, v] of other.confusions) total.confusions.set(k, (total.confusions.get(k) ?? 0) + v);
  return total;
}

/** Skor metrik sebagai pecahan 0..1, atau null bila tidak ada bagian yang bisa dibandingkan. */
export const score = (ev, metric) => (ev.comparable[metric] > 0 ? ev.correct[metric] / ev.comparable[metric] : null);

/** {exact, root} pecahan dari durasi kelas acuan, atau null bila kelas itu tidak muncul. */
export function classAccuracy(ev, cls) {
  const t = ev.clsTotal[cls];
  return t > 0 ? { exact: ev.clsExact[cls] / t, root: ev.clsRoot[cls] / t, seconds: t } : null;
}

/** Salah-baca terbanyak: [{ref, est, seconds}], urut menurun. Yang kurang dari minSeconds (selisih batas segmen) disembunyikan. */
export function topConfusions(ev, n = 15, minSeconds = 0.1) {
  return [...ev.confusions]
    .filter(([, seconds]) => seconds >= minSeconds)
    .map(([k, seconds]) => { const [ref, est] = k.split('\u0000'); return { ref, est, seconds }; })
    .sort((a, b) => b.seconds - a.seconds || a.ref.localeCompare(b.ref) || a.est.localeCompare(b.est))
    .slice(0, n);
}
