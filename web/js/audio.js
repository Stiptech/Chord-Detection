// Dekode file audio/video di browser menjadi sampel mono 22050 Hz, plus hash isi file.
// Tidak butuh ffmpeg: Safari/Chrome membaca mp3, m4a, mp4 (AAC), dan wav sendiri.

export const TARGET_SAMPLE_RATE = 22050;
export const MAX_DURATION_SEC = 15 * 60; // lebih dari ini memakan terlalu banyak RAM di iPad

/** Rata-rata semua kanal jadi satu kanal. */
export function downmixToMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return out;
}

/**
 * Resample linear sederhana. Hanya cadangan bila browser tidak meresample saat dekode.
 * Saat menurunkan sample rate, sampel dirata-ratakan dulu sebagai low-pass kasar agar tidak aliasing.
 */
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  let src = samples;
  const ratio = fromRate / toRate;
  if (ratio > 1) {
    const w = Math.round(ratio);
    if (w > 1) {
      src = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        let sum = 0, n = 0;
        for (let k = i - (w >> 1); k < i - (w >> 1) + w; k++) if (k >= 0 && k < samples.length) { sum += samples[k]; n++; }
        src[i] = sum / n;
      }
    }
  }
  const outLen = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.min(Math.floor(pos), src.length - 1);
    const i1 = Math.min(i0 + 1, src.length - 1);
    out[i] = src[i0] + (src[i1] - src[i0]) * (pos - i0);
  }
  return out;
}

export async function sha256Hex(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {ArrayBuffer} arrayBuffer isi file (tidak diubah)
 * @returns {Promise<{samples: Float32Array, sampleRate: number, duration: number}>}
 */
export async function decodeAudio(arrayBuffer) {
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('Browser ini tidak mendukung dekode audio. Pakai Safari atau Chrome versi terbaru.');
  // OfflineAudioContext (bukan AudioContext): tidak butuh gestur pengguna dan tidak membuka output suara.
  const ctx = new Ctx(1, 1, TARGET_SAMPLE_RATE);
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0)); // salinan: decodeAudioData mengosongkan buffer
  } catch {
    throw new Error('Browser tidak bisa membaca audio dari file ini. Coba format mp3, m4a, atau wav.');
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  let samples = downmixToMono(channels);
  let sampleRate = decoded.sampleRate;
  if (sampleRate !== TARGET_SAMPLE_RATE) {
    samples = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
    sampleRate = TARGET_SAMPLE_RATE;
  }
  const duration = samples.length / sampleRate;
  if (duration > MAX_DURATION_SEC) {
    throw new Error(`Audio terlalu panjang (${Math.round(duration / 60)} menit). Batasnya ${MAX_DURATION_SEC / 60} menit.`);
  }
  if (samples.length === 0) throw new Error('File ini tidak berisi audio.');
  return { samples, sampleRate, duration };
}
