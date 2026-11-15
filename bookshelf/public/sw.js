// Офлайн-оболочка: статические файлы — «сначала сеть», обложки — «сначала кэш», остальные запросы к серверу не кэшируются.
const SHELL = 'shelf-shell-v1';
const COVERS = 'shelf-covers-v1';
const FILES = ['./', 'style.css', 'app.js', 'shared.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== COVERS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/covers/')) {
    e.respondWith(caches.open(COVERS).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
    return res.clone();
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./'))));
});
