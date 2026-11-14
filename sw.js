/* Rotador · service worker: guarda la app en el teléfono para usarla sin internet.
   Si cambias algún archivo, sube el número de CACHE para forzar la actualización. */
const CACHE = 'rotador-v12';
const LIBS = 'rotador-libs'; // lector de imágenes (se descarga la primera vez que se usa)
const ASSETS = [
  './', 'index.html', 'styles.css', 'dates.js', 'catalog.js', 'app.js', 'manifest.webmanifest',
  'lib/jspdf.umd.min.js', 'lib/html5-qrcode.min.js', 'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== LIBS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Responde desde el caché (rápido y offline) y actualiza en segundo plano.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Lector de imágenes (CDN): se guarda al usarlo y queda disponible sin conexión.
    if (url.hostname === 'cdn.jsdelivr.net') {
      e.respondWith(fetch(req).then((res) => { if (res && (res.ok || res.type === 'opaque')) { const c = res.clone(); caches.open(LIBS).then((x) => x.put(req, c)); } return res; })
        .catch(() => caches.match(req)));
    }
    return;
  }
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
      return cached || network;
    })
  );
});
