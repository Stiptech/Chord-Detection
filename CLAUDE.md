# Chord Finder pribadi (lagu rohani)

Aplikasi lokal untuk satu pengguna: deteksi chord dari audio/video/link, tampil sinkron dengan lagu,
koreksi manual disimpan sebagai dataset label. Spesifikasi lengkap ada di `chord-finder-prompt.md`.

## Arsitektur (diputuskan 2026-11-24)
Web statis yang jalan di browser, deploy ke Netlify dari GitHub (folder `web/`, tanpa build step, tanpa framework).
Analisis chord dilakukan di browser (`web/js/`); Python (`app/`, `tests/`, `scripts/`) tetap sebagai acuan,
tes kesamaan, dan evaluasi offline. Backend FastAPI (`app/main.py`, `storage.py`, `download.py`) tidak lagi
dipakai dan dihapus di fase akhir. Fitur tempel link YouTube dilepas.
Data lintas perangkat: Supabase project `chord-finder` (Postgres songs + label_versions, bucket privat `audio`).
Saat ini MODE TERBUKA tanpa login (`REQUIRE_LOGIN = false`, RLS `using (true)` untuk anon; atas permintaan pengguna);
`supabase/lock-down.sql` + `REQUIRE_LOGIN = true` mengunci ke satu akun. Skema di `supabase/schema.sql`. Klien: `web/js/api.js`
(klien disuntikkan agar bisa diuji tanpa jaringan). Pengguna memberi izin penuh untuk urusan project ini;
jangan sentuh project Supabase lain milik mereka. Password akun dibuat pengguna sendiri.
Tes JS: `npm test`. Render UI diuji di browser dengan klien Supabase palsu (import map), tanpa login sungguhan.

Fase: A engine JS (selesai) -> B penyimpanan + daftar lagu (selesai) -> C pemutar (selesai) -> D editor koreksi (selesai) -> E evaluasi (selesai) -> F deploy/PWA.

## Prinsip
- Sederhana dan mudah diubah. Tanpa auth, tanpa cloud, tanpa ORM, frontend vanilla tanpa build step.
- Hasil mesin hanyalah tebakan awal; koreksi manual adalah alur utama.
- Semua analisis lokal. Satu-satunya akses jaringan keluar: unduhan dari link yang ditempel pengguna.
- Semua parameter yang bisa dituning ada di `app/config.py`.
- Tanya pengguna sebelum menambah dependensi besar (torch, tensorflow, dll).
- Kerja per fase; setelah tiap fase: jalankan tes, commit, lalu berhenti dan jelaskan cara mencobanya.
  Fase 6 (detector pretrained) hanya dikerjakan kalau diminta.

## Perintah
- Tes: `.\.venv\Scripts\python.exe -m pytest -q`
- Analisis CLI: `.\.venv\Scripts\python.exe scripts\analyze_file.py lagu.mp3`

## Format data
- `.lab`: `start<TAB>end<TAB>chord`. `<id>.auto.lab` tidak pernah ditimpa koreksi; koreksi masuk `<id>.corrected.lab`;
  tiap detector menulis `<id>.<detector>.lab`.
- Notasi aplikasi: `C Dm Dsus2 Dsus4 C7 Cmaj7 Am7 Cadd9 G/B N`. Konversi Harte ada di `app/labels.py`.
- Penghubung antar modul: `Segment(start, end, label)` di `app/detectors/base.py`.
