# Chord Finder (pribadi, lagu rohani)

Aplikasi lokal untuk mendeteksi chord dari file audio/video atau link, lalu mengoreksinya.
Status: **Fase 1 (engine CLI) dan Fase 2 (backend API) selesai**. Link YouTube (2b) dan web UI menyusul.

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
