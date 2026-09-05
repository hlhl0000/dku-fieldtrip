// compress.js — 사진 압축 파이프라인.
// 설계지시안 v3.1 §1-3 「압축 루프」 / §2-9 / §5 금지 4 적용.
//
// 규칙
//   · 성공적으로 디코드된 이미지만 EXIF 방향을 반영해 JPEG로 재인코딩한다.
//   · 해상도 단계(1600 → 1280 → 1024)마다 품질 0.85 → 0.5(0.05 단계) 루프를 재시작한다.
//   · 전 단계에서 상한을 못 맞추면 정상 오류로 끝낸다(빈 화면·무한 재시도 금지).
//   · finally에서 bitmap.close() · 임시 canvas 0×0 · objectURL revoke 를 반드시 실행한다.
//   · 결과는 data: 접두사 없는 순수 base64 + mime 별도 필드다.

export const COMPRESS = {
  maxSides: [1600, 1280, 1024],
  qualityStart: 0.85,
  qualityMin: 0.5,
  qualityStep: 0.05,
  thumbMaxSide: 240,
  thumbQualityStart: 0.8,
  thumbQualityMin: 0.35,
  fullMaxBytes: 900000,
  thumbMaxBytes: 20000,
  mime: 'image/jpeg'
};

export const DECODE_ERROR_TEXT = '이 사진을 읽지 못했습니다. 다른 사진을 선택하세요';
export const TOO_LARGE_TEXT = '사진을 충분히 줄이지 못했습니다. 다른 사진을 선택하세요';

// Blob → 순수 base64 문자열(data: 접두사 제거).
function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () {
      const s = String(reader.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = function () { reject(new Error(DECODE_ERROR_TEXT)); };
    reader.readAsDataURL(blob);
  });
}

function utf8Bytes(s) {
  return new TextEncoder().encode(s || '').length;
}

// createImageBitmap 우선, 실패하면 Image 폴백. 둘 다 실패하면 정상 오류.
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, objectUrl: null, width: bitmap.width, height: bitmap.height };
    } catch (e) {
      // 폴백으로 넘어간다.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise(function (resolve, reject) {
      const i = new Image();
      i.onload = function () { resolve(i); };
      i.onerror = function () { reject(new Error(DECODE_ERROR_TEXT)); };
      i.src = url;
    });
    return { source: img, objectUrl: url, width: img.naturalWidth, height: img.naturalHeight };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(DECODE_ERROR_TEXT);
  }
}

function scaledSize(w, h, maxSide) {
  const longSide = Math.max(w, h);
  if (longSide <= maxSide) return { w: w, h: h };
  const k = maxSide / longSide;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

function toBlobAsync(canvas, mime, quality) {
  return new Promise(function (resolve) {
    canvas.toBlob(function (blob) { resolve(blob); }, mime, quality);
  });
}

// 캔버스 하나를 특정 해상도로 그려 두고 품질을 낮춰 가며 상한을 맞춘다.
async function encodeUnder(canvas, ctx, source, w, h, qStart, qMin, step, maxBytes) {
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const attempts = [];
  for (let q = qStart; q >= qMin - 1e-9; q -= step) {
    const quality = Math.round(q * 100) / 100;
    const blob = await toBlobAsync(canvas, COMPRESS.mime, quality);
    if (!blob) throw new Error(DECODE_ERROR_TEXT);
    const b64 = await blobToBase64(blob);
    const bytes = utf8Bytes(b64);
    attempts.push({ w: w, h: h, quality: quality, bytes: bytes });
    if (bytes <= maxBytes) {
      return { b64: b64, bytes: bytes, quality: quality, width: w, height: h, attempts: attempts };
    }
  }
  return { b64: null, attempts: attempts };
}

/**
 * 사진 1장을 업로드용 full/thumb base64로 압축한다.
 * @param {File|Blob} file 사용자가 고른 원본
 * @param {(text:string)=>void} [onStage] 진행 문구 콜백
 * @returns {{full:string, thumb:string, mime:string, fullBytes:number, thumbBytes:number,
 *            width:number, height:number, quality:number, maxSide:number,
 *            sourceWidth:number, sourceHeight:number, attempts:Array}}
 */
export async function compressPhoto(file, onStage) {
  let decoded = null;
  let canvas = null;
  let ctx = null;
  try {
    if (onStage) onStage('사진을 읽는 중');
    decoded = await decodeImage(file);

    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(DECODE_ERROR_TEXT);

    let full = null;
    const allAttempts = [];
    for (const maxSide of COMPRESS.maxSides) {
      if (onStage) onStage('사진을 줄이는 중 (' + maxSide + 'px)');
      const size = scaledSize(decoded.width, decoded.height, maxSide);
      const r = await encodeUnder(
        canvas, ctx, decoded.source, size.w, size.h,
        COMPRESS.qualityStart, COMPRESS.qualityMin, COMPRESS.qualityStep, COMPRESS.fullMaxBytes
      );
      allAttempts.push.apply(allAttempts, r.attempts);
      if (r.b64) { full = Object.assign({ maxSide: maxSide }, r); break; }
    }
    if (!full) throw new Error(TOO_LARGE_TEXT);

    if (onStage) onStage('미리보기를 만드는 중');
    const tSize = scaledSize(decoded.width, decoded.height, COMPRESS.thumbMaxSide);
    const thumb = await encodeUnder(
      canvas, ctx, decoded.source, tSize.w, tSize.h,
      COMPRESS.thumbQualityStart, COMPRESS.thumbQualityMin, COMPRESS.qualityStep, COMPRESS.thumbMaxBytes
    );
    allAttempts.push.apply(allAttempts, thumb.attempts);
    if (!thumb.b64) throw new Error(TOO_LARGE_TEXT);

    return {
      full: full.b64,
      thumb: thumb.b64,
      mime: COMPRESS.mime,
      fullBytes: full.bytes,
      thumbBytes: thumb.bytes,
      width: full.width,
      height: full.height,
      quality: full.quality,
      maxSide: full.maxSide,
      sourceWidth: decoded.width,
      sourceHeight: decoded.height,
      attempts: allAttempts
    };
  } finally {
    // 메모리 해제 계약 — 성공·실패와 무관하게 실행한다.
    if (decoded) {
      if (decoded.source && typeof decoded.source.close === 'function') decoded.source.close();
      if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

// ── 앨범 사진 압축 (여행앨범 §3-0 ⑸) ──────────────────────────────────────
// 미션 사진과 다른 점 두 가지
//   ⑴ **썸네일이 없다.** 확대 보기가 없고 원본 화질이 불필요하므로 250KB 한 장이
//      표시·합성 양쪽을 겸한다(§5 금지 5 — 앨범 문서에 썸네일 필드를 두지 않는다).
//   ⑵ 상한이 250KB이고 해상도 단계가 [800, 640]이다. 합성 칸이 340px이라 800px이면
//      2.35배 여유이고, 1024px 16장 동시 보유(≈50MB)를 피한다(P-검토 A-4).
// 압축 루프 자체는 위 `encodeUnder` **그대로**를 쓴다 — 복제하지 않는다(F-4).
//
// ⚠ mime을 ALBUM_COMPRESS에 두지 않는다(P-검토 B-1): `encodeUnder`가 `COMPRESS.mime`을
//   하드코딩하므로 앨범용 mime 상수는 죽은 값이 되어 단일 원천을 참칭한다.
//   **인코딩 mime은 `COMPRESS.mime` 하나다.**
export const ALBUM_COMPRESS = {
  maxSides: [800, 640],
  qualityStart: 0.8,
  qualityMin: 0.5,
  qualityStep: 0.05,
  maxBytes: 250000          // base64 문자열의 UTF-8 바이트 기준(= 팽창 후 값).
};

/**
 * 앨범 사진 1장을 업로드용 base64로 압축한다. 썸네일은 만들지 않는다.
 * @param {File|Blob} file 사용자가 고른 원본
 * @param {(text:string)=>void} [onStage] 진행 문구 콜백
 * @returns {{b64:string, mime:string, bytes:number, width:number, height:number,
 *            quality:number, maxSide:number, sourceWidth:number, sourceHeight:number,
 *            attempts:Array}}
 */
export async function compressAlbumPhoto(file, onStage) {
  let decoded = null;
  let canvas = null;
  let ctx = null;
  try {
    if (onStage) onStage('사진을 읽는 중');
    decoded = await decodeImage(file);

    canvas = document.createElement('canvas');
    ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(DECODE_ERROR_TEXT);

    const allAttempts = [];
    for (const maxSide of ALBUM_COMPRESS.maxSides) {
      if (onStage) onStage('사진을 줄이는 중 (' + maxSide + 'px)');
      const size = scaledSize(decoded.width, decoded.height, maxSide);
      const r = await encodeUnder(
        canvas, ctx, decoded.source, size.w, size.h,
        ALBUM_COMPRESS.qualityStart, ALBUM_COMPRESS.qualityMin,
        ALBUM_COMPRESS.qualityStep, ALBUM_COMPRESS.maxBytes
      );
      allAttempts.push.apply(allAttempts, r.attempts);
      if (r.b64) {
        return {
          b64: r.b64,
          mime: COMPRESS.mime,
          bytes: r.bytes,
          width: r.width,
          height: r.height,
          quality: r.quality,
          maxSide: maxSide,
          sourceWidth: decoded.width,
          sourceHeight: decoded.height,
          attempts: allAttempts
        };
      }
    }
    throw new Error(TOO_LARGE_TEXT);
  } finally {
    // 미션 사진 경로와 같은 해제 계약 — 성공·실패와 무관하게 실행한다.
    if (decoded) {
      if (decoded.source && typeof decoded.source.close === 'function') decoded.source.close();
      if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

// ── 프레임 이미지 압축 (v3.3 확정 27·28 · §5 금지 22) ─────────────────────
// 사진과 다른 점 두 가지
//   ⑴ 목표 크기가 **좌표판의 캔버스 크기**로 정해져 있다. 원본 비율이 달라도 그 크기로 맞춘다.
//   ⑵ 오버레이는 투명을 보존해야 하므로 **PNG**로 인코딩한다. PNG에는 품질 인자가 없어서
//      품질 루프 대신 **해상도 축소 루프**로 상한을 맞춘다. 여기서 JPEG를 쓰면 투명이
//      검정으로 채워져 프레임이 사진을 통째로 덮는다(§5 금지 22).
export const FRAME_ASSET = {
  maxBytes: 900000,                       // 문서 1개 = 이미지 1장. 사진과 같은 상한
  jpegQualityStart: 0.9,
  jpegQualityMin: 0.45,
  qualityStep: 0.05,
  pngScales: [1, 0.85, 0.7, 0.55, 0.45, 0.35],
  backgroundMime: 'image/jpeg',
  overlayMime: 'image/png'
};

export const FRAME_ASSET_TOO_LARGE_TEXT =
  '이 이미지를 충분히 줄이지 못했습니다. 더 단순하거나 작은 파일로 다시 시도하세요';

// 캔버스를 목표 크기로 두고 source를 그린다.
//   background = cover(잘라서 꽉 채움) · overlay = 캔버스에 정확히 맞춤(프레임 도안이므로)
// @param {string} [fillColor] 배경 슬롯에서 투명한 자리를 채울 색. 생략하면 흰색.
function drawFrameSource(ctx, source, kind, w, h, fillColor) {
  ctx.clearRect(0, 0, w, h);
  if (kind === 'overlay') {
    ctx.drawImage(source, 0, 0, w, h);
    return;
  }
  // 배경은 JPEG로 저장된다 — JPEG에는 투명이 없다. 아무 것도 깔지 않고 투명 PNG를 그리면
  // 투명한 자리가 **검정**이 되어(실측 0,0,0) 교사가 올린 그림이 검은 판 위에 뜬다.
  // 프레임의 배경색을 먼저 칠해 두면 색 프레임과 이어지는 모습으로 저장된다.
  ctx.fillStyle = fillColor || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const sw = source.width || source.naturalWidth;
  const sh = source.height || source.naturalHeight;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * 프레임 배경·오버레이 이미지 1장을 업로드용 base64로 만든다.
 * @param {File|Blob} file 교사가 고른 이미지
 * @param {'background'|'overlay'} kind 슬롯
 * @param {number} targetW 좌표판 캔버스 너비
 * @param {number} targetH 좌표판 캔버스 높이
 * @param {(text:string)=>void} [onStage] 진행 문구 콜백
 * @param {string} [fillColor] 배경 슬롯에서 투명한 자리를 채울 색(보통 프레임 배경색)
 * @returns {{b64:string, mime:string, bytes:number, width:number, height:number,
 *            sourceWidth:number, sourceHeight:number, attempts:Array}}
 */
export async function compressFrameAsset(file, kind, targetW, targetH, onStage, fillColor) {
  const isOverlay = kind === 'overlay';
  const mime = isOverlay ? FRAME_ASSET.overlayMime : FRAME_ASSET.backgroundMime;
  let decoded = null;
  let canvas = null;
  try {
    if (onStage) onStage('이미지를 읽는 중');
    decoded = await decodeImage(file);

    canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error(DECODE_ERROR_TEXT);

    const attempts = [];

    if (isOverlay) {
      // PNG — 품질 인자가 없다. 해상도를 단계로 낮춰 상한을 맞춘다.
      for (const k of FRAME_ASSET.pngScales) {
        const w = Math.max(1, Math.round(targetW * k));
        const h = Math.max(1, Math.round(targetH * k));
        if (onStage) onStage('프레임을 줄이는 중 (' + w + '×' + h + ')');
        canvas.width = w;
        canvas.height = h;
        drawFrameSource(ctx, decoded.source, kind, w, h, fillColor);
        const blob = await toBlobAsync(canvas, mime, undefined);
        if (!blob) throw new Error(DECODE_ERROR_TEXT);
        const b64 = await blobToBase64(blob);
        const bytes = utf8Bytes(b64);
        attempts.push({ w: w, h: h, quality: null, bytes: bytes });
        if (bytes <= FRAME_ASSET.maxBytes) {
          return {
            b64: b64, mime: mime, bytes: bytes, width: w, height: h,
            sourceWidth: decoded.width, sourceHeight: decoded.height, attempts: attempts
          };
        }
      }
      throw new Error(FRAME_ASSET_TOO_LARGE_TEXT);
    }

    // 배경 — JPEG 품질 루프. 캔버스 크기는 좌표판 그대로 둔다.
    canvas.width = targetW;
    canvas.height = targetH;
    drawFrameSource(ctx, decoded.source, kind, targetW, targetH, fillColor);
    for (let q = FRAME_ASSET.jpegQualityStart; q >= FRAME_ASSET.jpegQualityMin - 1e-9; q -= FRAME_ASSET.qualityStep) {
      const quality = Math.round(q * 100) / 100;
      if (onStage) onStage('배경을 줄이는 중 (품질 ' + quality + ')');
      const blob = await toBlobAsync(canvas, mime, quality);
      if (!blob) throw new Error(DECODE_ERROR_TEXT);
      const b64 = await blobToBase64(blob);
      const bytes = utf8Bytes(b64);
      attempts.push({ w: targetW, h: targetH, quality: quality, bytes: bytes });
      if (bytes <= FRAME_ASSET.maxBytes) {
        return {
          b64: b64, mime: mime, bytes: bytes, width: targetW, height: targetH,
          sourceWidth: decoded.width, sourceHeight: decoded.height, attempts: attempts
        };
      }
    }
    throw new Error(FRAME_ASSET_TOO_LARGE_TEXT);
  } finally {
    // 사진 경로와 같은 해제 계약.
    if (decoded) {
      if (decoded.source && typeof decoded.source.close === 'function') decoded.source.close();
      if (decoded.objectUrl) URL.revokeObjectURL(decoded.objectUrl);
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
