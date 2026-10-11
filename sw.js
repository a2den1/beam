// 홈 화면 앱으로 설치했을 때 빠르게 열리도록 앱 파일을 캐시합니다. 항상 새 버전을 먼저 시도합니다.
const CACHE = 'beam-v3';
const SHELL = ['./', 'index.html', 'app.css', 'icons.js', 'js/app.js', 'js/mqtt.js', 'js/proto.js', 'js/session.js', 'js/touch.js',
  'manifest.webmanifest', 'assets/icon-192.png',
  'assets/fonts/Pretendard-Medium.woff2', 'assets/fonts/Pretendard-SemiBold.woff2', 'assets/fonts/Pretendard-Bold.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
