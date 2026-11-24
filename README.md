# Chord Finder (pribadi, lagu rohani)

Aplikasi lokal untuk mendeteksi chord dari file audio/video atau link, lalu mengoreksinya.
Status: **Fase 1 selesai** (engine baseline lewat CLI). Web UI menyusul di fase berikutnya.

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
