# Chord Finder (pribadi, lagu rohani)

Web statis (jalan sepenuhnya di browser) untuk mendeteksi chord dari file audio/video, memutarnya dengan chord yang sinkron,
mengoreksi hasilnya, dan mengukur seberapa benar mesinnya. Data (lagu, audio, label) disimpan di Supabase sehingga sama di semua perangkat.
Disajikan oleh Netlify dari folder `web/`: tanpa server Python, tanpa build, tanpa framework.

**Status:** semua fase inti selesai (engine JS, penyimpanan, pemutar, editor koreksi, evaluasi, PWA). Detector pretrained (Fase 6)
**belum dikerjakan** dan hanya akan dibuat bila diminta. Fitur tempel link YouTube dan backend FastAPI pernah ada, lalu dihapus
(masih ada di riwayat git, commit `3448cc8` dan sebelumnya).

## Memakai aplikasi

Buka situsnya (alamat Netlify) di browser mana pun. Di iPad: Safari → Bagikan → **Tambah ke Layar Utama** agar terbuka seperti app.
Di Chrome/Android/desktop ada tombol Pasang di bilah alamat.

1. **Daftar lagu** (`index.html`): **+ Tambah lagu** (atau seret file). File dibaca dan didekode di browser, diunggah ke Supabase Storage,
   dianalisis di Web Worker, lalu hasilnya disimpan. Satu file satu kali (hemat RAM iPad). Batas: 50 MB dan 15 menit. File yang sama (hash isi) ditolak.
   Tersedia juga **Analisis ulang**, **Ekspor .lab**, **Impor .lab** (jadi versi koreksi), **Hapus**, dan **Ekspor semua label (JSON)** untuk cadangan.
2. **Pemutar** (`player.html`, tombol **▶ Buka pemutar**): lihat bagian di bawah.
3. **Mode edit** di pemutar untuk mengoreksi chord.
4. **Statistik** (`stats.html`, tombol 📊): seberapa benar mesin dibanding koreksimu.

### Pemutar

- **Chord aktif** besar di tengah, **chord berikutnya** lebih kecil di sampingnya; lini waktu horizontal yang ikut bergulir (ketuk kotak untuk melompat).
- **Kontrol:** putar/jeda, ±5 detik, penggeser posisi, kecepatan 0.5×–1.25× (nada tetap), **loop A–B**, layar tetap menyala saat main.
  Laptop: spasi = putar/jeda, panah = ±5 detik.
- **Transpose** −6..+6 dan **capo** 0..11 hanya mengubah nama chord yang ditampilkan. Chord yang tampil = bentuk yang dimainkan (nada dasar dikurangi capo).
  Ejaan ♯/♭ konsisten ("Otomatis" memilih flat untuk key berflat seperti F, Bb, Eb). **Key** ditebak dari chord (Krumhansl-Kessler) dan hanya tebakan.
- Pengaturan transpose/capo/ejaan diingat per lagu di browser. Audio dialirkan dari Supabase lewat URL bertanda tangan yang mendukung HTTP Range (seek jalan).

### Mode edit (koreksi)

Koreksi disimpan sebagai versi `corrected` dan **tidak pernah menimpa** hasil mesin (`auto`).
- **Memilih segmen:** ketuk kotak chord. Kotak yang berbeda dari hasil mesin diberi garis kuning.
- **Mengganti chord:** nada dasar (12 tombol), jenis (maj, m, sus2, sus4, 7, maj7, m7, add9, …), bass untuk slash chord (`D/F#`), `N`, atau ketik manual (divalidasi).
  **Ganti semua:** setelah mengubah `Dsus2` → `D`, tombol "Ganti semua `Dsus2` lain → `D` (n)" muncul, dengan konfirmasi.
- **Operasi:** pecah di playhead, gabung dengan sebelumnya/berikutnya, hapus (waktunya diserap tetangga), geser batas (±0,1 / ±0,5 detik atau "= playhead"),
  geser playhead, dan **Loop segmen ini**. Durasi segmen minimal 0,1 detik; segmen tidak tumpang tindih.
- **Simpan otomatis** 0,8 detik setelah perubahan terakhir, dengan indikator. **Urungkan/Ulangi** sampai 100 langkah (Ctrl+Z / Ctrl+Shift+Z).
  **Kembalikan ke hasil mesin** (konfirmasi, bisa diurungkan). **⇄ Bandingkan dengan mesin**: dua baris sejajar, segmen berbeda diberi warna.
- Mode edit menampilkan chord **asli** (tanpa transpose/capo). Panel editor muncul tepat di bawah lini waktu, dan **dock** (posisi, tombol putar, ±5 detik, "Sekarang: …") menempel di dasar layar sambil mengedit, jadi kamu tidak perlu menggulir ke atas untuk memutar. Jenis chord yang jarang dipakai dilipat di "Jenis lain".
  Tidak ada penguncian antar perangkat: bila dua perangkat mengedit lagu yang sama, yang menyimpan terakhir menang.

### Statistik

Acuannya adalah koreksimu; yang dinilai adalah hasil mesin (`auto` atau `baseline`/detector lain). Halaman menampilkan perbandingan versi, tabel per lagu,
akurasi per jenis chord (mayor, minor, sus, add9, 7th, slash, N, lainnya), dan salah baca terbanyak (mis. `Dsus2 → D` berapa detik).
Empat skor standar mir_eval: **root**, **majmin**, **thirds**, **sevenths**. "–" = tidak ada bagian yang bisa dibandingkan.

Yang perlu dipahami:
- **mir_eval mengabaikan nada ke-9**: `add9` dianggap mayor, `9` = `7`, `maj9` = `maj7`, `m9` = `m7`. Salah baca `Cadd9` → `C` tidak mengurangi skor mir_eval;
  untuk itu ada tabel "persis sama" per jenis dan daftar salah baca. `majmin` dan `sevenths` mengecualikan chord acuan di luar kosakatanya (mis. sus);
  `thirds` hanya melihat root dan ada tidaknya terts minor (sus dan mayor dianggap sama).
- **Hanya sebagus koreksimu.** Bagian lagu yang belum kamu periksa masih berisi hasil mesin, sehingga dihitung "benar". Angka yang adil hanya untuk lagu yang
  sudah diperiksa sampai habis.
- Aturan: rentang evaluasi = rentang koreksi; mesin dipotong/diisi `N`; celah dianggap `N`; selisih batas < 0,1 detik tidak dihitung sebagai salah baca.

## Deploy

### Supabase (data lintas perangkat)
Project `chord-finder` (Singapore, free tier) sudah dibuat. Skema, bucket audio privat, dan aturan akses ada di [`supabase/schema.sql`](supabase/schema.sql)
(jalankan di SQL Editor untuk project baru). URL dan *publishable key* ada di `web/js/supabase-config.js`: keduanya **publik** dan memang ditaruh di kode;
**jangan pernah** menaruh `service_role`/secret key atau database password di kode atau repo.
Free tier: project dijeda otomatis bila tidak aktif 7 hari (data aman, tinggal *Restore* di dashboard); storage 1 GB.

### Netlify
Repo GitHub → Netlify → *Import an existing project*. Pengaturan (sudah dibaca dari `netlify.toml`): **Base directory** kosong, **Build command** kosong,
**Publish directory** `web`, **Functions directory** kosong. Netlify otomatis men-deploy setiap push ke `main`.
Jika situs mengembalikan HTTP 401, matikan **Team login** di Project configuration → Access & security → Visitor access.
`netlify.toml` juga memasang header keamanan, termasuk **Content-Security-Policy** yang hanya mengizinkan skrip dari situs sendiri dan jsdelivr
(supabase-js, versi terkunci) serta koneksi data/audio ke project Supabase di atas. **Bila project Supabase diganti, ubah alamatnya di `connect-src` dan `media-src`.**

### Keamanan: mode terbuka
Saat ini **tanpa login** (`REQUIRE_LOGIN = false`). Siapa pun yang tahu alamat situsnya bisa melihat, mengubah, dan menghapus lagu dan label, serta mengunggah
audio sampai kuota habis (bucket dibatasi 50 MB/file dan hanya audio/video). Repo GitHub publik memuat alamat Supabase, jadi endpoint mudah ditemukan.
**Mengunci ke satu akun:** ikuti urutan di [`supabase/lock-down.sql`](supabase/lock-down.sql) (buat user di dashboard, matikan signup, jalankan skripnya),
ubah `REQUIRE_LOGIN` ke `true`, lalu deploy ulang. Data yang ada tetap utuh; form login sudah tersedia.

### PWA
`manifest.webmanifest`, ikon (`web/icons/`, dibangkitkan `scripts/make_icons.py` tanpa dependensi), dan `sw.js`. Service worker memakai strategi **jaringan dulu**
(selalu versi terbaru; cache hanya cadangan) dan tidak menyentuh Supabase/CDN. Offline hanya cangkang aplikasinya yang terbuka; daftar lagu, audio, dan label
tetap butuh internet.

## Format data
- Label `.lab`: `start<TAB>end<TAB>chord` per baris. Notasi chord: `C Dm Dsus2 Dsus4 C7 Cmaj7 Am7 Cadd9 G/B N`. Konversi Harte dua arah ada di `web/js/labels.js` dan `app/labels.py`.
- Di database tiap lagu punya beberapa versi label: `auto` (analisis terakhir; tidak pernah ditimpa koreksi), nama detector (`baseline`), dan `corrected` (koreksimu).

## Detector (JavaScript, `web/js/`)
Chroma dari FFT (jendela 8192, hop 2048) → template (mayor, minor, sus2, sus4, 7, maj7, m7, N) → softmax → Viterbi → segmen → segmen < 0,3 detik diserap tetangga.
Semua parameter ada di `web/js/config.js`.

**Penyetelan (2026-11-24):** pada lagu worship asli versi pertama membaca **69,9% waktu sebagai "N"**, padahal tes sintetis lolos semua (chroma FFT pada rekaman
nyata menjadi datar). Perbaikan: median waktu (penguat harmonik), pengurangan lantai broadband, pangkat 1,5, "N" hanya untuk hening, suhu softmax 0,15, transisi 0,95,
penalti sus/7th. Hasil: N 69,9% → **1,2%**; kesepakatan dengan detector Python 22% → 76%. Keterbatasan: diuji pada **satu lagu** tanpa label benar berwaktu; Python
hanya pembanding; **sus2/sus4 masih sering terbaca** (ambiguitas bawaan: D dengan nada E dari pad = Dsus2; `qualityBias` adalah penilaian, geser sesuai selera);
slash chord belum dideteksi (butuh estimasi bass). Tes regresi memakai sinyal sintetis berderau tinggi yang membuat pengaturan lama gagal (N 100%).

## Pengembangan
```powershell
npm test                                                            # tes JS (Node 20+): engine, label, editor, evaluasi, PWA, API (klien Supabase palsu)
python -m venv .venv; .\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m pytest -q                             # tes Python: detector acuan, label, konversi audio, evaluasi (mir_eval)
cd web; python -m http.server 8000                                  # jalankan lokal di http://localhost:8000 (modul ES tidak jalan dari file://)
```
- **Python** (`app/`, `scripts/`) adalah acuan dan alat offline: detector CQT (`app/detectors/baseline.py`), `scripts/analyze_file.py lagu.mp3` (butuh ffmpeg:
  Windows `winget install Gyan.FFmpeg`, Mac `brew install ffmpeg`, Linux `sudo apt install ffmpeg`), `scripts/evaluate_dir.py` (`--backup berkas.json` dari
  tombol ekspor, atau `--dir folder-label`; `--est baseline` untuk versi lain).
- **Paritas JS = mir_eval:** `scripts/make_eval_fixture.py` membangkitkan 80 kasus acak + jawaban mir_eval ke `js-tests/fixtures/eval-parity.json`; jalankan ulang
  hanya bila logika evaluasi atau kosakata chord berubah.
- **Kualitas tes:** tes paritas diuji dengan mutasi (rumus sengaja dirusak → tes gagal). Tes sinyal sintetis bersih tidak cukup untuk detector (lihat penyetelan di atas).

## Belum terbukti
- **Safari iPad asli** (seek dan putar dari URL Supabase, sentuhan di editor, Wake Lock, pemasangan ke layar utama) dan **service worker di browser sungguhan**
  (browser uji tidak mendukung service worker; perilakunya diuji di Node dengan `self`/`caches`/`fetch` tiruan).
- **Akurasi pada banyak lagu.** Belum ada lagu yang dikoreksi penuh, jadi akurasi nyata belum terukur.
- Editor di layar HP masih panjang (~1200 px) meski dock menempel; tata letaknya baru dilihat di emulasi Chrome, belum di iPad.
