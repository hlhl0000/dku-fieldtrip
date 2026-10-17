// map-config.js — 지도 수치의 단일 원천
// 앤티크 판화 지도 v6.1: 정문 → 보정동 카페거리 → 탄천 다리 → 죽전역 → 용인포은아트홀.
// 신세계 사우스시티는 탄천 서쪽 기슭, 죽전역 바로 위에 붙은 단지다.
// 사용자 제공 Google 지도 플러스 코드 실측(2026-10-17)에 따른 일렬 동선.

export const MAP_WIDTH = 900;
export const MAP_HEIGHT = 1300;
export const MAP_VIEWBOX = '0 0 ' + MAP_WIDTH + ' ' + MAP_HEIGHT;
export const COORDINATE_SYSTEM = 'fraction-0-1';

// x·y는 0~1 분수이며, campus-map.svg의 같은 id 건물 중심에 맞춘다.
// 서쪽이 아래, 동쪽이 위, 북쪽이 왼쪽, 남쪽이 오른쪽이다. 축척은 모식이다.
export const LANDMARKS = [
  { id: 'lm-gate',     name: '정문 · 상징탑',       x: 0.39, y: 0.345, geoVerified: true  },
  { id: 'lm-museum',   name: '석주선기념박물관',    x: 0.79, y: 0.18, geoVerified: true  },
  { id: 'lm-library',  name: '퇴계기념중앙도서관',  x: 0.61, y: 0.245, geoVerified: true  },
  { id: 'lm-station',  name: '죽전역',              x: 0.415, y: 0.78, geoVerified: true  },
  { id: 'lm-shinsegae', name: '신세계 사우스시티',   x: 0.335, y: 0.725, geoVerified: true  },
  { id: 'lm-bojeong',  name: '보정동 카페거리',     x: 0.59, y: 0.6, geoVerified: true  },
  { id: 'lm-artshall', name: '용인포은아트홀',      x: 0.215, y: 0.89, geoVerified: true  },
  { id: 'lm-tancheon', name: '탄천',                x: 0.15, y: 0.625, geoVerified: false }
];

export const LANDMARK_ID_PREFIX = 'lm-';

// 아래 치수는 지도 오버레이(map-view.js)의 기존 계약이다.
export const PIN = { width: 44, height: 58, anchor: 'bottom', activeScale: 1.25, lockedOpacity: 0.55, hitRadius: 34 };
export const STAMP = { radius: 34, ringWidth: 3.5, rotation: -12, queuedOpacity: 0.45 };
export const POLAROID = { width: 118, height: 140, photoInset: 9, captionHeight: 30, rotation: -6, offsetX: 0, offsetY: -96 };
export const ROUTE = { width: 6, dashArray: '2 15', capStyle: 'round' };
export const LABEL = { fontSize: 25, haloWidth: 6, offsetY: 44 };

export function isFractionPoint(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}
export function toViewBox(p) { return { x: p.x * MAP_WIDTH, y: p.y * MAP_HEIGHT }; }
export function fromViewBox(px, py) {
  const clamp = function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); };
  return { x: clamp(px / MAP_WIDTH), y: clamp(py / MAP_HEIGHT) };
}
export function landmarkById(id) {
  for (let i = 0; i < LANDMARKS.length; i++) if (LANDMARKS[i].id === id) return LANDMARKS[i];
  return null;
}
