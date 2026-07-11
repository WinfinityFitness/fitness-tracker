const CACHE_NAME = 'fittracker-v207';
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
  './fonts/archivo-narrow.woff2',
  './fonts/montserrat-heavy.woff2',
  './fonts/sora.woff2',
  './fonts/sora-regular.woff2',
  './fonts/space-grotesk.woff2',
  './fonts/jetbrains-mono.woff2',
  './fonts/syne.woff2',
  './fonts/plus-jakarta-sans.woff2',
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

// Fires even with the app fully closed and the phone locked — that's the
// whole point of Web Push over the in-page Notification API, which needs
// the app's own JS actively running. Payload comes from the send-push
// Edge Function (see supabase/functions/send-push/).
self.addEventListener('push', event => {
  let data = { title: 'Winfinity Tracker', body: 'You have a new notification.' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) { /* ignore malformed payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: './' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Only same-origin app assets go through the cache-first strategy below.
  // Cross-origin GETs (Supabase REST reads, Google APIs, etc.) must always
  // hit the network — supabase-js issues SELECT queries as GET requests with
  // a deterministic URL (same select+filter = same URL every time), so
  // cache-first here was silently serving a stale snapshot of chat_room_members
  // / chat_rooms forever after the first fetch: Accept/Decline, Refresh, and
  // Sync to Nexus all appeared to "do nothing" because the app was reading a
  // frozen cached response instead of the real current DB state.
  if (new URL(event.request.url).origin !== self.location.origin) return;
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
