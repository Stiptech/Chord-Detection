# Chord Finder (pribadi, lagu rohani)

Aplikasi lokal untuk mendeteksi chord dari file audio/video atau link, lalu mengoreksinya.
> **Arah proyek berubah (2026-11-24):** aplikasi akan jadi **web statis yang jalan di browser**
> (deploy ke Netlify), bukan server Python. Backend FastAPI di bawah (Fase 2 dan 2b) tidak lagi
> dipakai dan akan dihapus di fase akhir; engine, format label, dan tes Python tetap sebagai acuan
> dan alat evaluasi offline. Penyimpanan lintas perangkat (database) sedang diputuskan.

Status: Fase 1, 2, 2b (Python) selesai. Fase A (engine JavaScript) dan Fase B (penyimpanan Supabase + daftar lagu) selesai; **berjalan tanpa login** (mode terbuka). Pemutar menyusul.

## Supabase (database + penyimpanan audio lintas perangkat)

Project `chord-finder` (Singapore, free tier) sudah dibuat dan skemanya terpasang ([`supabase/schema.sql`](supabase/schema.sql)).
URL dan publishable key ada di `web/js/supabase-config.js` (nilai publik; **jangan** menaruh `service_role`/secret key
atau database password di kode atau repo).

**Mode saat ini: terbuka, tanpa login.** Siapa pun yang membuka alamat situsnya bisa melihat, mengubah, dan menghapus
lagu serta label, dan bisa mengunggah audio sampai kuota storage habis (bucket dibatasi 50 MB/file dan hanya audio/video).
Alamat situs tidak dipublikasikan, tapi itu bukan keamanan sungguhan. Aman untuk data yang tidak sensitif; kunci kalau ragu.

**Mengunci nanti (satu akun):** ikuti urutan di [`supabase/lock-down.sql`](supabase/lock-down.sql): buat user di dashboard,
matikan signup, jalankan skripnya, ubah `REQUIRE_LOGIN` ke `true` di `supabase-config.js`, lalu deploy ulang.
Data yang sudah ada tetap utuh. Form login sudah tersedia di aplikasi.

Catatan free tier: project dijeda otomatis kalau tidak aktif 7 hari (data tetap aman, tinggal *Restore* di dashboard);
storage 1 GB.

## Aplikasi web (Fase B: daftar lagu)

Buka `web/index.html` lewat server statis (modul ES tidak jalan dari `file://`). Contoh lokal:

```powershell
cd web
python -m http.server 8000      # lalu buka http://localhost:8000
```

1. **+ Tambah lagu** (atau seret file): file dibaca dan didekode di browser, diunggah ke Supabase Storage,
   dianalisis di Web Worker, lalu hasilnya disimpan ke database (versi `baseline` dan `auto`).
   Satu file satu kali (hemat RAM iPad). Batas: 50 MB dan 15 menit. File yang sama (hash isi) ditolak.
2. **Lihat chord**, **Analisis ulang** (mengunduh audio lalu menganalisis lagi), **Ekspor .lab**
   (koreksi bila ada, kalau tidak hasil mesin), **Impor .lab** (jadi versi `corrected`), **Hapus**
   (audio + semua label), dan **Ekspor semua label (JSON)** sebagai cadangan.
3. Analisis yang terputus (tab ditutup) tampil sebagai "Terputus" dan bisa diulang. Daftar lagu
   disegarkan otomatis saat tab kembali aktif, jadi perubahan dari perangkat lain muncul.

Tes: `npm test` (tanpa jaringan; klien Supabase dipalsukan). Pemutar chord, lini waktu, dan editor koreksi
menyusul di Fase C dan D.

## Engine JavaScript (`web/js/`)

Port baseline Python ke JavaScript murni, tanpa dependensi dan tanpa build step; modul yang sama
dipakai browser dan Node. Tes: `npm test` (memakai `node --test`, Node 20+).

| Berkas | Isi |
|---|---|
| `config.js` | semua parameter yang bisa dituning (suhu softmax, transisi, segmen minimum, FFT, ...) |
| `fft.js`, `chroma.js` | FFT radix-2 dan chroma dari STFT (jendela 8192, hop 2048) |
| `baseline.js` | template, softmax, Viterbi, penggabungan segmen, `detect(samples, sampleRate)` |
| `labels.js` | baca/tulis `.lab`, validasi chord, konversi Harte dua arah |

Beda dengan Python: chroma dari FFT (bukan CQT) dan tanpa pemisahan harmonik/perkusif (HPSS).
Pada audio sintetis (termasuk harmonik banyak, bass, dan noise) hasilnya sama dengan Python;
pada lagu asli kemungkinan berbeda dan perlu dituning dengan lagumu.

## Instalasi

1. **Python 3.11+** (diuji di 3.14).
2. **ffmpeg** (wajib untuk mp3/mp4/m4a):
   - Windows: `winget install Gyan.FFmpeg` (lalu buka ulang terminal)
   - Mac: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
   - Cek: `ffmpeg -version`
3. Dependensi Python:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
   (Mac/Linux: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`)

## Mencoba Fase 1 (CLI)

```powershell
.\.venv\Scripts\python.exe scripts\analyze_file.py lagu.mp3
```

Mencetak segmen (`mulai akhir chord`) dan menulis `data/labels/lagu.baseline.lab`.
Tanpa ffmpeg, wav pun tetap lewat ffmpeg sehingga akan muncul pesan cara memasangnya.

Tes: `.\.venv\Scripts\python.exe -m pytest -q`

## Menjalankan server (Fase 2)

```powershell
.\run.ps1          # Mac/Linux: ./run.sh
```

Server jalan di `0.0.0.0:8000`. Buka **http://localhost:8000/docs** untuk mencoba semua endpoint
dari browser (halaman web aslinya baru ada di Fase 3). Dari iPad: cari IP laptop (`ipconfig`),
buka `http://IP:8000/docs`; kalau tidak bisa, izinkan Python di Windows Firewall untuk jaringan privat.

Contoh lewat terminal:
```powershell
curl.exe -F "file=@lagu.mp3" http://localhost:8000/api/songs          # -> {"id": 1, ...}
curl.exe -X POST "http://localhost:8000/api/songs/1/analyze"          # jalan di background
curl.exe http://localhost:8000/api/songs/1                            # poll: status uploaded/analyzing/ready/error
curl.exe http://localhost:8000/api/songs/1/chords
```

| Endpoint | Fungsi |
|---|---|
| `POST /api/songs` | upload file (multipart, field `file`) |
| `GET /api/songs`, `GET /api/songs/{id}` | daftar lagu / satu lagu (untuk polling status) |
| `POST /api/songs/{id}/analyze?detector=baseline` | analisis di background; 409 bila sedang berjalan |
| `GET /api/songs/{id}/chords?version=auto\|corrected` | segmen JSON. `corrected` yang belum ada = salinan `auto` (field `version` menyebut mana yang dikirim). Nama detector juga boleh jadi `version`. |
| `PUT /api/songs/{id}/chords` | simpan koreksi: `{"segments":[{"start","end","label"}]}`. Ditolak (422) bila tumpang tindih, tidak berurutan, durasi nol, atau chord tak valid. Gap antar segmen diperbolehkan. |
| `GET /api/songs/{id}/audio` | stream audio dengan HTTP Range (seek di Safari) |
| `GET /api/songs/{id}/export?format=lab\|txt&version=corrected` | unduh label; `txt` = 4 chord per baris tanpa `N` |
| `DELETE /api/songs/{id}` | hapus audio + semua label lagu itu (cache wav dibiarkan; dipakai bersama) |

### Input dari link (Fase 2b)

```powershell
curl.exe -X POST http://localhost:8000/api/songs/from-url -H "Content-Type: application/json" -d "{\"url\":\"https://youtu.be/XXXX\"}"
```

- Hanya `http`/`https`. Satu link = satu video; playlist, livestream, dan video lebih dari
  15 menit (`MAX_DOWNLOAD_SEC` di `app/config.py`) ditolak langsung (400) dengan pesan jelas.
- Status yang bisa dipoll lewat `GET /api/songs/{id}`: `downloading` -> `converting` -> `uploaded`
  (atau `error` dengan pesan manusiawi). Setelah itu lagu diperlakukan persis seperti upload:
  tinggal `POST .../analyze`. Status `ready` tetap berarti *analisis selesai*.
- Audio disimpan di `data/audio/<id>.m4a` (format m4a/AAC diutamakan karena bisa diputar Safari iPad).
- Link yang sama tidak diunduh dua kali: kalau video itu sudah ada sebagai lagu, respons `200` berisi
  lagu yang sudah ada dengan `"duplicate": true`. Kalau percobaan sebelumnya gagal, record yang sama dipakai ulang.
- Hanya untuk pemakaian pribadi. Hormati hak cipta dan ketentuan layanan situs asal.
- **yt-dlp perlu diperbarui berkala** karena situs sering berubah. Kalau muncul pesan
  "yt-dlp sudah kadaluarsa", jalankan `.\.venv\Scripts\python.exe -m pip install -U yt-dlp` lalu mulai ulang server.
- Unduhan butuh internet; analisis dan semua fitur lain tetap 100% lokal.

File label per lagu di `data/labels/`: `<id>.auto.lab` (analisis terakhir, tidak pernah disentuh
koreksi), `<id>.<detector>.lab` (tiap detector), `<id>.corrected.lab` (koreksimu). Analisis ulang
menimpa `auto` tapi tidak pernah `corrected`.

Keputusan sederhana: id lagu berupa angka yang tidak dipakai ulang; kalau server mati di tengah
analisis, lagu itu ditandai `error` saat server hidup lagi (bisa dianalisis ulang).

## Cara kerja detector baseline

audio -> komponen harmonik -> chroma CQT (hop 2048) -> kemiripan ke template chord
(mayor, minor, sus2, sus4, 7, maj7, m7, N) -> softmax -> Viterbi -> segmen -> segmen
< 0.3 detik diserap tetangga. Semua angka (suhu, probabilitas bertahan, panjang minimum,
bias per kualitas chord) ada di `app/config.py`.

Keterbatasan yang sudah diketahui:
- **sus2 vs sus4**: Dsus4 dan Gsus2 berisi nada yang sama, jadi root-nya tidak bisa dibedakan
  dari chroma. Perlu info bass atau model terlatih.
- Slash chord (G/B) belum dideteksi; bisa diisi lewat koreksi manual.
- Pad tebal dan reverb mengaburkan chroma. Anggap hasilnya tebakan awal.

## Format label

`.lab`, tiga kolom dipisah tab: `start_sec  end_sec  chord`. Notasi: `C Dm Dsus2 C7 Cmaj7 Am7 Cadd9 G/B N`.
Konversi ke notasi Harte (untuk mir_eval) ada di `app/labels.py`.

## Catatan keputusan desain

- Ejaan chord hasil mesin selalu sharp (C#, bukan Db). Pilihan sharp/flat untuk tampilan masuk di Fase 3.
- `add9` tidak ada di kosakata baseline (sesuai spesifikasi), tapi dikenali sebagai input/koreksi.
- Cache konversi memakai hash isi file, jadi file yang sama tidak dikonversi dua kali.
