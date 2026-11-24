// Daftarkan service worker (cangkang aplikasi untuk dipasang ke layar utama). Kegagalan tidak mengganggu aplikasi.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* mis. mode privat: abaikan */ });
  });
}
