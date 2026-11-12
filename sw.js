// Service Worker：離線快取 + Firebase 推播
importScripts('./config.js');

const CACHE = 'lc-v3';
const ASSETS = [
  './', './index.html', './config.js', './manifest.webmanifest',
  './css/style.css', './js/app.js', './js/store.js', './js/csv.js', './js/reminders.js', './js/lock.js', './js/notes.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 自己網站的檔案：先用快取讓 APP 秒開，同時在背景抓新版（下次開啟就是新版）
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});

// Firebase Cloud Messaging：APP 沒開時由這裡顯示通知
if (self.LC_CONFIG && self.LC_CONFIG.firebase) {
  importScripts(
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js'
  );
  firebase.initializeApp(self.LC_CONFIG.firebase);
  firebase.messaging();
}

// 點擊通知（測試通知；FCM 的通知由 Firebase 自行處理）
self.addEventListener('notificationclick', event => {
  if (event.notification.data && event.notification.data.FCM_MSG) return;
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
