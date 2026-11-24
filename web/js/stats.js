// Halaman statistik: hasil mesin vs koreksi, dihitung di browser dari label di Supabase.
import { supabase } from './supabase.js';
import { createApi, humanizeError } from './api.js';
import { REQUIRE_LOGIN } from './supabase-config.js';
import {
  CLASSES, CLASS_NAMES, METRICS, addEvaluation, classAccuracy, emptyEvaluation, evaluateSegments, score, topConfusions,
} from './evaluate.js';
import { h } from './dom.js';

const api = createApi(supabase);
const $ = (id) => document.getElementById(id);
const REF_VERSION = 'corrected';
const METRIC_HEADS = { root: 'root', majmin: 'majmin', thirds: 'thirds', sevenths: 'sevenths' };

function fail(msg) {
  $('stateMsg').hidden = true;
  $('errorMsg').textContent = msg;
  $('errorMsg').hidden = false;
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function pctCell(v, hint = '') {
  if (v === null || v === undefined) return h('td', { class: 'na', title: hint || 'Tidak ada bagian yang bisa dibandingkan' }, '–');
  const p = 100 * v;
  const tone = p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low';
  return h('td', {}, h('div', { class: `pct ${tone}` }, `${p.toFixed(1)}%`, h('div', { class: 'meter' }, h('span', { style: `width:${Math.min(100, p)}%` }))));
}

function table(head, rows) {
  return h('table', {}, h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows));
}

/** @returns {{songs:{id,name,duration}[], byVersion: Map<string, {name, ev}[]>}} */
function compute(songs, labelRows) {
  const labels = new Map(); // song_id -> {version: segments}
  for (const r of labelRows) {
    if (!labels.has(r.song_id)) labels.set(r.song_id, {});
    labels.get(r.song_id)[r.version] = r.segments;
  }
  const corrected = songs.filter((s) => labels.get(s.id)?.[REF_VERSION]?.length);
  const byVersion = new Map();
  for (const s of corrected) {
    const l = labels.get(s.id);
    for (const [version, est] of Object.entries(l)) {
      if (version === REF_VERSION || !est?.length) continue;
      let ev;
      try { ev = evaluateSegments(l[REF_VERSION], est); } catch { continue; } // label rusak: lewati lagunya
      if (!byVersion.has(version)) byVersion.set(version, []);
      byVersion.get(version).push({ name: s.name, ev });
    }
  }
  return { total: songs.length, corrected, byVersion };
}

const sum = (items) => items.reduce((t, { ev }) => addEvaluation(t, ev), emptyEvaluation());

function versionRank(v) { return v === 'auto' ? 0 : 1; }

function renderVersions(data) {
  const versions = [...data.byVersion.keys()].sort((a, b) => versionRank(a) - versionRank(b) || a.localeCompare(b));
  const rows = versions.map((v) => {
    const total = sum(data.byVersion.get(v));
    return h('tr', {}, h('td', {}, v === 'auto' ? 'auto (analisis terakhir)' : v),
      ...METRICS.map((m) => pctCell(score(total, m))), h('td', {}, String(data.byVersion.get(v).length)), h('td', {}, fmtDur(total.seconds)));
  });
  $('versionTable').replaceChildren(table(['Versi', ...METRICS.map((m) => METRIC_HEADS[m]), 'Lagu', 'Durasi'], rows));
  return versions;
}

function renderDetail(data, version) {
  $('detailVersion').textContent = version;
  const items = data.byVersion.get(version);
  const total = sum(items);

  // per lagu
  const songRows = items.map(({ name, ev }) => h('tr', {}, h('td', {}, name), ...METRICS.map((m) => pctCell(score(ev, m))), h('td', {}, fmtDur(ev.seconds))));
  songRows.push(h('tr', { class: 'total' }, h('td', {}, `Total (${items.length} lagu)`), ...METRICS.map((m) => pctCell(score(total, m))), h('td', {}, fmtDur(total.seconds))));
  $('songTable').replaceChildren(table(['Lagu', ...METRICS.map((m) => METRIC_HEADS[m]), 'Durasi'], songRows));

  // per jenis
  const classRows = CLASSES.map((c) => {
    const a = classAccuracy(total, c);
    return a ? h('tr', {}, h('td', {}, CLASS_NAMES[c]), h('td', {}, `${a.seconds.toFixed(0)} dtk`), pctCell(a.exact), pctCell(a.root)) : null;
  }).filter(Boolean);
  $('classTable').replaceChildren(table(['Jenis chord acuan', 'Durasi', 'Persis sama', 'Nada dasar'], classRows));

  // salah baca
  const conf = topConfusions(total, 15);
  $('confTable').replaceChildren(conf.length
    ? table(['Acuan (koreksimu)', 'Mesin', 'Detik'], conf.map((c) => h('tr', {}, h('td', {}, h('strong', {}, c.ref)), h('td', {}, h('span', { class: 'arrow' }, '→'), c.est), h('td', {}, c.seconds.toFixed(1)))))
    : h('p', { class: 'note muted' }, 'Tidak ada salah baca: hasil mesin sama persis dengan koreksimu.'));
}

(async function init() {
  try {
    if (REQUIRE_LOGIN && !(await api.getSession())) { location.replace('index.html'); return; }
    const [songs, labelRows] = await Promise.all([api.listSongs(), api.listAllLabels()]);
    const data = compute(songs, labelRows);
    $('stateMsg').hidden = true;
    if (!data.corrected.length || !data.byVersion.size) { $('emptyView').hidden = false; return; }

    $('summary').textContent = `${data.corrected.length} dari ${data.total} lagu punya koreksi.`;
    const versions = renderVersions(data);
    const pick = $('versionPick');
    const choose = (v) => {
      for (const b of pick.children) b.setAttribute('aria-pressed', String(b.dataset.value === v));
      renderDetail(data, v);
    };
    pick.replaceChildren(...versions.map((v) => h('button', { type: 'button', 'data-value': v, onclick: () => choose(v) }, v)));
    choose(versions[0]);
    $('statsView').hidden = false;
  } catch (e) {
    fail(humanizeError(e));
  }
})();
