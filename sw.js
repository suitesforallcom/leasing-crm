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
// v2 (2026-05-12): фиксим протекание старого кэша HTML, который раздавал
// устаревшую логику heal депозит-штампов. Стратегия HTML переключена с
// stale-while-revalidate на network-first ниже.
// v3 (2026-07-16): SW no longer intercepts CROSS-ORIGIN GETs. The Firebase
// SDK loads via dynamic import() from www.gstatic.com; the old code sent that
// through the cache-first branch, whose catch returns an EMPTY 503 on any
// network hiccup — which surfaces as "Failed to fetch dynamically imported
// module" and bricks Firebase init until a hard reload. Cross-origin now goes
// straight to the browser (native fetch + retry), so a blip is recoverable.
const CACHE_NAME = 'sfa-shell-v3';
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
  // Cross-origin GETs (Firebase SDK on www.gstatic.com, fonts, other CDNs)
  // MUST pass straight to the browser. If we intercept them, our cache-first
  // catch below returns an empty 503 on any network blip — and for an ES
  // module loaded via dynamic import() that becomes a hard "Failed to fetch
  // dynamically imported module", so the whole app fails to initialize until
  // a hard reload. We never cached cross-origin responses anyway (the cache.put
  // below is gated on same-origin), so letting the browser handle them natively
  // costs nothing and makes transient failures self-heal on a normal reload.
  if (url.origin !== location.origin) return;
  // HTML: network-first. Свежий код деплоя должен попадать к пользователю
  // СРАЗУ — раньше стояло stale-while-revalidate, и кэш раздавал старый
  // JS, который успевал испортить облачный state до прихода свежего HTML.
  // Теперь сначала сеть, и только при реальном офлайне — fallback в кэш.
  const isHtml = req.mode === 'navigate'
    || req.headers.get('accept')?.includes('text/html');
  if (isHtml) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      } catch (e) {
        const cached = await cache.match(req);
        return cached || new Response(
          '<h1>Offline</h1><p>SuitesForAll is offline. Reconnect to continue.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html' } }
        );
      }
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
