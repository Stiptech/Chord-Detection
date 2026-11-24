// Jalankan detector di Web Worker; kalau worker modul tidak tersedia, jatuh ke thread utama.
import { detect } from './baseline.js';

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {(p:number)=>void} [onProgress] 0..1
 * @returns {Promise<{start:number,end:number,label:string}[]>}
 */
export function analyzeSamples(samples, sampleRate, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      return resolve(runOnMainThread(samples, sampleRate, onProgress));
    }
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.p);
      else if (m.type === 'done') { worker.terminate(); resolve(m.segments); }
      else { worker.terminate(); reject(new Error(`Analisis gagal: ${m.message}`)); }
    };
    worker.onerror = () => {
      // Worker modul tidak didukung / gagal dimuat: ulangi di thread utama (UI mungkin tersendat sebentar).
      worker.terminate();
      resolve(runOnMainThread(samples, sampleRate, onProgress));
    };
    // Salin dulu supaya cadangan thread utama masih punya data setelah buffer dipindahkan ke worker.
    const copy = samples.slice();
    worker.postMessage({ samples: copy, sampleRate }, [copy.buffer]);
  });
}

function runOnMainThread(samples, sampleRate, onProgress) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(detect(samples, sampleRate, { onProgress })); } catch (e) { reject(e); }
    }, 0);
  });
}
