/* =========================================================
 * 背公式 · Service Worker
 * 部署在 GitHub Pages 子路径（如 /formula/）时：
 * ASSETS 中的相对路径会以 sw.js 所在目录为基准解析，
 * 因此无需写死仓库名，换用户名/仓库名都不用改代码。
 * 改版后请递增 CACHE_VERSION，旧缓存会在 activate 时清理。
 * ========================================================= */

const CACHE_VERSION = 'v4';
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

/* 安装：预缓存全部资源 */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(ASSETS);
    } catch (err) {
      // CDN 个别字体失败不应让整个 SW 安装失败，退化为逐个添加
      console.warn('[sw] cache.addAll 失败，改为逐个缓存：', err);
      await Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})));
    }
    await self.skipWaiting();
  })());
});

/* 激活：删除旧版本缓存 */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

/* 请求：Cache First，未命中再走网络并动态写入缓存 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!/^https?:$/.test(url.protocol)) return;

  event.respondWith((async () => {
    // 1) 缓存优先
    const cached = await caches.match(request);
    if (cached) return cached;

    // 2) 网络请求并回填缓存
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      // 3) 断网时导航请求回退到缓存的 index.html（子路径下同样有效）
      if (request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
