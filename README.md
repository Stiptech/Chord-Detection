# Chord Finder (pribadi, lagu rohani)

Web statis (jalan sepenuhnya di browser) untuk mendeteksi chord dari file audio/video, memutarnya dengan chord yang sinkron,
mengoreksi hasilnya, dan mengukur seberapa benar mesinnya. Data (lagu, audio, label) disimpan di Supabase sehingga sama di semua perangkat.
Disajikan oleh Netlify dari folder `web/`: tanpa server Python, tanpa build, tanpa framework.

**Status:** semua fase inti selesai (engine JS, penyimpanan, pemutar, editor koreksi, evaluasi, PWA, lembar chord). Detector pretrained (Fase 6)
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
4. **Lembar chord** (`sheet.html`, tombol 📄): chord di atas lirik seperti lembar cetak.
5. **Statistik** (`stats.html`, tombol 📊): seberapa benar mesin dibanding koreksimu.

### Pemutar

- **Chord aktif** besar di tengah, **chord berikutnya** lebih kecil di sampingnya; lini waktu horizontal yang ikut bergulir (ketuk kotak untuk melompat).
- **Kontrol:** putar/jeda, ±5 detik, penggeser posisi, kecepatan 0.5×–1.25× (nada tetap), **loop A–B**, layar tetap menyala saat main.
  Laptop: spasi = putar/jeda, panah = ±5 detik.
- **Transpose** −6..+6 dan **capo** 0..11 hanya mengubah nama chord yang ditampilkan. Chord yang tampil = bentuk yang dimainkan (nada dasar dikurangi capo).
  Ejaan ♯/♭ konsisten ("Otomatis" memilih flat untuk key berflat seperti F, Bb, Eb). **Key** ditebak dari chord (Krumhansl-Kessler) dan hanya tebakan.
- Pengaturan transpose/capo/ejaan diingat per lagu di browser. Audio dialirkan dari Supabase lewat URL bertanda tangan yang mendukung HTTP Range (seek jalan).

### Ketukan, birama, metronom (kartu "Ketukan" di pemutar)
Saat analisis, aplikasi juga mencari **ketukan** (tempo, garis ketukan, birama). Lagu lama: ketuk **Hitung ketukan** di pemutar (mengunduh audio lalu menghitung di browser, ~1 detik per lagu).
- **▦ Per birama:** lini waktu berubah jadi satu kotak per birama (`C`, `G Am`, `•` bila chord bertahan). Ketuk kotak untuk melompat.
- **Birama 3/4/6** dan **Downbeat ◀ ▶** (ketukan pertama tiap birama) bisa diubah; **÷2 / ×2** bila tempo terasa dua kali terlalu cepat/lambat. Semua tersimpan per lagu (`songs.beats`).
- **Metronom** (klik beraksen di downbeat, mengikuti kecepatan putar), **hitung mundur** satu birama sebelum lagu mulai, dan **loop 1 / 4 birama** dari posisi sekarang.
- Di mode edit: **⌗ Rapatkan ke ketukan** menggeser batas chord (yang berjarak ≤ 0,15 dtk dari ketukan) ke ketukan; satu langkah, bisa diurungkan.
- **Lembar chord:** bagian tanpa lirik (Intro/Instrumen) kini memakai palang birama sungguhan `| C | G | Am F | • |`, empat birama per baris.

**Cara kerja (klasik, bukan jaringan saraf):** kekuatan onset dari spektrum mel → tempo dari autokorelasi dengan prior (condong ke tempo lambat-sedang, 85 BPM) → pelacak ketukan
dinamis (Ellis 2007) → downbeat dan birama dipilih dari seberapa teratur pergantian chord terhadap siklus ketukan. Pada lagu asli, 52% pergantian chord jatuh dalam 80 ms
dari ketukan (pembanding acak 9%). **Batasan jujur:** tempo selalu ambigu satu oktaf (68 atau 136 BPM sama-sama "benar"), jadi ada ÷2/×2; birama tebakan lemah bila chord jarang berganti;
perkusi lemah/rubato membuat ketukan menyimpang. Hanya divalidasi pada satu lagu asli dan sinyal sintetis.

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

### Lembar chord (seperti lembar cetak)

Tombol **📄 Lembar chord** di pemutar (atau **📄 Lembar** di kartu lagu). Hasilnya teks monospace seperti lembar lagu rohani: baris `Key: F`, lencana bagian
(Intro, Verse 1, Chorus, Instrumen, …), chord merah di atas lirik, dan bagian tanpa lirik sebagai deretan chord (`| C  G  Am  F |`, empat chord per baris).

**Menyusunnya** (tab **✎ Susun lirik & sinkron**):
1. **Tempel lirik**, satu baris lirik per baris. Judul bagian boleh ditulis sebagai baris sendiri: `Intro`, `Verse 1`, `Chorus`, `Instrumen`, `Bridge`, atau `[Judul bebas]`.
   Bagian yang tidak punya lirik di bawahnya (Intro, Instrumen) menjadi deretan chord. Tekan **Terapkan lirik**.
2. **Ketuk waktunya:** putar lagu, lalu tekan **⏱ Mulai di sini** (atau spasi/Enter di laptop) tepat saat baris yang disorot mulai dinyanyikan. Waktu ketuk dikurangi 0,25 detik
   (waktu reaksi). Tiap baris punya ▶ (putar dari sini), ±0,1, "= posisi", dan ✕ untuk koreksi halus; **Urungkan** membatalkan ketukan terakhir.
3. Buka tab **📄 Lembar**. Lirik dan waktu tersimpan otomatis (kolom `songs.sheet`), jadi sama di semua perangkat.

**Aturan penempatan:** chord diambil dari versi koreksi (atau hasil mesin bila belum dikoreksi). Tiap chord diletakkan di awal kata terdekat menurut waktunya di dalam baris;
chord pertama di awal baris; chord yang saling berdekatan didorong ke kanan supaya tidak menimpa. Chord hanya dihitung bila berbunyi minimal 0,3 detik di dalam baris
(batas segmen deteksi sering meleset puluhan milidetik), sehingga chord yang berganti sesaat sebelum baris berikutnya tampil di baris berikutnya. `N` dilewati.

**Di tab Lembar:** transpose, capo, dan ejaan ♯/♭ (dibagi dengan pemutar, jadi lembar langsung mengikuti), ukuran huruf, **Salin teks**, **Unduh .txt**, dan
**Cetak / simpan PDF** (tampilan cetak putih-hitam tanpa kontrol).

**Batasan yang jujur:** penempatan chord memakai pembagian waktu *proporsional* di dalam baris, jadi bisa meleset satu-dua kata bila kata-katanya tidak merata waktunya;
belum ada geser manual per chord (solusinya: salin teks lalu rapikan, atau pecah baris panjang jadi dua). Palang birama hanya muncul bila lagu punya data ketukan
(lihat kartu Ketukan di pemutar); tanpa itu bagian tanpa lirik tampil empat chord per baris. Lembar hanya sebagus label chordnya: koreksi chord dulu di mode edit.

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
Jika situs mengembalikan HTTP 401, matikan **Team login** di Project configuration → Access & security → Visitor access (sudah dimatikan untuk situs ini, dan situs live sudah diuji publik).
Netlify menyuntikkan skripnya sendiri (`/.netlify/scripts/hud`, toolbar anggota tim) ke setiap halaman; bagian inline-nya diblokir CSP dan muncul sebagai satu error di konsol. Itu wajar dan tidak mengganggu aplikasi.
`netlify.toml` juga memasang header keamanan, termasuk **Content-Security-Policy** yang hanya mengizinkan skrip dari situs sendiri dan jsdelivr
(supabase-js, versi terkunci) serta koneksi data/audio ke project Supabase di atas. **Bila project Supabase diganti, ubah alamatnya di `connect-src` dan `media-src`.**

### Keamanan: mode terbuka
Saat ini **tanpa login** (`REQUIRE_LOGIN = false`). Siapa pun yang tahu alamat situsnya bisa melihat, mengubah, dan menghapus lagu dan label, serta mengunggah
audio sampai kuota habis (bucket dibatasi 50 MB/file dan hanya audio/video). Repo GitHub publik memuat alamat Supabase, jadi endpoint mudah ditemukan.
**Mengunci ke satu akun:** ikuti urutan di [`supabase/lock-down.sql`](supabase/lock-down.sql) (buat user di dashboard, matikan signup, jalankan skripnya),
ubah `REQUIRE_LOGIN` ke `true`, lalu deploy ulang. Data yang ada tetap utuh; form login sudah tersedia.

### PWA
Terbukti terdaftar dan aktif di situs live (HTTPS), dengan 36 berkas di cache. `manifest.webmanifest`, ikon (`web/icons/`, dibangkitkan `scripts/make_icons.py` tanpa dependensi), dan `sw.js`. Service worker memakai strategi **jaringan dulu**
(selalu versi terbaru; cache hanya cadangan) dan tidak menyentuh Supabase/CDN. Offline hanya cangkang aplikasinya yang terbuka; daftar lagu, audio, dan label
tetap butuh internet.

## Format data
- Label `.lab`: `start<TAB>end<TAB>chord` per baris. Notasi chord: `C Dm Dsus2 Dsus4 C7 Cmaj7 Am7 Cadd9 G/B N`. Konversi Harte dua arah ada di `web/js/labels.js` dan `app/labels.py`.
- Lembar chord disimpan di kolom `songs.sheet` (JSON: `{v, lyrics, times}`; `times` = detik awal tiap baris/bagian, dikunci oleh jenis|teks|urutan kemunculan).
- Ketukan disimpan di kolom `songs.beats` (JSON: `{v, bpm, meter, phase, confidence, beats:[detik]}`; `phase` = indeks ketukan yang jadi downbeat dalam siklus).
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

## Detector saraf BTC (otomatis di browser)
Model pretrained **BTC** (Bi-directional Transformer, Park dkk. ISMIR 2019, kosakata 170 chord) kini jalan **di browser**, tanpa server dan tanpa pustaka ML:
- `web/js/cqt.js`: CQT 144 bin (24 per oktaf), tiruan `librosa.cqt` (sub-sampling rekursif, pemotongan 10 dtk, log-magnitudo). Cocok dengan librosa: selisih rata-rata ~0,002 (log) pada lagu nyata.
- `web/js/btc.js`: inferensi transformer murni JavaScript (8 lapis, lebar 128, ±2,9 juta bobot). Cocok dengan PyTorch (selisih logit < 0,01 dengan bobot fp32; argmax 100% sama).
- `web/models/btc-large-voca.bin` (±6 MB, bobot fp16). Diunduh lewat jaringan setiap analisis BTC (browser meng-cache; service worker menyimpan salinan sebagai cadangan offline). **Berkas ini ikut tersedia publik** di repo dan situs; lihat `web/models/NOTICE`.
- Saat lagu dianalisis (unggah / "Analisis ulang"), BTC ikut dijalankan setelah detector sendiri dan ketukan; hasilnya disimpan sebagai versi label **`btc`** (otomatis ikut dibandingkan dengan `corrected` di Statistik). Kegagalan BTC tidak menggagalkan analisis. Matikan lewat `BTC_ON_ANALYZE` di `web/js/config.js`.
- Lagu lama: di mode edit, tombol **Hitung hasil BTC** menjalankannya di browser; setelah ada hasil, tombol berubah jadi **Muat hasil BTC** (mengganti segmen yang diedit; bisa diurungkan).
- Kecepatan: ±10 dtk untuk lagu 4 menit di laptop; di HP beberapa kali lebih lama (belum diukur).
- Verifikasi end-to-end pada lagu nyata (243 dtk): label BTC JavaScript sama dengan BTC Python di 100% titik uji (bobot fp16).

Membuat ulang berkas bobot dan fixture (venv terpisah dengan torch CPU, numpy, librosa, pyyaml; kode + bobot dari https://github.com/jayg996/BTC-ISMIR19, kode MIT):
```powershell
python -m venv btc_venv; .tc_venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.tc_venv\Scripts\python.exe -m pip install numpy librosa pyyaml mir_eval soundfile
.tc_venv\Scripts\python.exe -I scripts\export_btc_weights.py --btc-dir <folder BTC-ISMIR19> --out web\modelstc-large-voca.bin --fixture js-testsixturestc_model.json
.tc_venv\Scripts\python.exe -I scripts\make_cqt_fixture.py js-testsixtures\cqt.json
```
`scripts/btc_prototype.py` tetap ada sebagai acuan PyTorch (`--btc-dir --audio --out`) untuk membandingkan hasil.
**Lisensi:** kode BTC MIT; bobot dilaporkan CC-BY-NC-SA 4.0 oleh pihak ketiga (belum diverifikasi penulis asli), jadi hanya untuk pemakaian pribadi nonkomersial.

**Hasil awal pada lagu asli (akurasi BELUM terukur, belum ada koreksi penuh):** BTC membaca 74% waktu sebagai mayor polos, hanya 2,7% sus; detector sendiri membaca ~25-27% sus
(banyak `Gsus2` di mana BTC membaca `G`). Chord teratas BTC (D, A, G, Bm) adalah I-V-IV-vi di D, pola khas lagu ini. Kesepakatan BTC vs detector sendiri rendah (root 64%): tanda
perbedaan sistematis, bukan siapa yang benar. Pembuktian butuh lagu yang dikoreksi penuh; bandingkan di halaman Statistik.

## Belum terbukti
- **Pelacak ketukan** baru diuji pada satu lagu asli (+ sinyal sintetis); tebakan birama dan oktaf tempo belum teruji pada banyak lagu.
- **Safari iPad asli** (seek dan putar dari URL Supabase, sentuhan di editor, Wake Lock, pemasangan ke layar utama). Semua pengujian di Chrome (termasuk emulasi HP dan situs live).
- **Perilaku offline sungguhan** (mematikan jaringan lalu membuka app). Service worker terbukti terdaftar dan aktif di situs live, dan logikanya diuji di Node dengan `caches`/`fetch` tiruan.
- **Akurasi pada banyak lagu.** Belum ada lagu yang dikoreksi penuh, jadi akurasi nyata belum terukur.
- Editor di layar HP masih panjang (~1200 px) meski dock menempel; tata letaknya baru dilihat di emulasi Chrome.
