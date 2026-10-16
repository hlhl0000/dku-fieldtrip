// map-config.js — 지도 수치의 단일 원천
// 바깥 활동 구역 v3: 캠퍼스는 출발점, 죽전역은 갈림점, 바깥 두 곳이 본문이다.
// 캠퍼스 실루엣 안의 박물관·중앙도서관은 설계지시안 v3.4 「산출물 합의문」의 필수 6곳이라 남긴다.

export const MAP_WIDTH = 900;
export const MAP_HEIGHT = 1300;
export const MAP_VIEWBOX = '0 0 ' + MAP_WIDTH + ' ' + MAP_HEIGHT;
export const COORDINATE_SYSTEM = 'fraction-0-1';

// x·y는 0~1 분수이며, campus-map.svg의 같은 id 건물 중심에 맞춘다.
// 동선 모식도이므로 좌우는 실제 방위가 아니라 두 갈래를 읽기 쉽게 벌린 것이다.
export const LANDMARKS = [
  { id: 'lm-gate',     name: '정문 · 상징탑',       x: 0.50, y: 0.22, geoVerified: true  },
  { id: 'lm-museum',   name: '석주선기념박물관',    x: 0.19, y: 0.17, geoVerified: true  },
  { id: 'lm-library',  name: '퇴계기념중앙도서관',  x: 0.73, y: 0.17, geoVerified: true  },
  { id: 'lm-station',  name: '죽전역',              x: 0.50, y: 0.50, geoVerified: true  },
  { id: 'lm-bojeong',  name: '보정동 카페거리',     x: 0.24, y: 0.80, geoVerified: true  },
  { id: 'lm-artshall', name: '용인포은아트홀',      x: 0.76, y: 0.80, geoVerified: true  },
  { id: 'lm-tancheon', name: '탄천',                x: 0.10, y: 0.71, geoVerified: false }
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
