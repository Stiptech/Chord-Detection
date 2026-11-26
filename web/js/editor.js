// Editor koreksi chord: panel pemilih chord, operasi segmen, undo/redo, simpan otomatis ke Supabase.
// Logika murninya ada di edit-logic.js (teruji di Node); berkas ini hanya DOM dan penyimpanan.
import { h } from './dom.js';
import { humanizeError } from './api.js';
import { isValidChord, validateSegments } from './labels.js';
import { noteName } from './transpose.js';
import { fmtTimePrecise } from './player-logic.js';
import {
  History, QUALITY_OPTIONS, countLabel, deleteAt, labelFromPicker, mergeWith, moveEnd, moveStart,
  pickerFromLabel, qualityLabel, replaceAll, setLabelAt, snapSegments, splitAt,
} from './edit-logic.js';

const SAVE_DELAY_MS = 800;
// Jenis yang paling sering dipakai selalu tampil; sisanya dilipat di "Jenis lain".
const COMMON_QUALITIES = ['', 'm', 'sus2', 'sus4', '7', 'maj7', 'm7', 'add9'].filter((q) => QUALITY_OPTIONS.includes(q));
const EXTRA_QUALITIES = QUALITY_OPTIONS.filter((q) => !COMMON_QUALITIES.includes(q));
const $ = (id) => document.getElementById(id);

/**
 * @param {object} ctx
 * @param {HTMLAudioElement} ctx.audio
 * @param {object} ctx.api
 * @param {(msg:string)=>void} ctx.toast
 * @param {()=>string} ctx.songId
 * @param {()=>{start:number,end:number,label:string}[]} ctx.getSegs
 * @param {(segs:any[], selected:number|null)=>void} ctx.setSegs  pasang segmen baru di pemutar (membangun ulang lini waktu)
 * @param {()=>'sharp'|'flat'} ctx.spelling
 * @param {()=>number} ctx.duration
 * @param {(t:number)=>void} ctx.seekTo
 * @param {(a:number,b:number)=>void} ctx.setLoop
 * @param {()=>any[]|null} ctx.autoSegs
 * @param {()=>any[]|null} ctx.btcSegs  hasil detector saraf BTC (versi label `btc`), bila ada
 * @param {()=>number[]} ctx.beats  waktu ketukan (detik) untuk "rapatkan ke ketukan"
 * @param {()=>void} ctx.onSaved
 */
export function createEditor(ctx) {
  const history = new History(100);
  let on = false;
  let sel = null; // indeks segmen terpilih
  let selOrig = null; // label segmen terpilih saat pertama dipilih (untuk "ganti semua")
  let lastNonN = { rootPc: 0, suffix: '', bassPc: null };
  let manualError = '';
  let showMore = false; // lipatan "Jenis lain"
  // penyimpanan
  let dirty = false, saving = false, error = null, savedAt = null, timer = 0, anyChange = false;

  // ---------- simpan otomatis ----------

  function renderSave() {
    const el = $('saveState');
    let text = 'Belum ada perubahan', cls = 'muted';
    if (error) { text = `Gagal menyimpan: ${error} — ketuk untuk coba lagi`; cls = 'error'; }
    else if (saving) text = 'Menyimpan…';
    else if (dirty) text = 'Perubahan belum tersimpan…';
    else if (savedAt) { text = `Tersimpan ✓ ${savedAt}`; cls = 'ok'; }
    el.textContent = text;
    el.className = `savestate ${cls}`;
    el.toggleAttribute('data-retry', !!error);
  }

  function schedule() {
    dirty = true;
    anyChange = true;
    error = null;
    renderSave();
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  async function flush() {
    clearTimeout(timer);
    if (saving || !dirty) return;
    saving = true;
    dirty = false;
    error = null;
    renderSave();
    try {
      const normalized = validateSegments(ctx.getSegs());
      await ctx.api.saveLabels(ctx.songId(), 'corrected', normalized);
      savedAt = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      ctx.onSaved();
    } catch (e) {
      dirty = true; // tetap kotor supaya percobaan berikutnya mengirim ulang
      error = humanizeError(e);
    } finally {
      saving = false;
      renderSave();
    }
    if (dirty && !error) await flush(); // ada perubahan baru selama menyimpan
  }

  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty) flush(); // jangan kehilangan perubahan saat tab ditinggalkan
  });
  $('saveState').addEventListener('click', () => { if (error) flush(); });

  // ---------- menerapkan perubahan ----------

  function apply(segs, index = sel) {
    history.push(segs);
    sel = index === null ? null : Math.min(index, segs.length - 1);
    ctx.setSegs(segs, sel);
    renderPane();
    renderBar();
    schedule();
  }

  function attempt(fn) {
    try { fn(); } catch (e) { ctx.toast(e.message); }
  }

  function select(i) {
    sel = i;
    selOrig = ctx.getSegs()[i]?.label ?? null;
    manualError = '';
    ctx.setSegs(ctx.getSegs(), sel);
    renderPane();
    if (i !== null) ctx.seekTo(ctx.getSegs()[i].start + 0.001);
    // di layar kecil panel mungkin di luar pandangan: bawa ke atas hanya bila masih jauh di bawah
    const pane = $('segEditor');
    if (i !== null && !pane.hidden && pane.getBoundingClientRect().top > innerHeight * 0.6) {
      pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function undo() {
    const s = history.undo();
    if (!s) return;
    sel = sel === null ? null : Math.min(sel, s.length - 1);
    ctx.setSegs(s, sel);
    renderPane(); renderBar(); schedule();
  }
  function redo() {
    const s = history.redo();
    if (!s) return;
    sel = sel === null ? null : Math.min(sel, s.length - 1);
    ctx.setSegs(s, sel);
    renderPane(); renderBar(); schedule();
  }

  // ---------- tampilan ----------

  function renderBar() {
    $('undoBtn').disabled = !history.canUndo;
    $('redoBtn').disabled = !history.canRedo;
  }

  const btn = (text, onclick, opts = {}) =>
    h('button', { type: 'button', class: `btn small ${opts.cls || ''}`, onclick, disabled: opts.disabled, 'aria-pressed': opts.pressed }, text);

  function renderPane() {
    const pane = $('segEditor');
    if (!on || sel === null) { pane.hidden = true; pane.replaceChildren(); return; }
    const segs = ctx.getSegs();
    const seg = segs[sel];
    if (!seg) { pane.hidden = true; return; }
    pane.hidden = false;
    const spell = ctx.spelling();
    const picker = pickerFromLabel(seg.label);
    if (picker && !picker.n) lastNonN = { rootPc: picker.rootPc, suffix: picker.suffix, bassPc: picker.bassPc };
    const setPicker = (patch) => {
      const base = picker && !picker.n ? picker : { n: false, ...lastNonN };
      apply(setLabelAt(segs, sel, labelFromPicker({ ...base, n: false, ...patch }, spell)));
    };

    const qualityBtn = (q) => btn(qualityLabel(q), () => setPicker({ suffix: q }), { pressed: String(!!picker && !picker.n && picker.suffix === q) });
    const currentIsExtra = !!picker && !picker.n && EXTRA_QUALITIES.includes(picker.suffix);
    const others = selOrig !== null && selOrig !== seg.label ? countLabel(segs, selOrig) : 0;
    const nudge = (label, fn, steps) => h('div', { class: 'nudge' },
      h('span', { class: 'nudge-label' }, label),
      steps.map(([text, d]) => btn(text, () => attempt(() => {
        const next = fn(d);
        if (JSON.stringify(next) === JSON.stringify(segs)) return ctx.toast('Sudah di batas.');
        apply(next);
      }))));

    pane.replaceChildren(
      h('div', { class: 'seg-head' },
        h('div', {},
          h('strong', {}, `Segmen ${sel + 1} dari ${segs.length}`),
          h('div', { class: 'muted small-note' }, `${fmtTimePrecise(seg.start)} – ${fmtTimePrecise(seg.end)} · ${(seg.end - seg.start).toFixed(1)} dtk`)),
        h('span', { class: 'seg-label' }, seg.label),
        btn('Tutup', () => { sel = null; ctx.setSegs(ctx.getSegs(), null); renderPane(); })),

      h('div', { class: 'pick-block' },
        h('span', { class: 'opt-label' }, 'Nada dasar'),
        h('div', { class: 'pick-grid' },
          Array.from({ length: 12 }, (_, pc) => btn(noteName(pc, spell), () => setPicker({ rootPc: pc }), { pressed: String(!!picker && !picker.n && picker.rootPc === pc) })),
          btn('N (tanpa chord)', () => apply(setLabelAt(segs, sel, 'N')), { pressed: String(!!picker?.n) }))),

      h('div', { class: 'pick-block' },
        h('span', { class: 'opt-label' }, 'Jenis'),
        h('div', { class: 'pick-grid wide' }, COMMON_QUALITIES.map(qualityBtn)),
        // jenis yang jarang dipakai dilipat supaya panel tidak terlalu panjang di HP; terbuka otomatis bila chord ini memakainya
        !currentIsExtra && btn(showMore ? 'Jenis lain ▴' : 'Jenis lain ▾', () => { showMore = !showMore; renderPane(); }, { cls: 'wide-btn' }),
        (showMore || currentIsExtra) && h('div', { class: 'pick-grid wide' }, EXTRA_QUALITIES.map(qualityBtn))),

      h('div', { class: 'pick-block' },
        h('label', { class: 'opt-label', for: 'bassSel' }, 'Bass (slash chord, opsional)'),
        h('select', { id: 'bassSel', class: 'field', onchange: (e) => setPicker({ bassPc: e.target.value === '' ? null : Number(e.target.value) }) },
          h('option', { value: '' }, '— tanpa bass'),
          Array.from({ length: 12 }, (_, pc) =>
            h('option', { value: String(pc), selected: !!picker && !picker.n && picker.bassPc === pc && picker.bassPc !== picker.rootPc }, `/${noteName(pc, spell)}`)))),

      h('div', { class: 'pick-block' },
        h('label', { class: 'opt-label', for: 'manualChord' }, 'Atau ketik manual'),
        h('div', { class: 'row' },
          h('input', { id: 'manualChord', class: 'txt', type: 'text', placeholder: 'mis. Dsus2/F#', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
            onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); $('manualApply').click(); } } }),
          h('button', { id: 'manualApply', type: 'button', class: 'btn small primary', onclick: () => {
            const v = $('manualChord').value.trim();
            if (!isValidChord(v)) { manualError = `'${v}' bukan chord yang dikenal.`; $('manualErr').textContent = manualError; return; }
            manualError = '';
            apply(setLabelAt(segs, sel, v));
          } }, 'Terapkan')),
        h('p', { id: 'manualErr', class: 'error small-note', role: 'alert' }, manualError)),

      others > 0 && h('button', { type: 'button', class: 'btn small wide-btn', onclick: () => {
        if (!confirm(`Ganti semua "${selOrig}" lain (${others} segmen) menjadi "${seg.label}"?`)) return;
        const { segs: next, count } = replaceAll(segs, selOrig, seg.label);
        apply(next);
        selOrig = seg.label;
        ctx.toast(`${count} segmen diganti.`);
      } }, `Ganti semua "${selOrig}" lain → "${seg.label}" (${others})`),

      h('div', { class: 'ops' },
        btn('⟳ Loop segmen ini', () => { ctx.setLoop(seg.start, seg.end); ctx.seekTo(seg.start + 0.001); ctx.toast('Loop diatur ke segmen ini. Tekan Putar.'); }),
        btn('✂ Pecah di playhead', () => attempt(() => { const r = splitAt(segs, sel, ctx.audio.currentTime); apply(r.segs, r.index); })),
        btn('← Gabung sebelumnya', () => attempt(() => { const r = mergeWith(segs, sel, -1); apply(r.segs, r.index); }), { disabled: sel === 0 }),
        btn('Gabung berikutnya →', () => attempt(() => { const r = mergeWith(segs, sel, 1); apply(r.segs, r.index); }), { disabled: sel === segs.length - 1 }),
        btn('🗑 Hapus segmen', () => attempt(() => { const r = deleteAt(segs, sel); selOrig = r.segs[r.index].label; apply(r.segs, r.index); }), { cls: 'danger' })),

      nudge('Batas awal', (d) => (d === 'ph' ? moveStart(segs, sel, ctx.audio.currentTime) : moveStart(segs, sel, seg.start + d)),
        [['−0,5', -0.5], ['−0,1', -0.1], ['+0,1', 0.1], ['+0,5', 0.5], ['= playhead', 'ph']]),
      nudge('Batas akhir', (d) => (d === 'ph' ? moveEnd(segs, sel, ctx.audio.currentTime, ctx.duration()) : moveEnd(segs, sel, seg.end + d, ctx.duration())),
        [['−0,5', -0.5], ['−0,1', -0.1], ['+0,1', 0.1], ['+0,5', 0.5], ['= playhead', 'ph']]),
      h('div', { class: 'nudge' },
        h('span', { class: 'nudge-label' }, 'Playhead'),
        [['−1 dtk', -1], ['−0,1', -0.1], ['+0,1', 0.1], ['+1 dtk', 1]].map(([t, d]) => btn(t, () => ctx.seekTo(ctx.audio.currentTime + d)))),
    );
  }

  // ---------- mode ----------

  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('loadBtcBtn').addEventListener('click', () => {
    const btc = ctx.btcSegs();
    if (!btc) return ctx.toast('Tidak ada hasil BTC untuk lagu ini.');
    if (!confirm('Ganti semua chord yang sedang diedit dengan hasil BTC? Kamu masih bisa membatalkannya dengan Urungkan.')) return;
    sel = null;
    apply(btc.map((s) => ({ ...s })), null);
  });
  $('snapBtn').addEventListener('click', () => {
    const r = snapSegments(ctx.getSegs(), ctx.beats(), 0.15);
    if (!r.changed) return ctx.toast('Tidak ada batas chord yang perlu dirapatkan.');
    apply(r.segs); // satu langkah riwayat: bisa diurungkan
    ctx.toast(`${r.changed} batas chord dirapatkan ke ketukan. Urungkan bila kurang pas.`);
  });
  $('resetAutoBtn').addEventListener('click', () => {
    const auto = ctx.autoSegs();
    if (!auto) return ctx.toast('Tidak ada hasil mesin untuk dikembalikan.');
    if (!confirm('Kembalikan semua koreksi ke hasil mesin? Kamu masih bisa membatalkannya dengan Urungkan.')) return;
    sel = null;
    apply(auto.map((s) => ({ ...s })), null);
  });
  document.addEventListener('keydown', (e) => {
    if (!on || !(e.ctrlKey || e.metaKey) || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });

  return {
    get on() { return on; },
    get selected() { return sel; },
    select,
    hasChanges: () => anyChange,
    enter() {
      on = true;
      sel = null;
      history.reset(ctx.getSegs());
      $('editBar').hidden = false;
      $('loadBtcBtn').hidden = !ctx.btcSegs();
      renderBar(); renderSave(); renderPane();
    },
    async exit() {
      on = false;
      sel = null;
      $('editBar').hidden = true;
      renderPane();
      await flush(); // pastikan perubahan terakhir tersimpan sebelum keluar
    },
    flush,
  };
}
