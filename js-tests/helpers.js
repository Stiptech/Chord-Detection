// Pembangkit audio sintetis yang sama dengan tests/test_baseline.py.
export const SR = 22050;
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function freq(note, octave = 4) {
  const semis = NOTE[note[0]] + (note.includes('#') ? 1 : 0) - 9 + 12 * (octave - 4);
  return 440 * 2 ** (semis / 12);
}

/** Sinus bertumpuk: tiap nada + oktaf di atasnya (oktaf tidak menambah pitch class). */
export function chordTone(notes, seconds = 2) {
  const n = Math.round(SR * seconds);
  const y = new Float32Array(n);
  for (const note of notes) {
    const f = freq(note);
    for (let i = 0; i < n; i++) {
      y[i] += Math.sin((2 * Math.PI * f * i) / SR) + 0.5 * Math.sin((2 * Math.PI * 2 * f * i) / SR);
    }
  }
  const fade = Math.round(0.01 * SR); // 10 ms supaya pergantian tidak berklik
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) {
    let g = 0.5 / peak;
    if (i < fade) g *= i / (fade - 1);
    if (i >= n - fade) g *= (n - 1 - i) / (fade - 1);
    y[i] *= g;
  }
  return y;
}

export function concat(...parts) {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const silence = (seconds) => new Float32Array(Math.round(SR * seconds));
export const labelsOf = (segs) => segs.map((s) => s.label);
