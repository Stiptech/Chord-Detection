// Lembar chord: tampilan seperti lembar cetak (chord di atas lirik) + penyusunan lirik dan sinkron ketukan.
// Logika penempatan ada di sheet-logic.js (teruji di Node); berkas ini hanya DOM, simpan otomatis, dan pemutaran.
import { supabase } from './supabase.js';
import { createApi, humanizeError } from './api.js';
import { REQUIRE_LOGIN } from './supabase-config.js';
import { spellingForKey, transposeChord, estimateKey, keyName } from './transpose.js';
import { clamp, fmtTime, fmtTimePrecise } from './player-logic.js';
import { layoutSheet, needsTime, nextUnsynced, parseLyrics, pruneTimes, resolveTimes, sheetToText } from './sheet-logic.js';
import { h } from './dom.js';

const api = createApi(supabase);
const $ = (id) => document.getElementById(id);
const audio = $('audio');

const SPELLINGS = [['auto', 'Otomatis'], ['sharp', '♯'], ['flat', '♭']];
const REACTION_SEC = 0.25; // waktu ketuk dikurangi waktu reaksi manusia
const SAVE_DELAY_MS = 800;
const FONT_MIN = 11, FONT_MAX = 28;

const st = {
  song: null, segs: [], key: null,
  sheet: { v: 1, lyrics: '', times: {} }, items: [], cursor: -1, undo: [],
  transpose: 0, capo: 0, spelling: 'auto', fontSize: 17, tab: 'sheet',
  dirty: false, saving: false, error: null, savedAt: null, timer: 0,
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

const r2 = (v) => Math.round(v * 100) / 100;
const prefsKey = () => `chordfinder:prefs:${st.song.id}`; // sama dengan pemutar: transpose/capo/ejaan dibagi

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(prefsKey()) || '{}');
    st.transpose = clamp(Number(p.transpose) || 0, -6, 6);
    st.capo = clamp(Number(p.capo) || 0, 0, 11);
    if (SPELLINGS.some(([v]) => v === p.spelling)) st.spelling = p.spelling;
    st.fontSize = clamp(Number(localStorage.getItem('chordfinder:sheet-font')) || 17, FONT_MIN, FONT_MAX);
  } catch { /* penyimpanan browser mungkin diblokir */ }
}
function savePrefs() {
  try {
    const old = JSON.parse(localStorage.getItem(prefsKey()) || '{}');
    localStorage.setItem(prefsKey(), JSON.stringify({ ...old, transpose: st.transpose, capo: st.capo, spelling: st.spelling }));
    localStorage.setItem('chordfinder:sheet-font', String(st.fontSize));
  } catch { /* abaikan */ }
}

// ---------- nama chord yang ditampilkan (sama dengan pemutar) ----------

const shift = () => st.transpose - st.capo; // bentuk yang dimainkan = nada dasar - capo
function spellFor(tonicPc) {
  if (st.spelling !== 'auto') return st.spelling;
  return st.key ? spellingForKey(tonicPc, st.key.mode) : 'sharp';
}
const show = (label) => transposeChord(label, shift(), spellFor((st.key?.tonicPc ?? 0) + shift()));

function keyText() {
  if (!st.key) return 'Key: ?';
  const { tonicPc, mode } = st.key;
  const sound = (tonicPc + st.transpose + 120) % 12;
  const shape = (tonicPc + shift() + 120) % 12;
  const base = `Key: ${keyName(sound, mode, spellFor(sound))}`;
  return st.capo ? `${base}  Capo ${st.capo} (bentuk ${keyName(shape, mode, spellFor(shape))})` : base;
}

// ---------- simpan otomatis ----------

function renderSave() {
  const el = $('saveState');
  let text = 'Belum ada perubahan', cls = 'muted';
  if (st.error) { text = `Gagal menyimpan: ${st.error} — ketuk untuk coba lagi`; cls = 'error'; }
  else if (st.saving) text = 'Menyimpan…';
  else if (st.dirty) text = 'Perubahan belum tersimpan…';
  else if (st.savedAt) { text = `Tersimpan ✓ ${st.savedAt}`; cls = 'ok'; }
  el.textContent = text;
  el.className = `savestate ${cls}`;
}

function schedule() {
  st.dirty = true;
  st.error = null;
  renderSave();
  clearTimeout(st.timer);
  st.timer = setTimeout(flush, SAVE_DELAY_MS);
}

async function flush() {
  clearTimeout(st.timer);
  if (st.saving || !st.dirty) return;
  st.saving = true;
  st.dirty = false;
  renderSave();
  try {
    await api.saveSheet(st.song.id, st.sheet);
    st.savedAt = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    st.dirty = true;
    st.error = humanizeError(e);
  } finally {
    st.saving = false;
    renderSave();
  }
  if (st.dirty && !st.error) await flush();
}

window.addEventListener('beforeunload', (e) => { if (st.dirty || st.saving) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && st.dirty) flush(); });
$('saveState').addEventListener('click', () => { if (st.error) flush(); });

// ---------- lembar ----------

function currentBlocks() {
  const items = resolveTimes(st.items, st.sheet.times);
  return { items, blocks: layoutSheet(items, st.segs, { show, endTime: st.song.duration_sec || undefined }) };
}

function renderSheet() {
  const out = $('sheetOut');
  out.style.setProperty('--sheet-size', `${st.fontSize}px`);
  $('fsVal').textContent = String(st.fontSize);
  $('trVal').textContent = st.transpose > 0 ? `+${st.transpose}` : String(st.transpose);
  $('capoVal').textContent = String(st.capo);

  if (!st.items.length) {
    out.replaceChildren(
      h('div', { class: 'sheet-key' }, keyText()),
      h('div', { class: 'empty-sheet' },
        h('p', {}, 'Belum ada lirik. Tempel liriknya dulu, lalu tandai awal tiap baris sambil memutar lagu.'),
        h('button', { class: 'btn primary noprint', type: 'button', onclick: () => setTab('edit') }, '✎ Susun lirik & sinkron')));
    $('sheetHint').hidden = true;
    return;
  }

  const { items, blocks } = currentBlocks();
  const missing = items.filter((it, i) => needsTime(items, i) && !Number.isFinite(it.t)).length;
  $('sheetHint').hidden = missing === 0;
  $('sheetHint').textContent = `${missing} baris/bagian belum ditandai waktunya, jadi belum ada chordnya. Buka "Susun lirik & sinkron".`;

  const nodes = [h('div', { class: 'sheet-key' }, keyText())];
  for (const b of blocks) {
    if (b.kind === 'section') nodes.push(h('div', { class: 'sec' }, h('span', { class: 'sec-pill' }, b.name)));
    else if (b.kind === 'bars') nodes.push(b.lines.length
      ? b.lines.map((l) => h('pre', { class: 'bars' }, l))
      : h('pre', { class: 'bars' }, b.synced ? '(tidak ada chord)' : '(belum ditandai)'));
    else nodes.push(h('div', { class: `lyric${b.synced ? '' : ' nosync'}` }, b.synced && h('pre', { class: 'cl' }, b.chordLine || ' '), h('pre', { class: 'wl' }, b.text)));
  }
  out.replaceChildren(...nodes.flat());
}

function textExport() {
  const { blocks } = currentBlocks();
  return sheetToText(blocks, { title: st.song.name, keyText: keyText() });
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text); // cadangan untuk browser yang menolak clipboard API
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Browser menolak menyalin. Pakai "Unduh .txt".');
  }
}

// ---------- susun & sinkron ----------

function applyLyrics(text) {
  st.sheet.lyrics = text;
  st.items = parseLyrics(text);
  st.sheet.times = pruneTimes(st.items, st.sheet.times);
  st.cursor = nextUnsynced(st.items, st.sheet.times);
  st.undo = [];
}

function setTime(key, t) {
  st.undo.push({ ...st.sheet.times });
  if (st.undo.length > 100) st.undo.shift();
  if (t === null) delete st.sheet.times[key];
  else st.sheet.times[key] = Math.max(0, r2(t));
  schedule();
}

function setCursor(i) {
  st.cursor = i;
  renderSync();
}

function tap() {
  if (!st.items.length) return toast('Tempel dan terapkan liriknya dulu.');
  const i = st.cursor >= 0 && needsTime(st.items, st.cursor) ? st.cursor : nextUnsynced(st.items, st.sheet.times);
  if (i < 0) return toast('Semua baris sudah ditandai.');
  setTime(st.items[i].key, audio.currentTime - REACTION_SEC);
  st.cursor = nextUnsynced(st.items, st.sheet.times);
  renderSync();
  document.querySelector('.sync-row.next')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function undoTap() {
  const prev = st.undo.pop();
  if (!prev) return toast('Tidak ada ketukan untuk diurungkan.');
  st.sheet.times = prev;
  st.cursor = nextUnsynced(st.items, st.sheet.times);
  schedule();
  renderSync();
}

const mini = (text, onclick, aria) => h('button', { type: 'button', class: 'btn small', onclick, 'aria-label': aria }, text);

function renderSync() {
  const list = $('syncList');
  const times = st.sheet.times;
  if (!st.items.length) { list.replaceChildren(h('p', { class: 'muted small-note' }, 'Belum ada lirik. Tempel di atas lalu tekan "Terapkan lirik".')); renderTapBar(); return; }
  list.replaceChildren(...st.items.map((it, i) => {
    if (it.type === 'section' && !needsTime(st.items, i)) return h('div', { class: 'sync-sec' }, `▸ ${it.name}`);
    const t = times[it.key];
    const done = Number.isFinite(t);
    const label = it.type === 'section' ? `[${it.name}] bagian chord, tandai awalnya` : it.text;
    return h('div', { class: `sync-row${done ? ' done' : ''}${i === st.cursor ? ' next' : ''}`, 'data-i': String(i) },
      h('button', { type: 'button', class: 'sync-pick', onclick: () => setCursor(i) },
        h('span', { class: 'sync-time' }, done ? fmtTimePrecise(t) : '—'), h('span', { class: 'sync-text' }, label)),
      done && h('div', { class: 'sync-ctl' },
        mini('▶', () => { audio.currentTime = Math.max(0, t - 1); audio.play().catch(() => {}); }, 'Putar dari sini'),
        mini('−0,1', () => { setTime(it.key, t - 0.1); renderSync(); }),
        mini('+0,1', () => { setTime(it.key, t + 0.1); renderSync(); }),
        mini('= posisi', () => { setTime(it.key, audio.currentTime); renderSync(); }),
        mini('✕', () => { setTime(it.key, null); st.cursor = i; renderSync(); }, 'Hapus waktu')));
  }));
  renderTapBar();
}

function renderTapBar() {
  const i = st.cursor >= 0 ? st.cursor : nextUnsynced(st.items, st.sheet.times);
  const it = st.items[i];
  $('tapNext').textContent = it ? (it.type === 'section' ? `[${it.name}]` : it.text) : st.items.length ? 'semua sudah ditandai ✓' : '–';
  $('tapBtn').disabled = !it;
}

function markNowPlaying() {
  const t = audio.currentTime;
  let now = -1;
  st.items.forEach((it, i) => {
    const v = st.sheet.times[it.key];
    if (needsTime(st.items, i) && Number.isFinite(v) && v <= t) now = i;
  });
  document.querySelectorAll('.sync-row').forEach((r) => r.classList.toggle('now', Number(r.dataset.i) === now));
}

// ---------- tab & kontrol ----------

function setTab(tab) {
  st.tab = tab;
  $('tabSheet').setAttribute('aria-pressed', String(tab === 'sheet'));
  $('tabEdit').setAttribute('aria-pressed', String(tab === 'edit'));
  $('paneSheet').hidden = tab !== 'sheet';
  $('paneEdit').hidden = tab !== 'edit';
  $('dock').hidden = tab !== 'edit';
  document.body.classList.toggle('syncing', tab === 'edit');
  if (tab === 'sheet') { audio.pause(); renderSheet(); } else renderSync();
}

function buildSegmented(el, items, current, onPick) {
  el.replaceChildren(...items.map(([value, label]) => h('button', {
    type: 'button', 'data-value': String(value), onclick: () => { onPick(value); for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(value))); },
  }, label)));
  for (const b of el.children) b.setAttribute('aria-pressed', String(b.dataset.value === String(current)));
}

function changeView(fn) {
  fn();
  savePrefs();
  renderSheet();
}

function wire() {
  $('tabSheet').addEventListener('click', () => setTab('sheet'));
  $('tabEdit').addEventListener('click', () => setTab('edit'));
  $('trDown').addEventListener('click', () => changeView(() => { st.transpose = clamp(st.transpose - 1, -6, 6); }));
  $('trUp').addEventListener('click', () => changeView(() => { st.transpose = clamp(st.transpose + 1, -6, 6); }));
  $('trReset').addEventListener('click', () => changeView(() => { st.transpose = 0; st.capo = 0; }));
  $('capoDown').addEventListener('click', () => changeView(() => { st.capo = clamp(st.capo - 1, 0, 11); }));
  $('capoUp').addEventListener('click', () => changeView(() => { st.capo = clamp(st.capo + 1, 0, 11); }));
  $('fsDown').addEventListener('click', () => changeView(() => { st.fontSize = clamp(st.fontSize - 1, FONT_MIN, FONT_MAX); }));
  $('fsUp').addEventListener('click', () => changeView(() => { st.fontSize = clamp(st.fontSize + 1, FONT_MIN, FONT_MAX); }));
  buildSegmented($('spellSeg'), SPELLINGS, st.spelling, (v) => changeView(() => { st.spelling = v; }));

  $('copyBtn').addEventListener('click', async () => { try { await copyText(textExport()); toast('Teks lembar disalin.'); } catch (e) { toast(e.message); } });
  $('dlBtn').addEventListener('click', () => download(`${st.song.name.replace(/[\\/:*?"<>|]/g, '_')} - lembar chord.txt`, textExport()));
  $('printBtn').addEventListener('click', () => window.print());

  $('applyLyrics').addEventListener('click', () => { applyLyrics($('lyrics').value); schedule(); renderSync(); toast(`${st.items.length} item dibaca.`); });
  $('lyrics').addEventListener('change', () => { if ($('lyrics').value !== st.sheet.lyrics) { applyLyrics($('lyrics').value); schedule(); renderSync(); } });

  $('tapBtn').addEventListener('click', tap);
  $('tapUndo').addEventListener('click', undoTap);
  $('playBtn').addEventListener('click', async () => { if (audio.paused) { try { await audio.play(); } catch { toast('Audio belum bisa diputar. Ketuk lagi.'); } } else audio.pause(); });
  $('back5').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); });
  $('fwd5').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 5); });
  const seek = $('seek');
  seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); });

  audio.addEventListener('play', () => { $('playBtn').textContent = '⏸ Jeda'; });
  audio.addEventListener('pause', () => { $('playBtn').textContent = '▶ Putar'; });
  audio.addEventListener('loadedmetadata', () => { seek.max = String(audio.duration); $('totTime').textContent = fmtTime(audio.duration); });
  audio.addEventListener('timeupdate', () => { seek.value = String(audio.currentTime); $('curTime').textContent = fmtTime(audio.currentTime); markNowPlaying(); });
  // URL bertanda tangan bisa gagal/kedaluwarsa: minta yang baru sekali lalu lanjut dari posisi yang sama
  let retried = false;
  audio.addEventListener('error', async () => {
    if (retried || !st.song) return toast('Audio tidak bisa dimuat. Muat ulang halaman.');
    retried = true;
    const resume = audio.currentTime || 0;
    try {
      audio.src = await api.getAudioUrl(st.song);
      audio.addEventListener('loadedmetadata', () => { audio.currentTime = resume; }, { once: true });
    } catch (e) { toast(humanizeError(e)); }
  });

  document.addEventListener('keydown', (e) => {
    if (st.tab !== 'edit' || e.ctrlKey || e.metaKey) return;
    const tag = e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); tap(); }
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
    const { segments } = await api.getLabelsWithFallback(id, 'corrected');
    if (!segments?.length) return fail('Lagu ini belum dianalisis. Kembali ke daftar lalu jalankan analisis.');

    st.song = song;
    st.segs = [...segments].sort((a, b) => a.start - b.start);
    st.key = estimateKey(st.segs);
    const saved = song.sheet && typeof song.sheet === 'object' ? song.sheet : {};
    st.sheet = { v: 1, lyrics: typeof saved.lyrics === 'string' ? saved.lyrics : '', times: saved.times && typeof saved.times === 'object' ? saved.times : {} };
    st.items = parseLyrics(st.sheet.lyrics);
    st.sheet.times = pruneTimes(st.items, st.sheet.times);
    st.cursor = nextUnsynced(st.items, st.sheet.times);
    loadPrefs();

    $('songTitle').textContent = song.name;
    $('backLink').href = `player.html?id=${song.id}`;
    document.title = `Lembar · ${song.name} · Chord Finder`;
    $('lyrics').value = st.sheet.lyrics;
    $('totTime').textContent = fmtTime(song.duration_sec || 0);
    wire();
    renderSave();
    $('stateMsg').hidden = true;
    $('sheetView').hidden = false;
    setTab(st.items.length ? 'sheet' : 'edit');
    audio.src = await api.getAudioUrl(song);
  } catch (e) {
    fail(humanizeError(e));
  }
})();
