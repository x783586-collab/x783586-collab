/* 简易离线缓存：壳资源缓存，API 请求直通网络 */
const CACHE = "tghub-v1";
const SHELL = ["./", "./index.html", "./app.js", "./style.css", "./manifest.json"];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.indexOf("/api/") >= 0 || url.pathname.indexOf("/hook/") >= 0) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
