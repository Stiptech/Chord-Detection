// Halaman daftar lagu: login, tambah file (dekode + unggah + analisis di browser), hasil, ekspor/impor.
import { supabase } from './supabase.js';
import { createApi, humanizeError } from './api.js';
import { decodeAudio, sha256Hex } from './audio.js';
import { analyzeSamples } from './analysis.js';
import { formatLab, parseLab, validateSegments } from './labels.js';
import { REQUIRE_LOGIN } from './supabase-config.js';
import { h } from './dom.js';

const api = createApi(supabase);
const MAX_BYTES = 50 * 1024 * 1024; // sama dengan batas bucket
const STATUS = {
  uploaded: ['Belum dianalisis', 'idle'],
  analyzing: ['Menganalisis…', 'warn'],
  ready: ['Siap', 'ok'],
  error: ['Gagal', 'bad'],
};

const $ = (id) => document.getElementById(id);
const state = {
  songs: [],
  pending: [], // file yang sedang diproses sebelum punya id: {key, name, text, progress, error}
  busy: new Map(), // id lagu -> {text, progress} untuk (re)analisis yang sedang berjalan di tab ini
  open: new Set(), // id lagu yang hasilnya sedang dibuka
  labels: new Map(), // id -> {version, segments}
  labTarget: null,
};

// ---------- util ----------

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4500);
}

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'lagu';

// ---------- render ----------

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const list = $('songList');
    list.replaceChildren(
      ...state.pending.map(pendingCard),
      ...state.songs.map(songCard),
    );
    $('emptyMsg').hidden = state.songs.length + state.pending.length > 0;
  });
}

function progressBar(p) {
  return h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': Math.round(p * 100) },
    h('span', { style: `width:${Math.round(p * 100)}%` }));
}

function pendingCard(item) {
  return h('article', { class: 'card' },
    h('div', { class: 'song-head' },
      h('div', {}, h('div', { class: 'song-name' }, item.name), h('div', { class: 'song-meta' }, item.error ? '' : item.text)),
      h('span', { class: `badge ${item.error ? 'bad' : 'warn'}` }, item.error ? 'Gagal' : 'Proses'),
    ),
    item.error ? h('p', { class: 'note error' }, item.error) : progressBar(item.progress),
    item.error && h('div', { class: 'actions' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { state.pending = state.pending.filter((p) => p !== item); render(); } }, 'Tutup')),
  );
}

function songCard(song) {
  const busy = state.busy.get(song.id);
  // 'analyzing' di database tapi tidak berjalan di tab ini = proses terputus (tab ditutup).
  const stale = song.status === 'analyzing' && !busy;
  const [label, tone] = stale ? ['Terputus', 'bad'] : STATUS[song.status] ?? [song.status, 'idle'];
  const meta = [song.duration_sec ? fmtTime(song.duration_sec) : null, song.size_bytes ? fmtSize(song.size_bytes) : null]
    .filter(Boolean).join(' · ');
  const isOpen = state.open.has(song.id);

  return h('article', { class: 'card' },
    h('div', { class: 'song-head' },
      h('div', {}, h('div', { class: 'song-name' }, song.name), h('div', { class: 'song-meta' }, meta)),
      h('span', { class: `badge ${tone}` }, busy ? 'Proses' : label),
    ),
    busy && h('p', { class: 'note muted' }, busy.text),
    busy && progressBar(busy.progress),
    !busy && song.status === 'error' && h('p', { class: 'note error' }, song.error || 'Terjadi kesalahan.'),
    stale && h('p', { class: 'note error' }, 'Analisis terputus (halaman ditutup). Analisis ulang untuk melanjutkan.'),
    h('div', { class: 'actions' },
      !busy && song.status === 'ready' && h('a', { class: 'btn small primary', href: `player.html?id=${song.id}` }, '▶ Buka pemutar'),
      !busy && song.status === 'ready' && h('button', { class: 'btn small', type: 'button', onclick: () => toggleResult(song) }, isOpen ? 'Sembunyikan chord' : 'Lihat chord'),
      !busy && h('button', { class: 'btn small', type: 'button', onclick: () => reanalyze(song) }, song.status === 'uploaded' ? 'Analisis' : 'Analisis ulang'),
      !busy && song.status === 'ready' && h('button', { class: 'btn small', type: 'button', onclick: () => exportLab(song) }, 'Ekspor .lab'),
      !busy && h('button', { class: 'btn small', type: 'button', onclick: () => pickLab(song) }, 'Impor .lab'),
      !busy && h('button', { class: 'btn small danger', type: 'button', onclick: () => removeSong(song) }, 'Hapus'),
    ),
    isOpen && resultView(song),
  );
}

function resultView(song) {
  const data = state.labels.get(song.id);
  if (!data) return h('p', { class: 'note muted' }, 'Memuat chord…');
  return h('div', {},
    h('p', { class: 'note muted' }, data.version === 'corrected' ? 'Versi koreksi' : 'Hasil mesin (belum dikoreksi)'),
    h('div', { class: 'chords' }, data.segments.map((s) =>
      h('span', { class: 'chip' }, h('b', {}, s.label), h('small', {}, fmtTime(s.start))))),
  );
}

// ---------- aksi ----------

async function refreshSongs() {
  state.songs = await api.listSongs();
  render();
}

async function toggleResult(song) {
  if (state.open.has(song.id)) state.open.delete(song.id);
  else {
    state.open.add(song.id);
    render();
    try {
      state.labels.set(song.id, await api.getLabelsWithFallback(song.id, 'corrected'));
    } catch (e) {
      state.open.delete(song.id);
      toast(humanizeError(e));
    }
  }
  render();
}

function patchSong(song) {
  const i = state.songs.findIndex((s) => s.id === song.id);
  if (i >= 0) state.songs[i] = song;
}

/** Jalankan analisis di browser lalu simpan hasilnya (versi 'baseline' dan 'auto'). */
async function analyzeAndSave(song, audio) {
  const busy = { text: 'Menganalisis…', progress: 0 };
  state.busy.set(song.id, busy);
  render();
  try {
    patchSong(await api.updateSong(song.id, { status: 'analyzing', error: null }));
    const segments = await analyzeSamples(audio.samples, audio.sampleRate, (p) => {
      busy.progress = p;
      busy.text = `Menganalisis… ${Math.round(p * 100)}%`;
      render();
    });
    busy.text = 'Menyimpan hasil…';
    await api.saveLabels(song.id, 'baseline', segments);
    await api.saveLabels(song.id, 'auto', segments); // 'auto' = analisis terakhir; koreksi tidak menyentuhnya
    patchSong(await api.updateSong(song.id, { status: 'ready', detector: 'baseline', error: null }));
    state.labels.delete(song.id);
  } catch (e) {
    const message = humanizeError(e);
    try { patchSong(await api.updateSong(song.id, { status: 'error', error: message })); } catch { /* jaringan mati: abaikan */ }
    toast(message);
  } finally {
    state.busy.delete(song.id);
    render();
  }
}

async function reanalyze(song) {
  state.busy.set(song.id, { text: 'Mengunduh audio…', progress: 0 });
  render();
  let audio;
  try {
    audio = await decodeAudio(await api.downloadAudio(song));
  } catch (e) {
    state.busy.delete(song.id);
    toast(humanizeError(e));
    render();
    return;
  }
  await analyzeAndSave(song, audio);
}

async function addOne(file) {
  const item = { key: Symbol(file.name), name: file.name, text: 'Membaca file…', progress: 0.02, error: null };
  state.pending.push(item);
  const step = (text, progress) => { item.text = text; item.progress = progress; render(); };
  render();
  try {
    if (file.size > MAX_BYTES) throw new Error(`File terlalu besar (${fmtSize(file.size)}). Maksimal 50 MB.`);
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    const dup = state.songs.find((s) => s.audio_hash === hash);
    if (dup) throw new Error(`File ini sudah ada sebagai "${dup.name}".`);

    step('Mendekode audio…', 0.15);
    const audio = await decodeAudio(buf); // gagal di sini = file tidak ikut terunggah

    step('Mengunggah…', 0.35);
    const song = await api.addSong(file, { hash, duration: audio.duration });
    state.songs.unshift(song);
    state.pending = state.pending.filter((p) => p !== item);
    render();
    await analyzeAndSave(song, audio);
  } catch (e) {
    item.error = humanizeError(e);
    render();
  }
}

async function addFiles(files) {
  for (const f of files) await addOne(f); // satu per satu: hemat RAM di iPad
}

async function removeSong(song) {
  if (!confirm(`Hapus "${song.name}" beserta semua labelnya? Ini tidak bisa dibatalkan.`)) return;
  try {
    await api.deleteSong(song);
    state.songs = state.songs.filter((s) => s.id !== song.id);
    state.open.delete(song.id);
    state.labels.delete(song.id);
    render();
  } catch (e) {
    toast(humanizeError(e));
  }
}

async function exportLab(song) {
  try {
    const { version, segments } = await api.getLabelsWithFallback(song.id, 'corrected');
    if (!segments) return toast('Belum ada label untuk lagu ini.');
    download(`${safeName(song.name)}${version === 'corrected' ? '' : '.auto'}.lab`, formatLab(segments));
  } catch (e) {
    toast(humanizeError(e));
  }
}

function pickLab(song) {
  state.labTarget = song;
  $('labInput').value = '';
  $('labInput').click();
}

async function importLab(file) {
  const song = state.labTarget;
  if (!song || !file) return;
  try {
    const segments = validateSegments(parseLab(await file.text(), file.name));
    const existing = await api.getLabels(song.id, 'corrected');
    if (existing && !confirm('Lagu ini sudah punya koreksi. Timpa dengan isi file ini?')) return;
    await api.saveLabels(song.id, 'corrected', segments);
    state.labels.delete(song.id);
    toast(`${segments.length} segmen diimpor sebagai koreksi.`);
    if (state.open.has(song.id)) {
      state.labels.set(song.id, await api.getLabelsWithFallback(song.id, 'corrected'));
      render();
    }
  } catch (e) {
    toast(humanizeError(e));
  }
}

async function backupAll() {
  try {
    const data = await api.exportAll();
    download(`chordfinder-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
  } catch (e) {
    toast(humanizeError(e));
  }
}

// ---------- login & tampilan ----------

function showView(name) {
  $('loading').hidden = true;
  $('loginView').hidden = name !== 'login';
  $('listView').hidden = name !== 'list';
  $('userBox').hidden = !(name === 'list' && REQUIRE_LOGIN);
}

async function enterOpen() {
  showView('list');
  try {
    await refreshSongs();
  } catch (e) {
    toast(humanizeError(e));
  }
}

async function enter(session) {
  $('userEmail').textContent = session.user.email ?? '';
  showView('list');
  try {
    await refreshSongs();
  } catch (e) {
    toast(humanizeError(e));
  }
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('loginError');
  err.hidden = true;
  $('loginBtn').disabled = true;
  try {
    await enter(await api.signIn($('email').value.trim(), $('password').value));
    $('password').value = '';
  } catch (ex) {
    err.textContent = humanizeError(ex);
    err.hidden = false;
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api.signOut(); } catch (e) { toast(humanizeError(e)); }
});
$('fileInput').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  addFiles(files);
});
$('labInput').addEventListener('change', (e) => importLab(e.target.files[0]));
$('backupBtn').addEventListener('click', backupAll);

// seret & lepas file ke halaman
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  if (!$('listView').hidden) addFiles([...e.dataTransfer.files]);
});

// sinkron dengan perangkat lain saat tab kembali aktif
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('listView').hidden && !state.busy.size && !state.pending.length) {
    refreshSongs().catch(() => {});
  }
});

api.onAuthChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    state.songs = []; state.labels.clear(); state.open.clear();
    showView('login');
  }
});

(async function init() {
  if (!REQUIRE_LOGIN) return enterOpen();
  try {
    const session = await api.getSession();
    if (session) await enter(session);
    else showView('login');
  } catch (e) {
    showView('login');
    const err = $('loginError');
    err.textContent = humanizeError(e);
    err.hidden = false;
  }
})();
