// fourcut.js — 인생네컷 합성.
// 설계지시안 v3.1 §2-10 / §1-3 「네컷 캔버스」 / 확정 11·16·18 + v3.2 확정 24 적용.
//
// 규칙
//   · 캔버스는 720 × 2280 고정. 셀은 640 × 480 네 칸, 코스(장소) 순 오름차순.
//   · 셀마다 자를 범위를 학생이 정한다 — 채우기 모드(cover/contain) + 배율 + 이동(확정 24).
//     조정값은 그 세션의 합성에만 쓰고 서버에 저장하지 않는다(확정 24-⑷ · §5 금지 18).
//   · 「전체 담기(contain)」의 여백은 같은 사진을 크게 확대해 흐리게 깐 배경으로 채운다.
//     흐림은 **축소 → 확대 재그리기**가 기본 경로이고, `ctx.filter`는 지원될 때만 덧붙이는
//     보강이다(§5 금지 17 — iOS Safari의 캔버스 필터 지원이 버전에 따라 갈린다).
//   · 결과 toBlob이 null이거나 예외면 정상 오류로 처리한다(문구 + 재생성 버튼).
//     마지막으로 성공한 미리보기·Blob은 유지한다 — 저장 3버튼의 공통 단일 실패점을 없앤다.
//   · 입력 비트맵 4장도 finally에서 해제한다(bitmap.close · 임시 canvas 0×0 · objectURL revoke).
//
// v3.3 확정 28·29 추가
//   · 캔버스 크기와 칸 좌표는 **프레임이 가리키는 좌표판**에서 나온다(frames.js LAYOUTS).
//     이 파일에 720·2280·4칸 좌표를 다시 적지 않는다.
//   · 그리기 순서는 배경색 → 배경 이미지 → 칸 → 강조선 → 문구 → 오버레이 이미지 고정이다.
//     오버레이가 마지막이라 기성 프레임 PNG의 테두리·장식이 사진 위에 얹힌다.
//   · 오버레이는 투명을 보존해야 하므로 이 파일에서도 JPEG로 다시 인코딩하지 않는다(§5 금지 22).

import {
  LAYOUT, cellTop, frameById, DEFAULT_FRAME_TEXTS,
  frameLayoutOf, cellBoxOf
} from '../frames/frames.js';

export const OUTPUT = {
  mime: 'image/jpeg',
  quality: 0.92,
  width: LAYOUT.width,
  height: LAYOUT.height
};

export const COMPOSE_ERROR_TEXT = '네컷 이미지를 만들지 못했습니다. 다시 만들기를 눌러 주세요';

// ── 셀 조정 (확정 24) ─────────────────────────────────────────────────────
// 셀 좌표계는 640 × 480 하나뿐이다. 미리보기 화면과 합성 캔버스가 **같은 함수**로
// 사각형을 계산하므로 화면에서 본 범위가 그대로 산출물이 된다(F-1 단일 원천).
// 기본 좌표판(vertical4)의 칸 크기. 하위호환용 상수이며, 좌표판이 다른 프레임에서는
// cellRect의 4번째 인자로 그 프레임의 칸 크기를 넘긴다(§5 금지 23 — 이름·시그니처 보존).
export const CELL = { w: LAYOUT.cellW, h: LAYOUT.cellH };

export const ADJUST = {
  minScale: 1,
  maxScale: 3,
  scaleStep: 0.05,
  modes: ['cover', 'contain']
};

function num(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : dflt;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// 셀을 꽉 채우는 배율 / 셀 안에 전부 들어가는 배율. cell을 생략하면 기본 좌표판의 칸이다.
export function coverScale(sw, sh, cell) {
  const box = cell && cell.w && cell.h ? cell : CELL;
  return Math.max(box.w / sw, box.h / sh);
}
export function containScale(sw, sh, cell) {
  const box = cell && cell.w && cell.h ? cell : CELL;
  return Math.min(box.w / sw, box.h / sh);
}

// 실픽셀이 셀(640×480)보다 작아 **확대가 필요하면** 「전체 담기」를 기본값으로 연다(확정 24-⑶).
// 늘려 채우면 화질이 뭉개지고, 잘라 채우면 작은 사진이 더 잘린다.
export function defaultFillMode(sw, sh, cell) {
  return coverScale(sw, sh, cell) > 1 ? 'contain' : 'cover';
}

// 한 셀의 조정 초기값 — 가운데 맞춤, 배율 1배(확정 24-⑴).
export function newAdjust(sw, sh, cell) {
  return { mode: defaultFillMode(sw, sh, cell), scale: 1, offsetX: 0, offsetY: 0 };
}

/**
 * 셀 좌표계에서 사진을 그릴 사각형을 계산한다.
 * 이동량은 사진이 셀 밖으로 달아나지 않도록 잘라 낸다(잘라 낸 값도 함께 돌려준다).
 * @param {{w:number,h:number}} [cell] 이 칸의 크기. 생략하면 기본 좌표판의 640 × 480이다
 *        (§5 금지 23 — 기존 호출부·검사가 3인자로 부른다).
 * @returns {{mode:string, scale:number, w:number, h:number, left:number, top:number,
 *            maxX:number, maxY:number, offsetX:number, offsetY:number}}
 */
export function cellRect(sw, sh, adjust, cell) {
  const a = adjust || {};
  const box = cell && cell.w && cell.h ? cell : CELL;
  const mode = a.mode === 'contain' ? 'contain' : 'cover';
  const base = mode === 'contain' ? containScale(sw, sh, box) : coverScale(sw, sh, box);
  const scale = clamp(num(a.scale, 1), ADJUST.minScale, ADJUST.maxScale);
  const w = sw * base * scale;
  const h = sh * base * scale;
  const maxX = Math.abs(w - box.w) / 2;
  const maxY = Math.abs(h - box.h) / 2;
  const offsetX = clamp(num(a.offsetX, 0), -maxX, maxX);
  const offsetY = clamp(num(a.offsetY, 0), -maxY, maxY);
  return {
    mode: mode, scale: scale, w: w, h: h,
    left: (box.w - w) / 2 + offsetX,
    top: (box.h - h) / 2 + offsetY,
    maxX: maxX, maxY: maxY, offsetX: offsetX, offsetY: offsetY
  };
}

// ── 흐린 배경 (확정 24-⑵ · §5 금지 17) ────────────────────────────────────
// 기본 경로: 작은 오프스크린 캔버스에 셀 비율로 **축소**해 그린 뒤 셀 크기로 **확대**해
// 되그린다. 축소에서 픽셀이 평균되고 확대에서 스무딩이 번지므로, 캔버스 필터가 없는
// 브라우저에서도 흐린 배경이 실제로 그려진다. `ctx.filter`는 그 위에 얹는 보강일 뿐이다.
export const BLUR_BG = { smallW: 24, smallH: 18, filterPx: 20, overscan: 0.08 };

// 필터 지원 여부는 대입 후 되읽어서 판정한다(미지원 브라우저는 대입이 먹지 않는다).
export function canvasFilterSupported(ctx) {
  try {
    const before = ctx.filter;
    ctx.filter = 'blur(2px)';
    const ok = ctx.filter === 'blur(2px)';
    ctx.filter = before || 'none';
    return ok;
  } catch (e) {
    return false;
  }
}

// 셀을 꽉 채우도록 가운데 잘라 그린다(cover). 축소·확대 양쪽에서 쓴다.
function drawCoverInto(ctx, source, sx, sy, dw, dh) {
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const scale = Math.max(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, sx + (dw - w) / 2, sy + (dh - h) / 2, w, h);
}

/**
 * 셀 영역에 같은 사진의 흐린 확대본을 깐다.
 * @param {object} options {useFilter:false}를 주면 `ctx.filter` 보강을 끄고
 *                 축소→확대 경로만 단독 실행한다(미지원 환경 검사용).
 * @returns {{path:string, filterUsed:boolean}}
 */
export function drawBlurredBackground(ctx, source, x, y, dw, dh, options) {
  const opt = options || {};
  // ⑴ 축소 — 여기서 정보가 사라지는 것이 흐림의 원천이다.
  const small = document.createElement('canvas');
  small.width = BLUR_BG.smallW;
  small.height = BLUR_BG.smallH;
  const sctx = small.getContext('2d');
  if (!sctx) throw new Error(COMPOSE_ERROR_TEXT);
  sctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in sctx) sctx.imageSmoothingQuality = 'high';
  drawCoverInto(sctx, source, 0, 0, BLUR_BG.smallW, BLUR_BG.smallH);

  // ⑵ 확대 — 스무딩을 켜 둔 채 셀보다 조금 크게 그린다(가장자리 비는 것 방지).
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  // ⑶ 보강 — 지원될 때만 캔버스 필터를 덧붙인다. 없어도 ⑴⑵로 이미 흐리다.
  const useFilter = opt.useFilter === false ? false : canvasFilterSupported(ctx);
  if (useFilter) {
    try { ctx.filter = 'blur(' + BLUR_BG.filterPx + 'px)'; } catch (e) { /* 무시 */ }
  }
  const over = BLUR_BG.overscan;
  ctx.drawImage(small, x - dw * over, y - dh * over, dw * (1 + over * 2), dh * (1 + over * 2));
  ctx.restore();

  small.width = 0;
  small.height = 0;
  return { path: 'downscale-upscale', filterUsed: useFilter };
}

export function toBlobAsync(canvas, mime, quality) {
  return new Promise(function (resolve) {
    canvas.toBlob(function (b) { resolve(b); }, mime, quality);
  });
}

// 순수 base64 → 디코드된 비트맵. createImageBitmap 우선, Image 폴백.
export async function decodeBase64(b64, mime) {
  const dataUrl = 'data:' + (mime || 'image/jpeg') + ';base64,' + b64;
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, objectUrl: null };
    } catch (e) {
      // 폴백으로 넘어간다.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise(function (resolve, reject) {
      const i = new Image();
      i.onload = function () { resolve(i); };
      i.onerror = function () { reject(new Error(COMPOSE_ERROR_TEXT)); };
      i.src = url;
    });
    return { source: img, objectUrl: url };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(COMPOSE_ERROR_TEXT);
  }
}

/**
 * 사진 4장을 프레임에 합성한다.
 * @param {Array<{locIndex:number, full:string, mime:string, name:string}>} photos 정확히 4장, locIndex 오름차순
 * @param {string} frameId frames.js의 프레임 ID
 * @param {{top:string, bottom:string}} texts 상·하단 문구
 * @param {Array<{mode:string, scale:number, offsetX:number, offsetY:number}>} adjusts
 *        셀별 조정값(확정 24). 없거나 빈 자리는 그 사진의 자동 기본값(가운데 맞춤)으로 채운다.
 * @param {object} options 부가 설정 — 시그니처는 바꾸지 않는다(§5 금지 23)
 *        · useFilter:false  흐린 배경의 `ctx.filter` 보강을 끈다(검사용)
 *        · layoutId         교사가 고른 좌표판. 프레임 기본값을 이긴다(확정 29-⑷)
 *        · hideTexts        문구를 그리지 않는다. 문구가 이미 그려진 기성 프레임용(확정 28-⑶)
 *        · assets           {background:{b64,mime}, overlay:{b64,mime}} 관리 화면에서 올린 이미지
 * @returns {{blob:Blob, dataUrl:string, width:number, height:number, cells:Array, assetsUsed:Array}}
 */
export async function composeFourcut(photos, frameId, texts, adjusts, options) {
  if (!Array.isArray(photos) || photos.length !== LAYOUT.cells) {
    throw new Error('사진 ' + LAYOUT.cells + '장을 골라 주세요');
  }
  const locSet = new Set(photos.map(function (p) { return p.locIndex; }));
  if (locSet.size !== LAYOUT.cells) {
    throw new Error('서로 다른 장소 ' + LAYOUT.cells + '곳의 사진을 골라 주세요');
  }

  const frame = frameById(frameId);
  // 빈 문자열도 폴백 대상이다(A-6). Object.assign은 키가 있기만 하면 기본값을 ''로 덮어써서
  // 문구 없는 네컷이 나온다 — config 문서가 없거나 문구를 지운 상태가 정확히 그 경우다.
  // 기본값의 원천은 frames.js 하나이며, admin.html도 같은 방식으로 폴백한다.
  const t = {
    top: ((texts && texts.top) || '').trim() ? texts.top : DEFAULT_FRAME_TEXTS.top,
    bottom: ((texts && texts.bottom) || '').trim() ? texts.bottom : DEFAULT_FRAME_TEXTS.bottom
  };
  // 캔버스 크기·칸 좌표·문구 기준선의 원천은 좌표판 하나다(확정 29-⑸).
  const layout = frameLayoutOf(frame, options);
  const assets = (options && options.assets) || {};
  const hideTexts = !!(options && options.hideTexts);
  const decoded = [];
  const assetDecoded = [];   // 배경·오버레이 비트맵. finally에서 함께 해제한다.
  const assetsUsed = [];
  const usedCells = [];      // 실제로 쓰인 셀별 조정값(계측·검사용). 서버에 저장하지 않는다.
  let canvas = null;

  // 자산 1장을 디코드한다. 못 읽으면 **합성을 실패시키지 않고 건너뛴다** — 프레임 이미지가
  // 없는 것은 색 프레임으로 계속 갈 수 있는 상태이고, 여기서 던지면 학생이 네컷을 못 만든다.
  const loadAsset = async function (kind) {
    const a = assets[kind];
    if (!a || !a.b64) return null;
    try {
      const d = await decodeBase64(a.b64, a.mime);
      assetDecoded.push(d);
      assetsUsed.push(kind);
      return d.source;
    } catch (e) {
      return null;
    }
  };

  try {
    for (const p of photos) {
      decoded.push(await decodeBase64(p.full, p.mime));
    }

    canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(COMPOSE_ERROR_TEXT);

    // ⑴ 배경색 — 자산이 없거나 못 읽혔을 때 이것이 최종 배경이다.
    ctx.fillStyle = frame.background;
    ctx.fillRect(0, 0, layout.width, layout.height);

    // ⑵ 배경 이미지 — 캔버스 전체를 cover로 덮는다(확정 28-⑴).
    const bgSource = await loadAsset('background');
    if (bgSource) drawCoverInto(ctx, bgSource, 0, 0, layout.width, layout.height);

    // ⑶ 칸 4개 — 좌표는 좌표판에서 온다. 칸마다 크기가 달라도 같은 코드가 돈다.
    for (let n = 0; n < layout.cells.length; n += 1) {
      const box = cellBoxOf(frame, options, n);
      const x = box.x;
      const y = box.y;
      const src = decoded[n].source;
      const sw = src.width || src.naturalWidth;
      const sh = src.height || src.naturalHeight;
      // 조정값이 없으면 그 사진의 자동 기본값(확정 24-⑴·⑶)으로 그린다.
      const rect = cellRect(sw, sh, (adjusts && adjusts[n]) || newAdjust(sw, sh, box), box);
      ctx.save();
      ctx.fillStyle = frame.cellBackground;
      ctx.fillRect(x, y, box.w, box.h);
      ctx.beginPath();
      ctx.rect(x, y, box.w, box.h);
      ctx.clip();
      // 「전체 담기」의 남는 여백은 같은 사진의 흐린 확대본으로 채운다(확정 24-⑵).
      if (rect.mode === 'contain') {
        drawBlurredBackground(ctx, src, x, y, box.w, box.h, options);
      }
      ctx.drawImage(src, x + rect.left, y + rect.top, rect.w, rect.h);
      ctx.restore();
      if (frame.cellBorderWidth > 0) {
        ctx.strokeStyle = frame.cellBorder;
        ctx.lineWidth = frame.cellBorderWidth;
        ctx.strokeRect(x, y, box.w, box.h);
      }
      usedCells.push({
        locIndex: photos[n].locIndex, sourceW: sw, sourceH: sh,
        mode: rect.mode, scale: rect.scale,
        offsetX: rect.offsetX, offsetY: rect.offsetY
      });
    }

    // ⑷ 강조선 — 두께 0이면 그리지 않는다(업로드 프레임의 기본값).
    if (frame.accent && frame.accent.height > 0) {
      ctx.fillStyle = frame.accent.color;
      ctx.fillRect(layout.accent.x, layout.accent.y, layout.accent.w, frame.accent.height);
    }

    // ⑸ 문구 — 위치는 좌표판, 색·크기는 프레임. 기성 프레임에 문구가 이미 있으면 건너뛴다.
    if (!hideTexts) {
      ctx.textAlign = layout.topText.align;
      ctx.fillStyle = frame.topText.color;
      ctx.font = frame.topText.weight + ' ' + frame.topText.size + 'px system-ui, sans-serif';
      ctx.fillText(t.top, layout.topText.x, layout.topText.baseline, layout.topText.maxWidth);

      ctx.textAlign = layout.bottomText.align;
      ctx.fillStyle = frame.bottomText.color;
      ctx.font = frame.bottomText.weight + ' ' + frame.bottomText.size + 'px system-ui, sans-serif';
      ctx.fillText(t.bottom, layout.bottomText.x, layout.bottomText.baseline, layout.bottomText.maxWidth);
    }

    // ⑹ 오버레이 이미지 — 마지막이다. 투명 구멍으로 사진이 보인다(확정 28-⑵).
    //    투명을 지켜야 하므로 여기서 다시 인코딩하지 않고 그대로 얹는다(§5 금지 22).
    const overlaySource = await loadAsset('overlay');
    if (overlaySource) ctx.drawImage(overlaySource, 0, 0, layout.width, layout.height);

    const blob = await toBlobAsync(canvas, OUTPUT.mime, OUTPUT.quality);
    if (!blob) throw new Error(COMPOSE_ERROR_TEXT);
    const dataUrl = canvas.toDataURL(OUTPUT.mime, OUTPUT.quality);

    return {
      blob: blob, dataUrl: dataUrl,
      width: layout.width, height: layout.height,
      layoutId: layout.id,
      cells: usedCells,
      assetsUsed: assetsUsed
    };
  } finally {
    // 입력 비트맵 4장 + 임시 캔버스를 성공·실패와 무관하게 해제한다.
    decoded.concat(assetDecoded).forEach(function (d) {
      if (d.source && typeof d.source.close === 'function') d.source.close();
      if (d.objectUrl) URL.revokeObjectURL(d.objectUrl);
    });
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export function fileNameFor(groupNo) {
  const d = new Date();
  const p = function (n) { return ('0' + n).slice(-2); };
  return 'fourcut-' + Number(groupNo) + '모둠-' +
    d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.jpg';
}
