// Web Worker: menjalankan detector di thread terpisah supaya halaman tidak macet.
import { detect } from './baseline.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const segments = detect(samples, sampleRate, {
      onProgress: (p) => self.postMessage({ type: 'progress', p }),
    });
    self.postMessage({ type: 'done', segments });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
