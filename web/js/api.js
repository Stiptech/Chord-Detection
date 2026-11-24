// Lapisan data: semua akses ke Supabase lewat sini. Klien disuntikkan (createApi(client))
// supaya bisa diuji tanpa jaringan.

const MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', wav: 'audio/wav',
  webm: 'video/webm', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac',
};

export function fileExt(name) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** Safari sering memberi file.type kosong untuk m4a; jatuh ke tebakan dari ekstensi. */
export function guessMime(file) {
  return file.type || MIME_BY_EXT[fileExt(file.name)] || 'application/octet-stream';
}

export class ApiError extends Error {}

export function humanizeError(err) {
  const msg = String(err?.message ?? err ?? '');
  const low = msg.toLowerCase();
  if (low.includes('invalid login credentials')) return 'Email atau password salah.';
  if (low.includes('email not confirmed')) return 'Akun belum dikonfirmasi. Buat user di dashboard Supabase dengan "Auto Confirm User".';
  if (low.includes('failed to fetch') || low.includes('networkerror') || low.includes('load failed')) {
    return 'Tidak bisa terhubung ke server. Periksa internet; kalau normal, cek apakah project Supabase sedang dijeda di dashboard.';
  }
  if (low.includes('maximum allowed size') || low.includes('payload too large')) return 'File terlalu besar (maksimal 50 MB).';
  if (low.includes('jwt expired') || low.includes('not authenticated') || low.includes('row-level security')) {
    return 'Sesi habis atau akses ditolak. Keluar lalu masuk lagi.';
  }
  return msg || 'Terjadi kesalahan.';
}

export function createApi(sb, { bucket = 'audio' } = {}) {
  const check = (error) => {
    if (error) throw new ApiError(humanizeError(error), { cause: error });
  };

  return {
    // ---------- auth ----------
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      check(error);
      return data.session;
    },
    async signOut() {
      const { error } = await sb.auth.signOut();
      check(error);
    },
    async getSession() {
      const { data, error } = await sb.auth.getSession();
      check(error);
      return data?.session ?? null;
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event, session) => cb(event, session));
      return () => data.subscription.unsubscribe();
    },

    // ---------- lagu ----------
    async listSongs() {
      const { data, error } = await sb.from('songs').select('*').order('created_at', { ascending: false });
      check(error);
      return data;
    },

    /** Unggah audio lalu buat record. Kalau insert gagal, file yang sudah terunggah dihapus lagi. */
    async addSong(file, { hash, duration }) {
      const id = crypto.randomUUID();
      const ext = fileExt(file.name);
      const path = `shared/${id}${ext ? '.' + ext : ''}`; // satu pengguna: satu folder bersama
      const mime = guessMime(file);
      const name = file.name.replace(/\.[^.]*$/, '').trim() || 'Tanpa judul';

      // supabase-js memakai file.type (bukan opsi contentType) untuk badan multipart. Safari sering memberi
      // type kosong (m4a), yang akan terkirim sebagai octet-stream dan ditolak bucket. Bungkus dengan tipe yang benar.
      const body = file instanceof Blob ? new Blob([file], { type: mime }) : file;
      const up = await sb.storage.from(bucket).upload(path, body, { contentType: mime, upsert: false });
      check(up.error);
      const { data, error } = await sb.from('songs').insert({
        id, name, audio_path: path, audio_mime: mime, size_bytes: file.size,
        duration_sec: duration, audio_hash: hash, status: 'uploaded',
      }).select().single();
      if (error) {
        await sb.storage.from(bucket).remove([path]); // jangan tinggalkan file yatim
        check(error);
      }
      return data;
    },

    async getSong(id) {
      const { data, error } = await sb.from('songs').select('*').eq('id', id).maybeSingle();
      check(error);
      return data; // null bila tidak ada
    },

    /** Simpan lembar chord ({v, lyrics, times}) lagu ini. */
    async saveSheet(id, sheet) {
      const { error } = await sb.from('songs').update({ sheet, updated_at: new Date().toISOString() }).eq('id', id);
      check(error);
    },

    async updateSong(id, patch) {
      const { data, error } = await sb.from('songs')
        .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().single();
      check(error);
      return data;
    },

    /** File dihapus dulu, baru record (label ikut terhapus lewat ON DELETE CASCADE). */
    async deleteSong(song) {
      if (song.audio_path) {
        const { error } = await sb.storage.from(bucket).remove([song.audio_path]);
        check(error);
      }
      const { error } = await sb.from('songs').delete().eq('id', song.id);
      check(error);
    },

    async getAudioUrl(song, expiresSec = 6 * 3600) {
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(song.audio_path, expiresSec);
      check(error);
      return data.signedUrl;
    },

    async downloadAudio(song) {
      const url = await this.getAudioUrl(song, 300);
      let res;
      try { res = await fetch(url); } catch (e) { throw new ApiError(humanizeError(e), { cause: e }); }
      if (!res.ok) throw new ApiError(`Gagal mengunduh audio (HTTP ${res.status}).`);
      return res.arrayBuffer();
    },

    // ---------- label ----------
    async getLabels(songId, version) {
      const { data, error } = await sb.from('label_versions').select('segments')
        .eq('song_id', songId).eq('version', version).maybeSingle();
      check(error);
      return data ? data.segments : null;
    },

    /** 'corrected' yang belum ada jatuh ke 'auto'. Mengembalikan {version, segments} atau {version:null, segments:null}. */
    async getLabelsWithFallback(songId, version = 'corrected') {
      let segments = await this.getLabels(songId, version);
      if (segments) return { version, segments };
      if (version === 'corrected') {
        segments = await this.getLabels(songId, 'auto');
        if (segments) return { version: 'auto', segments };
      }
      return { version: null, segments: null };
    },

    /** Semua label semua lagu: [{song_id, version, segments}] (dipakai halaman statistik). */
    async listAllLabels() {
      const { data, error } = await sb.from('label_versions').select('song_id,version,segments');
      check(error);
      return data;
    },

    async saveLabels(songId, version, segments) {
      const { error } = await sb.from('label_versions').upsert(
        { song_id: songId, version, segments, updated_at: new Date().toISOString() },
        { onConflict: 'song_id,version' });
      check(error);
    },

    /** Cadangan semua lagu + label sebagai satu objek JSON (audio tidak ikut; file aslinya milikmu). */
    async exportAll() {
      const [songs, labels] = await Promise.all([
        sb.from('songs').select('id,name,audio_hash,duration_sec,detector,created_at,sheet').order('created_at'),
        sb.from('label_versions').select('song_id,version,segments,updated_at'),
      ]);
      check(songs.error);
      check(labels.error);
      return {
        format: 'chordfinder-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        songs: songs.data.map((s) => ({
          ...s,
          labels: Object.fromEntries(labels.data.filter((l) => l.song_id === s.id).map((l) => [l.version, l.segments])),
        })),
      };
    },
  };
}
