const VERSION = 'v5';
const SHELL_CACHE = `family-app-shell-${VERSION}`;
const RUNTIME_CACHE = `family-app-runtime-${VERSION}`;

/** Every module the SPA needs to boot offline. */
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/index.css',
  './js/app.js',
  './js/api.js',
  './js/config.js',
  './js/store.js',
  './js/utils.js',
  './js/nanobot.js',
  './js/components/nav.js',
  './js/components/modal.js',
  './js/screens/auth.js',
  './js/screens/home.js',
  './js/screens/task-list.js',
  './js/screens/task-detail.js',
  './js/screens/calendar.js',
  './js/screens/shopping.js',
  './js/screens/settings.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Added individually: one missing file must not void the whole precache.
    await Promise.all(SHELL_FILES.map((file) =>
      cache.add(new Request(file, { cache: 'reload' }))
        .catch((error) => console.warn('[sw] precache skipped', file, error))
    ));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name !== SHELL_CACHE && name !== RUNTIME_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  // Only same-origin, complete, successful GETs are worth storing.
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

/** Fresh when online, cached when not — and the cache is refreshed on every hit. */
async function networkFirstWithCache(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // The Cache API rejects non-GET requests; agent calls must go straight to the network.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.includes('/v1/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.origin !== self.location.origin) {
    // Fonts and other cross-origin assets: serve from cache, fall back to network.
    event.respondWith(cacheFirst(request, RUNTIME_CACHE).catch(() => caches.match(request)));
    return;
  }

  // Code is network-first, assets are cache-first.
  //
  // Cache-first on scripts meant that forgetting to bump VERSION stranded every
  // installed device on old JavaScript indefinitely — a deploy would appear to
  // succeed while nobody actually received it. Network-first removes that whole
  // failure mode: online devices always run the deployed code, and the cache is
  // still there as the offline fallback. Images and icons rarely change and are
  // the bulk of the bytes, so they stay cache-first.
  if (/\.(?:js|mjs|css|html|json)$/.test(url.pathname) || url.pathname.endsWith('/')) {
    event.respondWith(networkFirstWithCache(request, RUNTIME_CACHE));
    return;
  }

  event.respondWith(cacheFirst(request, RUNTIME_CACHE));
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'task-sync') {
    event.waitUntil(self.clients.matchAll().then((clients) => {
      clients.forEach((client) => client.postMessage({ type: 'SYNC_REQUESTED' }));
    }));
  }
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
