// Nestly service worker: lets the installed app open instantly and show its shell when offline.
// It only ever handles same-origin GETs for the app's own files. /api/* (all private data) is never touched
// or cached. Files are fetched network-first, so a new deploy is picked up immediately and the cache is only a fallback.
const CACHE = 'nestly-shell-v2';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      } catch (err) {
        const cached = (await caches.match(req)) ?? (req.mode === 'navigate' ? await caches.match('/') : undefined);
        if (cached) return cached;
        throw err;
      }
    })(),
  );
});
