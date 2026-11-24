// Logika pemutar yang murni (tanpa DOM) supaya bisa diuji di Node.

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

/** Waktu dengan satu desimal (dibulatkan ke terdekat) untuk editor: 1:05.3 */
export function fmtTimePrecise(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const tenths = Math.round(sec * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, '0')}.${tenths % 10}`;
}

/** Indeks segmen yang sedang berbunyi pada waktu t, atau -1 (sebelum segmen pertama / di gap / setelah akhir). */
export function findSegmentIndex(segs, t) {
  let lo = 0, hi = segs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const last = found === segs.length - 1;
  // Toleransi kecil di ujung terakhir supaya currentTime == duration tetap menampilkan chord terakhir.
  return t < segs[found].end || (last && t <= segs[found].end + 0.05) ? found : -1;
}

/** Indeks chord berikutnya (bukan 'N') setelah posisi waktu t, atau -1. */
export function nextChordIndex(segs, t) {
  const cur = findSegmentIndex(segs, t);
  let j;
  if (cur >= 0) j = cur + 1;
  else {
    j = segs.findIndex((s) => s.start > t);
    if (j < 0) return -1;
  }
  for (; j < segs.length; j++) if (segs[j].label !== 'N') return j;
  return -1;
}

/**
 * Loop A-B: bila t sudah melewati B, kembalikan A (waktu yang harus dilompati); selain itu null.
 * @param {{a:number,b:number}|null} loop
 */
export function loopJump(t, loop) {
  if (!loop || !(loop.b > loop.a)) return null;
  return t >= loop.b ? loop.a : null;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
