// service-worker.js
// Caches the app shell so the whole app works with zero internet connection.
// Bump CACHE_NAME whenever you change any cached file so clients pick up the update.

const CACHE_NAME = "esh-attendance-v32";

// App code — changes often, and staleness here is dangerous (a critical bug
// fix could ship in the source but still appear broken in the browser
// because an old cached copy kept being served). Network-first: try the
// network for the latest version, cache it as a fallback for offline use,
// and only fall back to whatever's cached if the network request fails.
const APP_ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./css/dashboard.css",
  "./css/responsive.css",
  "./js/app.js",
  "./js/students-data.js",
  "./js/subjects-data.js",
  "./js/export-xlsx.js",
  "./manifest.json"
];

// Large, rarely-changing vendor assets — safe and faster to serve cache-first.
const STATIC_ASSETS = [
  "./vendor/xlsx.bundle.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...APP_ASSETS, ...STATIC_ASSETS]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAppAsset(url){
  return APP_ASSETS.some(a => url.endsWith(a.replace("./","/")) || url.endsWith(a.replace("./","")));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const isSameOrigin = request.url.startsWith(self.location.origin);
  const isNavigation = request.mode === "navigate";

  if (isSameOrigin && (isNavigation || isAppAsset(request.url))) {
    // Network-first for the app shell itself, so a browser that's currently
    // open always picks up a freshly deployed fix instead of being stuck
    // on whatever was cached before. Falls back to cache only when offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for everything else (large vendor bundles, icons, fonts).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && isSameOrigin) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});

// Background sync hook point — used once Firebase is connected to flush queued
// attendance writes made while offline. No-op until then.
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-attendance") {
    // [FIREBASE HOOK] — flush any pending writes to Firestore here.
  }
});
