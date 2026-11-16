const CACHE_NAME = 'parex-iapc-campo-v1';
const PHOTO_CACHE = 'parex-iapc-photos-v1';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './pdf-export.js',
  './manifest.webmanifest',
  './data/rncs.json',
  './assets/vendor/jspdf.umd.min.js',
  './assets/parex-logo-negativa.png',
  './assets/parex-logo-positiva.png',
  './assets/parex-mark.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== PHOTO_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Photos: cache-first then network & store
  if (url.pathname.includes('/photos/')) {
    event.respondWith(
      caches.open(PHOTO_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const net = await fetch(req);
          if (net && net.ok) cache.put(req, net.clone());
          return net;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell & data: network-first for rncs.json/html, cache-first for static assets
  if (url.pathname.endsWith('/rncs.json') || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(req)
        .then((net) => {
          if (net && net.ok) {
            caches.open(CACHE_NAME).then((c) => c.put(req, net.clone()));
          }
          return net;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((net) => {
        if (net && net.ok) {
          caches.open(CACHE_NAME).then((c) => c.put(req, net.clone()));
        }
        return net;
      });
    })
  );
});
