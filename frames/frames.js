// frames.js — 네컷 프레임 정의 데이터. 그리기 코드는 여기 없다(fourcut.js가 읽어 그린다).
// 설계지시안 v3.1 §2-12 + v3.3 확정 28·29.
//
// 구조
//   LAYOUTS  : 이름 있는 좌표판. 캔버스 크기 · 칸 4개 사각형 · 문구 기준선 · 강조선 사각형.
//   FRAMES   : 색·글꼴 두께 등 **꾸밈**과 layoutId(어느 좌표판을 쓰는지).
//   자산     : 배경·오버레이 이미지는 여기 담지 않는다. 교사가 관리 화면에서 올려
//              Firestore config 문서에 들어가고, db.js가 읽어 fourcut.js에 넘긴다(확정 27).
//
// 좌표 검산 (§1-3 네컷 캔버스 — 아래 LAYOUT 상수가 원천이고 checks 25가 다시 계산한다):
//   상단 140 + 셀 480×4 + 셀 간격 24×3 + 하단 148 = 2280
//   가로 = 좌여백 40 + 셀 640 + 우여백 40 = 720

export const LAYOUT = {
  width: 720,
  height: 2280,
  marginX: 40,
  topBand: 140,
  cellW: 640,
  cellH: 480,
  gap: 24,
  bottomBand: 148,
  cells: 4
};

// 셀 n(0~3)의 좌상단 y 좌표.
export function cellTop(n) {
  return LAYOUT.topBand + n * (LAYOUT.cellH + LAYOUT.gap);
}

// 프레임 문구는 관리 화면(config)에서 읽는다. 아래는 config가 비었을 때의 기본값이다.
export const DEFAULT_FRAME_TEXTS = {
  top: '2026 용인고 단국대 현장체험학습',
  bottom: '단국대학교 죽전캠퍼스'
};

// ── 좌표판 (확정 29) ──────────────────────────────────────────────────────
// vertical4의 칸 좌표는 **LAYOUT에서 유도한다**. 숫자를 다시 적으면 두 원천이 생기고
// 한쪽만 고쳐질 때 산출물이 조용히 어긋난다(F-1).
function vertical4Cells() {
  const out = [];
  for (let n = 0; n < LAYOUT.cells; n += 1) {
    out.push({ x: LAYOUT.marginX, y: cellTop(n), w: LAYOUT.cellW, h: LAYOUT.cellH });
  }
  return out;
}

// grid2x2 — 2열 × 2행. 좌표는 아래 변수들에서 유도하고, 검산은 checks가 다시 계산한다.
const G = { marginX: 48, topBand: 150, cellW: 480, cellH: 360, gapX: 24, gapY: 24, bottomBand: 148 };
function grid2x2Cells() {
  const out = [];
  for (let n = 0; n < 4; n += 1) {
    const col = n % 2;
    const row = Math.floor(n / 2);
    out.push({
      x: G.marginX + col * (G.cellW + G.gapX),
      y: G.topBand + row * (G.cellH + G.gapY),
      w: G.cellW,
      h: G.cellH
    });
  }
  return out;
}
const GRID_W = G.marginX * 2 + G.cellW * 2 + G.gapX;
const GRID_H = G.topBand + G.cellH * 2 + G.gapY + G.bottomBand;

export const LAYOUTS = [
  {
    id: 'vertical4',
    name: '세로 4칸 (720 × 2280)',
    width: LAYOUT.width,
    height: LAYOUT.height,
    cells: vertical4Cells(),
    accent: { x: LAYOUT.marginX, y: LAYOUT.topBand - 20, w: LAYOUT.cellW },
    topText: { x: LAYOUT.width / 2, baseline: 88, align: 'center', maxWidth: LAYOUT.cellW },
    bottomText: { x: LAYOUT.width / 2, baseline: 2214, align: 'center', maxWidth: LAYOUT.cellW }
  },
  {
    id: 'grid2x2',
    name: '2 × 2 네 칸 (' + GRID_W + ' × ' + GRID_H + ')',
    width: GRID_W,
    height: GRID_H,
    cells: grid2x2Cells(),
    accent: { x: G.marginX, y: G.topBand - 20, w: GRID_W - G.marginX * 2 },
    topText: { x: GRID_W / 2, baseline: 98, align: 'center', maxWidth: GRID_W - G.marginX * 2 },
    bottomText: { x: GRID_W / 2, baseline: GRID_H - 48, align: 'center', maxWidth: GRID_W - G.marginX * 2 }
  }
];

export const DEFAULT_LAYOUT_ID = 'vertical4';

export function layoutById(id) {
  return LAYOUTS.filter(function (l) { return l.id === id; })[0]
    || LAYOUTS.filter(function (l) { return l.id === DEFAULT_LAYOUT_ID; })[0];
}

// ── 프레임 (꾸밈 + 좌표판 참조) ───────────────────────────────────────────
// 프레임을 늘릴 때는 FRAMES 배열에 항목 하나를 더하면 된다. 좌표를 새로 만들려면
// LAYOUTS에 좌표판 하나를 더하고 layoutId로 가리킨다 — fourcut.js는 고치지 않는다.
export const FRAMES = [
  {
    id: 'photoism-black',
    name: '검정 포토이즘형',
    layoutId: 'vertical4',
    background: '#111111',
    cellBackground: '#000000',
    cellBorder: '#2a2a2a',
    cellBorderWidth: 2,
    topText: { color: '#ffffff', size: 40, weight: '700' },
    bottomText: { color: '#d8d8d8', size: 30, weight: '400' },
    accent: { color: '#c8a34a', height: 4 }
  },
  {
    id: 'campus-pastel',
    name: '파스텔 캠퍼스형',
    layoutId: 'vertical4',
    background: '#f5efe6',
    cellBackground: '#ffffff',
    cellBorder: '#e0d6c6',
    cellBorderWidth: 3,
    topText: { color: '#4a3f35', size: 40, weight: '700' },
    bottomText: { color: '#6b5c4c', size: 30, weight: '400' },
    accent: { color: '#a8c3a0', height: 4 }
  },
  {
    // 여행로그 지도(campus-map.svg)와 같은 팔레트를 쓴다 — 크림 종이·갈색 잉크·구리 지붕.
    // 배경 자산을 올리지 않아도 이 색만으로 완성된 한 벌이 되도록 골랐다. 자산을 올리면
    // 종이 질감·리본·모서리 장식이 더해진다(vintage-frame-bg.png · 안내서 §15).
    //
    // 문구 색이 크림(#fdf6e3·#f3d9bd)인 이유: 문구가 앉는 위·아래 띠가 **자산이 있든
    // 없든 갈색**이기 때문이다. 자산 없이 쓰면 background 색 #8c5b34 위에, 자산을 올리면
    // 같은 색 리본 위에 얹힌다 — 둘 다 읽힌다. 배경색과 자산의 바탕색을 일부러 맞춰
    // 두었으니, 자산을 다시 그릴 때도 위·아래 띠는 어두운 갈색으로 남겨야 한다.
    id: 'vintage-travellog',
    name: '빈티지 여행로그형',
    layoutId: 'vertical4',
    background: '#8c5b34',
    cellBackground: '#f5edd8',
    cellBorder: '#6f5f47',
    cellBorderWidth: 3,
    topText: { color: '#fdf6e3', size: 34, weight: '800' },
    bottomText: { color: '#f3d9bd', size: 28, weight: '600' },
    accent: { color: '#c9a24a', height: 3 }
  },
  {
    id: 'custom-upload',
    name: '업로드한 이미지 프레임',
    layoutId: 'vertical4',
    background: '#ffffff',
    cellBackground: '#e9e9e9',
    cellBorder: '#ffffff',
    cellBorderWidth: 0,
    topText: { color: '#222222', size: 40, weight: '700' },
    bottomText: { color: '#444444', size: 30, weight: '400' },
    accent: { color: '#ffffff', height: 0 }
  }
];

export function frameById(id) {
  return FRAMES.filter(function (f) { return f.id === id; })[0] || FRAMES[0];
}

// 프레임이 실제로 쓸 좌표판. 교사가 관리 화면에서 고른 layoutId가 프레임 기본값을 이긴다.
// @param {{layoutId?:string}} [options] db.js가 읽어 온 프레임별 설정
export function frameLayoutOf(frame, options) {
  const picked = (options && options.layoutId) || (frame && frame.layoutId) || DEFAULT_LAYOUT_ID;
  return layoutById(picked);
}

// 칸 사각형 4개. 미리보기 상자·조정 UI·합성 캔버스가 모두 이 함수를 통해 좌표를 얻는다(확정 29-⑸).
export function cellBoxes(frame, options) {
  return frameLayoutOf(frame, options).cells;
}

export function cellBoxOf(frame, options, n) {
  const boxes = cellBoxes(frame, options);
  return boxes[n] || boxes[0];
}

// ── 프레임 이미지 자산 (확정 27·28) ───────────────────────────────────────
// background = 칸 아래, 캔버스 전체(cover, JPEG)
// overlay    = 칸·문구 위, 캔버스 전체(투명 보존, PNG)
export const FRAME_ASSET_KINDS = ['background', 'overlay'];

export const FRAME_ASSET_LABELS = {
  background: '배경 사진 (칸 아래에 깔림)',
  overlay: '덮는 프레임 PNG (칸 위에 겹침 · 투명 구멍 필요)'
};

// 사진과 같은 상한. 문서 1개 = 이미지 1장이라 1MiB 한도를 장당으로 분리한다(확정 27-⑶).
export const FRAME_ASSET_MAX_BYTES = 900000;

// 자산 문서 ID의 단일 원천. db.js가 이 함수만 쓴다(두 곳에 규칙을 적지 않는다).
export function frameAssetDocId(frameId, kind) {
  return 'frameImg-' + String(frameId) + '-' + String(kind);
}

// 메타 인덱스 문서 ID — 프레임별 layoutId·hideTexts·자산 크기 요약이 여기 모인다.
export const FRAME_ASSET_META_DOC = 'frameAssets';
