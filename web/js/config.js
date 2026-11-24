// Parameter detector baseline (versi JavaScript). Disetel pada rekaman nyata (lagu worship, 4 menit);
// lihat README "Penyetelan detector" untuk alasan tiap nilai.
export const DEFAULTS = {
  sampleRate: 22050,
  hopLength: 2048, // ~93 ms per frame
  fftSize: 8192, // jendela ~371 ms; cukup tajam untuk membedakan semiton di atas ~C2
  fminHz: 65, // ~C2: di bawah ini resolusi FFT terlalu kasar untuk memisahkan semiton
  fmaxHz: 3000,

  // --- Pembersihan chroma (tanpa ini, rekaman nyata berderau/berperkusi menghasilkan chroma datar) ---
  // Median sepanjang waktu per bin: menjaga nada yang bertahan (harmonik), membuang transien/perkusi.
  // Jumlah frame, ganjil. 1 = nonaktif.
  harmonicMedianFrames: 5,
  // Kurangi lantai broadband tiap frame (median magnitudo antar bin x angka ini). 0 = nonaktif.
  whitenMult: 3,
  // Pangkat magnitudo: >1 mempertajam puncak nada terhadap derau. 1 = nonaktif.
  chromaPower: 1.5,

  // Suhu softmax: kecil = tegas, besar = landai (lebih sedikit segmen pendek yang berganti-ganti).
  softmaxTemperature: 0.15,
  // Probabilitas bertahan di chord yang sama antar frame (Viterbi).
  transitionLoop: 0.95,
  // Segmen lebih pendek dari ini digabung ke tetangganya.
  minSegmentSec: 0.3,
  // Frame dengan energi < silenceRatio * (persentil 95 energi) dianggap hening -> N.
  silenceRatio: 0.05,

  // Penalti kecil untuk kualitas "kompleks" agar triad tidak kalah oleh sus/7th hanya karena
  // nada pad/melodi ikut tertangkap. Negatif = lebih sulit terpilih. Geser sesuai seleramu:
  // lebih negatif = lebih banyak chord polos, lebih dekat ke nol = lebih banyak sus/7th terdeteksi.
  qualityBias: { '': 0, m: 0, sus2: -0.06, sus4: -0.06, 7: -0.04, maj7: -0.04, m7: -0.04 },
  // Frame hening selalu N (dipaksa di chromaToProbs). Pada frame berbunyi, bias negatif ini membuat N
  // hanya terpilih bila chroma benar-benar datar. Antara -1 dan -0.4 hasilnya sama pada lagu uji.
  noChordBias: -0.4,
};
