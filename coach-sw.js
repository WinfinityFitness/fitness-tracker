'use strict';
// Minimal service worker for the Coach Portal -- push notifications only,
// no offline caching. Unlike the main Fitness Tracker's sw.js, this isn't
// precaching anything: coach-portal.html already treats GitHub Pages as
// the live source of truth on every normal load (see its own version-
// check comment), so the only reason this file exists at all is that
// Web Push requires an active service worker registration to receive
// and display a notification while the tab itself is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Payload comes from the send-push Edge Function's coach_id branch (see
// notify_coach_of_client_workout() in supabase_coach_push_notifications_migration.sql).
self.addEventListener('push', event => {
  let data = { title: 'Winfinity Coach Portal', body: 'You have a new notification.', url: 'https://winfinityfitness.com/coach-portal' };
  try { if (event.data) data = Object.assign(data, event.data.json()); } catch (e) { /* ignore malformed payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://winfinityfitness.github.io/fitness-tracker/icons/icon-192.png',
      badge: 'https://winfinityfitness.github.io/fitness-tracker/icons/icon-192.png',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || 'https://winfinityfitness.com/coach-portal';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.startsWith(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    })
  );
});