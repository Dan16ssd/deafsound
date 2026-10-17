// Offline cache for the app shell, TensorFlow.js and the YAMNet model.
// Only same-origin GETs are cached. The narration POST is never touched.
const CACHE = 'deafsound-v19';

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'fonts/plus-jakarta-sans-latin.woff2',
  'manifest.webmanifest',
  'icon.svg',
  'js/app.js',
  'js/audio.js',
  'js/capture-worklet.js',
  'js/detector.js',
  'js/approach.js',
  'js/head.js',
  'js/scene.js',
  'js/pitch.js',
  'js/viz.js',
  'js/crossing.js',
  'js/finder.js',
  'js/guardian.js',
  'js/demo.js',
  'js/outputs.js',
  'js/timeline.js',
  'js/novelty.js',
  'js/risk.js',
  'js/labels.js',
  'js/library.js',
  'js/narrate.js',
  'js/yamnet.js',
  'vendor/tf.min.js',
  'model/model.json',
  'model/group1-shard1of4.bin',
  'model/group1-shard2of4.bin',
  'model/group1-shard3of4.bin',
  'model/group1-shard4of4.bin',
  'model/yamnet_class_map.csv',
  'packs/lao-starter.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App code (html/css/js/json) is network-first so a new release shows on the next
// load, falling back to the cache offline. The big static files (model, TensorFlow.js)
// stay cache-first so they are not re-downloaded.
const isShell = (url) => /(\/|\.html|\.css|\.js|\.webmanifest|\.svg)$/.test(url.pathname) && !url.pathname.startsWith('/vendor/');

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (isShell(url)) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
          return res;
        })
        .catch(() => caches.match(e.request, { ignoreSearch: true })),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit ?? fetch(e.request)),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((wins) => (wins[0] ? wins[0].focus() : self.clients.openWindow('./'))),
  );
});
