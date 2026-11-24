// Tes integritas aplikasi statis: manifest, ikon, daftar cache service worker, dan semua tautan/import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const rel = (p) => relative(WEB, p).split('\\').join('/');
const files = walk(WEB).map(rel);

function pngSize(path) {
  const b = readFileSync(join(WEB, path));
  assert.equal(b.toString('ascii', 1, 4), 'PNG', `${path} bukan PNG`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

test('manifest: lengkap, ikon ada, ukurannya sesuai deklarasi, ada ikon maskable', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.name && m.short_name && m.start_url && m.scope);
  assert.ok(existsSync(join(WEB, m.start_url)), 'start_url harus ada');
  const sizes = new Set();
  for (const icon of m.icons) {
    assert.ok(existsSync(join(WEB, icon.src)), `ikon hilang: ${icon.src}`);
    assert.equal(pngSize(icon.src), icon.sizes, `ukuran ${icon.src}`);
    sizes.add(icon.sizes);
  }
  assert.ok(sizes.has('192x192') && sizes.has('512x512'), 'butuh 192 dan 512 agar bisa dipasang');
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  assert.equal(pngSize('icons/apple-touch-icon.png'), '180x180');
});

test('service worker: semua berkas di daftar cache ada dan tidak ada berkas aplikasi yang terlupa', () => {
  const src = read('sw.js');
  const shell = [...src.slice(src.indexOf('const SHELL = ['), src.indexOf('];', src.indexOf('const SHELL')))
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(shell.length > 20);
  for (const f of shell) if (f !== './') assert.ok(files.includes(f), `ada di daftar cache tapi tidak ada: ${f}`);
  const shouldBeCached = files.filter((f) => f !== 'sw.js' && /\.(html|css|js|svg|png|webmanifest)$/.test(f));
  for (const f of shouldBeCached) assert.ok(shell.includes(f), `berkas ini belum masuk daftar cache sw.js: ${f}`);
  assert.equal(new Set(shell).size, shell.length, 'daftar cache tidak boleh duplikat');
});

test('service worker: hanya menyentuh GET dari situs sendiri (Supabase/CDN/Range tidak lewat sini)', () => {
  const src = read('sw.js');
  assert.match(src, /req\.method !== 'GET'/);
  assert.match(src, /origin !== self\.location\.origin/);
});

test('setiap halaman: memasang manifest, ikon, pwa.js, dan tak ada tautan lokal yang putus', () => {
  const pages = files.filter((f) => f.endsWith('.html'));
  assert.deepEqual(pages.sort(), ['index.html', 'player.html', 'stats.html']);
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /rel="manifest" href="manifest\.webmanifest"/, page);
    assert.match(html, /rel="apple-touch-icon"/, page);
    assert.match(html, /src="js\/pwa\.js"/, page);
    for (const m of html.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)) {
      const target = m[1];
      if (/^(https?:|data:|mailto:)/.test(target)) continue;
      assert.ok(existsSync(join(WEB, target)), `${page}: tautan putus -> ${target}`);
    }
  }
});

test('setiap modul JS: semua import lokal ada, dan CDN hanya jsdelivr dengan versi terkunci', () => {
  for (const f of files.filter((x) => x.startsWith('js/') && x.endsWith('.js'))) {
    const src = read(f);
    for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('http')) {
        assert.match(spec, /^https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+\//, `${f}: CDN harus mengunci versi: ${spec}`);
        continue;
      }
      assert.ok(spec.startsWith('.'), `${f}: import tak dikenal: ${spec}`);
      assert.ok(existsSync(resolve(WEB, dirname(f), spec)), `${f}: import putus -> ${spec}`);
    }
  }
});

test('netlify.toml: publish = web, tanpa build, header keamanan dan CSP terpasang', () => {
  const toml = readFileSync(join(WEB, '..', 'netlify.toml'), 'utf8');
  assert.match(toml, /publish\s*=\s*"web"/);
  assert.doesNotMatch(toml, /^\s*command\s*=/m, 'tidak boleh ada build command');
  assert.match(toml, /Content-Security-Policy/);
  assert.match(toml, /frame-ancestors 'none'/);
  assert.match(toml, /for = "\/sw\.js"/);
});

// ---------- perilaku service worker (dijalankan di Node dengan self/caches/fetch tiruan) ----------
import vm from 'node:vm';

function loadSw({ network }) {
  const store = new Map(); // namaCache -> Map(url -> response)
  const listeners = {};
  const calls = { respondWith: 0, waitUntil: [] };
  const caches = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name);
      return {
        addAll: async (urls) => urls.forEach((u) => m.set(new URL(u, 'https://situs.test/').href, `cache:${u}`)),
        put: async (req, res) => m.set(req.url, res),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (req, opts) => {
      const strip = (u) => (opts?.ignoreSearch ? u.split('?')[0] : u);
      for (const m of store.values()) for (const [u, v] of m) if (strip(u) === strip(req.url)) return v;
      return undefined;
    },
  };
  const ctx = {
    caches, URL, Promise,
    fetch: network,
    self: { location: { origin: 'https://situs.test' }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(WEB, 'sw.js'), 'utf8'), ctx);
  const fire = async (type, event) => {
    let pending;
    listeners[type]({ ...event, waitUntil: (p) => { pending = p; }, respondWith: (p) => { calls.respondWith++; pending = p; } });
    return pending;
  };
  return { fire, store, calls };
}
const GET = (url) => ({ request: { method: 'GET', url } });

test('sw install: seluruh cangkang disimpan; activate: cache lama dibuang, cache lain tidak disentuh', async () => {
  const sw = loadSw({ network: async () => { throw new Error('offline'); } });
  await sw.fire('install', {});
  const [name] = [...sw.store.keys()];
  assert.match(name, /^chordfinder-shell-/);
  assert.ok(sw.store.get(name).has('https://situs.test/js/app.js') && sw.store.get(name).has('https://situs.test/index.html'));
  sw.store.set('chordfinder-shell-v0', new Map());
  sw.store.set('milik-aplikasi-lain', new Map());
  await sw.fire('activate', {});
  assert.deepEqual([...sw.store.keys()].sort(), [name, 'milik-aplikasi-lain'].sort());
});

test('sw fetch: jaringan dulu (selalu versi terbaru) dan menyimpan salinan', async () => {
  const fresh = { ok: true, clone() { return { ok: true, body: 'baru' }; }, body: 'baru' };
  const sw = loadSw({ network: async () => fresh });
  await sw.fire('install', {});
  const out = await sw.fire('fetch', GET('https://situs.test/js/app.js'));
  assert.equal(out, fresh);
  await new Promise((r) => setTimeout(r)); // put() berjalan di belakang
  const [name] = [...sw.store.keys()];
  assert.equal(sw.store.get(name).get('https://situs.test/js/app.js').body, 'baru');
});

test('sw fetch: offline -> cadangan dari cache, termasuk halaman dengan query (player.html?id=...)', async () => {
  const sw = loadSw({ network: async () => { throw new Error('offline'); } });
  await sw.fire('install', {});
  assert.equal(await sw.fire('fetch', GET('https://situs.test/js/app.js')), 'cache:js/app.js');
  assert.equal(await sw.fire('fetch', GET('https://situs.test/player.html?id=abc')), 'cache:player.html');
});

test('sw fetch: POST dan permintaan lintas-origin (Supabase, CDN, audio) tidak disentuh sama sekali', async () => {
  const sw = loadSw({ network: async () => { throw new Error('tidak boleh dipanggil'); } });
  await sw.fire('install', {});
  for (const req of [
    { method: 'POST', url: 'https://situs.test/api' },
    { method: 'GET', url: 'https://lzthqhlyekkuvjibaopu.supabase.co/storage/v1/object/sign/audio/x.m4a' },
    { method: 'GET', url: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.99.3/+esm' },
  ]) {
    sw.calls.respondWith = 0;
    sw.fire('fetch', { request: req });
    assert.equal(sw.calls.respondWith, 0, `${req.method} ${req.url} tidak boleh ditangani service worker`);
  }
});
