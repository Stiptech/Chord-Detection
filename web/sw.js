// Service worker: menyimpan "cangkang" aplikasi (HTML/CSS/JS) supaya bisa dipasang ke layar utama dan terbuka cepat.
//
// Strategi: JARINGAN DULU, cache hanya cadangan. Jadi setelah deploy baru, kamu selalu mendapat versi terbaru
// (tidak ada versi basi yang menyangkut). Hanya berkas dari situs ini yang disentuh: Supabase (data dan audio)
// dan CDN tidak pernah lewat sini, jadi audio dengan Range tetap ditangani browser.
// Tanpa internet cangkang tetap terbuka, tapi daftar lagu/audio/label tetap butuh Supabase.
const CACHE = 'chordfinder-shell-v1'; // naikkan nomor ini bila perlu membuang cache lama

const SHELL = [
  './', 'index.html', 'player.html', 'stats.html', 'manifest.webmanifest', 'icon.svg',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'css/style.css', 'css/player.css', 'css/stats.css',
  'js/analysis.js', 'js/api.js', 'js/app.js', 'js/audio.js', 'js/baseline.js', 'js/chroma.js', 'js/config.js',
  'js/dom.js', 'js/edit-logic.js', 'js/editor.js', 'js/evaluate.js', 'js/fft.js', 'js/labels.js', 'js/player-logic.js',
  'js/player.js', 'js/pwa.js', 'js/stats.js', 'js/supabase-config.js', 'js/supabase.js', 'js/transpose.js', 'js/worker.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('chordfinder-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // bukan urusan kita
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      // offline: cadangan dari cache; ignoreSearch agar player.html?id=... memakai player.html
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
