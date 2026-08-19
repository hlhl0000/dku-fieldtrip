// frames.js — 네컷 프레임 정의 데이터. 그리기 코드는 여기 없다(fourcut.js가 읽어 그린다).
// 설계지시안 v3.1 §2-12. 프레임을 늘릴 때는 FRAMES 배열에 항목 하나를 더하면 된다.
//
// 좌표 검산 (§1-3 네컷 캔버스):
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

export const FRAMES = [
  {
    id: 'photoism-black',
    name: '검정 포토이즘형',
    background: '#111111',
    cellBackground: '#000000',
    cellBorder: '#2a2a2a',
    cellBorderWidth: 2,
    topText: { color: '#ffffff', size: 40, weight: '700', baseline: 88 },
    bottomText: { color: '#d8d8d8', size: 30, weight: '400', baseline: 2214 },
    accent: { color: '#c8a34a', height: 4 }
  },
  {
    id: 'campus-pastel',
    name: '파스텔 캠퍼스형',
    background: '#f5efe6',
    cellBackground: '#ffffff',
    cellBorder: '#e0d6c6',
    cellBorderWidth: 3,
    topText: { color: '#4a3f35', size: 40, weight: '700', baseline: 88 },
    bottomText: { color: '#6b5c4c', size: 30, weight: '400', baseline: 2214 },
    accent: { color: '#a8c3a0', height: 4 }
  }
];

export function frameById(id) {
  return FRAMES.filter(function (f) { return f.id === id; })[0] || FRAMES[0];
}
