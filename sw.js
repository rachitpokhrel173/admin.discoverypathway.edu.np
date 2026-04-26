/**
 * Discovery Pathway CRM — Service Worker
 * Strategy:
 *   • App shell (HTML, local assets) → Cache-first, fallback to network
 *   • CDN resources (fonts, Chart.js, Supabase SDK) → Stale-while-revalidate
 *   • Supabase API calls → Network-first, no caching (live data)
 *   • Offline fallback → /offline.html
 */

const APP_VERSION = 'v1.0.0';
const SHELL_CACHE  = `dp-shell-${APP_VERSION}`;
const CDN_CACHE    = `dp-cdn-${APP_VERSION}`;
const IMAGE_CACHE  = `dp-images-${APP_VERSION}`;

// ─── App shell: files that must be cached on install ───────────────────────
const SHELL_URLS = [
  './index.html',
  './index-login.html',
  './index-password.html',
  './offline.html',
  './manifest.json',
  './New_DP_Logo.png',
  './Discovery_Logo-removebg-preview.png',
];

// ─── CDN domains to cache with stale-while-revalidate ──────────────────────
const CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
];

// ─── Never cache these (live API / auth) ───────────────────────────────────
const BYPASS_HOSTS = [
  'vptbdniwqoyvdoqjcymf.supabase.co',
  'emailjs.com',
];

// ───────────────────────────────────────────────────────────────────────────
// INSTALL — pre-cache app shell
// ───────────────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();                  // activate immediately

  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      return Promise.allSettled(
        SHELL_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Failed to cache ${url}:`, err)
          )
        )
      );
    })
  );
});

// ───────────────────────────────────────────────────────────────────────────
// ACTIVATE — clean up old caches
// ───────────────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const CURRENT = new Set([SHELL_CACHE, CDN_CACHE, IMAGE_CACHE]);

  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => !CURRENT.has(key))
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ───────────────────────────────────────────────────────────────────────────
// FETCH — routing logic
// ───────────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // ── 1. Skip non-GET requests entirely ──
  if (request.method !== 'GET') return;

  // ── 2. Skip chrome-extension or other schemes ──
  if (!['http:', 'https:'].includes(url.protocol)) return;

  // ── 3. Live API calls — bypass completely ──
  if (BYPASS_HOSTS.some(h => url.hostname.includes(h))) return;

  // ── 4. CDN resources — stale-while-revalidate ──
  if (CDN_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // ── 5. Images — cache-first ──
  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // ── 6. App shell — cache-first with offline fallback ──
  event.respondWith(appShellStrategy(request));
});

// ───────────────────────────────────────────────────────────────────────────
// STRATEGIES
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cache-first — used for app shell pages.
 * Falls back to network; if both fail, serves offline.html for navigation.
 */
async function appShellStrategy(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Offline fallback for page navigations
    if (request.mode === 'navigate') {
      const offline = await caches.match('./offline.html');
      return offline || new Response(
        '<h1>You are offline</h1><p>Please reconnect to use the CRM.</p>',
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Cache-first — served from cache immediately; fetches update in background.
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

/**
 * Stale-while-revalidate — return cache immediately, refresh in background.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || new Response('', { status: 503 });
}

// ───────────────────────────────────────────────────────────────────────────
// BACKGROUND SYNC — retry failed Supabase writes when back online
// ───────────────────────────────────────────────────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'dp-sync') {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(client =>
          client.postMessage({ type: 'SYNC_TRIGGERED' })
        )
      )
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS (placeholder — enable when you add a push server)
// ───────────────────────────────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Discovery Pathway', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-96.png',
      tag: data.tag || 'dp-notification',
      data: { url: data.url || './index.html' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(target) && 'focus' in client)
          return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// ───────────────────────────────────────────────────────────────────────────
// MESSAGE — handle version-check from app
// ───────────────────────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: APP_VERSION });
  }
});
