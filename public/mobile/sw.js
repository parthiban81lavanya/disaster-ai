// Offline-first service worker: app shell + Ward 14 map tiles (cache-first), API GETs (network-first, cache fallback).
const SHELL = "shield-shell-v1", TILES = "shield-tiles-v2", API = "shield-api-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./index.html", "./app.js", "./manifest.webmanifest",
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"]).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("shield-tiles-") && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET") return;
  if (u.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith(caches.open(TILES).then(async (c) => (await c.match(r)) || fetch(r).then((n) => { if (n.ok) c.put(r, n.clone()); return n; }).catch(() => new Response("", { status: 504 }))));
  } else if (u.pathname.startsWith("/api/")) {
    e.respondWith(fetch(r).then((n) => { const k = n.clone(); caches.open(API).then((c) => c.put(r, k)); return n; }).catch(() => caches.match(r)));
  } else {
    e.respondWith(fetch(r).then((n) => { const k = n.clone(); caches.open(SHELL).then((c) => c.put(r, k)); return n; }).catch(() => caches.match(r)));
  }
});
