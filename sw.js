const CACHE_NAME = 'fittracker-v391';
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
  './icons/mode-beginner.png',
  './icons/mode-warrior.png',
  './icons/mode-spartan.png',
  './icons/mode-demigod.png',
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
  // url lets a specific reminder (e.g. the Start/End Day Log pushes from
  // check-reminders) deep-link straight to the relevant sheet instead of
  // just opening the app to whatever tab it was last on.
  let data = { title: 'Winfinity Tracker', body: 'You have a new notification.', url: './' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) { /* ignore malformed payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      // No explicit vibrate pattern — like most well-behaved apps, this lets
      // Android's own per-app notification vibration setting decide instead
      // of forcing a fixed buzz regardless of what the phone is set to.
      data: { url: data.url || './' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes(self.registration.scope));
      if (existing) {
        // Already open — a fresh navigation would reload and lose state, so
        // just tell the running page which sheet to open instead.
        existing.postMessage({ type: 'DEEP_LINK', url: targetUrl });
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

// ---------------------------------------------------------------------
// Web Share Target (manifest.webmanifest's share_target block) — lets FT
// appear in Android's native share sheet. A share arrives here as a POST
// with multipart form data; the service worker has no localStorage, so the
// shared photo/text is stashed in IndexedDB (one fixed key, overwritten on
// every new share) for the page itself to pick up after the redirect below
// — see initShareTargetHandling in app.js. The Blob is stored as-is rather
// than round-tripped through a data URL first (Chrome supports Blob values
// in IndexedDB directly).
// ---------------------------------------------------------------------
const SHARE_DB_NAME = 'wft-share-target';
const SHARE_STORE_NAME = 'pending';

function openShareDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(SHARE_STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('photo');
    const text = formData.get('text') || '';
    const title = formData.get('title') || '';
    const db = await openShareDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE_NAME, 'readwrite');
      tx.objectStore(SHARE_STORE_NAME).put({ blob: file || null, text, title, ts: Date.now() }, 'pending');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* best effort — the page just won't find a pending share */ }
  // 303 so the browser follows up with a GET (not a re-POST) — this landing
  // page is served by the cache-first GET handler below like any other nav.
  return Response.redirect('./?shared-target=1', 303);
}

self.addEventListener('fetch', event => {
  if (event.request.method === 'POST' && new URL(event.request.url).pathname.endsWith('/share-target/')) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
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
