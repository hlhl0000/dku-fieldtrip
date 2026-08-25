// common.js — 화면 공통 유틸. 이메일 규칙·상태 문구·로그인 유도·렌더링 안전장치.
// 설계지시안 v3.1 §2-11 / 확정 22 / §5 금지 11 적용.

import { classIds, classLabels, activeProjectId, APP_VERSION, SDK_VERSION } from './firebase-config.js';

// ── 학생 계정 이메일 규칙 (단일 원천 · F-1) ────────────────────────────────
// 아래 한 줄은 firestore.rules의 같은 줄과 문자 단위로 일치해야 한다(checks가 대조).
// [EMAIL-RULE] s-{classId소문자}-{학번5자리}@{projectId}.web.app

// 모둠 번호를 2자리 0패딩 문자열로. 이 값이 그대로 모둠 문서 ID(gid)가 된다.
export function pad2(groupNo) {
  const n = String(groupNo).trim().replace(/[^0-9]/g, '');
  return n.length >= 2 ? n.slice(-2) : ('0' + n).slice(-2);
}

// 반 ID + 학번 → 결정적 학생 계정 이메일. 인증 전 서버 읽기가 필요 없다.
// 규칙의 studentEmail()과 같은 조립식이다(설계지시안 로그인모둠개편 §3-0 ⑴).
export function studentEmail(classId, sid, projectId) {
  const pid = projectId || activeProjectId();
  return 's-' + String(classId).toLowerCase() + '-' + String(sid) + '@' + pid + '.web.app';
}

// 학생 계정 비밀번호. 학생·교사 누구에게도 노출하지 않는 내부 값이며 화면에 찍지 않는다
// (§5 금지 5 — 파생식은 코드에 있어도 되나 파생 **값**은 어디에도 남기지 않는다).
// Firebase Auth의 6자 이상 요건을 학번 5자리 + '-' + PIN 4자리 = 10자로 충족한다.
export function studentPassword(sid, pin) {
  return String(sid) + '-' + String(pin);
}

// 학번 5자리에서 반 ID를 파생한다 — '10401' → '1-4', '11201' → '1-12'.
// 로그인 화면의 반 select를 없애는 근거이며 파생식의 단일 원천이다(§3-0 ⑸).
// 형식이 아니면 null이다. 호출자는 파생 직후 classIds 포함 여부를 대조한다.
export function classIdOfSid(sid) {
  const s = String(sid == null ? '' : sid).trim();
  if (!/^[0-9]{5}$/.test(s)) return null;
  return s.slice(0, 1) + '-' + String(parseInt(s.slice(1, 3), 10));
}

// 파생 + 등재 대조를 한 번에. 미등재 반이면 null이다(자격 오류 문면으로 거부한다).
export function knownClassIdOfSid(sid) {
  const cid = classIdOfSid(sid);
  return cid && classIds.indexOf(cid) >= 0 ? cid : null;
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

// ── 미션 카드 문면 (목록 카드 · 지도 시트 공용 단일 원천 · F-1) ─────────────
// 「인증 조건」은 장소마다 다르지 않은 **전 장소 공통 고정문**이다. 코스 항목에는
// name·mission뿐이라 이 문장의 원천이 코드밖에 없다. 목록 카드와 지도 시트가
// 같은 문장을 보여야 하므로 화면 파일에 리터럴로 적지 않는다.
//
// 읽는 순서도 여기서 정한다 — 학생이 먼저 읽어야 하는 것은 **이 장소에서 무엇을
// 하는가**(미션)이고, 인증 조건은 그다음에 확인하는 보조 정보다. 두 라벨을 함께
// 두는 이유는 그 순서가 화면에서 뒤집히지 않게 하기 위해서다.
export const MISSION_LABEL = '미션';
export const PHOTO_RULE_LABEL = '인증 조건';
export const PHOTO_RULE_TEXT = '모둠원 전원이 보이는 단체사진';

// 인증 조건 줄의 DOM 모양을 만드는 단일 함수. 목록 카드는 새 요소로, 지도 시트는
// 정적 마크업의 빈 컨테이너로 들어오지만 **안쪽 모양은 반드시 같아야** CSS가 두
// 화면에 똑같이 걸린다. 두 곳에서 각자 조립하면 한쪽만 바뀐다(F-1).
export function fillPhotoRule(box) {
  clear(box);
  box.appendChild(el('span', 'fixed-note-label', PHOTO_RULE_LABEL));
  box.appendChild(el('span', 'fixed-note-text', PHOTO_RULE_TEXT));
  return box;
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
//
// 개별 PIN 로그인에서는 **모둠 미배정 학생도 정상 로그인 상태**다(§1-1 #14).
// 그래서 신원 판정 기준은 `classId && sid` 하나이고, 모둠(gid)은 화면마다 다르게 요구한다:
//   needsGroup:false (기본) — mission·survey. 미배정도 들어오고 화면이 스스로 분기한다.
//   needsGroup:true         — fourcut. 모둠 사진이 없으면 할 일이 없으므로 mission으로 보낸다
//                             (index로 튕기면 로그인은 멀쩡한데 로그인 화면이 떠 혼란스럽다).
export function requireLogin(opts) {
  const s = loadSession();
  if (!s || !s.classId || !s.sid) {
    location.replace('index.html');
    return null;
  }
  if (opts && opts.needsGroup === true && !s.gid) {
    location.replace('mission.html');
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
// 값은 세 가지로 온다 — 데모(MockDB)는 ISO 문자열, Firebase는 **Firestore Timestamp 객체**,
// 그리고 Date. new Date(Timestamp)는 Invalid Date가 되어 전부 '없음'으로 찍혔다(실측:
// 설문 제출시각·수정시각이 화면과 CSV에서 통째로 비었다). 데모 e2e는 문자열만 지나므로
// 이 결함을 원리적으로 못 본다 — 세 경우를 함께 다루는 toDateSafe로 통일한다.
export function formatTime(value) {
  if (!value) return '없음';
  const d = toDateSafe(value);
  if (!d || isNaN(d.getTime())) return '없음';
  const p = function (n) { return ('0' + n).slice(-2); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// 서버 타임스탬프·Date·문자열을 Date로. 못 읽으면 null이다 — 기기 시계로 메우지 않는다.
// v3.4 §2-9: teacher.html의 지역 함수였던 것을 공용으로 승격했다(map-view·교사 화면이 함께 쓴다).
// 시그니처·동작은 그대로다(§5 금지 29의 「기존 이름·시그니처 불변」과 충돌하지 않는 명시 작업).
export function toDateSafe(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') {
    try { return v.toDate(); } catch (e) { return null; }
  }
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ── 모둠 색 팔레트 (v3.4 추정 7 — 단일 원천) ──────────────────────────────
// 12색 고정. 학년 전체 12개 반 확장(이월 §6.9)까지 번호가 겹치지 않는다.
// 지도 핀·경로·폴라로이드 테두리가 전부 이 값을 쓴다. 색을 바꾸려면 여기만 고친다.
export const GROUP_COLORS = [
  '#c0392b', '#2d7d5a', '#2b5fa8', '#8a4fa8',
  '#b8791f', '#127c86', '#8c5a2b', '#7a2f5e',
  '#3f6f2a', '#25507a', '#a03a63', '#5c4a9c'
];

// 모둠 번호(1부터 · '01' 같은 0패딩 문자열도 받는다) → 팔레트 색 1개.
export function groupColor(groupNo) {
  const n = Number(String(groupNo == null ? '' : groupNo).replace(/[^0-9]/g, ''));
  const i = Number.isFinite(n) && n >= 1 ? (n - 1) : 0;
  return GROUP_COLORS[i % GROUP_COLORS.length];
}

// ── 스팟 식별자 (v3.4 §3-C) ───────────────────────────────────────────────
// 좌표의 키는 **표시 이름이 아니라** 불변 식별자다(§5 금지 34).
// 이름을 고쳐도, 코스를 복사해도 따라간다.
function randomHex8() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8);
  }
  // randomUUID가 없는 환경(구형·비보안 컨텍스트)용 폴백. 같은 8자리 16진수를 만든다.
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i += 1) out += ('0' + buf[i].toString(16)).slice(-2);
  return out;
}

// taken = 이미 쓰인 id 목록(배열·Set 모두 받는다). 코스 안 충돌을 검사한다(§3-C ⑴).
export function makeSpotId(taken) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  for (let tries = 0; tries < 50; tries += 1) {
    const id = 's-' + randomHex8();
    if (!used.has(id)) return id;
  }
  return 's-' + randomHex8() + '-' + Date.now().toString(36);
}

// 코스 배열의 모든 항목이 spotId를 갖도록 보장한다. **이미 있는 id는 절대 바꾸지 않는다** —
// 로드·복사·추가·재정렬 어느 경로로 들어와도 좌표가 고아가 되지 않게 하는 지점이다(§3-C ⑵).
// 원본 배열을 그 자리에서 고치고 같은 배열을 돌려준다.
export function ensureSpotIds(course) {
  const list = course || [];
  const used = new Set();
  list.forEach(function (loc) {
    if (loc && typeof loc.spotId === 'string' && loc.spotId) used.add(loc.spotId);
  });
  list.forEach(function (loc) {
    if (!loc) return;
    // 없는 경우에만 만든다. 있으면 그대로 둔다 — 여기서 갈아 끼우면 좌표가 고아가 된다.
    if (typeof loc.spotId !== 'string' || !loc.spotId) {
      loc.spotId = makeSpotId(used);
      used.add(loc.spotId);
    }
  });
  return list;
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
