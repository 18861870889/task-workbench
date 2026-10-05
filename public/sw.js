const SHELL_CACHE = 'task-workbench-shell-v1';
const PUBLIC_SHELL = ['/offline.html', '/icon.svg', '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(PUBLIC_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('task-workbench-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  } else if (PUBLIC_SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  }
});

function safeUrl(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : self.location.origin + '/';
  } catch { return self.location.origin + '/'; }
}
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* Use a generic notification for invalid payloads. */ }
  if (!data || typeof data !== 'object') data = {};
  if (data.notification && typeof data.notification === 'object') {
    data = { ...data.notification, url: data.notification.navigate, ...data };
  }
  event.waitUntil(self.registration.showNotification(typeof data.title === 'string' ? data.title : '我的工作台', {
    body: typeof data.body === 'string' ? data.body : '你有一项新的工作提醒，打开工作台查看。',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: typeof data.tag === 'string' ? data.tag : 'workbench-reminder',
    data: { url: safeUrl(data.url) },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = safeUrl(event.notification.data?.url);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(destination);
      return existing.focus();
    }
    return self.clients.openWindow(destination);
  }));
});
