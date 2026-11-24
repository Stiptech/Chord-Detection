// Parameter detector baseline. Nilai default sama dengan app/config.py (Python) bila ada padanannya.
export const DEFAULTS = {
  sampleRate: 22050,
  hopLength: 2048, // ~93 ms per frame
  fftSize: 8192, // jendela ~371 ms; cukup tajam untuk membedakan semiton di atas ~C2
  fminHz: 65, // ~C2: di bawah ini resolusi FFT terlalu kasar untuk memisahkan semiton
  fmaxHz: 3000,

  // Suhu softmax: kecil = tegas, besar = landai.
  softmaxTemperature: 0.1,
  // Probabilitas bertahan di chord yang sama antar frame (Viterbi).
  transitionLoop: 0.9,
  // Segmen lebih pendek dari ini digabung ke tetangganya.
  minSegmentSec: 0.3,
  // Frame dengan energi < silenceRatio * (persentil 95 energi) dianggap N.
  silenceRatio: 0.05,

  // Penalti kecil untuk kualitas "kompleks" agar triad tidak kalah oleh chord 4 nada.
  qualityBias: { '': 0, m: 0, sus2: -0.03, sus4: -0.03, 7: -0.03, maj7: -0.03, m7: -0.03 },
  // Chroma datar mirip semua chord; penalti ini mencegah N terpilih pada pad tebal.
  noChordBias: -0.1,
};
