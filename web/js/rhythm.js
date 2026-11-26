// Metronom dan hitung-mundur untuk pemutar. Penjadwalan klik adalah fungsi murni (planClicks, teruji di Node);
// sisanya memakai WebAudio dan elemen <audio>.
import { metronomeClicks } from './beats.js';

export const LOOKAHEAD_SEC = 0.25; // seberapa jauh (waktu nyata) klik dijadwalkan lebih dulu
export const TICK_MS = 50;

/**
 * Klik yang harus dijadwalkan untuk jendela waktu-lagu [from, to).
 * `when` = waktu AudioContext (detik) tempat klik berbunyi, memperhitungkan kecepatan putar.
 */
export function planClicks({ beats, meter, phase, from, to, mediaNow, rate, ctxNow }) {
  return metronomeClicks(beats, meter, phase, from, to)
    .map((c) => ({ t: c.t, accent: c.accent, when: ctxNow + (c.t - mediaNow) / rate }));
}

/** Waktu nyata (detik) tiap ketukan dari `bpm` pada kecepatan putar `rate`. */
export const beatSeconds = (bpm, rate = 1) => 60 / Math.max(1, bpm) / Math.max(0.1, rate);

/** Mesin klik: satu AudioContext dibuat saat dibutuhkan (harus dari gestur pengguna di iOS). */
export function createClickEngine() {
  let ctx = null;
  const ensure = () => {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };
  return {
    ensure,
    /** Bunyikan satu klik pada waktu AudioContext `when`. */
    click(when, accent) {
      const c = ensure();
      if (!c) return;
      const osc = c.createOscillator(), gain = c.createGain();
      osc.frequency.value = accent ? 1600 : 1000;
      const t0 = Math.max(when, c.currentTime);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.55, t0 + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + 0.06);
    },
  };
}

/**
 * Metronom yang mengikuti posisi lagu: selama audio berputar, klik dijadwalkan sedikit di depan.
 * @param {HTMLAudioElement} audio
 * @param {()=>{beats:number[],meter:number,phase:number}|null} getGrid
 */
export function createMetronome(audio, getGrid, engine = createClickEngine()) {
  let on = false, timer = 0, next = 0;

  function tick() {
    const grid = getGrid();
    if (!on || !grid || audio.paused) return;
    const c = engine.ensure();
    if (!c) return;
    const rate = audio.playbackRate || 1;
    const now = audio.currentTime;
    const to = now + LOOKAHEAD_SEC * rate;
    const plan = planClicks({ ...grid, from: Math.max(next, now), to, mediaNow: now, rate, ctxNow: c.currentTime });
    for (const p of plan) engine.click(p.when, p.accent);
    next = to;
  }

  const resync = () => { next = audio.currentTime || 0; };
  audio.addEventListener('seeking', resync);
  audio.addEventListener('play', resync);

  return {
    get on() { return on; },
    engine,
    set(value) {
      on = value;
      clearInterval(timer);
      if (on) { engine.ensure(); resync(); timer = setInterval(tick, TICK_MS); }
    },
  };
}

/**
 * Hitung-mundur: `count` klik sebelum lagu mulai. Janji selesai saat klik terakhir selesai (lalu lagu dimulai);
 * bernilai false bila dibatalkan lewat `cancel()`.
 */
export function countIn(engine, count, bpm, rate) {
  const c = engine.ensure();
  const gap = beatSeconds(bpm, rate);
  let cancelled = false, timer = 0, finish = () => {};
  const promise = new Promise((resolve) => {
    finish = resolve;
    if (!c || count < 1) return resolve(true);
    const start = c.currentTime + 0.08;
    for (let i = 0; i < count; i++) engine.click(start + i * gap, i === 0);
    timer = setTimeout(() => resolve(!cancelled), (0.08 + count * gap) * 1000);
  });
  return { promise, cancel() { cancelled = true; clearTimeout(timer); finish(false); } };
}
