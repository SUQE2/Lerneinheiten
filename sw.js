const CACHE = "lernzeit-shell-v2";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];
const SUPABASE_LIBRARY = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(SHELL);
    await cache.add(SUPABASE_LIBRARY).catch(() => undefined);
  }));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== location.origin) {
    if (requestUrl.hostname === "cdn.jsdelivr.net") {
      event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
    }
    return;
  }
  event.respondWith(fetch(event.request)
    .then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    })
    .catch(() => caches.match(event.request).then(response => response || caches.match("./index.html"))));
});
