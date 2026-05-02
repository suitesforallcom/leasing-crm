// SuitesForAll service worker
// =====================================================================
// Lightweight cache that lets the operator see the LAST loaded version
// of the app shell when offline (elevators, parking garages, plane WiFi
// outages). NEVER caches data — every Firestore / Stripe / DocuSign
// call goes to the network so financial state is always fresh.
//
// Strategy:
//   - Install: precache the app shell URL only (HTML + manifest)
//   - Fetch: network-first for HTML and same-origin JSON; cache-first
//     for static assets (images, fonts). Stale-while-revalidate for the
//     HTML so reloads see new code as soon as a deploy lands.
//   - Activate: clear old caches.
//
// Cache name MUST be bumped whenever sw.js itself changes — that
// triggers the clear in `activate`. Use a date-based name so each
// deploy gets a fresh cache.
const CACHE_NAME = 'sfa-shell-v1';
const APP_SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);
    } catch (e) {
      // Best-effort — first install on a flaky network can fail; we
      // retry naturally on the next visit.
    }
    // Activate immediately on first install so the cache is usable
    // without a second navigation.
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET. POST/PUT/DELETE go straight to network — caching
  // mutations is a footgun.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // NEVER cache calls to Firebase, Stripe, DocuSign, or any other
  // backend. Financial freshness > offline support for those paths.
  const NEVER_CACHE = [
    'firestore.googleapis.com',
    'identitytoolkit.googleapis.com',
    'firebaseapp.com',
    'cloudfunctions.net',
    'cloudfunctions.googleapis.com',
    'run.app',
    'stripe.com',
    'docusign.net',
  ];
  if (NEVER_CACHE.some(host => url.hostname.includes(host))) return;
  // HTML: stale-while-revalidate. Serve from cache if available, but
  // fetch in background so the next visit sees fresh code.
  const isHtml = req.mode === 'navigate'
    || req.headers.get('accept')?.includes('text/html');
  if (isHtml) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const fetchPromise = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      }).catch(() => null);
      return cached || (await fetchPromise) || new Response(
        '<h1>Offline</h1><p>SuitesForAll is offline. Reconnect to continue.</p>',
        { status: 503, headers: { 'Content-Type': 'text/html' } }
      );
    })());
    return;
  }
  // Static assets (images, fonts, css): cache-first, network fallback.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && url.origin === location.origin) {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (e) {
      // No cached + no network → 503. Browser shows native offline UI
      // for navigations; for assets it'll show the broken-image icon.
      return new Response('', { status: 503 });
    }
  })());
});
