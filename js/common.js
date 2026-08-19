// common.js — 화면 공통 유틸. 이메일 규칙·상태 문구·로그인 유도·렌더링 안전장치.
// 설계지시안 v3.1 §2-11 / 확정 22 / §5 금지 11 적용.

import { classIds, classLabels, activeProjectId, APP_VERSION, SDK_VERSION } from './firebase-config.js';

// ── 모둠 계정 이메일 규칙 (단일 원천 · F-1) ────────────────────────────────
// 아래 한 줄은 firestore.rules의 같은 줄과 문자 단위로 일치해야 한다(checks가 대조).
// [EMAIL-RULE] g-{classId소문자}-{groupNo2자리}@{projectId}.web.app

// 모둠 번호를 2자리 0패딩 문자열로. 이 값이 그대로 모둠 문서 ID(gid)가 된다.
export function pad2(groupNo) {
  const n = String(groupNo).trim().replace(/[^0-9]/g, '');
  return n.length >= 2 ? n.slice(-2) : ('0' + n).slice(-2);
}

// 반 ID + 모둠 번호 → 결정적 모둠 계정 이메일. 인증 전 서버 읽기가 필요 없다.
export function groupEmail(classId, groupNo, projectId) {
  const pid = projectId || activeProjectId();
  return 'g-' + String(classId).toLowerCase() + '-' + pad2(groupNo) + '@' + pid + '.web.app';
}

// ── done 집합 키 (v3.1 §1-3 B-10) ────────────────────────────────────────
// 숫자 인덱스가 아니라 문자열 "L0"~"L4"를 쓴다.
export function doneKey(locIndex) {
  return 'L' + String(locIndex);
}
export function locIndexOfDoneKey(key) {
  return Number(String(key).slice(1));
}

// ── 화면 상태 언어 4종 (확정 22 — 문자 단위 고정) ──────────────────────────
// 이 4개 문자열 밖의 상태 어휘를 새로 만들지 않는다(§5 금지 15).
export const STATUS_TEXT = {
  synced: '완료(동기화됨)',
  queued: '전송 대기',
  error: '전송 오류 — 사진은 보관됨',
  locked: '잠금'
};

// 현재 진행 중인 장소는 상태가 아니라 위치 표시다(확정 22 "+현재 장소 표시").
export const CURRENT_TEXT = '현재 장소';

export function statusText(state) {
  return STATUS_TEXT[state] || STATUS_TEXT.locked;
}

// ── 반 목록 (인증 전 서버 읽기 금지 · v3.1 §1-3) ──────────────────────────
export function classOptions() {
  return classIds.map(function (id) {
    return { id: id, label: classLabels[id] || id };
  });
}

// ── 렌더링 안전장치 (§5 금지 11 — innerHTML 금지, textContent만) ───────────
export function setText(el, text) {
  el.textContent = text == null ? '' : String(text);
  return el;
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ── 로그인 세션 (§2-11) ───────────────────────────────────────────────────
// 로그인 결과의 식별 정보만 로컬에 남긴다. 비밀번호는 저장하지 않는다.
const SESSION_KEY = 'dku:session';

export function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// 미로그인 상태로 직접 URL에 접근하면 index.html로 되돌린다.
export function requireLogin() {
  const s = loadSession();
  if (!s || !s.classId || !s.gid) {
    location.replace('index.html');
    return null;
  }
  return s;
}

// ── 업로드 중 이탈 경고 (§2-2) ────────────────────────────────────────────
let busyCount = 0;
function onBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = '';
  return '';
}
export function markBusy() {
  busyCount += 1;
  if (busyCount === 1) window.addEventListener('beforeunload', onBeforeUnload);
}
export function markIdle() {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount === 0) window.removeEventListener('beforeunload', onBeforeUnload);
}

// ── 시각 표기 ─────────────────────────────────────────────────────────────
export function formatTime(value) {
  if (!value) return '없음';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '없음';
  const p = function (n) { return ('0' + n).slice(-2); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// ── 기기 정리 유틸 (§2-2 버튼이 db.wipeLocalData()와 함께 호출) ────────────
// 앱이 브라우저에 남긴 캐시·localStorage를 지운다.
// 주의: 논리 삭제이며 복구 불가능한 소거가 아니다(Firebase 공식 문서 · v3.1 §2-18).
export async function clearAppShellAndStorage() {
  const result = { caches: 0, localStorage: 0 };
  if (typeof caches !== 'undefined' && caches.keys) {
    const keys = await caches.keys();
    for (const k of keys) {
      if (await caches.delete(k)) result.caches += 1;
    }
  }
  const own = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.indexOf('dku') === 0) own.push(key);
  }
  own.forEach(function (k) { localStorage.removeItem(k); result.localStorage += 1; });
  return result;
}

// ── 서비스 워커 등록 (확정 21) ────────────────────────────────────────────
// 스크립트 경로·스코프를 전부 상대 경로로 둔다(GitHub Pages 하위 경로 대응).
// 버전 값은 firebase-config.js 한 곳에서 나와 질의문자열로 전달된다(F-1).
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  const url = 'service-worker.js?v=' + APP_VERSION + '&sdk=' + SDK_VERSION;
  return navigator.serviceWorker.register(url, { scope: './' }).catch(function (e) {
    // 등록 실패는 앱 사용을 막지 않는다. 오프라인 새로고침만 안 될 뿐이다.
    console.warn('서비스 워커 등록 실패', e);
    return null;
  });
}

// ── base64 문자열의 UTF-8 바이트 길이 (§1-3 압축 상한 실측용) ──────────────
// base64는 ASCII이므로 문자 수 = 바이트 수지만, 실측 규정이므로 인코더로 잰다.
export function base64Bytes(b64) {
  return new TextEncoder().encode(b64 || '').length;
}
