// album.js — 오후 과제 「모둠 여행 앨범」의 상수·합성기.
// 설계지시안_여행앨범 §3-0 ⑴ ⑹ ⑼ / §3-A C1·C2 / §5 금지 4c·5 적용.
//
// 이 파일이 단일 원천인 것 (F-1 — 다른 파일에 다시 적지 않는다)
//   · 격자(4 × 4 = 16칸)와 slot id 규칙
//   · 합성 캔버스 좌표 전부
//   · 캡션 규격(15자 · 22px · 1줄) — UI의 maxlength·placeholder도 여기서 파생한다
//   · 반복 문자열 정본(§3-0 ⑼) — 섹션 제목·빈 칸 안내·내려받기 버튼·합성 실패 문면 등
//
// 재사용 계약 (F-4 — 복제하지 않는다)
//   · 사진 사각형 계산은 fourcut.js의 `cellRect`를 그대로 쓴다(내부에서 coverScale을 부른다).
//   · base64 디코드·Blob 변환도 fourcut.js의 `decodeBase64`·`toBlobAsync`를 쓴다.
//
// ⚠ 메모리 계약 (P-검토 A-4 — X-1): `composeAlbum`은 슬롯을 **한 장씩** 디코드 → 그리기 →
//   즉시 해제한다. composeFourcut처럼 전부 디코드해 배열에 담으면 16장이라 비트맵만
//   수십 MB를 동시 보유해 실기기에서 탭이 죽는다. 함수는 재사용하되 루프 구조만 1장 단위다.

import { cellRect, decodeBase64, toBlobAsync } from './fourcut.js';
import { pad2 } from './common.js';

// ── 격자·캡션·캔버스 상수 ─────────────────────────────────────────────────
// 캔버스 검산(§3-0 ⑹ — 작성 시 재계산 완료)
//   좌우 여백 60 × 2      → 내부 폭 1600 - 120 = 1480
//   열 4개, 열 간격 40    → 4w + 3×40 = 1480 → w = 340
//   칸 340 × 310          = 사진 340 × 255 (4:3) + 캡션 띠 55
//   행 4개, 행 간격 40    → 4×310 + 3×40 = 1360
//   총 높이               = 160(제목) + 1360 + 60(하단 여백) = 1580
export const ALBUM = {
  cols: 4,
  rows: 4,
  slots: 16,

  // 캡션 규격 — 정지점 1에서 사용자 확정(§1-1 #14 · P-검토 A-8).
  // 340px 폭 ÷ 15자 = 글자당 22.7px이므로 22px 한 줄이 잘리지 않는다.
  caption: { maxChars: 15, fontPx: 22, lines: 1 },

  canvas: {
    width: 1600,
    height: 1580,
    margin: 60,        // 좌·우·하단 여백
    header: 160,       // 상단 제목 영역(모둠명·날짜)
    colGap: 40,
    rowGap: 40,
    cellW: 340,
    cellH: 310,
    photoW: 340,
    photoH: 255,
    captionBand: 55
  },

  output: { mime: 'image/jpeg', quality: 0.9 },

  // 캔버스는 CSS 변수를 읽을 수 없다. 아래 hex는 **style.css :root와 같은 값**이며
  // 테마를 바꾸면 두 곳을 함께 고친다(§3-0 ⑹ · §5 금지 9의 캔버스 쪽 대응).
  color: {
    paper: '#e6d9bf',      // --bg, style.css :root와 같은 값
    cell: '#fbf6e9',       // --card-2, style.css :root와 같은 값
    cellEmpty: '#f4ecd8',  // --card, style.css :root와 같은 값
    line: '#cabb98',       // --line
    ink: '#372c20',        // --ink
    inkWeak: '#7c6a4f',    // --ink-weak
    accent: '#2b5a57',     // --accent
    gold: '#a8894e'        // --gold
  },

  // 모두 운영체제에 있는 시스템 폰트 스택이다(외부 웹폰트 없음).
  font: {
    serif: 'Georgia, "Times New Roman", "Nanum Myeongjo", "Apple SD Gothic Neo", serif',
    sans: 'system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
  },

  // 반복 문자열 정본(§3-0 ⑼). 화면·합성이 같은 문면을 쓰도록 여기서만 정한다 —
  // UI 파일에 이 문자열을 리터럴로 다시 적지 않는다(F-1 · B-6).
  text: {
    sectionTitle: '여행 앨범',                                            // ①
    emptyCell: '사진 올리기',                                             // ②
    download: '앨범 내려받기',                                            // ③
    composeError: '앨범 이미지를 만들지 못했습니다. 다시 시도해 주세요',   // ④
    captionPlaceholder: '여기에 한 줄 (15자)',                            // ⑤
    missionCard: '여행 앨범 만들기'                                       // ⑥
  }
};

// ── slot id ───────────────────────────────────────────────────────────────
// 문서 id = pad2(0..15) = '00'~'15'(§1-2 추정 3). 문자열 정렬이 시각 순서와 일치한다.
// 규칙의 `slot.matches('^[0-9]{2}$')`와 같은 모양이다(§3-0 ⑵).
export function albumSlotId(slot) {
  return pad2(slot);
}

// '00'~'15'만 참이다. 규칙은 '99'까지 통과시키지만 클라이언트는 16칸 밖을 만들지 않는다.
export function isAlbumSlotId(id) {
  if (typeof id !== 'string' || !/^[0-9]{2}$/.test(id)) return false;
  const n = Number(id);
  return n >= 0 && n < ALBUM.slots;
}

// slot id 또는 숫자 → 0~15 인덱스. 범위 밖이면 -1이다.
export function albumSlotIndex(slot) {
  const n = Number(String(slot == null ? '' : slot).replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < ALBUM.slots ? n : -1;
}

// 캡션 한 줄로 다듬는다. 줄바꿈은 공백으로 접고 15자에서 자른다(§5 금지 4c 단일 원천).
export function clampCaption(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.slice(0, ALBUM.caption.maxChars);
}

// 빈 앨범 = null 16개. getAlbum()의 기본 반환 모양과 같다.
export function emptyAlbum() {
  const out = [];
  for (let i = 0; i < ALBUM.slots; i += 1) out.push(null);
  return out;
}

// 내려받기 파일명. fourcut.js의 fileNameFor와 같은 조립식이되 접두사만 다르다.
export function albumFileNameFor(groupNo) {
  const d = new Date();
  const p = function (n) { return ('0' + n).slice(-2); };
  return 'album-' + Number(groupNo) + '모둠-' +
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.jpg';
}

// ── 좌표 계산 ─────────────────────────────────────────────────────────────
// 칸 n(0~15)의 왼쪽 위 좌표. 좌표를 쓰는 자리는 전부 이 함수를 지난다(F-1).
export function albumCellBox(n) {
  const c = ALBUM.canvas;
  const col = n % ALBUM.cols;
  const row = Math.floor(n / ALBUM.cols);
  return {
    x: c.margin + col * (c.cellW + c.colGap),
    y: c.header + row * (c.cellH + c.rowGap),
    w: c.cellW,
    h: c.cellH
  };
}

function formatAlbumDate(value) {
  const d = value instanceof Date ? value : new Date();
  if (isNaN(d.getTime())) return '';
  const p = function (n) { return ('0' + n).slice(-2); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ── 그리기 조각 ───────────────────────────────────────────────────────────
function drawHeader(ctx, options) {
  const c = ALBUM.canvas;
  const opt = options || {};
  const cx = c.width / 2;

  ctx.textAlign = 'center';
  ctx.fillStyle = ALBUM.color.ink;
  ctx.font = '600 52px ' + ALBUM.font.serif;
  ctx.fillText(opt.title || ALBUM.text.sectionTitle, cx, 82, c.width - c.margin * 2);

  const parts = [];
  if (opt.groupNo !== undefined && opt.groupNo !== null && String(opt.groupNo).trim() !== '') {
    parts.push(Number(String(opt.groupNo).replace(/[^0-9]/g, '')) + '모둠');
  }
  const dateText = opt.dateText || formatAlbumDate(opt.date);
  if (dateText) parts.push(dateText);
  if (parts.length) {
    ctx.fillStyle = ALBUM.color.inkWeak;
    ctx.font = '26px ' + ALBUM.font.sans;
    ctx.fillText(parts.join('  ·  '), cx, 122, c.width - c.margin * 2);
  }

  // 제목 아래 이중선 — style.css .app-header의 3px double과 같은 인상.
  ctx.fillStyle = ALBUM.color.line;
  ctx.fillRect(c.margin, 145, c.width - c.margin * 2, 2);
  ctx.fillRect(c.margin, 150, c.width - c.margin * 2, 2);
}

// 칸별 미세 기울기. 좌표 박스는 두고 중심을 기준으로 그리기만 회전한다.
function rotateAlbumCell(ctx, box, n) {
  const turns = [-0.014, 0.011, -0.019, 0.016];
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  ctx.translate(cx, cy);
  ctx.rotate(turns[n % turns.length]);
  ctx.translate(-cx, -cy);
}

// 실제 사진첩의 대지 종이 + 짧고 부드러운 아래 그림자 + 얰은 종이 결.
function drawCellPaper(ctx, box, filled) {
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.shadowColor = ALBUM.color.ink;
  ctx.shadowBlur = 14;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 7;
  ctx.fillStyle = filled ? ALBUM.color.cell : ALBUM.color.cellEmpty;
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.restore();

  const paper = ctx.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
  paper.addColorStop(0, ALBUM.color.cell);
  paper.addColorStop(0.58, filled ? ALBUM.color.cell : ALBUM.color.cellEmpty);
  paper.addColorStop(1, ALBUM.color.cellEmpty);
  ctx.fillStyle = paper;
  ctx.fillRect(box.x, box.y, box.w, box.h);

  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = ALBUM.color.line;
  ctx.lineWidth = 1;
  for (let y = box.y + 8; y < box.y + box.h; y += 12) {
    ctx.beginPath();
    ctx.moveTo(box.x + 1, y + 0.5);
    ctx.lineTo(box.x + box.w - 1, y + 0.5);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = ALBUM.color.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
}

// 빈 칸 — 점선 테두리 + 옅은 종이색 + 안내 문면(§3-0 ⑼ ②).
// ⚠ 빈 칸은 **상태가 아니다**. statusText()에 넣지 않는다(P-검토 B-6 — 「잠금」이 뜬다).
function drawEmptyPhoto(ctx, box) {
  const c = ALBUM.canvas;
  const inset = 14;
  ctx.save();
  ctx.strokeStyle = ALBUM.color.line;
  ctx.lineWidth = 2;
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([10, 8]);
  ctx.strokeRect(box.x + inset, box.y + inset, box.w - inset * 2, c.photoH - inset * 2);
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.fillStyle = ALBUM.color.inkWeak;
  ctx.font = '24px ' + ALBUM.font.sans;
  ctx.fillText(ALBUM.text.emptyCell, box.x + box.w / 2, box.y + c.photoH / 2 + 8, box.w - inset * 4);
}

// 사진 1장을 칸에 채운다(cover — 여백 없이). 사각형 계산은 fourcut.js의 cellRect다.
function drawPhoto(ctx, box, source) {
  const c = ALBUM.canvas;
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const cell = { w: c.photoW, h: c.photoH };
  const rect = cellRect(sw, sh, { mode: 'cover', scale: 1, offsetX: 0, offsetY: 0 }, cell);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, c.photoW, c.photoH);
  ctx.clip();
  ctx.drawImage(source, box.x + rect.left, box.y + rect.top, rect.w, rect.h);
  ctx.restore();
}

// 사진을 꽂은 네 모서리의 작은 삼각 포토코너.
function drawPhotoCorners(ctx, box) {
  const c = ALBUM.canvas;
  const size = 28;
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + c.photoW;
  const y1 = box.y + c.photoH;
  const corners = [
    [[x0, y0], [x0 + size, y0], [x0, y0 + size]],
    [[x1, y0], [x1 - size, y0], [x1, y0 + size]],
    [[x0, y1], [x0 + size, y1], [x0, y1 - size]],
    [[x1, y1], [x1 - size, y1], [x1, y1 - size]]
  ];

  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.fillStyle = ALBUM.color.gold;
  corners.forEach(function (points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    ctx.lineTo(points[1][0], points[1][1]);
    ctx.lineTo(points[2][0], points[2][1]);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();
}

// 캡션 띠 — 시스템 세리프 이탤릭 + 방명록처럼 가는 밑줄 한 줄.
function drawCaption(ctx, box, caption) {
  const c = ALBUM.canvas;
  const text = clampCaption(caption);
  const bandTop = box.y + c.photoH;
  ctx.save();
  ctx.globalAlpha = 0.62;
  ctx.strokeStyle = ALBUM.color.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(box.x + 22, bandTop + c.captionBand - 13.5);
  ctx.lineTo(box.x + box.w - 22, bandTop + c.captionBand - 13.5);
  ctx.stroke();
  ctx.restore();
  if (!text) return;
  ctx.textAlign = 'center';
  ctx.fillStyle = ALBUM.color.inkWeak;
  ctx.font = 'italic ' + ALBUM.caption.fontPx + 'px ' + ALBUM.font.serif;
  ctx.fillText(text, box.x + box.w / 2, bandTop + c.captionBand / 2 + 8, box.w - 28);
}

// 펼친 앨범 페이지 바탕: 종이색 그라데이션, 얰은 결, 좌측 제본선.
function drawAlbumPage(ctx) {
  const c = ALBUM.canvas;
  const page = ctx.createLinearGradient(0, 0, c.width, c.height);
  page.addColorStop(0, ALBUM.color.cellEmpty);
  page.addColorStop(0.48, ALBUM.color.paper);
  page.addColorStop(1, ALBUM.color.cellEmpty);
  ctx.fillStyle = page;
  ctx.fillRect(0, 0, c.width, c.height);

  ctx.save();
  ctx.globalAlpha = 0.11;
  ctx.strokeStyle = ALBUM.color.line;
  ctx.lineWidth = 1;
  for (let y = 4; y < c.height; y += 9) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(c.width, y + 0.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.42;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(25, 24);
  ctx.lineTo(25, c.height - 24);
  ctx.moveTo(33, 24);
  ctx.lineTo(33, c.height - 24);
  ctx.stroke();
  ctx.restore();
}

// ── 합성 ──────────────────────────────────────────────────────────────────
/**
 * 앨범 16칸을 빈티지 틀에 합성해 한 장 이미지로 만든다.
 *
 * @param {Array<{b64:string, mime:string, caption:string}|null>} slots
 *        길이 16 배열. 인덱스 = slot 번호. 빈 칸은 null이다(getAlbum()의 반환 모양 그대로).
 *        길이가 다르면 앞에서부터 16칸으로 맞춘다(모자라면 빈 칸).
 * @param {{groupNo?:string|number, date?:Date, dateText?:string, title?:string}} [options]
 *        제목 영역에 찍을 값. 전부 선택이며 없으면 제목만 그린다.
 * @returns {{blob:Blob, width:number, height:number}}
 *
 * 슬롯 1장이 깨져 디코드에 실패하면 그 칸만 빈 칸으로 그리고 합성은 계속한다 —
 * 16장 중 1장 때문에 앨범을 통째로 못 내려받는 것이 더 나쁜 결과다(composeFourcut의
 * loadAsset이 자산 1장 실패를 건너뛰는 것과 같은 판단). 캔버스·Blob 실패는 던진다.
 */
export async function composeAlbum(slots, options) {
  const c = ALBUM.canvas;
  const list = Array.isArray(slots) ? slots : [];
  let canvas = null;

  try {
    canvas = document.createElement('canvas');
    canvas.width = c.width;
    canvas.height = c.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(ALBUM.text.composeError);

    // ⑴ 바탕 종이
    drawAlbumPage(ctx);

    // ⑵ 제목 영역
    drawHeader(ctx, options);

    // ⑶ 칸 16개 — **한 장씩** 디코드 → 그리기 → 즉시 해제(메모리 계약).
    for (let n = 0; n < ALBUM.slots; n += 1) {
      const box = albumCellBox(n);
      const item = list[n] || null;
      const hasPhoto = !!(item && item.b64);

      ctx.save();
      rotateAlbumCell(ctx, box, n);
      try {
        drawCellPaper(ctx, box, hasPhoto);

        if (!hasPhoto) {
          drawEmptyPhoto(ctx, box);
        } else {
          let decoded = null;
          try {
            decoded = await decodeBase64(item.b64, item.mime);
            drawPhoto(ctx, box, decoded.source);
            drawPhotoCorners(ctx, box);
          } catch (e) {
            drawEmptyPhoto(ctx, box);
          } finally {
            // 다음 슬롯을 디코드하기 **전에** 해제한다 — 동시 보유는 언제나 1장이다.
            if (decoded) {
              if (decoded.source && typeof decoded.source.close === 'function') decoded.source.close();
              if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
            }
          }
        }

        drawCaption(ctx, box, item ? item.caption : '');
      } finally {
        ctx.restore();
      }
    }

    const blob = await toBlobAsync(canvas, ALBUM.output.mime, ALBUM.output.quality);
    if (!blob) throw new Error(ALBUM.text.composeError);
    return { blob: blob, width: c.width, height: c.height };
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
