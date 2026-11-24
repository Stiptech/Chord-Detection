-- KUNCI: ubah dari mode terbuka menjadi hanya pengguna yang sudah login (authenticated).
-- Tidak ada data yang dipindah; semua lagu/label/audio yang sudah ada tetap bisa dibuka setelah login.
--
-- Urutan yang benar:
--   1. Dashboard -> Authentication -> Users -> Add user (email + password-mu, centang Auto Confirm User).
--   2. Dashboard -> Authentication -> Sign In / Providers -> matikan "Allow new users to sign up".
--   3. Jalankan file ini di SQL Editor.
--   4. Di web/js/supabase-config.js ubah REQUIRE_LOGIN menjadi true, lalu deploy ulang.
-- (Kalau langkah 3 dijalankan sebelum langkah 4 di-deploy, situs sementara tidak bisa memuat data.)

drop policy if exists "songs: akses terbuka" on public.songs;
drop policy if exists "label_versions: akses terbuka" on public.label_versions;
drop policy if exists "audio: baca" on storage.objects;
drop policy if exists "audio: unggah" on storage.objects;
drop policy if exists "audio: ubah" on storage.objects;
drop policy if exists "audio: hapus" on storage.objects;

create policy "songs: hanya login" on public.songs
  for all to authenticated using (true) with check (true);
create policy "label_versions: hanya login" on public.label_versions
  for all to authenticated using (true) with check (true);

create policy "audio: baca (login)" on storage.objects
  for select to authenticated using (bucket_id = 'audio');
create policy "audio: unggah (login)" on storage.objects
  for insert to authenticated with check (bucket_id = 'audio');
create policy "audio: ubah (login)" on storage.objects
  for update to authenticated using (bucket_id = 'audio') with check (bucket_id = 'audio');
create policy "audio: hapus (login)" on storage.objects
  for delete to authenticated using (bucket_id = 'audio');
