/* =========================================================
 * 背公式 · Service Worker
 * 更新策略：
 *   1) 应用外壳（index.html / app.js / manifest.json / docs/formulas.json）
 *      走 Network First —— 联网时永远拿最新版，断网回退缓存；
 *   2) 静态大件（KaTeX CDN、图标）走 Cache First —— 省流量、离线可用。
 * 因此日常改版不需要手动改 CACHE_VERSION，用户下次打开即自动更新。
 * ========================================================= */

const CACHE_VERSION = 'v6';
const CACHE_NAME = `beigongshi-${CACHE_VERSION}`;

const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist';

const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './docs/formulas.json',
  './icon-192.png',
  './icon-512.png',
  // KaTeX：样式、脚本与排版所需字体（缺字体会导致公式变成方块）
  `${KATEX}/katex.min.css`,
  `${KATEX}/katex.min.js`,
  `${KATEX}/fonts/KaTeX_Main-Regular.woff2`,
  `${KATEX}/fonts/KaTeX_Main-Bold.woff2`,
  `${KATEX}/fonts/KaTeX_Math-Italic.woff2`,
  `${KATEX}/fonts/KaTeX_AMS-Regular.woff2`,
  `${KATEX}/fonts/KaTeX_Size1-Regular.woff2`,
  `${KATEX}/fonts/KaTeX_Size2-Regular.woff2`,
  `${KATEX}/fonts/KaTeX_Size3-Regular.woff2`,
  `${KATEX}/fonts/KaTeX_Size4-Regular.woff2`,
];

/* 安装：预缓存全部资源（cache: 'reload' 绕过 HTTP 缓存，避免缓存到旧文件） */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const requests = ASSETS.map((url) => new Request(url, { cache: 'reload' }));
    try {
      await cache.addAll(requests);
    } catch (err) {
      // CDN 个别字体失败不应让整个 SW 安装失败，退化为逐个添加
      console.warn('[sw] cache.addAll 失败，改为逐个缓存：', err);
      await Promise.all(
        requests.map((req) => cache.add(req).catch(() => {}))
      );
    }
    await self.skipWaiting();
  })());
});

/* 激活：删除旧版本缓存，立即接管页面 */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

/* 应用外壳判定：这些文件联网时必须取最新，保证部署后自动更新 */
function isAppShell(request, url) {
  if (request.mode === 'navigate') return true;
  if (url.origin !== self.location.origin) return false;
  return /\/(index\.html|app\.js|manifest\.json|docs\/formulas\.json)$/.test(url.pathname);
}

/* Network First：联网取最新并回填缓存，断网回退缓存
 * 注意：必须用 cache: 'no-store' 绕过浏览器 HTTP 缓存，
 * 否则部署后最长 10 分钟仍会拿到旧文件（GitHub Pages 默认 max-age=600）。*/
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(new Request(request, { cache: 'no-store' }));
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // 导航请求统一回退到 index.html（子路径部署下依然正确）
    if (request.mode === 'navigate') {
      const fallback = (await cache.match('./index.html')) || (await caches.match('./index.html'));
      if (fallback) return fallback;
    }
    throw err;
  }
}

/* Cache First：命中直接返回，未命中走网络并回填 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

/* 请求分发 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  event.respondWith(
    isAppShell(request, url) ? networkFirst(request) : cacheFirst(request)
  );
});
