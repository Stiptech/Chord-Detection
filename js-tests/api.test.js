// Tes lapisan data dengan klien Supabase palsu (tanpa jaringan).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, fileExt, guessMime, humanizeError, ApiError } from '../web/js/api.js';

/**
 * Klien palsu: from(table) mengembalikan builder berantai yang dicatat; saat di-await,
 * handler({table, ops}) memberi hasil {data, error}. Storage dicatat di `calls`.
 */
function fakeClient({ db = () => ({ data: null, error: null }), storage = {}, session = { user: { id: 'user-1' } } } = {}) {
  const calls = [];
  const builder = (table) => {
    const q = { table, ops: [] };
    const b = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (res, rej) => { calls.push(q); return Promise.resolve(db(q)).then(res, rej); };
        return (...args) => { q.ops.push([prop, args]); return b; };
      },
    });
    return b;
  };
  const bucket = (name) => ({
    upload: async (path, body, opts) => { calls.push({ storage: 'upload', name, path, body, opts }); return storage.upload?.() ?? { data: {}, error: null }; },
    remove: async (paths) => { calls.push({ storage: 'remove', name, paths }); return storage.remove?.() ?? { data: [], error: null }; },
    createSignedUrl: async (path, sec) => { calls.push({ storage: 'sign', path, sec }); return { data: { signedUrl: `https://x/${path}?t=1` }, error: null }; },
  });
  return {
    calls,
    from: builder,
    storage: { from: bucket },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInWithPassword: async () => ({ data: { session }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
}

const op = (q, name) => q.ops.find(([n]) => n === name)?.[1];
const file = (name, type = '', size = 1234) => ({ name, type, size });

test('fileExt dan guessMime (Safari sering memberi type kosong untuk m4a)', () => {
  assert.equal(fileExt('Lagu Ku.M4A'), 'm4a');
  assert.equal(fileExt('tanpa-ekstensi'), '');
  assert.equal(guessMime(file('a.m4a', '')), 'audio/mp4');
  assert.equal(guessMime(file('a.mp3', 'audio/mpeg')), 'audio/mpeg');
  assert.equal(guessMime(file('a.xyz', '')), 'application/octet-stream');
});

test('humanizeError menerjemahkan pesan umum', () => {
  assert.match(humanizeError({ message: 'Invalid login credentials' }), /Email atau password salah/);
  assert.match(humanizeError(new TypeError('Failed to fetch')), /dijeda/);
  assert.match(humanizeError({ message: 'The object exceeded the maximum allowed size' }), /50 MB/);
  assert.match(humanizeError({ message: 'new row violates row-level security policy' }), /masuk lagi/i);
  assert.equal(humanizeError({ message: 'sesuatu' }), 'sesuatu');
});

test('addSong: unggah ke <user>/<id>.<ext> dengan content-type benar, lalu insert record', async () => {
  const sb = fakeClient({ db: (q) => ({ data: { id: op(q, 'insert')[0].id, ...op(q, 'insert')[0] }, error: null }) });
  const api = createApi(sb);
  const song = await api.addSong(file('Bagi Mu Tuhan.m4a'), { hash: 'abc', duration: 200.5 });

  const up = sb.calls.find((c) => c.storage === 'upload');
  assert.match(up.path, /^shared\/[0-9a-f-]{36}\.m4a$/);
  assert.equal(up.opts.contentType, 'audio/mp4');
  assert.equal(up.opts.upsert, false);
  assert.equal(song.name, 'Bagi Mu Tuhan');
  assert.equal(song.audio_path, up.path);
  assert.equal(song.audio_hash, 'abc');
  assert.equal(song.duration_sec, 200.5);
  assert.equal(song.status, 'uploaded');
});

test('addSong: file dengan type kosong dibungkus agar terkirim dengan content-type benar', async () => {
  const sb = fakeClient({ db: (q) => ({ data: op(q, 'insert')[0], error: null }) });
  const real = new File(['abc'], 'Lagu.m4a', { type: '' }); // seperti Safari
  await createApi(sb).addSong(real, { hash: 'h', duration: 1 });
  const up = sb.calls.find((c) => c.storage === 'upload');
  assert.equal(up.body.type, 'audio/mp4'); // yang dipakai supabase-js untuk multipart
  assert.equal(up.body.size, 3);
});

test('addSong: insert gagal -> file yang sudah terunggah dihapus lagi', async () => {
  const sb = fakeClient({ db: () => ({ data: null, error: { message: 'boom' } }) });
  await assert.rejects(createApi(sb).addSong(file('a.mp3'), { hash: 'h', duration: 1 }), ApiError);
  const up = sb.calls.find((c) => c.storage === 'upload');
  const rm = sb.calls.find((c) => c.storage === 'remove');
  assert.deepEqual(rm.paths, [up.path]);
});

test('addSong: unggah gagal -> tidak ada record dibuat', async () => {
  const sb = fakeClient({ storage: { upload: () => ({ data: null, error: { message: 'The object exceeded the maximum allowed size' } }) } });
  await assert.rejects(createApi(sb).addSong(file('a.mp3'), { hash: 'h', duration: 1 }), /50 MB/);
  assert.ok(!sb.calls.some((c) => c.table === 'songs'));
});

test('addSong tidak butuh sesi login (mode terbuka)', async () => {
  const sb = fakeClient({ session: null, db: (q) => ({ data: op(q, 'insert')[0], error: null }) });
  const song = await createApi(sb).addSong(file('a.mp3'), { hash: 'h', duration: 1 });
  assert.match(song.audio_path, /^shared\//);
  assert.ok(!('user_id' in song));
});

test('deleteSong: file dihapus dulu, baru record', async () => {
  const sb = fakeClient();
  await createApi(sb).deleteSong({ id: 's1', audio_path: 'shared/s1.mp3' });
  assert.equal(sb.calls[0].storage, 'remove');
  assert.equal(sb.calls[1].table, 'songs');
  assert.deepEqual(op(sb.calls[1], 'eq'), ['id', 's1']);
  assert.ok(op(sb.calls[1], 'delete'));
});

test('deleteSong: gagal hapus file -> record tidak dihapus', async () => {
  const sb = fakeClient({ storage: { remove: () => ({ data: null, error: { message: 'gagal' } }) } });
  await assert.rejects(createApi(sb).deleteSong({ id: 's1', audio_path: 'p' }), ApiError);
  assert.ok(!sb.calls.some((c) => c.table === 'songs'));
});

test('getLabelsWithFallback: corrected ada -> dipakai; belum ada -> jatuh ke auto', async () => {
  const rows = { corrected: null, auto: [{ start: 0, end: 1, label: 'C' }] };
  const sb = fakeClient({ db: (q) => { const v = op(q, 'eq') && q.ops.filter(([n]) => n === 'eq').find(([, a]) => a[0] === 'version')[1][1]; return { data: rows[v] ? { segments: rows[v] } : null, error: null }; } });
  const api = createApi(sb);
  assert.deepEqual(await api.getLabelsWithFallback('s1'), { version: 'auto', segments: rows.auto });

  rows.corrected = [{ start: 0, end: 1, label: 'Dsus2' }];
  assert.deepEqual(await api.getLabelsWithFallback('s1'), { version: 'corrected', segments: rows.corrected });
});

test('getLabelsWithFallback: tidak ada label sama sekali', async () => {
  const api = createApi(fakeClient({ db: () => ({ data: null, error: null }) }));
  assert.deepEqual(await api.getLabelsWithFallback('s1'), { version: null, segments: null });
  // versi selain corrected tidak jatuh ke auto
  assert.deepEqual(await api.getLabelsWithFallback('s1', 'baseline'), { version: null, segments: null });
});

test('saveLabels memakai upsert dengan kunci (song_id, version)', async () => {
  const sb = fakeClient();
  const segs = [{ start: 0, end: 1, label: 'C' }];
  await createApi(sb).saveLabels('s1', 'corrected', segs);
  const [row, opts] = op(sb.calls[0], 'upsert');
  assert.equal(sb.calls[0].table, 'label_versions');
  assert.deepEqual([row.song_id, row.version, row.segments], ['s1', 'corrected', segs]);
  assert.deepEqual(opts, { onConflict: 'song_id,version' });
});

test('exportAll mengelompokkan label per lagu', async () => {
  const db = (q) => q.table === 'songs'
    ? { data: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }], error: null }
    : { data: [{ song_id: 's1', version: 'auto', segments: [1] }, { song_id: 's1', version: 'corrected', segments: [2] }], error: null };
  const out = await createApi(fakeClient({ db })).exportAll();
  assert.equal(out.format, 'chordfinder-backup');
  assert.deepEqual(out.songs[0].labels, { auto: [1], corrected: [2] });
  assert.deepEqual(out.songs[1].labels, {});
});

test('getAudioUrl meminta signed URL dengan masa berlaku', async () => {
  const sb = fakeClient();
  assert.equal(await createApi(sb).getAudioUrl({ audio_path: 'u/s.mp3' }, 120), 'https://x/u/s.mp3?t=1');
  assert.equal(sb.calls[0].sec, 120);
});

test('listAllLabels mengambil semua baris label', async () => {
  const sb = fakeClient({ db: () => ({ data: [{ song_id: 's1', version: 'auto', segments: [] }], error: null }) });
  assert.deepEqual(await createApi(sb).listAllLabels(), [{ song_id: 's1', version: 'auto', segments: [] }]);
  assert.equal(sb.calls[0].table, 'label_versions');
});
