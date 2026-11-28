// Detector chord saraf BTC (Bi-directional Transformer for Chord recognition, Park dkk., ISMIR 2019), inferensi murni JavaScript.
//
// Tanpa pustaka ML: modelnya kecil (8 lapis, lebar 128, ±2,9 juta bobot), jadi cukup perkalian matriks biasa.
// Bobot diekspor dari checkpoint resmi oleh scripts/export_btc_weights.py ke satu berkas biner (lihat format di sana).
// Kode BTC berlisensi MIT; bobot dilaporkan CC-BY-NC-SA (nonkomersial): hanya untuk pemakaian pribadi.
// Kecocokan dengan PyTorch diuji di js-tests/btc.test.js.

import { btcFeatures, CQT } from './cqt.js';

export const BTC = Object.freeze({
  timestep: 108, // bingkai per blok (= 10 detik)
  features: 144,
  hidden: 128,
  heads: 4,
  layers: 8,
  blockSeconds: 10,
  lnEps: 1e-6,
});

/** float16 (IEEE 754 half) -> float32. */
function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/**
 * Baca berkas bobot (ArrayBuffer) menjadi model siap pakai.
 * @param {ArrayBuffer} buf
 */
export function parseBtcWeights(buf) {
  const headLen = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen)));
  const base = 4 + headLen;
  const t = {};
  const f16 = header.dtype === 'f16';
  let table = null;
  if (f16) { // tabel 65536 entri: konversi cepat
    table = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) table[i] = halfToFloat(i);
  }
  for (const [name, { shape, offset }] of Object.entries(header.tensors)) {
    const size = shape.reduce((a, b) => a * b, 1);
    if (f16) {
      const src = new Uint16Array(buf.slice(base + offset * 2, base + (offset + size) * 2));
      const dst = new Float32Array(size);
      for (let i = 0; i < size; i++) dst[i] = table[src[i]];
      t[name] = dst;
    } else {
      t[name] = new Float32Array(buf.slice(base + offset * 4, base + (offset + size) * 4));
    }
  }
  return { t, mean: header.mean, std: header.std, labels: header.labels, numClasses: header.labels.length, timing: timingSignal() };
}

/** Sinyal posisi sinusoidal (seperti tensor2tensor): [T][hidden], paruh pertama sin lalu cos. */
function timingSignal(T = BTC.timestep, C = BTC.hidden) {
  const half = C / 2, inc = Math.log(1e4) / (half - 1);
  const out = new Float32Array(T * C);
  for (let p = 0; p < T; p++) {
    for (let j = 0; j < half; j++) {
      const a = p * Math.exp(-j * inc);
      out[p * C + j] = Math.sin(a);
      out[p * C + half + j] = Math.cos(a);
    }
  }
  return out;
}

/** y[t][o] = b[o] + sum_i x[t][i] * w[o][i] (w baris-per-keluaran). `inDim` boleh lebih kecil dari lebar baris x. */
function linear(x, T, inDim, w, outDim, b, y) {
  for (let t = 0; t < T; t++) {
    const xo = t * inDim;
    for (let o = 0; o < outDim; o++) {
      const wo = o * inDim;
      let s = b ? b[o] : 0;
      for (let i = 0; i < inDim; i++) s += x[xo + i] * w[wo + i];
      y[t * outDim + o] = s;
    }
  }
}

/** Konvolusi 1D kernel 3, pad nol di kedua sisi, lalu ReLU. w: [keluar][3][masuk]. */
function convRelu(x, T, C, w, b, y) {
  for (let t = 0; t < T; t++) {
    for (let o = 0; o < C; o++) {
      let s = b[o];
      for (let k = 0; k < 3; k++) {
        const tt = t + k - 1;
        if (tt < 0 || tt >= T) continue;
        const xo = tt * C, wo = (o * 3 + k) * C;
        for (let i = 0; i < C; i++) s += x[xo + i] * w[wo + i];
      }
      y[t * C + o] = s > 0 ? s : 0;
    }
  }
}

/** LayerNorm gaya BTC: gamma*(x-mean)/(std+eps)+beta dengan std tak-bias (N-1), seperti torch.std. */
function layerNorm(x, T, C, g, b, y) {
  for (let t = 0; t < T; t++) {
    const o = t * C;
    let mean = 0;
    for (let i = 0; i < C; i++) mean += x[o + i];
    mean /= C;
    let v = 0;
    for (let i = 0; i < C; i++) { const d = x[o + i] - mean; v += d * d; }
    const inv = 1 / (Math.sqrt(v / (C - 1)) + BTC.lnEps);
    for (let i = 0; i < C; i++) y[o + i] = g[i] * (x[o + i] - mean) * inv + b[i];
  }
}

/** Ruang kerja dipakai ulang antar blok supaya tidak ada alokasi di dalam loop. */
function makeWorkspace(T, C) {
  const buf = () => new Float32Array(T * C);
  return { xn: buf(), q: buf(), k: buf(), v: buf(), ctx: buf(), a: buf(), f1: buf(), f2: buf(), enc: buf(), rev: buf(), cat: new Float32Array(T * 2 * C), x: buf(), x2: buf(), scores: new Float32Array(T) };
}

/** Satu blok self-attention (kausal ke depan atau ke belakang) + FFN konvolusi. `x` [T][C] -> hasil di `out`. */
function attnBlock(m, p, x, T, C, forward, ws, out) {
  const { t } = m;
  const H = BTC.heads, D = C / H, scale = D ** -0.5;
  layerNorm(x, T, C, t[`${p}.ln1g`], t[`${p}.ln1b`], ws.xn);
  linear(ws.xn, T, C, t[`${p}.q`], C, null, ws.q);
  linear(ws.xn, T, C, t[`${p}.k`], C, null, ws.k);
  linear(ws.xn, T, C, t[`${p}.v`], C, null, ws.v);
  const { q, k, v, ctx, scores } = ws;
  for (let h = 0; h < H; h++) {
    const ho = h * D;
    for (let i = 0; i < T; i++) {
      const j0 = forward ? 0 : i, j1 = forward ? i : T - 1; // topeng kausal: tak boleh melihat sisi sebaliknya
      let max = -Infinity;
      for (let j = j0; j <= j1; j++) {
        let s = 0;
        for (let d = 0; d < D; d++) s += q[i * C + ho + d] * k[j * C + ho + d];
        s *= scale;
        scores[j] = s;
        if (s > max) max = s;
      }
      let sum = 0;
      for (let j = j0; j <= j1; j++) { scores[j] = Math.exp(scores[j] - max); sum += scores[j]; }
      for (let d = 0; d < D; d++) ctx[i * C + ho + d] = 0;
      for (let j = j0; j <= j1; j++) {
        const w = scores[j] / sum;
        for (let d = 0; d < D; d++) ctx[i * C + ho + d] += w * v[j * C + ho + d];
      }
    }
  }
  linear(ctx, T, C, t[`${p}.o`], C, null, ws.a);
  for (let i = 0; i < T * C; i++) ws.x2[i] = x[i] + ws.a[i];
  layerNorm(ws.x2, T, C, t[`${p}.ln2g`], t[`${p}.ln2b`], ws.xn);
  convRelu(ws.xn, T, C, t[`${p}.c1w`], t[`${p}.c1b`], ws.f1);
  convRelu(ws.f1, T, C, t[`${p}.c2w`], t[`${p}.c2b`], ws.f2);
  for (let i = 0; i < T * C; i++) out[i] = ws.x2[i] + ws.f2[i];
}

/**
 * Logit untuk satu blok fitur ternormalisasi.
 * @param {*} m model dari parseBtcWeights
 * @param {Float32Array} x [timestep][144]
 * @returns {Float32Array} [timestep][numClasses]
 */
export function btcLogits(m, x) {
  const T = BTC.timestep, C = BTC.hidden;
  const ws = m.ws || (m.ws = makeWorkspace(T, C));
  const { t } = m;
  let cur = new Float32Array(T * C);
  linear(x, T, BTC.features, t.embed, C, null, cur);
  for (let i = 0; i < T * C; i++) cur[i] += m.timing[i];
  for (let l = 0; l < BTC.layers; l++) {
    attnBlock(m, `l${l}.f`, cur, T, C, true, ws, ws.enc);
    attnBlock(m, `l${l}.b`, cur, T, C, false, ws, ws.rev);
    for (let i = 0; i < T; i++) {
      ws.cat.set(ws.enc.subarray(i * C, (i + 1) * C), i * 2 * C);
      ws.cat.set(ws.rev.subarray(i * C, (i + 1) * C), i * 2 * C + C);
    }
    const next = new Float32Array(T * C);
    linear(ws.cat, T, 2 * C, t[`l${l}.lin.w`], C, t[`l${l}.lin.b`], next);
    cur = next;
  }
  layerNorm(cur, T, C, t['ln.g'], t['ln.b'], ws.xn);
  const logits = new Float32Array(T * m.numClasses);
  linear(ws.xn, T, C, t['out.w'], m.numClasses, t['out.b'], logits);
  return logits;
}

/**
 * Prediksi indeks kelas untuk tiap bingkai fitur (log-CQT mentah, waktu dulu).
 * @param {*} m model
 * @param {Float32Array} data frames*144
 * @param {number} frames
 * @param {{onProgress?: (done:number,total:number)=>void}} [opts]
 * @returns {Uint8Array} satu indeks kelas per bingkai
 */
export function btcPredict(m, data, frames, opts = {}) {
  const T = BTC.timestep, F = BTC.features;
  const blocks = Math.ceil(frames / T);
  const pred = new Uint8Array(blocks * T);
  const x = new Float32Array(T * F);
  const n = m.numClasses;
  for (let b = 0; b < blocks; b++) {
    x.fill(0); // bingkai pengisi di blok terakhir = 0 setelah normalisasi (sama seperti kode asli)
    const from = b * T, to = Math.min(frames, from + T);
    for (let i = from * F; i < to * F; i++) x[i - from * F] = (data[i] - m.mean) / m.std;
    const logits = btcLogits(m, x);
    for (let i = 0; i < T; i++) {
      let best = 0, bv = -Infinity;
      for (let c = 0; c < n; c++) { const v = logits[i * n + c]; if (v > bv) { bv = v; best = c; } }
      pred[from + i] = best;
    }
    opts.onProgress?.(b + 1, blocks);
  }
  return pred.subarray(0, frames);
}

/**
 * Bingkai -> segmen berurutan [{start,end,label}] (bingkai bertetangga yang sama digabung), label dalam notasi proyek.
 * Satu bingkai = 10/108 detik, persis seperti kode BTC asli.
 */
export function framesToSegments(pred, labels) {
  const unit = BTC.blockSeconds / BTC.timestep;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const segs = [];
  let start = 0, prev = labels[pred[0]];
  for (let i = 1; i < pred.length; i++) {
    const lab = labels[pred[i]];
    if (lab !== prev) { segs.push({ start: r3(start), end: r3(unit * i), label: prev }); start = unit * i; prev = lab; }
  }
  segs.push({ start: r3(start), end: r3(unit * pred.length), label: prev });
  return segs;
}

let modelPromise = null;
/** Muat bobot sekali per halaman/worker; gagal -> boleh dicoba lagi. */
export function loadBtcModel(url = new URL('../models/btc-large-voca.bin', import.meta.url)) {
  if (!modelPromise) {
    modelPromise = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`Model BTC tidak bisa diunduh (${r.status})`); return r.arrayBuffer(); })
      .then(parseBtcWeights)
      .catch((e) => { modelPromise = null; throw e; });
  }
  return modelPromise;
}

/**
 * Jalankan BTC pada satu lagu: audio mono 22050 Hz -> segmen chord (notasi proyek).
 * @param {(p:number)=>void} [onProgress] 0..1 (fitur = 5% pertama, sisanya model)
 */
export async function detectBtc(samples, sampleRate, onProgress = () => {}, model = null) {
  if (sampleRate !== CQT.sr) throw new Error(`BTC butuh audio ${CQT.sr} Hz, dapat ${sampleRate}`);
  const m = model || await loadBtcModel();
  const { frames, data } = btcFeatures(samples);
  if (!frames) return [];
  onProgress(0.05);
  const pred = btcPredict(m, data, frames, { onProgress: (d, n) => onProgress(0.05 + 0.95 * (d / n)) });
  return framesToSegments(pred, m.labels);
}
