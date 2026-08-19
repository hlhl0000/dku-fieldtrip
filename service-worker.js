// service-worker.js — 앱 셸 캐시. 오프라인에서 새로고침해도 앱이 열리게 한다.
// 설계지시안 v3.1 확정 21 / §1-3(B-6·B-7) / §2-13.
//
// 캐시 대상
//   앱 셸 5쪽 + css / js / frames + gstatic Firebase 모듈 3개
//   (firebase-firestore.js가 firebase-app.js를 절대 URL로 import 하므로 셋 다 필요하다)
//
// 경로 규칙
//   캐시 키·스코프를 전부 상대 경로로 둔다. GitHub Pages는 https://{user}.github.io/{repo}/ 로
//   서빙되므로 '/index.html' 같은 절대 경로를 쓰면 스코프 밖이 되어 등록·매칭이 실패한다.
//
// 버전 단일 원천
//   앱 버전·SDK 버전을 등록 URL의 질의문자열로 받는다. 값의 원천은 firebase-config.js 하나다(F-1).

const PARAMS = new URL(self.location.href).searchParams;
const APP_VERSION = PARAMS.get('v') || 'v0';
const SDK_VERSION = PARAMS.get('sdk') || '';
const CACHE_NAME = 'dku-shell-' + APP_VERSION + '-' + SDK_VERSION;

// 앱 셸 5쪽 + 자원. 전부 상대 경로다.
const SHELL = [
  './',
  './index.html',
  './mission.html',
  './fourcut.html',
  './teacher.html',
  './admin.html',
  './css/style.css',
  './js/db.js',
  './js/firebase-config.js',
  './js/common.js',
  './js/compress.js',
  './js/fourcut.js',
  './frames/frames.js'
];

function sdkUrls() {
  if (!SDK_VERSION) return [];
  const base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  return [
    base + 'firebase-app.js',
    base + 'firebase-auth.js',
    base + 'firebase-firestore.js'
  ];
}

// 한 항목이 없어도 설치를 통째로 실패시키지 않는다.
// (아직 만들지 않은 화면이 있어도 나머지 셸은 캐시되어야 한다)
async function cacheAllTolerant(cache, urls) {
  const missing = [];
  for (const url of urls) {
    try {
      await cache.add(new Request(url, { cache: 'reload' }));
    } catch (e) {
      missing.push(url);
    }
  }
  return missing;
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE_NAME);
    const missingShell = await cacheAllTolerant(cache, SHELL);
    const missingSdk = await cacheAllTolerant(cache, sdkUrls());
    if (missingShell.length || missingSdk.length) {
      console.warn('[sw] 캐시하지 못한 항목', missingShell.concat(missingSdk));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.map(function (n) {
      return n !== CACHE_NAME && n.indexOf('dku-shell-') === 0 ? caches.delete(n) : Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

// 캐시 우선 + 네트워크 갱신. 문서 요청은 실패 시 캐시본으로 되돌린다.
self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isSdk = url.origin === 'https://www.gstatic.com';

  // Firestore·Auth API 호출은 가로채지 않는다(오프라인 큐는 SDK가 관리한다).
  if (!sameOrigin && !isSdk) return;

  event.respondWith((async function () {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });

    if (cached) {
      // 백그라운드 갱신. 실패해도 캐시본을 그대로 쓴다.
      event.waitUntil((async function () {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        } catch (e) { /* 오프라인 — 무시 */ }
      })());
      return cached;
    }

    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && (sameOrigin || isSdk)) {
        cache.put(req, fresh.clone()).catch(function () { /* 무시 */ });
      }
      return fresh;
    } catch (e) {
      if (req.mode === 'navigate') {
        const fallback = await cache.match('./index.html', { ignoreSearch: true });
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});
