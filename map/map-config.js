// map-config.js — 지도 수치의 단일 원천 (설계지시안 v3.4 §2-2 · F-1)
//
// 이 파일이 정하는 것: viewBox 크기 · 랜드마크 목록 · 핀/스탬프/폴라로이드 표시 치수.
// 런타임 코드(map-view.js·mission.html·teacher.html·admin.html·css)는 지도 수치를
// 하드코딩하지 않고 전부 여기서 가져온다(§2-2 「지도 수치 하드코딩 0건」).
//
// campus-map.svg · map-manifest.json · map-reference.md 의 같은 값은 파생 사본이며
// 문자 단위로 일치해야 한다(§6 파생 메타 일치 검사).
//
// 이 모듈은 순수 상수·순수 함수만 담는다. DB를 읽지 않는다(금지 35).
// 외부 URL 참조 0건(금지 26).

// ── viewBox (추정 1 — 세로형, 사용자 승인됨) ────────────────────────────────
export const MAP_WIDTH = 900;
export const MAP_HEIGHT = 1300;

// SVG·매니페스트와 문자 단위로 일치해야 하는 문자열.
export const MAP_VIEWBOX = '0 0 ' + MAP_WIDTH + ' ' + MAP_HEIGHT;

// 좌표 표기 방식 (추정 2). 저장·전달은 전부 0~1 분수다.
export const COORDINATE_SYSTEM = 'fraction-0-1';

// ── 랜드마크 6곳 (확정 4) ──────────────────────────────────────────────────
// x·y 는 0~1 분수. campus-map.svg 안 같은 id의 그림 중심과 일치한다.
// 배치 근거·출처는 map-reference.md §3.
// geoVerified:false = 사용자가 「위치 상관 없음」이라 한 항목 = 지리 검증 예외.
export const LANDMARKS = [
  { id: 'lm-gate',     name: '정문',                x: 0.50, y: 0.70, geoVerified: true  },
  { id: 'lm-library',  name: '중앙도서관',          x: 0.35, y: 0.54, geoVerified: true  },
  { id: 'lm-museum',   name: '단국대 박물관',       x: 0.67, y: 0.34, geoVerified: true  },
  { id: 'lm-artshall', name: '죽전 포은아트홀',     x: 0.76, y: 0.83, geoVerified: true  },
  { id: 'lm-bojeong',  name: '보정동 카페거리 입구', x: 0.33, y: 0.86, geoVerified: true  },
  { id: 'lm-tancheon', name: '탄천',                x: 0.14, y: 0.78, geoVerified: false }
];

// SVG 안 랜드마크 그룹 id 규칙(§6 「id="lm-" 6건」 검사와 같은 접두).
export const LANDMARK_ID_PREFIX = 'lm-';

// ── 오버레이 표시 치수 (전부 viewBox 단위) ─────────────────────────────────
// 오버레이 SVG는 campus-map.svg 와 같은 viewBox·같은 aspect 를 쓴다(§6 ⑼).
// SVG 내부 요소 접근 금지(금지 33)이므로 핀·경로·폴라로이드는 전부 오버레이에 그린다.
export const PIN = {
  width: 44,          // 핀 머리 지름
  height: 58,         // 꼭짓점까지 총 높이
  anchor: 'bottom',   // 좌표는 핀 '끝'이 가리키는 지점
  activeScale: 1.25,  // statusOf === 'current' 인 핀
  lockedOpacity: 0.55,
  hitRadius: 34       // 탭 판정 반경 — 손가락 기준으로 그림보다 크게
};

export const STAMP = {
  radius: 34,
  ringWidth: 3.5,
  rotation: -12,      // 도장 기울기(도)
  queuedOpacity: 0.45 // statusOf === 'queued' 반투명 스탬프
};

export const POLAROID = {
  width: 118,
  height: 140,
  photoInset: 9,      // 사진 여백(좌·우·위)
  captionHeight: 30,  // 아래쪽 흰 여백
  rotation: -6,
  offsetX: 0,         // 핀 좌표 기준 사진 붙는 위치
  offsetY: -96
};

export const ROUTE = {
  width: 6,
  dashArray: '2 15',
  capStyle: 'round'
};

export const LABEL = {
  fontSize: 25,
  haloWidth: 6,
  offsetY: 44        // 핀 좌표에서 라벨까지
};

// ── 순수 헬퍼 ──────────────────────────────────────────────────────────────

// 0~1 유한수 점인가. db.js 좌표 검증·관리 화면 클릭 지정이 같은 판정을 쓴다.
export function isFractionPoint(p) {
  return !!p &&
    Number.isFinite(p.x) && Number.isFinite(p.y) &&
    p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}

// 분수 좌표 → viewBox 픽셀. 반대 방향은 fromViewBox().
export function toViewBox(p) {
  return { x: p.x * MAP_WIDTH, y: p.y * MAP_HEIGHT };
}

// viewBox 픽셀 → 분수 좌표 (관리 화면 클릭 지정용). 0~1 밖은 잘라 낸다.
export function fromViewBox(px, py) {
  const clamp = function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); };
  return { x: clamp(px / MAP_WIDTH), y: clamp(py / MAP_HEIGHT) };
}

// 랜드마크 id → 랜드마크. 없으면 null.
export function landmarkById(id) {
  for (let i = 0; i < LANDMARKS.length; i++) {
    if (LANDMARKS[i].id === id) return LANDMARKS[i];
  }
  return null;
}
