/* Lexis Service Worker —— 让整套应用（HTML/CSS/JS/词库数据/图标）在没有网络时也能启动
   缓存策略：
     · 导航请求（打开页面）      → 联网优先，失败回退缓存（保证能拿到新版本，断网也能开）
     · 同源静态资源（CSS/JS/数据）→ 缓存优先 + 后台更新（stale-while-revalidate）
     · 跨域请求（有道/Google/百度在线音源）→ 完全不接管，交给浏览器（离线时自然失败并回退系统语音）
   版本：由构建时写入的 BUILD_ID 决定；内容一变就换缓存名，旧缓存自动清理。 */
const BUILD_ID = "0e71c9192f";
const CACHE = "lexis-" + BUILD_ID;
const PRECACHE = [
  "./index.html",
  "./app.css",
  "./app.js",
  "./audio.js",
  "./store.js",
  "./backup.js",
  "./patch.js",
  "./manifest.webmanifest",
  "./pwa.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon-180.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE.map(u => new Request(u, { cache: "reload" })));
    /* 故意不在这里 skipWaiting：等页面提示用户"有新版本"后再切换，避免学习中途被打断 */
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.indexOf("lexis-") === 0 && k !== CACHE).map(k => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (e) { }
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  const d = event.data || {};
  if (d.type === "SKIP_WAITING") self.skipWaiting();
  if (d.type === "VERSION") event.source && event.source.postMessage({ type: "VERSION", build: BUILD_ID });
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;          // 跨域（在线音源）不接管

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          const c = await caches.open(CACHE);
          c.put(req, fresh.clone());
        }
        return fresh;
      } catch (e) {
        const hit = (await caches.match(req)) || (await caches.match("./index.html")) || (await caches.match("./"));
        return hit || new Response("离线且没有缓存", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => { });
      return res;
    }).catch(() => null);
    if (cached) return cached;
    const fresh = await network;
    return fresh || new Response("", { status: 504 });
  })());
});
