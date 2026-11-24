// Operasi koreksi segmen chord yang murni (tanpa DOM): semua fungsi mengembalikan array BARU dan tidak
// pernah mengubah masukan, jadi riwayat undo cukup menyimpan referensi array.
import { CHORD_QUALITIES, parseChord } from './labels.js';
import { noteName } from './transpose.js';

export const MIN_SEG = 0.1; // durasi minimum segmen (detik)
const r3 = (v) => Math.round(v * 1000) / 1000; // milidetik, sama dengan isi .lab
const EPS = 1e-6;
const copy = (segs) => segs.map((s) => ({ ...s }));
const same = (a, b) => Math.abs(a - b) < EPS;

function check(segs, i) {
  if (!Number.isInteger(i) || i < 0 || i >= segs.length) throw new Error('Segmen tidak ditemukan.');
}

/** Ganti label satu segmen. */
export function setLabelAt(segs, i, label) {
  check(segs, i);
  const out = copy(segs);
  out[i].label = label;
  return out;
}

/** Ganti semua segmen berlabel `from` menjadi `to`. */
export function replaceAll(segs, from, to) {
  let count = 0;
  const out = segs.map((s) => {
    if (s.label !== from) return { ...s };
    count++;
    return { ...s, label: to };
  });
  return { segs: out, count };
}

export const countLabel = (segs, label) => segs.filter((s) => s.label === label).length;

/** Pecah segmen i di waktu t menjadi dua segmen berlabel sama. Mengembalikan {segs, index} (index = bagian kiri). */
export function splitAt(segs, i, t) {
  check(segs, i);
  const s = segs[i];
  t = r3(t);
  if (t < s.start + MIN_SEG - EPS || t > s.end - MIN_SEG + EPS) {
    throw new Error(`Playhead harus berada di dalam segmen ini, minimal ${MIN_SEG} detik dari tepinya.`);
  }
  const out = copy(segs);
  out.splice(i, 1, { start: s.start, end: t, label: s.label }, { start: t, end: s.end, label: s.label });
  return { segs: out, index: i };
}

/** Gabung segmen i dengan tetangganya (dir = -1 sebelumnya, +1 berikutnya). Label segmen i yang dipakai; gap ikut tertutup. */
export function mergeWith(segs, i, dir) {
  check(segs, i);
  const j = i + dir;
  if (j < 0 || j >= segs.length) throw new Error(dir < 0 ? 'Tidak ada segmen sebelumnya.' : 'Tidak ada segmen berikutnya.');
  const [lo, hi] = i < j ? [i, j] : [j, i];
  const merged = { start: segs[lo].start, end: segs[hi].end, label: segs[i].label };
  const out = copy(segs);
  out.splice(lo, 2, merged);
  return { segs: out, index: lo };
}

/** Hapus segmen i; waktunya diserap tetangga (sebelumnya, atau berikutnya bila i adalah yang pertama). */
export function deleteAt(segs, i) {
  check(segs, i);
  if (segs.length === 1) throw new Error('Minimal harus ada 1 segmen.');
  const out = copy(segs);
  const [gone] = out.splice(i, 1);
  if (i > 0) {
    out[i - 1].end = gone.end;
    return { segs: out, index: i - 1 };
  }
  out[0].start = gone.start;
  return { segs: out, index: 0 };
}

/**
 * Geser batas awal segmen i ke waktu t (dijepit ke rentang yang sah). Bila segmen sebelumnya bersambung,
 * batas akhirnya ikut bergeser. Mengembalikan array baru (isinya sama bila tidak ada perubahan).
 */
export function moveStart(segs, i, t) {
  check(segs, i);
  const s = segs[i], prev = segs[i - 1];
  const joined = prev && same(prev.end, s.start);
  const lo = prev ? (joined ? prev.start + MIN_SEG : prev.end) : 0;
  const hi = s.end - MIN_SEG;
  const nt = r3(Math.min(Math.max(t, lo), hi));
  const out = copy(segs);
  out[i].start = nt;
  if (joined) out[i - 1].end = nt;
  return out;
}

/** Geser batas akhir segmen i ke t. `maxEnd` (mis. durasi audio) membatasi segmen terakhir. */
export function moveEnd(segs, i, t, maxEnd = Infinity) {
  check(segs, i);
  const s = segs[i], next = segs[i + 1];
  const joined = next && same(next.start, s.end);
  const lo = s.start + MIN_SEG;
  const hi = next ? (joined ? next.end - MIN_SEG : next.start) : maxEnd;
  const nt = r3(Math.min(Math.max(t, lo), hi));
  const out = copy(segs);
  out[i].end = nt;
  if (joined) out[i + 1].start = nt;
  return out;
}

/**
 * Tandai segmen yang berbeda antara dua versi: sebuah segmen dianggap berbeda bila di bagian mana pun dari
 * rentang waktunya (lebih dari `tol` detik) versi lain tidak berlabel sama, termasuk bila di sana tidak ada segmen.
 * Mengembalikan {a: boolean[], b: boolean[]} sejajar dengan masing-masing array.
 */
export function diffMarks(a, b, tol = 0.05) {
  const mark = (x, y) => x.map((s) => {
    let agree = 0;
    for (const o of y) {
      if (o.start >= s.end) break; // y terurut: sisanya di luar rentang
      if (o.label === s.label) agree += Math.max(0, Math.min(s.end, o.end) - Math.max(s.start, o.start));
    }
    return s.end - s.start - agree > tol;
  });
  return { a: mark(a, b), b: mark(b, a) };
}

// ---------- pemilih chord ----------

/** Pecah label menjadi {n:true} untuk N, atau {rootPc, suffix, bassPc}; null bila tak bisa diurai (pakai input manual). */
export function pickerFromLabel(label) {
  if (label === 'N') return { n: true };
  try {
    const p = parseChord(label, true);
    return { n: false, rootPc: p.rootPc, suffix: p.suffix, bassPc: p.bassPc };
  } catch {
    return null;
  }
}

export function labelFromPicker(p, spelling = 'sharp') {
  if (p.n) return 'N';
  const bass = p.bassPc !== null && p.bassPc !== undefined && p.bassPc !== p.rootPc ? '/' + noteName(p.bassPc, spelling) : '';
  return noteName(p.rootPc, spelling) + p.suffix + bass;
}

/** Jenis chord yang ditawarkan di editor (semua yang dikenal labels.js), urutan: yang umum dulu. */
export const QUALITY_OPTIONS = ['', 'm', 'sus2', 'sus4', '7', 'maj7', 'm7', 'add9', 'madd9', '6', 'm6', '9', 'maj9', 'm9', 'dim', 'aug', 'm7b5', 'dim7']
  .filter((q) => CHORD_QUALITIES.has(q));
export const qualityLabel = (q) => (q === '' ? 'maj' : q);

// ---------- riwayat undo/redo ----------

export class History {
  constructor(limit = 100) {
    this.limit = limit;
    this.states = [];
    this.pos = -1;
  }
  reset(state) {
    this.states = [state];
    this.pos = 0;
  }
  get current() {
    return this.states[this.pos];
  }
  get canUndo() {
    return this.pos > 0;
  }
  get canRedo() {
    return this.pos < this.states.length - 1;
  }
  push(state) {
    if (state === this.current) return;
    this.states = this.states.slice(0, this.pos + 1);
    this.states.push(state);
    if (this.states.length > this.limit) this.states.shift();
    this.pos = this.states.length - 1;
  }
  undo() {
    if (!this.canUndo) return null;
    return this.states[--this.pos];
  }
  redo() {
    if (!this.canRedo) return null;
    return this.states[++this.pos];
  }
}
