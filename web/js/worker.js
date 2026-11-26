// Web Worker: menjalankan detector dan pelacak ketukan di thread terpisah supaya halaman tidak macet.
import { detect } from './baseline.js';
import { analyzeBeatGrid } from './beats.js';

self.onmessage = (e) => {
  const { task = 'chords', samples, sampleRate, segments } = e.data;
  try {
    if (task === 'beats') {
      self.postMessage({ type: 'done', beats: analyzeBeatGrid(samples, sampleRate, segments || []) });
      return;
    }
    const result = detect(samples, sampleRate, {
      onProgress: (p) => self.postMessage({ type: 'progress', p }),
    });
    self.postMessage({ type: 'done', segments: result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
