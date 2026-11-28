// Jalankan analisis (chord, ketukan) di Web Worker; kalau worker modul tidak tersedia, jatuh ke thread utama.
import { detect } from './baseline.js';
import { analyzeBeatGrid } from './beats.js';
import { detectBtc } from './btc.js';

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {(p:number)=>void} [onProgress] 0..1
 * @returns {Promise<{start:number,end:number,label:string}[]>}
 */
export function analyzeSamples(samples, sampleRate, onProgress = () => {}) {
  return runTask({ task: 'chords' }, samples, sampleRate, onProgress, (m) => m.segments,
    () => detect(samples, sampleRate, { onProgress }));
}

/** Ketukan + tempo + birama untuk satu lagu; `segments` (chord) membantu menebak birama. */
export function analyzeBeats(samples, sampleRate, segments = []) {
  return runTask({ task: 'beats', segments }, samples, sampleRate, () => {}, (m) => m.beats,
    () => analyzeBeatGrid(samples, sampleRate, segments));
}

/** Detector saraf BTC (model ±6 MB diunduh sekali, lalu di-cache). Lambat: ±10 dtk per 4 menit lagu di laptop, lebih lama di HP. */
export function analyzeBtc(samples, sampleRate, onProgress = () => {}) {
  return runTask({ task: 'btc' }, samples, sampleRate, onProgress, (m) => m.segments,
    () => detectBtc(samples, sampleRate, onProgress));
}

function runTask(extra, samples, sampleRate, onProgress, pick, fallback) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      return resolve(runOnMainThread(fallback));
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.p);
      else if (m.type === 'done') { worker.terminate(); resolve(pick(m)); }
      else { worker.terminate(); reject(new Error(`Analisis gagal: ${m.message}`)); }
    };
    worker.onerror = () => {
      // Worker modul tidak didukung / gagal dimuat: ulangi di thread utama (UI mungkin tersendat sebentar).
      worker.terminate();
      resolve(runOnMainThread(fallback));
    };
    // Salin dulu supaya cadangan thread utama masih punya data setelah buffer dipindahkan ke worker.
    const copy = samples.slice();
    worker.postMessage({ ...extra, samples: copy, sampleRate }, [copy.buffer]);
  });
}

function runOnMainThread(fn) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      Promise.resolve().then(fn).then(resolve, reject);
    }, 0);
  });
}
