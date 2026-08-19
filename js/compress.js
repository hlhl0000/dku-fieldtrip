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
