// Pemutar: audio + chord sinkron, lini waktu, kecepatan, loop A-B, transpose, capo.
import { supabase } from './supabase.js';
import { createApi, humanizeError } from './api.js';
import { REQUIRE_LOGIN } from './supabase-config.js';
import { spellingForKey, transposeChord, estimateKey, keyName } from './transpose.js';
import { findSegmentIndex, nextChordIndex, loopJump, fmtTime, clamp } from './player-logic.js';

const api = createApi(supabase);
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const SPEEDS = [0.5, 0.75, 1, 1.25];
const SPELLINGS = [['auto', 'Otomatis'], ['sharp', '♯'], ['flat', '♭']];
const PX_PER_SEC = 40; // lebar kotak lini waktu ~ durasi chord
const MIN_BOX_PX = 60; // dan tidak pernah lebih kecil dari target sentuh
const USER_SCROLL_PAUSE_MS = 2500; // setelah pengguna menggeser lini waktu, auto-scroll berhenti sebentar

const st = {
  song: null, segs: [], key: null, boxes: [],
  idx: -2, loopA: null, loopB: null, speed: 1,
  transpose: 0, capo: 0, spelling: 'auto',
  raf: 0, lastUserScroll: 0, wakeLock: null, urlRetries: 0,
};

// ---------- util ----------

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : st.song?.duration_sec || 0);
const prefsKey = () => `chordfinder:prefs:${st.song.id}`;

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefsKey()) || '{}');
    st.transpose = clamp(Number(p.transpose) || 0, -6, 6);
    st.capo = clamp(Number(p.capo) || 0, 0, 11);
    if (SPELLINGS.some(([v]) => v === p.spelling)) st.spelling = p.spelling;
  } catch { /* penyimpanan browser mungkin diblokir: pakai bawaan */ }
}
function savePrefs() {
  try {
    localStorage.setItem(prefsKey(), JSON.stringify({ transpose: st.transpose, capo: st.capo, spelling: st.spelling }));
  } catch { /* abaikan */ }
}

// ---------- nama chord yang ditampilkan ----------

const shapeShift = () => st.transpose - st.capo; // bentuk chord yang dimainkan = nada dasar - capo

function spellFor(tonicPc) {
  if (st.spelling !== 'auto') return st.spelling;
  return st.key ? spellingForKey(tonicPc, st.key.mode) : 'sharp';
}
const show = (label) => (label === 'N' ? '–' : transposeChord(label, shapeShift(), spellFor((st.key?.tonicPc ?? 0) + shapeShift())));

function keyText() {
  if (!st.key) return 'Key: ?';
  const { tonicPc, mode } = st.key;
  const sound = (tonicPc + st.transpose + 120) % 12;
  const shape = (tonicPc + shapeShift() + 120) % 12;
  const soundName = keyName(sound, mode, spellFor(sound));
  if (!st.capo) return `Key: ${soundName}`;
  return `Key: ${soundName} · Capo ${st.capo} · Bentuk: ${keyName(shape, mode, spellFor(shape))}`;
}

// ---------- tampilan chord aktif + lini waktu ----------

function buildTimeline() {
  const tl = $('timeline');
  tl.replaceChildren();
  st.boxes = st.segs.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.className = 'tl-box' + (s.label === 'N' ? ' none' : '');
    b.style.width = `${Math.max(MIN_BOX_PX, (s.end - s.start) * PX_PER_SEC)}px`;
    b.append(document.createElement('strong'), document.createElement('small'));
    b.addEventListener('click', () => { st.lastUserScroll = 0; seekTo(s.start + 0.001); });
    tl.append(b);
    return b;
  });
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
    tl.addEventListener(ev, () => { st.lastUserScroll = Date.now(); }, { passive: true });
  }
}

function refreshLabels() {
  st.boxes.forEach((b, i) => {
    b.firstChild.textContent = show(st.segs[i].label);
    b.lastChild.textContent = fmtTime(st.segs[i].start);
  });
  $('keyInfo').textContent = keyText();
  st.idx = -2; // paksa perbarui panggung
  syncUI();
}

function scrollToActive() {
  const box = st.boxes[st.idx];
  if (!box || Date.now() - st.lastUserScroll < USER_SCROLL_PAUSE_MS) return;
  const tl = $('timeline');
  tl.scrollTo({ left: box.offsetLeft - (tl.clientWidth - box.offsetWidth) / 2, behavior: 'smooth' });
}

function syncUI() {
  const t = audio.currentTime || 0;
  if (!st.seeking) $('seek').value = String(t);
  $('curTime').textContent = fmtTime(t);

  const idx = findSegmentIndex(st.segs, t);
  if (idx === st.idx) return;
  st.idx = idx;

  const label = idx >= 0 ? st.segs[idx].label : 'N';
  const now = $('nowChord');
  now.textContent = show(label);
  now.classList.toggle('none', label === 'N');
  const ni = nextChordIndex(st.segs, t);
  $('nextChord').textContent = ni >= 0 ? show(st.segs[ni].label) : '–';
  st.boxes.forEach((b, i) => {
    b.classList.toggle('on', i === idx);
    b.classList.toggle('next', i === ni);
  });
  scrollToActive();
}

function seekTo(t) {
  audio.currentTime = clamp(t, 0, duration() || t);
  syncUI();
}

// ---------- pemutaran ----------

function frame() {
  if (audio.paused) return;
  const jump = loopJump(audio.currentTime, st.loopA !== null && st.loopB !== null ? { a: st.loopA, b: st.loopB } : null);
  if (jump !== null) audio.currentTime = jump;
  syncUI();
  st.raf = requestAnimationFrame(frame);
}

function applySpeed() {
  audio.defaultPlaybackRate = st.speed;
  audio.playbackRate = st.speed;
  // pitch tetap saat diperlambat/dipercepat (Safari memakai prefiks webkit pada versi lama)
  audio.preservesPitch = true;
  audio.webkitPreservesPitch = true;
  audio.mozPreservesPitch = true;
}

async function setWakeLock(on) {
  try {
    if (on && 'wakeLock' in navigator && !st.wakeLock) {
      st.wakeLock = await navigator.wakeLock.request('screen'); // layar tetap menyala saat main
      st.wakeLock.addEventListener('release', () => { st.wakeLock = null; });
    } else if (!on && st.wakeLock) {
      await st.wakeLock.release();
      st.wakeLock = null;
    }
  } catch { /* tidak didukung / ditolak: abaikan */ }
}

async function togglePlay() {
  if (!audio.paused) { audio.pause(); return; }
  try {
    applySpeed();
    await audio.play();
  } catch {
    toast('Audio belum bisa diputar. Ketuk Putar lagi.');
  }
}

audio.addEventListener('play', () => {
  $('playBtn').textContent = '⏸ Jeda';
  applySpeed();
  cancelAnimationFrame(st.raf);
  st.raf = requestAnimationFrame(frame);
  setWakeLock(true);
});
audio.addEventListener('pause', () => { $('playBtn').textContent = '▶ Putar'; cancelAnimationFrame(st.raf); syncUI(); setWakeLock(false); });
audio.addEventListener('ended', () => { $('playBtn').textContent = '▶ Putar'; cancelAnimationFrame(st.raf); setWakeLock(false); });
audio.addEventListener('seeked', syncUI);
audio.addEventListener('timeupdate', () => { if (audio.paused) syncUI(); });
audio.addEventListener('loadedmetadata', () => {
  applySpeed();
  const d = duration();
  $('seek').max = String(d);
  $('totTime').textContent = fmtTime(d);
});

// URL bertanda tangan bisa kedaluwarsa atau gagal sesaat: minta yang baru lalu lanjutkan dari posisi yang sama.
audio.addEventListener('error', async () => {
  if (!st.song || st.urlRetries >= 2) { toast('Audio tidak bisa dimuat. Muat ulang halaman.'); return; }
  st.urlRetries++;
  const resume = audio.currentTime || 0;
  try {
    audio.src = await api.getAudioUrl(st.song);
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = resume; }, { once: true });
  } catch (e) {
    toast(humanizeError(e));
  }
});

// ---------- kontrol ----------

function buildSegmented(el, items, current, onPick) {
  el.replaceChildren();
  for (const [value, label] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.value = String(value);
    b.addEventListener('click', () => { onPick(value); updateSegmented(el, value); });
    el.append(b);
  }
  updateSegmented(el, current);
}
function updateSegmented(el, current) {
  for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(current)));
}

function updateLoopInfo() {
  const a = st.loopA, b = st.loopB;
  $('loopInfo').textContent = a === null ? 'Loop mati' : b === null ? `A ${fmtTime(a)} · pilih titik B` : `Loop aktif: A ${fmtTime(a)} – B ${fmtTime(b)}`;
}

function updateSteppers() {
  $('trVal').textContent = st.transpose > 0 ? `+${st.transpose}` : String(st.transpose);
  $('capoVal').textContent = String(st.capo);
}

function changeShift(fn) {
  fn();
  savePrefs();
  updateSteppers();
  refreshLabels();
}

function wireControls() {
  $('playBtn').addEventListener('click', togglePlay);
  $('back5').addEventListener('click', () => seekTo(audio.currentTime - 5));
  $('fwd5').addEventListener('click', () => seekTo(audio.currentTime + 5));

  const seek = $('seek');
  seek.addEventListener('pointerdown', () => { st.seeking = true; });
  seek.addEventListener('pointerup', () => { st.seeking = false; });
  seek.addEventListener('input', () => seekTo(Number(seek.value)));
  seek.addEventListener('change', () => { st.seeking = false; });

  buildSegmented($('speedSeg'), SPEEDS.map((s) => [s, `${s}×`]), st.speed, (v) => { st.speed = v; applySpeed(); });
  buildSegmented($('spellSeg'), SPELLINGS, st.spelling, (v) => changeShift(() => { st.spelling = v; }));

  $('setA').addEventListener('click', () => {
    st.loopA = audio.currentTime;
    if (st.loopB !== null && st.loopB <= st.loopA) st.loopB = null;
    updateLoopInfo();
  });
  $('setB').addEventListener('click', () => {
    if (st.loopA === null) return toast('Set titik A dulu.');
    if (audio.currentTime <= st.loopA) return toast('Titik B harus setelah titik A.');
    st.loopB = audio.currentTime;
    updateLoopInfo();
  });
  $('clearLoop').addEventListener('click', () => { st.loopA = st.loopB = null; updateLoopInfo(); });

  $('trDown').addEventListener('click', () => changeShift(() => { st.transpose = clamp(st.transpose - 1, -6, 6); }));
  $('trUp').addEventListener('click', () => changeShift(() => { st.transpose = clamp(st.transpose + 1, -6, 6); }));
  $('trReset').addEventListener('click', () => changeShift(() => { st.transpose = 0; st.capo = 0; }));
  $('capoDown').addEventListener('click', () => changeShift(() => { st.capo = clamp(st.capo - 1, 0, 11); }));
  $('capoUp').addEventListener('click', () => changeShift(() => { st.capo = clamp(st.capo + 1, 0, 11); }));

  // pintasan keyboard (laptop): spasi = putar/jeda, panah = ±5 dtk
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') seekTo(audio.currentTime - 5);
    else if (e.code === 'ArrowRight') seekTo(audio.currentTime + 5);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !audio.paused) setWakeLock(true);
  });
}

// ---------- mulai ----------

function fail(message) {
  $('stateMsg').hidden = true;
  $('errorMsg').textContent = message;
  $('errorMsg').hidden = false;
}

(async function init() {
  const id = new URLSearchParams(location.search).get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail('Lagu tidak ditentukan. Pilih lagu dari daftar.');
  try {
    if (REQUIRE_LOGIN && !(await api.getSession())) { location.replace('index.html'); return; }
    const song = await api.getSong(id);
    if (!song) return fail('Lagu tidak ditemukan (mungkin sudah dihapus).');
    const { version, segments } = await api.getLabelsWithFallback(id, 'corrected');
    if (!segments?.length) return fail('Lagu ini belum dianalisis. Kembali ke daftar lalu jalankan analisis.');

    st.song = song;
    st.segs = [...segments].sort((a, b) => a.start - b.start);
    st.key = estimateKey(st.segs);
    loadPrefs();
    $('songTitle').textContent = song.name;
    document.title = `${song.name} · Chord Finder`;
    $('versionInfo').textContent = version === 'corrected' ? 'Versi koreksi' : 'Hasil mesin (belum dikoreksi)';

    buildTimeline();
    wireControls();
    updateSteppers();
    updateLoopInfo();
    $('totTime').textContent = fmtTime(song.duration_sec || 0);
    $('seek').max = String(song.duration_sec || 100);
    $('stateMsg').hidden = true;
    $('playerView').hidden = false;
    refreshLabels();

    audio.src = await api.getAudioUrl(song);
  } catch (e) {
    fail(humanizeError(e));
  }
})();
