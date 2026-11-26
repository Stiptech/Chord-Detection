# Chord Finder pribadi (lagu rohani)

Web statis untuk satu pengguna: deteksi chord dari file audio/video di browser, putar dengan chord sinkron, koreksi manual, ukur akurasi.
Spesifikasi awal ada di `chord-finder-prompt.md` (sebagian sudah usang: arsitektur berubah, lihat di bawah). Dokumentasi pemakaian dan deploy ada di `README.md`.

## Arsitektur (diputuskan 2026-11-24)
- **Web statis di browser**, deploy ke Netlify dari GitHub (`Stiptech/Chord-Detection`, folder `web/`, tanpa build, tanpa framework, `netlify.toml`).
  Tanpa server Python. Fitur tempel link YouTube dan backend FastAPI sudah dihapus (riwayat git, commit `3448cc8` dan sebelumnya).
- **Data lintas perangkat: Supabase** project `chord-finder` (Postgres `songs` + `label_versions`, bucket privat `audio`). Klien: `web/js/api.js`
  (klien disuntikkan agar bisa diuji tanpa jaringan). Skema di `supabase/schema.sql`.
- **MODE TERBUKA tanpa login** (`REQUIRE_LOGIN = false`, RLS `using (true)` untuk anon), atas permintaan pengguna. `supabase/lock-down.sql` +
  `REQUIRE_LOGIN = true` mengunci ke satu akun. Pengguna memberi izin penuh untuk urusan project ini; jangan sentuh project Supabase lain
  milik mereka. Password akun dibuat pengguna sendiri.
- **Python** (`app/`, `scripts/`, `tests/`) = acuan (detector CQT), tes paritas, dan evaluasi offline (mir_eval). Detector yang dipakai aplikasi ada di `web/js/`.
- Jangan push ke GitHub atau mengubah arsitektur tanpa persetujuan (push ke `main` memicu deploy Netlify).

## Peta berkas `web/js/`
`app.js` daftar lagu · `player.js` pemutar · `beats.js` ketukan/tempo/birama (DSP klasik) + `rhythm.js` metronom/hitung-mundur · `sheet.js` + `sheet-logic.js` lembar chord (lirik + ketuk-sinkron) · `editor.js` + `edit-logic.js` koreksi · `stats.js` + `evaluate.js` statistik · `baseline.js`, `chroma.js`, `fft.js`,
`config.js` detector · `labels.js` .lab/Harte/validasi · `transpose.js` transpose + key · `audio.js`, `analysis.js`, `worker.js` dekode + Web Worker ·
`api.js`, `supabase.js`, `supabase-config.js` data · `dom.js` pembuat elemen · `pwa.js` + `sw.js` service worker.
Logika murni dipisah dari DOM (`edit-logic.js`, `player-logic.js`, `evaluate.js`, `transpose.js`, `sheet-logic.js`) supaya bisa dites di Node.

## Prinsip kerja
- Sederhana dan mudah diubah. Frontend vanilla tanpa build. Hasil mesin hanyalah tebakan awal; koreksi manual adalah alur utama.
- Tanya pengguna sebelum menambah dependensi besar. Parameter yang bisa dituning ada di `web/js/config.js` (detector JS).
- Kerja per fase; setelah tiap fase: jalankan tes, commit, lalu berhenti dan jelaskan cara mencobanya. Fase 6 (detector pretrained) hanya bila diminta.
- Tes sinyal sintetis bersih TIDAK cukup untuk detector (sudah pernah menyembunyikan N 70% pada lagu nyata). Uji dengan audio nyata atau sinyal berderau tinggi.
- Jujur soal yang belum terbukti: Safari iPad belum teruji. Situs live (https://chorddetection.netlify.app) sudah publik (Team login dimatikan) dan diuji end-to-end; service worker terbukti aktif di HTTPS live.

## Perintah
- Tes JS: `npm test` · Tes Python: `.\.venv\Scripts\python.exe -m pytest -q`
- Lokal: `cd web; python -m http.server 8000` · CLI: `.\.venv\Scripts\python.exe scripts\analyze_file.py lagu.mp3` (butuh ffmpeg)
- Evaluasi offline: `scripts\evaluate_dir.py --backup berkas.json` · ikon: `scripts\make_icons.py` · fixture paritas: `scripts\make_eval_fixture.py`

## Catatan pengujian di browser (alat Claude)
- Panel browser yang tersembunyi menghentikan `requestAnimationFrame`, sehingga UI tampak kosong; tampilkan panel (`show_pane`) atau pasang penyiasat rAF
  khusus uji. Service worker gagal terdaftar di http://127.0.0.1 pada browser uji, tapi berhasil di HTTPS live.
- Data uji ke Supabase asli: beri nama berawalan `ZZ-UJI` dan hapus **berdasarkan nama persis**, jangan pernah menghapus semua kartu (ada lagu asli pengguna).

## Format data
- `.lab`: `start<TAB>end<TAB>chord`. Versi label per lagu: `auto` (tidak pernah ditimpa koreksi), nama detector, `corrected`.
- `songs.beats` = `{v, bpm, meter, phase, confidence, beats:[detik]}`; dihitung di worker saat analisis (gagal tidak menggagalkan analisis), bisa dihitung ulang dari pemutar. Tempo ambigu satu oktaf: UI punya ÷2/×2.
- Notasi: `C Dm Dsus2 Dsus4 C7 Cmaj7 Am7 Cadd9 G/B N`. Konversi Harte: `web/js/labels.js` dan `app/labels.py`.
