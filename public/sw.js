const CACHE = 'diary-v1';
const ASSETS = ['/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x))))); self.clients.claim(); });

// Share target: фото, отправленное через «Поделиться», кладём во временный кэш и открываем приложение.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname === '/share') {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const file = form.get('image');
      if (file) { const c = await caches.open('shared'); await c.put('/shared-image', new Response(file, { headers: { 'Content-Type': file.type } })); }
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
