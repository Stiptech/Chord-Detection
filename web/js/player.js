// Pemutar: audio + chord sinkron, lini waktu, kecepatan, loop A-B, transpose, capo,
// mode edit (koreksi) dan perbandingan hasil mesin vs koreksi.
import { supabase } from './supabase.js';
import { createApi, humanizeError } from './api.js';
import { REQUIRE_LOGIN } from './supabase-config.js';
import { spellingForKey, transposeChord, estimateKey, keyName } from './transpose.js';
import { findSegmentIndex, nextChordIndex, loopJump, fmtTime, clamp } from './player-logic.js';
import { diffMarks } from './edit-logic.js';
import { createEditor } from './editor.js';
import {
  barChords, barIndexAt, bpmFromBeats, buildGrid, doubleTempo, halveTempo, pickPhase,
} from './beats.js';
import { countIn, createMetronome } from './rhythm.js';
import { analyzeBeats, analyzeBtc } from './analysis.js';
import { decodeAudio } from './audio.js';
import { h } from './dom.js';

const api = createApi(supabase);
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const SPEEDS = [0.5, 0.75, 1, 1.25];
const SPELLINGS = [['auto', 'Otomatis'], ['sharp', '♯'], ['flat', '♭']];
const PX_PER_SEC = 40; // lebar kotak lini waktu ~ durasi chord
const MIN_BOX_PX = 60; // dan tidak pernah lebih kecil dari target sentuh
const CMP_PX_PER_SEC = 30; // tampilan bandingkan: lebar persis sebanding durasi supaya dua baris sejajar
const USER_SCROLL_PAUSE_MS = 2500; // setelah pengguna menggeser lini waktu, auto-scroll berhenti sebentar

const st = {
  song: null, segs: [], autoSegs: null, key: null, boxes: [],
  idx: -2, loopA: null, loopB: null, speed: 1,
  transpose: 0, capo: 0, spelling: 'auto',
  editing: false, compareOn: false, version: 'auto', selected: null,
  raf: 0, lastUserScroll: 0, wakeLock: null, urlRetries: 0,
  btcSegs: null, beats: null, bars: [], barMode: false, barBoxes: [], barIdx: -2, countInOn: false, counting: null, beatSaveTimer: 0,
};
const METERS = [[3, '3'], [4, '4'], [6, '6']];
const metro = createMetronome(audio, () => (st.beats ? { beats: st.beats.beats, meter: st.beats.meter, phase: st.beats.phase } : null));

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
    st.countInOn = !!p.countIn;
  } catch { /* penyimpanan browser mungkin diblokir: pakai bawaan */ }
}
function savePrefs() {
  try {
    localStorage.setItem(prefsKey(), JSON.stringify({ transpose: st.transpose, capo: st.capo, spelling: st.spelling, countIn: st.countInOn }));
  } catch { /* abaikan */ }
}

// ---------- nama chord yang ditampilkan ----------

// Di mode edit chord ditampilkan apa adanya (tanpa transpose/capo) supaya yang diedit = yang tersimpan.
const shapeShift = () => (st.editing ? 0 : st.transpose - st.capo); // bentuk yang dimainkan = nada dasar - capo

function spellFor(tonicPc) {
  if (st.spelling !== 'auto') return st.spelling;
  return st.key ? spellingForKey(tonicPc, st.key.mode) : 'sharp';
}
const editSpelling = () => spellFor(st.key?.tonicPc ?? 0);
const show = (label) => (label === 'N' ? '–' : transposeChord(label, shapeShift(), spellFor((st.key?.tonicPc ?? 0) + shapeShift())));

function keyText() {
  if (!st.key) return 'Key: ?';
  const { tonicPc, mode } = st.key;
  const sound = (tonicPc + (st.editing ? 0 : st.transpose) + 120) % 12;
  const shape = (tonicPc + shapeShift() + 120) % 12;
  const soundName = keyName(sound, mode, spellFor(sound));
  if (st.editing || !st.capo) return `Key: ${soundName}`;
  return `Key: ${soundName} · Capo ${st.capo} · Bentuk: ${keyName(shape, mode, spellFor(shape))}`;
}

// ---------- lini waktu ----------

function onBoxClick(i) {
  st.lastUserScroll = 0;
  if (st.editing) editor.select(i);
  else seekTo(st.segs[i].start + 0.001);
}

function buildTimeline() {
  const tl = $('timeline');
  const keepScroll = tl.scrollLeft;
  tl.replaceChildren();
  st.boxes = st.segs.map((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.className = 'tl-box' + (s.label === 'N' ? ' none' : '');
    b.style.width = `${Math.max(MIN_BOX_PX, (s.end - s.start) * PX_PER_SEC)}px`;
    b.append(document.createElement('strong'), document.createElement('small'));
    b.addEventListener('click', () => onBoxClick(i));
    tl.append(b);
    return b;
  });
  tl.scrollLeft = keepScroll;
}

/** Tanda pada kotak: terpilih (edit) dan berbeda dari hasil mesin. */
function decorate() {
  const marks = st.editing && st.autoSegs ? diffMarks(st.segs, st.autoSegs).a : null;
  st.boxes.forEach((b, i) => {
    b.classList.toggle('sel', st.selected === i);
    b.classList.toggle('diff', !!marks?.[i]);
  });
}

function refreshLabels() {
  st.boxes.forEach((b, i) => {
    b.firstChild.textContent = show(st.segs[i].label);
    b.lastChild.textContent = fmtTime(st.segs[i].start);
  });
  $('keyInfo').textContent = keyText();
  document.body.classList.toggle('editing', st.editing);
  $('dockNow').hidden = !st.editing; // 'Sekarang: X' di dock hanya saat mode edit
  decorate();
  refreshBarLabels();
  if (st.compareOn) renderCompare();
  st.idx = -2; // paksa perbarui panggung
  st.barIdx = -2;
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
  if (st.compareOn) moveCompareHead(t);
  syncBars(t);

  const idx = findSegmentIndex(st.segs, t);
  if (idx === st.idx) return;
  st.idx = idx;

  const label = idx >= 0 ? st.segs[idx].label : 'N';
  const now = $('nowChord');
  now.textContent = show(label);
  now.classList.toggle('none', label === 'N');
  $('dockChord').textContent = show(label);
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

// ---------- ketukan & birama ----------

function recomputeBars() {
  const b = st.beats;
  st.bars = b?.beats?.length > 1 ? barChords(buildGrid(b.beats, b.meter, b.phase), st.segs) : [];
}

const barText = (bar) => (bar.hold ? '•' : bar.chords.length ? bar.chords.map(show).join(' ') : '–');

function buildBarTimeline() {
  const tl = $('timeline');
  tl.replaceChildren();
  st.barBoxes = st.bars.map((bar) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.className = 'tl-box bar' + (bar.hold ? ' hold' : '') + (bar.n === 0 ? ' downbeat0' : '');
    b.append(document.createElement('strong'), document.createElement('small'));
    b.addEventListener('click', () => { st.lastUserScroll = 0; seekTo(bar.start + 0.001); });
    tl.append(b);
    return b;
  });
  refreshBarLabels();
}

function refreshBarLabels() {
  if (!st.barMode) return;
  st.barBoxes.forEach((b, i) => {
    const bar = st.bars[i];
    b.firstChild.textContent = barText(bar);
    b.lastChild.textContent = bar.n === 0 ? 'awal' : `bar ${bar.n}`;
    b.style.minWidth = `${Math.max(76, 40 + 46 * Math.max(1, bar.hold ? 1 : bar.chords.length))}px`;
  });
}

function syncBars(t) {
  if (!st.barMode) return;
  const bi = barIndexAt(st.bars, t);
  if (bi === st.barIdx) return;
  st.barIdx = bi;
  st.barBoxes.forEach((b, i) => b.classList.toggle('on', i === bi));
  const box = st.barBoxes[bi];
  if (box && Date.now() - st.lastUserScroll >= USER_SCROLL_PAUSE_MS) {
    const tl = $('timeline');
    tl.scrollTo({ left: box.offsetLeft - (tl.clientWidth - box.offsetWidth) / 2, behavior: 'smooth' });
  }
}

function setBarMode(on) {
  if (on && !st.bars.length) { toast('Belum ada data ketukan. Ketuk "Hitung ketukan".'); on = false; }
  if (on && st.compareOn) setCompare(false);
  st.barMode = on;
  st.barIdx = -2;
  $('barToggle').setAttribute('aria-pressed', String(on));
  if (on) buildBarTimeline(); else buildTimeline();
  refreshLabels();
}

function renderRhythm() {
  const b = st.beats;
  $('rhythmCard').classList.toggle('has-beats', !!b);
  $('barToggle').hidden = !b;
  $('snapBtn').hidden = !b;
  $('beatCalc').textContent = b ? 'Hitung ulang' : 'Hitung ketukan';
  if (!b) { $('beatInfo').textContent = 'Belum dihitung'; return; }
  const bpm = Math.round(bpmFromBeats(b.beats) * 10) / 10;
  $('beatInfo').textContent = `${bpm} BPM · ${b.meter} ketukan per birama · ${st.bars.length} birama`;
  buildSegmented($('meterSeg'), METERS, b.meter, setMeter);
  $('metroBtn').setAttribute('aria-pressed', String(metro.on));
  $('countInBtn').setAttribute('aria-pressed', String(st.countInOn));
  $('countInBtn').textContent = `Hitung mundur ${b.meter} ketukan`;
}

function commitBeats(patch) {
  st.beats = { ...st.beats, ...patch };
  recomputeBars();
  if (st.barMode) { st.barIdx = -2; buildBarTimeline(); syncBars(audio.currentTime || 0); }
  renderRhythm();
  clearTimeout(st.beatSaveTimer);
  st.beatSaveTimer = setTimeout(() => {
    api.saveBeats(st.song.id, st.beats).catch((e) => toast(humanizeError(e)));
  }, 700);
}

function setMeter(meter) {
  commitBeats({ meter, phase: pickPhase(st.beats.beats, st.segs, meter).phase });
}
function shiftPhase(d) {
  const { meter, phase } = st.beats;
  commitBeats({ phase: (phase + d + meter) % meter });
}
function changeTempoOctave(dir) {
  const src = st.beats.beats;
  if (dir < 0 && src.length < 8) return toast('Ketukan terlalu sedikit untuk dibagi dua.');
  const beats = dir > 0 ? doubleTempo(src) : halveTempo(src);
  commitBeats({ beats, bpm: Math.round(bpmFromBeats(beats) * 10) / 10, phase: pickPhase(beats, st.segs, st.beats.meter).phase });
}

async function calcBeats() {
  const btn = $('beatCalc');
  btn.disabled = true;
  try {
    btn.textContent = 'Mengunduh audio…';
    const dec = await decodeAudio(await api.downloadAudio(st.song));
    btn.textContent = 'Menghitung…';
    const beats = await analyzeBeats(dec.samples, dec.sampleRate, st.segs);
    await api.saveBeats(st.song.id, beats);
    st.beats = beats;
    recomputeBars();
    if (st.barMode) buildBarTimeline();
    renderRhythm();
    toast(`Ketukan ditemukan: ${beats.bpm} BPM.`);
  } catch (e) {
    toast(humanizeError(e));
    renderRhythm();
  } finally {
    btn.disabled = false;
  }
}

/** Loop dari birama yang sedang berbunyi sepanjang `count` birama. */
function loopBars(count) {
  const bi = Math.max(0, barIndexAt(st.bars, audio.currentTime || 0));
  const first = st.bars[bi], last = st.bars[Math.min(st.bars.length - 1, bi + count - 1)];
  if (!first) return;
  st.loopA = first.start;
  st.loopB = last.end;
  updateLoopInfo();
  toast(`Loop ${last === first ? 'birama ' + first.n : `birama ${first.n}–${last.n}`}. Tekan Putar.`);
}

// ---------- bandingkan hasil mesin vs koreksi ----------

function renderCompare() {
  const wrap = $('compare');
  const d = duration();
  const marks = st.autoSegs ? diffMarks(st.autoSegs, st.segs) : { a: [], b: [] };
  const keepScroll = wrap.querySelector('.cmp-scroll')?.scrollLeft ?? 0;

  const row = (caption, segs, flags, corrected) => [
    h('span', { class: 'cmp-cap' }, caption),
    h('div', {
      class: 'cmp-row',
      onclick: (e) => {
        const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
        st.lastUserScroll = 0;
        seekTo(x / CMP_PX_PER_SEC);
      },
    }, segs.map((s, i) => {
      const w = Math.max(3, (s.end - s.start) * CMP_PX_PER_SEC);
      return h('div', {
        class: `cmp-box${flags[i] ? ' diff' : ''}${corrected && st.editing && st.selected === i ? ' sel' : ''}`,
        style: `left:${s.start * CMP_PX_PER_SEC}px;width:${w}px`,
        title: `${show(s.label)} · ${fmtTime(s.start)}`,
        onclick: corrected && st.editing ? (e) => { e.stopPropagation(); editor.select(i); } : null,
      }, w >= 26 ? show(s.label) : null);
    })),
  ];

  const inner = h('div', { class: 'cmp-inner', style: `width:${Math.max(d, st.segs.at(-1)?.end ?? 0) * CMP_PX_PER_SEC}px` },
    row('Mesin (auto)', st.autoSegs ?? [], marks.a, false),
    row('Koreksi', st.segs, marks.b, true),
    h('div', { class: 'cmp-head', id: 'cmpHead' }));
  const nDiff = marks.b.filter(Boolean).length;
  wrap.replaceChildren(
    h('div', { class: 'cmp-scroll', id: 'cmpScroll' }, inner),
    h('p', { class: 'cmp-legend muted' }, nDiff ? `${nDiff} segmen koreksi berbeda dari mesin (berwarna).` : 'Belum ada perbedaan dari hasil mesin.'));
  $('cmpScroll').scrollLeft = keepScroll;
  for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
    $('cmpScroll').addEventListener(ev, () => { st.lastUserScroll = Date.now(); }, { passive: true });
  }
  moveCompareHead(audio.currentTime || 0, false);
}

function moveCompareHead(t, follow = true) {
  const head = $('cmpHead');
  if (!head) return;
  head.style.left = `${t * CMP_PX_PER_SEC}px`;
  const sc = $('cmpScroll');
  if (follow && !audio.paused && sc && Date.now() - st.lastUserScroll > USER_SCROLL_PAUSE_MS) {
    const x = t * CMP_PX_PER_SEC;
    if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 40) sc.scrollLeft = x - sc.clientWidth / 3;
  }
}

function setCompare(on) {
  if (on && !st.autoSegs) { toast('Tidak ada hasil mesin untuk dibandingkan.'); return; }
  if (on && st.barMode) setBarMode(false);
  st.compareOn = on;
  $('compareToggle').setAttribute('aria-pressed', String(on));
  $('compare').hidden = !on;
  $('timeline').hidden = on;
  if (on) renderCompare();
}

// ---------- mode edit ----------

/** Dipanggil editor saat segmen berubah: pasang segmen baru, bangun ulang lini waktu, pertahankan posisi putar. */
function setSegments(segs, selected) {
  st.segs = segs;
  st.selected = selected;
  buildTimeline();
  refreshLabels();
  if (selected !== null) centerOnBox(selected);
}

function centerOnBox(i) {
  const box = st.boxes[i], tl = $('timeline');
  if (box && !tl.hidden) tl.scrollTo({ left: box.offsetLeft - (tl.clientWidth - box.offsetWidth) / 2, behavior: 'smooth' });
}

const editor = createEditor({
  audio, api, toast, seekTo,
  songId: () => st.song.id,
  getSegs: () => st.segs,
  setSegs: setSegments,
  spelling: editSpelling,
  duration,
  setLoop: (a, b) => { st.loopA = a; st.loopB = b; updateLoopInfo(); },
  autoSegs: () => st.autoSegs,
  beats: () => st.beats?.beats ?? [],
  btcSegs: () => st.btcSegs,
  async computeBtc(onProgress) {
    onProgress(0);
    const dec = await decodeAudio(await api.downloadAudio(st.song));
    const segs = await analyzeBtc(dec.samples, dec.sampleRate, onProgress);
    if (!segs.length) throw new Error('hasil kosong');
    await api.saveLabels(st.song.id, 'btc', segs);
    st.btcSegs = segs;
  },
  onSaved: () => {
    st.version = 'corrected';
    $('versionInfo').textContent = 'Versi koreksi';
  },
});

async function setEditing(on) {
  if (on === st.editing) return;
  if (on && st.barMode) setBarMode(false);
  st.editing = on;
  $('editToggle').setAttribute('aria-pressed', String(on));
  for (const id of ['trDown', 'trUp', 'trReset', 'capoDown', 'capoUp']) $(id).disabled = on; // transpose/capo tidak berlaku saat edit
  $('barToggle').disabled = on;
  if (on) {
    editor.enter();
    st.selected = null;
    toast('Mode edit: ketuk kotak chord untuk mengedit.');
  } else {
    await editor.exit(); // tunggu penyimpanan terakhir
    st.selected = null;
    st.key = estimateKey(st.segs); // key bisa berubah setelah koreksi
    recomputeBars();
    renderRhythm();
  }
  refreshLabels();
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
  if (st.counting) { st.counting.cancel(); st.counting = null; $('playBtn').textContent = '▶ Putar'; return; }
  if (!audio.paused) { audio.pause(); return; }
  try {
    if (st.countInOn && st.beats) {
      $('playBtn').textContent = '… hitung mundur';
      st.counting = countIn(metro.engine, st.beats.meter, st.beats.bpm, st.speed);
      const go = await st.counting.promise;
      st.counting = null;
      if (!go) return;
    }
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
  if (st.compareOn) renderCompare();
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

  $('barToggle').addEventListener('click', () => setBarMode(!st.barMode));
  $('beatCalc').addEventListener('click', () => {
    if (st.beats && !confirm('Hitung ulang ketukan? Pengaturan birama dan downbeat yang sudah kamu ubah akan diganti.')) return;
    calcBeats();
  });
  $('tempoHalf').addEventListener('click', () => changeTempoOctave(-1));
  $('tempoDouble').addEventListener('click', () => changeTempoOctave(1));
  $('phaseDown').addEventListener('click', () => shiftPhase(-1));
  $('phaseUp').addEventListener('click', () => shiftPhase(1));
  $('metroBtn').addEventListener('click', () => { metro.set(!metro.on); $('metroBtn').setAttribute('aria-pressed', String(metro.on)); });
  $('countInBtn').addEventListener('click', () => { st.countInOn = !st.countInOn; savePrefs(); renderRhythm(); });
  $('loopBar1').addEventListener('click', () => loopBars(1));
  $('loopBar4').addEventListener('click', () => loopBars(4));

  $('editToggle').addEventListener('click', () => setEditing(!st.editing));
  $('compareToggle').addEventListener('click', () => setCompare(!st.compareOn));

  // pintasan keyboard (laptop): spasi = putar/jeda, panah = ±5 dtk
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey) return;
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
    const [{ version, segments }, auto, btc] = await Promise.all([
      api.getLabelsWithFallback(id, 'corrected'), api.getLabels(id, 'auto'), api.getLabels(id, 'btc').catch(() => null)]);
    if (!segments?.length) return fail('Lagu ini belum dianalisis. Kembali ke daftar lalu jalankan analisis.');

    st.song = song;
    st.version = version;
    st.segs = [...segments].sort((a, b) => a.start - b.start);
    st.btcSegs = btc?.length ? [...btc].sort((a, b) => a.start - b.start) : null;
    st.autoSegs = auto?.length ? [...auto].sort((a, b) => a.start - b.start) : null;
    st.key = estimateKey(st.segs);
    st.beats = song.beats?.beats?.length > 1 ? song.beats : null;
    recomputeBars();
    loadPrefs();
    $('songTitle').textContent = song.name;
    $('sheetLink').href = `sheet.html?id=${song.id}`;
    document.title = `${song.name} · Chord Finder`;
    $('versionInfo').textContent = version === 'corrected' ? 'Versi koreksi' : 'Hasil mesin (belum dikoreksi)';

    buildTimeline();
    wireControls();
    updateSteppers();
    updateLoopInfo();
    renderRhythm();
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
