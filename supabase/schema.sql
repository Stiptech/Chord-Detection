-- Skema Chord Finder untuk Supabase.
-- Jalankan SEKALI di Dashboard -> SQL Editor -> New query -> tempel semua -> Run.
-- Aman dijalankan ulang (idempotent).
--
-- Model keamanan: satu pengguna (akunmu). Semua baris dan file dikunci ke auth.uid()
-- lewat Row Level Security, jadi kunci publishable/anon yang ada di kode web tidak bisa
-- membaca apa pun tanpa login.

-- ---------- tabel ----------

create table if not exists public.songs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,
  audio_path   text,                      -- path di bucket 'audio': <user_id>/<song_id>.<ext>
  audio_mime   text,
  size_bytes   bigint,
  duration_sec real,
  audio_hash   text,                      -- SHA-256 isi file; untuk mendeteksi file yang sama
  status       text not null default 'uploaded'
               check (status in ('uploaded', 'analyzing', 'ready', 'error')),
  error        text,
  detector     text,                      -- detector analisis terakhir
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists songs_user_created_idx on public.songs (user_id, created_at desc);

-- Satu baris per (lagu, versi). version: 'auto', 'corrected', atau nama detector ('baseline', ...).
-- 'auto' tidak pernah ditimpa oleh koreksi; koreksi hanya menulis 'corrected'.
create table if not exists public.label_versions (
  song_id    uuid not null references public.songs (id) on delete cascade,
  version    text not null check (version ~ '^[a-z0-9_]+$'),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  segments   jsonb not null check (jsonb_typeof(segments) = 'array'),  -- [{"start":0,"end":2.1,"label":"C"}, ...]
  updated_at timestamptz not null default now(),
  primary key (song_id, version)
);

-- ---------- Row Level Security: hanya pemilik ----------

alter table public.songs          enable row level security;
alter table public.label_versions enable row level security;

drop policy if exists "songs: pemilik" on public.songs;
create policy "songs: pemilik" on public.songs
  for all to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "label_versions: pemilik" on public.label_versions;
create policy "label_versions: pemilik" on public.label_versions
  for all to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------- Storage: bucket privat 'audio' ----------
-- Batas 50 MB per file (batas free tier). Folder pertama di path harus id penggunanya.

insert into storage.buckets (id, name, public, file_size_limit)
values ('audio', 'audio', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "audio: baca file sendiri" on storage.objects;
create policy "audio: baca file sendiri" on storage.objects
  for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "audio: unggah file sendiri" on storage.objects;
create policy "audio: unggah file sendiri" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "audio: ubah file sendiri" on storage.objects;
create policy "audio: ubah file sendiri" on storage.objects
  for update to authenticated
  using      (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "audio: hapus file sendiri" on storage.objects;
create policy "audio: hapus file sendiri" on storage.objects
  for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
