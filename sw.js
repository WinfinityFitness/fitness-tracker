const CACHE_NAME = 'fittracker-v152';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/measure-guide-male.jpg',
  './icons/measure-guide-female.jpg',
  './icons/bg-pattern.svg',
  './icons/bg-pattern-light.svg',
  './data/exercises.json',
];

self.addEventListener('install', event => {
  // No unconditional skipWaiting() here — on an update (an existing version is
  // already controlling the page), the new worker installs and then WAITS
  // until the page explicitly asks it to activate (see the message listener
  // below), so the in-app "Update Now" button controls exactly when the swap
  // happens instead of it happening silently mid-session.
  //
  // Every asset is fetched with { cache: 'reload' } to bypass the browser's
  // HTTP cache entirely. Plain cache.addAll() lets the browser serve some
  // CORE_ASSETS from its own (possibly stale) HTTP cache while others come
  // fresh from the network, so the precached bundle can end up as a mix of
  // old and new files (e.g. new app.js referencing an element that doesn't
  // exist in the still-old cached index.html) — that mismatch is what caused
  // the app to hang on the splash screen after an update.
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(CORE_ASSETS.map(url =>
        fetch(url, { cache: 'reload' }).then(response => cache.put(url, response))
      ))
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => cached);
    })
  );
});
