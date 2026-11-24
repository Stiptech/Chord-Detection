# PROYEK: Chord Finder Pribadi untuk Lagu Rohani

## Tujuan
Bangun aplikasi lokal (jalan di laptop, bisa dibuka dari Safari iPad lewat jaringan WiFi yang sama) untuk mendeteksi chord dari file audio/video atau link, menampilkannya sinkron dengan pemutaran lagu, dan memungkinkan saya mengoreksi hasilnya. Koreksi disimpan sebagai dataset label pribadi untuk fine-tuning model di kemudian hari.

Pengguna cuma satu orang (saya). Prioritasnya: sederhana, bisa dipahami, mudah diubah. Jangan over-engineering, jangan pakai autentikasi, jangan pakai cloud.

## Konteks musik (penting untuk keputusan desain)
- Genre: lagu rohani / worship. Banyak memakai sus2, sus4, add9, 7, maj7, m7, dan slash chord seperti D/F# atau C/E. Sebagian lagu bergaya jazzy/gospel dengan chord lewat yang cepat.
- Audio sering penuh pad synth, reverb tebal, dan paduan suara, jadi harmoni kabur. Deteksi otomatis pasti tidak sempurna. Aplikasi ini harus dirancang dengan asumsi hasil mesin hanyalah tebakan awal, dan koreksi manual adalah bagian utama alur kerja.
- Dataset publik (Isophonics, McGill Billboard, RWC-Pop, JAAH) didominasi pop/rock barat, jadi model pretrained kemungkinan lemah di chord khas rohani. Itu alasan fitur koreksi dan penyimpanan label sangat penting.

## Input yang harus didukung
1. Upload file: mp3, mp4, m4a, wav (apa pun yang bisa dibaca ffmpeg).
2. Tempel link (misalnya YouTube): audionya diunduh lalu diperlakukan sama seperti file upload.

## Tech stack
- Python 3.11+, FastAPI + uvicorn untuk backend.
- librosa, numpy, scipy untuk audio. ffmpeg (via subprocess) untuk konversi mp3/mp4/m4a/wav ke wav mono 22050 Hz.
- yt-dlp untuk unduh audio dari link.
- mir_eval untuk evaluasi.
- Penyimpanan: file di disk + SQLite (modul sqlite3 bawaan). Tidak perlu ORM.
- Frontend: HTML + CSS + JavaScript biasa (vanilla), tanpa build step, tanpa framework, disajikan langsung oleh FastAPI sebagai static files. Harus nyaman dipakai di layar iPad (tombol besar, responsif).
- Tes: pytest.

## Struktur folder yang diinginkan
```
chordfinder/
  README.md
  CLAUDE.md
  requirements.txt
  run.sh                  # menjalankan server di 0.0.0.0:8000
  .gitignore              # abaikan data/audio, data/cache, *.wav, *.mp3, *.mp4
  app/
    main.py               # FastAPI app + routes
    config.py
    audio.py              # konversi ffmpeg + load audio
    download.py           # unduh dari link via yt-dlp
    detectors/
      base.py             # interface ChordDetector
      baseline.py         # chroma + template + Viterbi
      (pretrained.py nanti, di fase 6)
    labels.py             # baca/tulis .lab, konversi notasi
    storage.py            # SQLite: daftar lagu, status analisis, versi label
    evaluate.py           # perbandingan label mesin vs koreksi manual
    static/
      index.html
      app.js
      style.css
  data/
    audio/                # file asli (tidak di-commit)
    labels/               # label .lab (auto dan corrected)
    cache/                # hasil konversi wav
  tests/
  scripts/
    analyze_file.py       # CLI: audio -> .lab
    evaluate_dir.py       # CLI: evaluasi seluruh folder
```

## Format data
- Label disimpan sebagai file teks `.lab`, tiga kolom dipisah tab: `start_sec  end_sec  chord`.
- Notasi chord di aplikasi (yang tampil di layar): `C`, `Dm`, `Dsus2`, `Dsus4`, `C7`, `Cmaj7`, `Am7`, `Cadd9`, `G/B`, dan `N` untuk tanpa chord.
- Untuk evaluasi dengan mir_eval, sediakan fungsi konversi dua arah antara notasi di atas dan notasi Harte (`C:maj`, `D:min`, `D:sus2`, `C:maj(9)`, `G:maj/3`, dst). Kalau ada chord yang tidak bisa dipetakan rapi, fallback ke triad terdekat dan catat di log.
- Setiap lagu punya dua berkas label terpisah: `<id>.auto.lab` (keluaran mesin, jangan pernah ditimpa oleh koreksi) dan `<id>.corrected.lab` (hasil koreksi saya).
- Setiap analisis ulang dengan detector berbeda disimpan sebagai berkas auto dengan nama detector, misal `<id>.baseline.lab`, `<id>.btc.lab`.

## Kerjakan BERTAHAP. Setelah tiap fase selesai: jalankan tes, commit git dengan pesan jelas, lalu berhenti dan beri tahu saya cara mencobanya sebelum lanjut ke fase berikutnya.

### Fase 1: Engine baseline (CLI saja, belum ada web)
1. Buat interface `ChordDetector` di `detectors/base.py` dengan method `detect(wav_path) -> list[Segment]`, di mana `Segment` berisi start, end, label.
2. Implementasi `baseline.py`:
   - load audio mono 22050 Hz, ambil komponen harmonik (`librosa.effects.harmonic`).
   - hitung `chroma_cqt` (hop 2048), normalisasi per frame.
   - template matching dengan kosakata awal: mayor, minor, sus2, sus4, dominant 7, maj7, m7, plus `N`. Template tiap chord dibangun dari interval nadanya, root dirotasi ke 12 nada.
   - hitung similarity, ubah ke probabilitas (softmax dengan suhu yang bisa diatur di config).
   - haluskan dengan Viterbi (`librosa.sequence.viterbi_discriminative` dengan `transition_loop`), probabilitas bertahan bisa diatur di config.
   - gabungkan frame berurutan yang labelnya sama menjadi segmen.
   - hilangkan segmen yang lebih pendek dari ambang minimum (default 0.3 detik) dengan menggabungkannya ke tetangga.
3. `audio.py`: fungsi konversi file apa pun yang didukung ffmpeg (termasuk mp4) ke wav mono 22050 Hz di `data/cache/`, dengan cache berdasarkan hash isi file.
4. `scripts/analyze_file.py lagu.mp3` mencetak segmen dan menulis `.lab`.
5. Tes unit: bangkitkan audio sintetis (sinus bertumpuk untuk C, Am, F, G masing-masing 2 detik) dan pastikan baseline mengenali urutannya dengan benar. Tes untuk parser/penulis `.lab` dan konversi notasi Harte.

### Fase 2: Backend API
Endpoint FastAPI:
- `POST /api/songs` upload file (multipart), simpan ke `data/audio/`, buat record di SQLite, kembalikan id.
- `GET /api/songs` daftar lagu beserta status (uploaded, analyzing, ready, error).
- `POST /api/songs/{id}/analyze?detector=baseline` jalankan analisis di background task, status bisa dipoll.
- `GET /api/songs/{id}/chords?version=auto|corrected` kembalikan segmen sebagai JSON. Kalau `corrected` belum ada, kembalikan salinan `auto`.
- `PUT /api/songs/{id}/chords` simpan segmen hasil koreksi ke `.corrected.lab` (validasi: waktu berurutan, tidak tumpang tindih, chord valid).
- `GET /api/songs/{id}/audio` stream audio dengan dukungan HTTP Range (wajib, supaya seek bekerja di Safari iPad).
- `GET /api/songs/{id}/export?format=lab|txt` ekspor label, atau teks sederhana berisi urutan chord per baris.
- `DELETE /api/songs/{id}`.
Tambahkan tes API dengan TestClient.

### Fase 2b: Input dari link
- Tambah endpoint `POST /api/songs/from-url` dengan body JSON `{ "url": "..." }`.
- Unduh audionya saja memakai `yt-dlp` (dipanggil lewat subprocess atau library-nya), format terbaik lalu dikonversi ke wav mono 22050 Hz lewat pipeline `audio.py` yang sudah ada. Simpan juga judul video sebagai nama lagu di SQLite.
- Pengunduhan dijalankan di background task, statusnya bisa dipoll seperti analisis: `downloading`, `converting`, `ready`, `error`.
- Validasi URL: hanya http/https, tolak yang bukan. Batasi durasi maksimum (default 15 menit, bisa diatur di config.py) supaya tidak nyangkut di video panjang atau livestream.
- Satu link satu lagu. Playlist ditolak dengan pesan jelas.
- Tangani error dengan pesan manusiawi: link tidak valid, video privat, diblokir wilayah, yt-dlp kadaluarsa (sarankan `pip install -U yt-dlp`), ffmpeg tidak ada.
- Cache berdasarkan ID video, jadi link yang sama tidak diunduh dua kali.
- Setelah unduhan selesai, simpan audio ke `data/audio/` seperti upload biasa, sehingga semua fitur lain (analisis, koreksi, ekspor) bekerja sama persis.
- Tambahkan di README catatan bahwa fitur ini untuk pemakaian pribadi, dan bahwa yt-dlp perlu diperbarui berkala karena situs sering berubah.
- Tes: mock pemanggilan yt-dlp, jangan lakukan unduhan sungguhan di pytest.

### Fase 3: Antarmuka web (mode lihat)
- Halaman daftar lagu + tombol upload.
- Halaman pemutar: audio player, plus tampilan chord:
  - chord yang sedang berbunyi ditampilkan BESAR di tengah, chord berikutnya lebih kecil di sampingnya.
  - lini waktu horizontal berisi kotak-kotak chord, kotak aktif menyala dan ikut bergulir saat lagu jalan.
  - klik kotak untuk lompat ke waktu itu.
- Kontrol: kecepatan putar 0.5x sampai 1.25x dengan `preservesPitch = true`, loop A-B, tombol mundur/maju 5 detik.
- Transpose tampilan (-6 sampai +6 semiton) dan pilihan capo. Ini hanya mengubah nama chord yang ditampilkan, bukan audio. Pilih ejaan sharp atau flat secara konsisten.
- Desain mobile-first dan nyaman di iPad: target sentuh minimal 44px, font besar, tanpa hover-only interaction.

### Fase 3b: UI untuk link
- Di halaman daftar lagu, sediakan satu kolom input yang menerima dua hal: tempel link, atau pilih file. Tombol "Tambah" besar dan nyaman disentuh di iPad.
- Tampilkan progres status unduhan dan analisis di kartu lagu, tanpa perlu refresh halaman.

### Fase 4: Koreksi
- Mode edit di halaman pemutar: ketuk kotak chord untuk membuka editor kecil (pilih root, jenis chord, bass opsional untuk slash chord, atau ketik manual).
- Operasi: ganti label, pecah segmen di posisi playhead, gabung dengan segmen sebelah, geser batas waktu, hapus.
- Tombol "Salin chord ini ke semua segmen yang sama" dengan konfirmasi.
- Simpan otomatis (debounce) ke `PUT /api/songs/{id}/chords`. Tampilkan indikator tersimpan.
- Undo/redo minimal 20 langkah di sisi klien.
- Pilihan tampilan: bandingkan `auto` vs `corrected` berdampingan (segmen yang berbeda ditandai warna).

### Fase 5: Evaluasi
- `evaluate.py`: bandingkan label mesin dengan `corrected.lab` memakai mir_eval, laporkan `root`, `majmin`, `thirds`, `sevenths` (atau metrik terdekat yang didukung), plus akurasi per kualitas chord (sus, add9, 7, slash).
- `scripts/evaluate_dir.py` mengevaluasi semua lagu yang punya `corrected.lab`, mencetak tabel ringkasan dan daftar chord yang paling sering salah terbaca (misal Dsus2 terbaca D).
- Halaman `/stats` sederhana menampilkan angka itu, supaya saya bisa melihat apakah detector membaik atau memburuk.

### Fase 6: Detector pretrained (jangan dikerjakan sebelum saya minta)
Siapkan saja kerangkanya: `detectors/pretrained.py` sebagai stub dengan interface yang sama, dan pilihan `detector=` di API sudah mendukung nama lain. Tuliskan di README langkah untuk mencoba madmom (chord recognition) atau model BTC, tanpa memasang dependensi beratnya secara default.

## Aturan kerja
- Tanya saya sebelum menambah dependensi besar (torch, tensorflow, dll). Dependensi kecil boleh langsung.
- Kode harus bersih dan berkomentar singkat di bagian yang tidak jelas. Hindari abstraksi yang tidak dibutuhkan.
- Semua parameter yang bisa dituning (suhu softmax, probabilitas transisi, panjang segmen minimum, hop length, durasi maksimum unduhan) ditaruh di `config.py`.
- Tangani error dengan pesan jelas: file rusak, ffmpeg tidak ada, format tidak didukung.
- Semua proses analisis berjalan lokal. Satu-satunya akses jaringan keluar adalah unduhan dari link yang saya tempel sendiri. Jangan pernah mengunggah audio ke layanan luar.
- Jangan commit file audio. `.gitignore` harus mencakup folder data.
- README berisi: cara install (termasuk ffmpeg di Windows/Mac/Linux), cara menjalankan, cara membuka dari iPad (cari IP laptop, buka `http://IP:8000`), dan penjelasan alur kerja koreksi.
- Kalau ada keputusan desain yang ambigu, pilih opsi paling sederhana, catat alasannya di komentar atau README, dan lanjut.

Mulai dari Fase 1. Sebelum menulis kode, tampilkan rencana singkat (daftar file yang akan dibuat) dan tunggu persetujuan saya.
