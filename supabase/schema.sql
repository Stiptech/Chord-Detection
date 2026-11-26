-- Skema Chord Finder untuk Supabase (MODE TERBUKA: tanpa login).
-- Sudah terpasang di project `chord-finder`. Aman dijalankan ulang (idempotent).
--
-- PERHATIAN: dengan aturan di bawah, siapa pun yang membuka situs (kunci publishable ada di kode web)
-- bisa membaca, mengubah, dan menghapus lagu + label, serta mengunggah audio sampai kuota storage habis.
-- Untuk mengunci ke satu akun, jalankan supabase/lock-down.sql.

create table if not exists public.songs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  audio_path   text,                      -- path di bucket 'audio': shared/<song_id>.<ext>
  audio_mime   text,
  size_bytes   bigint,
  duration_sec real,
  audio_hash   text,                      -- SHA-256 isi file; untuk mendeteksi file yang sama
  status       text not null default 'uploaded'
               check (status in ('uploaded', 'analyzing', 'ready', 'error')),
  error        text,
  detector     text,                      -- detector analisis terakhir
  sheet        jsonb check (sheet is null or jsonb_typeof(sheet) = 'object'),  -- lembar chord: {v, lyrics, times}
  beats        jsonb check (beats is null or jsonb_typeof(beats) = 'object'),  -- ketukan: {v, bpm, meter, phase, beats:[detik]}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Untuk project yang dibuat dari versi skema lama:
alter table public.songs add column if not exists sheet jsonb check (sheet is null or jsonb_typeof(sheet) = 'object');
alter table public.songs add column if not exists beats jsonb check (beats is null or jsonb_typeof(beats) = 'object');

create index if not exists songs_created_idx on public.songs (created_at desc);

-- Satu baris per (lagu, versi). version: 'auto', 'corrected', atau nama detector ('baseline', ...).
-- 'auto' tidak pernah ditimpa oleh koreksi; koreksi hanya menulis 'corrected'.
create table if not exists public.label_versions (
  song_id    uuid not null references public.songs (id) on delete cascade,
  version    text not null check (version ~ '^[a-z0-9_]+$'),
  segments   jsonb not null check (jsonb_typeof(segments) = 'array'),  -- [{"start":0,"end":2.1,"label":"C"}, ...]
  updated_at timestamptz not null default now(),
  primary key (song_id, version)
);

alter table public.songs          enable row level security;
alter table public.label_versions enable row level security;

drop policy if exists "songs: akses terbuka" on public.songs;
create policy "songs: akses terbuka" on public.songs
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "label_versions: akses terbuka" on public.label_versions;
create policy "label_versions: akses terbuka" on public.label_versions
  for all to anon, authenticated using (true) with check (true);

-- Bucket privat 'audio': maks 50 MB per file, hanya audio/video agar tidak bisa dipakai menyimpan file sembarang.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('audio', 'audio', false, 52428800, array['audio/*', 'video/mp4', 'video/webm'])
on conflict (id) do update
  set public = false, file_size_limit = 52428800, allowed_mime_types = array['audio/*', 'video/mp4', 'video/webm'];

drop policy if exists "audio: baca" on storage.objects;
create policy "audio: baca" on storage.objects
  for select to anon, authenticated using (bucket_id = 'audio');

drop policy if exists "audio: unggah" on storage.objects;
create policy "audio: unggah" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'audio');

drop policy if exists "audio: ubah" on storage.objects;
create policy "audio: ubah" on storage.objects
  for update to anon, authenticated using (bucket_id = 'audio') with check (bucket_id = 'audio');

drop policy if exists "audio: hapus" on storage.objects;
create policy "audio: hapus" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'audio');
