// Lembar chord: chord di atas lirik, dengan bagian lagu (Intro, Verse, Chorus, ...). Logika murni (tanpa DOM), teruji di Node.
//
// Alur: pengguna menempel lirik (boleh dengan judul bagian), lalu mengetuk saat lagu diputar untuk menandai awal tiap baris.
// Dari waktu itu dan label chord (koreksi), tiap chord ditempatkan di atas kata yang sedang dinyanyikan.
// Hasil berupa teks monospace (chord di baris atas, lirik di baris bawah), sama persis untuk layar, cetak, dan ekspor .txt.

const HEADER_RE = /^(intro|interlude|instrumen(?:tal)?|verse|bait|chorus|reff?|refrain|pre[\s-]?chorus|bridge|outro|ending|tag|coda|turnaround)\b[\s\d:.\-]*$/i;
const CHORDS_PER_BAR_LINE = 4;
// Chord hanya dihitung bila berbunyi minimal sekian detik di dalam rentang. Batas segmen hasil deteksi sering meleset puluhan
// milidetik, jadi tanpa ini chord tetangga "bocor" ke awal/akhir rentang; chord yang mulai sesaat sebelum baris berikutnya
// (antisipasi) juga otomatis tampil di baris berikutnya.
const MIN_OVERLAP_SEC = 0.3;

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Urai lirik tempelan menjadi daftar item berurutan.
 * Judul bagian: baris `[Verse 1]`, atau baris yang hanya berisi kata judul umum ("Verse 1", "Chorus", "Instrumen:", "Bait 2", ...).
 * Baris kosong diabaikan. Tiap item punya `key` yang stabil (jenis|teks|urutan kemunculan) untuk menyimpan waktunya.
 * @returns {{type:'section'|'line', name?:string, text?:string, key:string}[]}
 */
export function parseLyrics(text) {
  const items = [];
  const seen = new Map();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    let type = 'line';
    let value = t;
    const bracket = /^\[(.+)\]$/.exec(t);
    if (bracket) { type = 'section'; value = bracket[1].trim(); }
    else if (HEADER_RE.test(t)) { type = 'section'; value = t.replace(/[\s:.\-]+$/, ''); }
    if (type === 'section') value = capitalize(value.replace(/\s+/g, ' '));
    else value = value.replace(/\s+/g, ' ');
    const base = `${type === 'section' ? 's' : 'l'}|${value}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    items.push(type === 'section' ? { type, name: value, key: `${base}|${n}` } : { type, text: value, key: `${base}|${n}` });
  }
  return items;
}

/** Bagian tanpa lirik di bawahnya (Intro/Instrumen) berisi deretan chord saja. */
export function isChordOnly(items, i) {
  return items[i].type === 'section' && (i + 1 >= items.length || items[i + 1].type === 'section');
}

/** Item yang perlu ditandai waktunya oleh pengguna: tiap baris lirik, dan bagian yang hanya berisi chord. */
export function needsTime(items, i) {
  return items[i].type === 'line' || isChordOnly(items, i);
}

/** Pasang waktu dari `times` (key -> detik). Judul bagian berlirik memakai waktu baris pertamanya. */
export function resolveTimes(items, times = {}) {
  const out = items.map((it) => ({ ...it, t: Number.isFinite(times[it.key]) ? times[it.key] : undefined }));
  out.forEach((it, i) => {
    if (it.type === 'section' && !isChordOnly(out, i)) it.t = out[i + 1].t;
  });
  return out;
}

/** Indeks item bernilai-waktu pertama yang belum punya waktu (dipakai tombol ketuk), atau -1. */
export function nextUnsynced(items, times = {}) {
  return items.findIndex((it, i) => needsTime(items, i) && !Number.isFinite(times[it.key]));
}

function wordStarts(text) {
  return [...text.matchAll(/\S+/g)].map((m) => m.index);
}

function snapToWord(idx, starts) {
  if (!starts.length) return 0;
  let best = starts[0];
  for (const s of starts) if (Math.abs(s - idx) < Math.abs(best - idx)) best = s;
  return best;
}

function activeChords(segs, t0, t1, minOverlap = MIN_OVERLAP_SEC) {
  const cand = [];
  for (const s of segs) {
    if (s.label === 'N') continue;
    const ov = Math.min(s.end, t1) - Math.max(s.start, t0);
    if (ov > 1e-6) cand.push({ label: s.label, t: Math.max(s.start, t0), ov });
  }
  let out = cand.filter((c) => c.ov >= minOverlap);
  if (!out.length && cand.length) out = [cand.reduce((a, b) => (b.ov > a.ov ? b : a))]; // rentang sangat pendek: ambil yang paling lama berbunyi
  return out.filter((c, i) => i === 0 || c.label !== out[i - 1].label).map(({ label, t }) => ({ label, t }));
}

/** Baris chord di atas lirik: tiap chord di awal kata terdekat menurut waktunya, tanpa saling menimpa. */
export function placeChords(text, chords, t0, t1, show = (l) => l) {
  const starts = wordStarts(text);
  const span = t1 - t0;
  let cursor = 0;
  let line = '';
  const placed = [];
  chords.forEach((c, k) => {
    const label = show(c.label);
    let pos;
    if (k === 0 && c.t <= t0 + 0.05) pos = starts[0] ?? 0;
    else if (!(span > 0.2)) pos = cursor; // rentang terlalu pendek untuk dipetakan
    else pos = snapToWord(Math.round(((c.t - t0) / span) * text.length), starts);
    pos = Math.max(pos, cursor); // jangan menimpa chord sebelumnya (sisakan satu spasi)
    line += ' '.repeat(pos - line.length) + label;
    placed.push({ label, pos });
    cursor = pos + label.length + 1;
  });
  return { chordLine: line, placed };
}

/** Bar chord untuk bagian tanpa lirik: empat chord per baris, mis. `| C  G  Am  F |`. */
export function barLines(chords, show = (l) => l) {
  const names = chords.map((c) => show(c.label));
  const lines = [];
  for (let i = 0; i < names.length; i += CHORDS_PER_BAR_LINE) {
    lines.push(`| ${names.slice(i, i + CHORDS_PER_BAR_LINE).join('  ')} |`);
  }
  return lines;
}

/**
 * Susun lembar. Mengembalikan blok berurutan:
 *   {kind:'section', name}
 *   {kind:'bars', lines:[...]}                           bagian tanpa lirik
 *   {kind:'lyric', chordLine, text, synced:boolean}      satu baris lirik
 * Baris yang belum punya waktu tetap tampil (tanpa chord) dengan synced:false.
 * @param {ReturnType<typeof resolveTimes>} items
 * @param {{start:number,end:number,label:string}[]} segs chord terurut
 * @param {{show?:(label:string)=>string, endTime?:number}} [opts] show = transpose/ejaan; endTime = akhir lagu
 */
export function layoutSheet(items, segs, { show = (l) => l, endTime } = {}) {
  const songEnd = endTime ?? segs.at(-1)?.end ?? 0;
  // waktu mulai item berikutnya yang bernilai-waktu & lebih lambat, sebagai batas akhir item ini
  const endOf = (i) => {
    const t0 = items[i].t;
    for (let j = i + 1; j < items.length; j++) {
      if (Number.isFinite(items[j].t) && items[j].t > t0) return items[j].t;
    }
    return Math.max(songEnd, t0);
  };

  const blocks = [];
  items.forEach((it, i) => {
    if (it.type === 'section') {
      blocks.push({ kind: 'section', name: it.name });
      if (isChordOnly(items, i)) {
        const synced = Number.isFinite(it.t);
        const chords = synced ? activeChords(segs, it.t, endOf(i)) : [];
        blocks.push({ kind: 'bars', lines: barLines(chords, show), synced });
      }
      return;
    }
    if (!Number.isFinite(it.t)) {
      blocks.push({ kind: 'lyric', chordLine: '', text: it.text, synced: false });
      return;
    }
    const t1 = endOf(i);
    const { chordLine } = placeChords(it.text, activeChords(segs, it.t, t1), it.t, t1, show);
    blocks.push({ kind: 'lyric', chordLine, text: it.text, synced: true });
  });
  return blocks;
}

/** Teks polos monospace (untuk salin/unduh): judul, Key, lalu bagian demi bagian. */
export function sheetToText(blocks, { title = '', keyText = '' } = {}) {
  const out = [];
  if (title) out.push(title);
  if (keyText) out.push(keyText);
  if (out.length) out.push('');
  blocks.forEach((b, i) => {
    if (b.kind === 'section') {
      if (i > 0) out.push('');
      out.push(`[${b.name}]`);
    } else if (b.kind === 'bars') out.push(...b.lines);
    else {
      if (b.chordLine.trim()) out.push(b.chordLine);
      out.push(b.text);
    }
  });
  return out.join('\n') + '\n';
}

/** Pertahankan waktu yang masih berlaku setelah lirik diubah: hanya key yang masih ada di daftar item. */
export function pruneTimes(items, times = {}) {
  const keys = new Set(items.map((it) => it.key));
  return Object.fromEntries(Object.entries(times).filter(([k, v]) => keys.has(k) && Number.isFinite(v)));
}
