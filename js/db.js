// db.js — 데이터 계층. MockDB(데모)와 FirebaseDB(실서버)가 같은 계약을 구현한다.
// 설계지시안 v3.1 §2 「db.js 계약」 / 확정 19·20·22 / §5 금지 13·14·15 적용.
//
// 계약 메서드
//   login / logout / getCachedCourse / completeLocation / currentLocIndex /
//   listMyPhotos / getPhoto / onGroup / onDashboard / retryFailed /
//   admin.createGroup / admin.updateCourse / admin.resetData / admin.setFrameTexts /
//   admin.setFrameAsset / admin.clearFrameAsset / admin.setFrameOptions /
//   getFrameTexts / getFrameAssetMeta / getFrameAssetImages / wipeLocalData /
//   getMapSpots / admin.setMapSpot / admin.clearMapSpot            (v3.4 §2-8 · §3-C)
//   getRoster / saveRoster / getRosterPins / getSurveyConfig / saveSurveyConfig /
//   getSurveyAnswer / submitSurveyAnswer / listSurveyAnswers      (설문 v1 §3 단계 1)
//
// 진행도는 숫자 필드가 아니라 완료 집합 done:{ "L0": 승인시각 } 이다(확정 19, §5 금지 13).
// 오프라인 전송 주체는 Firebase 모드에서 Firestore 지속 캐시(mutation queue) 하나뿐이며,
// 별도 재전송 큐를 만들지 않는다(확정 20, §5 금지 14). 실패 보관함은 보존·수동 재시도 전용이다.

import {
  MODE, classIds, classLabels, firebaseConfig, activeProjectId, sdkUrls
} from './firebase-config.js';
import { groupEmail, doneKey, locIndexOfDoneKey, pad2, base64Bytes, ensureSpotIds } from './common.js';
import { isFractionPoint } from '../map/map-config.js';
import {
  DEFAULT_FRAME_TEXTS, FRAME_ASSET_KINDS, FRAME_ASSET_MAX_BYTES,
  frameAssetDocId, FRAME_ASSET_META_DOC, DEFAULT_LAYOUT_ID
} from '../frames/frames.js';
// 설문의 데이터 계약은 survey.js 하나가 원천이다(F-1). 여기서 문항·형식을 다시 정의하지 않는다.
import {
  SURVEY_COLLECTION, SURVEY_ANSWERS_COLLECTION, SURVEY_DOC,
  answerDocId, assertSid, assertPin, sidOfAnswerId,
  mergeRosterPins, normalizeRoster, normalizeQuestions, validateQuestions
} from './survey.js';

// ── 상한값 (§1-3) ─────────────────────────────────────────────────────────
export const LIMITS = {
  FULL_MAX_BYTES: 900000,   // full base64 문자열의 UTF-8 바이트 상한
  THUMB_MAX_BYTES: 20000    // thumb base64 문자열의 UTF-8 바이트 상한
};

// 프레임 이미지 상한 — 원천은 frames.js다(두 곳에 숫자를 적지 않는다 · F-1).
export const FRAME_LIMITS = {
  ASSET_MAX_BYTES: FRAME_ASSET_MAX_BYTES
};

// 프레임 이미지 1장의 형식·크기를 쓰기 전에 검사한다(확정 27-⑶ · §5 금지 22).
export function assertFrameAsset(kind, asset) {
  if (FRAME_ASSET_KINDS.indexOf(kind) < 0) {
    throw new Error('알 수 없는 프레임 이미지 종류입니다: ' + kind);
  }
  if (!asset || typeof asset.b64 !== 'string' || !asset.b64) {
    throw new Error('이미지 데이터가 비어 있습니다');
  }
  if (asset.b64.indexOf('data:') === 0) {
    throw new Error('이미지 데이터 형식이 잘못되었습니다(data: 접두사 없이 저장합니다)');
  }
  // 오버레이를 JPEG로 저장하면 투명이 검정으로 채워져 사진을 다 덮는다(§5 금지 22).
  if (kind === 'overlay' && asset.mime !== 'image/png') {
    throw new Error('덮는 프레임은 투명을 지원하는 PNG여야 합니다');
  }
  const bytes = base64Bytes(asset.b64);
  if (bytes > FRAME_LIMITS.ASSET_MAX_BYTES) {
    throw new Error('이미지가 너무 큽니다(' + bytes + 'B). 더 작은 파일로 다시 시도하세요');
  }
  return bytes;
}

// 메타 인덱스의 한 프레임 항목을 기본값으로 채운다. 화면·합성이 같은 모양을 받는다.
export function normalizeFrameOptions(entry) {
  const e = entry || {};
  return {
    layoutId: e.layoutId || DEFAULT_LAYOUT_ID,
    hideTexts: e.hideTexts === true,
    background: e.background || null,
    overlay: e.overlay || null
  };
}

// 자격 오류 단일 고정 문구 (v3.1 db.js 계약 login — 이메일 열거 보호로 코드가 합쳐진다)
export const CREDENTIAL_ERROR_TEXT =
  '반·모둠 번호 또는 비밀번호가 맞지 않습니다. 인쇄된 비밀번호표를 확인하세요';

// 자격 외 오류 코드만 개별 한국어 문구를 둔다.
const NON_CREDENTIAL_ERROR_TEXT = {
  'auth/too-many-requests': '로그인 시도가 많아 잠시 막혔습니다. 1분 뒤 다시 시도하세요',
  'auth/network-request-failed': '네트워크에 연결되지 않았습니다. 연결을 확인하고 다시 시도하세요',
  'auth/internal-error': '서버 오류가 발생했습니다. 잠시 뒤 다시 시도하세요',
  'auth/user-disabled': '이 모둠 계정이 잠겼습니다. 선생님께 알리세요'
};

export function loginErrorText(code) {
  return NON_CREDENTIAL_ERROR_TEXT[code] || CREDENTIAL_ERROR_TEXT;
}

// ── 실패 보관함 (IndexedDB · 확정 20) ─────────────────────────────────────
// 영구 거절(권한·용량)된 payload를 보존한다. 자동 재전송하지 않는다 — 수동 재시도 전용.
const VAULT_DB_NAME = 'dku-fourcut-vault';
const VAULT_STORE = 'failed';

function openVault() {
  return new Promise(function (resolve, reject) {
    const req = indexedDB.open(VAULT_DB_NAME, 1);
    req.onupgradeneeded = function () {
      const d = req.result;
      if (!d.objectStoreNames.contains(VAULT_STORE)) d.createObjectStore(VAULT_STORE, { keyPath: 'id' });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function vaultTx(mode, fn) {
  return openVault().then(function (d) {
    return new Promise(function (resolve, reject) {
      const tx = d.transaction(VAULT_STORE, mode);
      const store = tx.objectStore(VAULT_STORE);
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = function () { d.close(); resolve(out && out.__req ? out.__req.result : out); };
      tx.onerror = function () { d.close(); reject(tx.error); };
    });
  });
}

export const vault = {
  id: function (classId, gid, locIndex) { return classId + '/' + gid + '/' + locIndex; },

  put: function (entry) {
    return vaultTx('readwrite', function (s) { s.put(entry); });
  },

  remove: function (id) {
    return vaultTx('readwrite', function (s) { s.delete(id); });
  },

  clear: function () {
    return vaultTx('readwrite', function (s) { s.clear(); });
  },

  all: function () {
    return vaultTx('readonly', function (s) { return { __req: s.getAll() }; })
      .then(function (rows) { return rows || []; });
  },

  listFor: function (classId, gid) {
    const prefix = classId + '/' + gid + '/';
    return vault.all().then(function (rows) {
      return rows.filter(function (r) { return String(r.id).indexOf(prefix) === 0; });
    });
  }
};

// ── 상태 계산 (확정 22) ───────────────────────────────────────────────────
// 'synced' 서버 승인 / 'queued' 로컬 전송 대기 / 'error' 영구 거절(사진은 보관됨)
// 'current' 지금 해야 할 장소 / 'locked' 아직 잠김
export function statusOf(state, locIndex) {
  const key = doneKey(locIndex);
  if (state.done && Object.prototype.hasOwnProperty.call(state.done, key)) return 'synced';
  if (state.pending && Object.prototype.hasOwnProperty.call(state.pending, key)) return 'queued';
  if (state.failed && state.failed.indexOf(key) >= 0) return 'error';
  if (locIndex === computeCurrentLocIndex(state)) return 'current';
  return 'locked';
}

// 진행 계산의 기준 집합 = done ∪ pending ∪ error (확정 23-⑴).
// 서버 승인(done)·전송 대기(pending)·전송 오류(failed)를 한 집합으로 본다.
// 표기는 여전히 갈린다 — 「완료(동기화됨)」는 서버 승인일 때만 쓴다(확정 22 · §5 금지 15·16).
// 진행 수·해금·네컷 선택 대상이 전부 이 함수 하나를 원천으로 쓴다(F-1).
export function progressKeys(state) {
  const keys = new Set();
  Object.keys((state && state.done) || {}).forEach(function (k) { keys.add(k); });
  Object.keys((state && state.pending) || {}).forEach(function (k) { keys.add(k); });
  ((state && state.failed) || []).forEach(function (k) { keys.add(k); });
  return keys;
}

// 서로 다른 진행 장소 수. 같은 locIndex가 세 집합에 겹쳐 있어도 한 번만 센다.
export function progressCount(state) {
  return progressKeys(state).size;
}

// 현재 장소 = 첫 미완료 locIndex. 전송 대기·전송 오류도 진행으로 보므로 잠기지 않는다(확정 23).
export function computeCurrentLocIndex(state) {
  const total = (state.course || []).length;
  const keys = progressKeys(state);
  for (let i = 0; i < total; i += 1) {
    if (!keys.has(doneKey(i))) return i;
  }
  return total; // 전부 진행 완료
}

// 아직 서버가 받지 못한 사진 수 = pending ∪ error (확정 25-⑴ 미전송 배지).
// 「완료」로 뭉뚱그리지 않는다(§5 금지 19) — done은 세지 않는다.
export function unsentKeys(state) {
  const keys = new Set();
  Object.keys((state && state.pending) || {}).forEach(function (k) { keys.add(k); });
  ((state && state.failed) || []).forEach(function (k) { keys.add(k); });
  return keys;
}

// ── 코스 잠금 판정 (v3.4 §3-C — 3곳 불일치를 하나로 통일) ────────────────
// 2026-08-21 실측: admin UI는 done>0, MockDB.updateCourse는 done|pending, FirebaseDB는 done
// 세 곳이 서로 달랐다. 기준을 **서버 done 1건 이상**으로 통일하고 이 함수 하나만 쓴다.
// 전송 대기(pending)는 서버가 아직 받지 않았으므로 잠그지 않는다 —
// MockDB 쪽 동작이 이 정렬로 바뀌며, 그것이 의도한 변경이다.
// 잠금의 이유는 locIndex가 사진 문서 주소이기 때문이고, 그 주소를 실제로 점유하는 것은
// 서버에 도착한 사진(done)뿐이다.
export function isCourseLocked(doneMap) {
  return Object.keys(doneMap || {}).length > 0;
}

// ── 지도 스팟 좌표 (v3.4 §3-C) ────────────────────────────────────────────
// 좌표는 `config/mapSpots` 문서 하나에 `byId[spotId] = {x, y}` 로 산다.
// 키는 불변 spotId다 — 표시 이름을 키로 쓰지 않는다(§5 금지 34).
// 규칙 파일은 건드리지 않는다. 기존 `config/{doc}`(읽기=인증자·쓰기=교사) 안이다(§5 금지 25).
export const MAP_SPOTS_DOC = 'mapSpots';

function assertSpotId(spotId) {
  if (typeof spotId !== 'string' || !spotId.trim()) throw new Error('장소 식별자(spotId)가 없습니다');
  return spotId.trim();
}

// 0~1 유한수 판정의 원천은 map-config.js 하나다(F-1). 여기서 다시 쓰지 않는다.
function assertSpotXy(xy) {
  if (!isFractionPoint(xy)) throw new Error('좌표가 0~1 범위의 유한수가 아닙니다');
  return { x: xy.x, y: xy.y };
}

// 저장본 → 화면이 쓰는 모양. 형식이 깨진 항목은 조용히 버린다(빈 값 반환 계약과 같은 방향).
function normalizeMapSpots(raw) {
  const src = (raw && raw.byId) || {};
  const out = {};
  Object.keys(src).forEach(function (k) {
    if (isFractionPoint(src[k])) out[k] = { x: src[k].x, y: src[k].y };
  });
  return { byId: out };
}

// ── 사후 설문 (설문 v1 §3 단계 1) ─────────────────────────────────────────
// 두 구현이 같은 계약을 갖도록, 형식 검사·기본값 채우기는 여기 모듈 함수 하나에 둔다(F-1).
//
// PIN은 계정 비밀번호가 아니라 열람 토큰이다 — rosterPins(교사 전용 문서)에 **평문 문자열**로
// 산다(§1-1 #12b). 해시로 바꾸면 규칙의 문자열 동등 비교가 깨져 전 학급 제출이 거부된다.
// 필드명에 password·pw·passwd를 쓰지 않는다(규칙의 noSecretFields()와 충돌).

// 마감·PIN 불일치·명렬표 미등록은 실서버에서 규칙이 거부한다. 데모 모드도 같은 코드로
// 거부해, 화면의 분기 하나가 두 모드에서 같은 길을 지나게 한다(§3 단계 2).
export const SURVEY_DENIED_CODE = 'permission-denied';

function surveyDenied(message) {
  const e = new Error(message);
  e.code = SURVEY_DENIED_CODE;
  return e;
}

// 저장본 → 화면이 쓰는 모양. 문항이 저장된 적 없으면 기본 양식이 적용된다.
function normalizeSurveyConfig(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const edited = Array.isArray(d.questions) && d.questions.length > 0;
  return {
    questions: normalizeQuestions(d.questions),
    closed: d.closed === true,
    edited: edited,
    updatedAt: d.updatedAt || null
  };
}

// 응답 본문. PIN은 본문에 넣지 않는다 — 소재지는 rosterPins와 문서 경로뿐이다(§5 금지 8b).
function buildAnswerBody(sid, name, groupNo, answers) {
  return {
    sid: sid,
    name: name,
    groupNo: groupNo,
    answers: answers && typeof answers === 'object' ? answers : {}
  };
}

// 업로드 payload 크기 검사 (§5 금지 4)
function assertPayloadSize(fullB64, thumbB64) {
  const fullBytes = base64Bytes(fullB64);
  const thumbBytes = base64Bytes(thumbB64);
  if (fullBytes > LIMITS.FULL_MAX_BYTES) {
    throw new Error('사진이 너무 큽니다(' + fullBytes + 'B). 다른 사진을 선택하세요');
  }
  if (thumbBytes > LIMITS.THUMB_MAX_BYTES) {
    throw new Error('미리보기 이미지가 너무 큽니다(' + thumbBytes + 'B). 다른 사진을 선택하세요');
  }
  return { fullBytes: fullBytes, thumbBytes: thumbBytes };
}

// base64는 data: 접두사 없이 순수 문자열로만 저장하고 mime은 별도 필드로 둔다(§1-3).
function assertPureBase64(b64) {
  if (typeof b64 !== 'string' || b64.indexOf('data:') === 0) {
    throw new Error('사진 데이터 형식이 잘못되었습니다(data: 접두사 없이 저장합니다)');
  }
}

// ── 지속 캐시 양성 확인 (S-검토 A-4) ──────────────────────────────────────
// initializeFirestore + persistentLocalCache 는 IndexedDB를 못 써도 **예외를 던지지 않고**
// 조용히 메모리 캐시로 폴백한다(공식 동작). 그러므로 예외를 기다리지 않고 우리가 직접
// IndexedDB를 열어 본다(양성 확인). 타임아웃·onerror·onblocked는 전부 실패로 본다.
const IDB_PROBE_NAME = 'dku-idb-probe';

export function probeIndexedDB(timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;
    const done = function (v) { if (!settled) { settled = true; resolve(v); } };
    let req = null;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) { done(false); return; }
      req = indexedDB.open(IDB_PROBE_NAME, 1);
    } catch (e) {
      done(false);
      return;
    }
    const timer = setTimeout(function () { done(false); }, timeoutMs || 3000);
    req.onerror = function () { clearTimeout(timer); done(false); };
    req.onblocked = function () { clearTimeout(timer); done(false); };
    req.onsuccess = function () {
      clearTimeout(timer);
      try { req.result.close(); } catch (ignored) { /* 무시 */ }
      try { indexedDB.deleteDatabase(IDB_PROBE_NAME); } catch (ignored) { /* 무시 */ }
      done(true);
    };
  });
}

// 초기화 뒤 한 번 더 본다. 저장 용량 자체가 0이면 지속 캐시가 사실상 없는 것과 같다.
// estimate()를 제공하지 않는 브라우저에서는 판정을 보류하고 true를 돌려준다
// (그 경우 판정은 probeIndexedDB() 결과에 맡긴다).
export async function probeStorageEstimate() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage
      || typeof navigator.storage.estimate !== 'function') return true;
    const est = await navigator.storage.estimate();
    if (est && typeof est.quota === 'number' && est.quota === 0) return false;
    return true;
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MockDB — 데모 모드. localStorage(본체) + IndexedDB(실패 보관함).
// 외부 네트워크 요청을 하지 않는다.
// 주의: 아래 대기 큐는 데모용 시뮬레이션이다. Firebase 모드에는 이런 큐가 없고
//       Firestore mutation queue가 유일한 전송 주체다(§5 금지 14).
// ─────────────────────────────────────────────────────────────────────────
const DEMO_KEY = 'dku:demo';
const DEMO_REJECT_KEY = 'dku:demo:forceReject';
// mapSpots 읽기 실패 주입 훅 (v3.4 §6 ⑺ · 2차 P-검토 A-4).
// 「셸은 설치됐는데 mapSpots만 캐시에 없는 첫 지도 진입」을 데모 모드에서 재현한다.
// 앱 완전 첫 방문 오프라인은 셸 자체가 없어 시험할 수 없으므로 이 훅으로 대신한다.
const DEMO_MAPSPOTS_FAIL_KEY = 'dku:demo:failMapSpots';

function demoCourse(groupNo) {
  const out = [];
  for (let i = 0; i < 5; i += 1) {
    out.push({
      locIndex: i,
      name: '데모 장소 ' + (i + 1),
      mission: '[데모] ' + groupNo + '모둠 ' + (i + 1) + '번째 미션 안내문입니다. 실제 미션은 관리 화면에서 입력합니다.'
    });
  }
  // 데모 코스도 실제와 같은 계약을 갖는다 — 항목마다 불변 spotId(§3-C).
  return ensureSpotIds(out);
}

function demoSeed() {
  const cid = classIds[0];
  const groups = {};
  ['01', '02'].forEach(function (gid) {
    groups[gid] = {
      gid: gid,
      groupNo: gid,
      email: groupEmail(cid, gid),
      courseRev: 1,
      course: demoCourse(gid),
      done: {},
      pending: {},
      lastSyncAt: null
    };
  });
  return {
    classes: {},
    groups: {},
    photos: {},
    photoMeta: {},
    config: {
      frameTexts: { top: '2026 용인고 단국대 현장체험학습', bottom: '단국대학교 죽전캠퍼스' }
    },
    // 데모 전용 자격 대응표. Firestore에 비밀번호를 저장한다는 뜻이 아니다(§5 금지 9).
    demoAuth: (function () {
      const m = {};
      m[cid + '/01'] = 'demo1234';
      m[cid + '/02'] = 'demo1234';
      return m;
    })(),
    __init: (function () {
      return { cid: cid, groups: groups };
    })()
  };
}

class MockDB {
  constructor() {
    this.mode = 'demo';
    this.session = null;
    this._subs = [];
    this._dashSubs = [];
    this._ensureStore();
    const self = this;
    window.addEventListener('online', function () { self._flushPending(); });
  }

  // 데모 모드는 준비 절차가 없다. 계약을 맞추기 위한 no-op.
  // offlineProtection: 화면이 「오프라인 보호 꺼짐」 배너를 띄울지 판단하는 값(A-4).
  async ensureReady() {
    this._ensureStore();
    return { persistence: 'local', offlineProtection: true };
  }

  // ── 로컬 저장소 ─────────────────────────────────────────────────────────
  _ensureStore() {
    let s = this._read();
    if (!s) {
      const seed = demoSeed();
      const cid = seed.__init.cid;
      s = {
        classes: {}, groups: {}, photos: {}, photoMeta: {},
        config: seed.config, demoAuth: seed.demoAuth
      };
      s.classes[cid] = { classId: cid, name: classLabels[cid] || cid, courseRev: 1 };
      s.groups[cid] = seed.__init.groups;
      this._write(s);
    }
    return s;
  }

  _read() {
    try {
      const raw = localStorage.getItem(DEMO_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  _write(s) { localStorage.setItem(DEMO_KEY, JSON.stringify(s)); }

  _group(classId, gid) {
    const s = this._ensureStore();
    return (s.groups[classId] || {})[gid] || null;
  }

  _saveGroup(classId, gid, g) {
    const s = this._ensureStore();
    if (!s.groups[classId]) s.groups[classId] = {};
    s.groups[classId][gid] = g;
    this._write(s);
  }

  // ── login ──────────────────────────────────────────────────────────────
  async login(classId, groupNo, password) {
    const gid = pad2(groupNo);
    const s = this._ensureStore();
    if (classIds.indexOf(classId) < 0) throw new Error(CREDENTIAL_ERROR_TEXT);
    const expected = (s.demoAuth || {})[classId + '/' + gid];
    if (!expected || expected !== String(password)) throw new Error(CREDENTIAL_ERROR_TEXT);
    const g = this._group(classId, gid);
    if (!g) throw new Error(CREDENTIAL_ERROR_TEXT);

    this.session = {
      classId: classId, gid: gid, groupNo: gid,
      email: groupEmail(classId, gid), courseRev: g.courseRev
    };
    // 코스 전체 + courseRev를 로컬에 캐시한다(오프라인에서도 코스를 본다).
    localStorage.setItem('dku:course:' + classId + '/' + gid, JSON.stringify({
      course: g.course, courseRev: g.courseRev
    }));
    return this.getState();
  }

  async logout() {
    this.session = null;
    return true;
  }

  // ── 상태 조회 ───────────────────────────────────────────────────────────
  getCachedCourse() {
    const s = this.session;
    if (!s) return null;
    try {
      const raw = localStorage.getItem('dku:course:' + s.classId + '/' + s.gid);
      const cached = raw ? JSON.parse(raw) : null;
      const g = this._group(s.classId, s.gid);
      if (cached && g && cached.courseRev !== g.courseRev) {
        return { course: cached.course, courseRev: cached.courseRev, revMismatch: true };
      }
      return cached ? { course: cached.course, courseRev: cached.courseRev, revMismatch: false } : null;
    } catch (e) { return null; }
  }

  async getState() {
    const s = this.session;
    if (!s) return null;
    const g = this._group(s.classId, s.gid);
    const failed = await vault.listFor(s.classId, s.gid);
    return {
      classId: s.classId, gid: s.gid, groupNo: g.groupNo,
      course: g.course, courseRev: g.courseRev,
      done: g.done || {}, pending: g.pending || {},
      failed: failed.map(function (f) { return doneKey(f.locIndex); }),
      lastSyncAt: g.lastSyncAt
    };
  }

  async currentLocIndex() {
    const state = await this.getState();
    return state ? computeCurrentLocIndex(state) : 0;
  }

  // ── completeLocation ───────────────────────────────────────────────────
  // 반환 status: 'synced'(서버 승인) / 'queued'(전송 대기) / 'error'(영구 거절)
  async completeLocation(locIndex, fullB64, thumbB64, mime, operationId) {
    const s = this.session;
    if (!s) throw new Error('로그인이 필요합니다');
    assertPureBase64(fullB64);
    assertPureBase64(thumbB64);
    assertPayloadSize(fullB64, thumbB64);

    const g = this._group(s.classId, s.gid);
    const cached = this.getCachedCourse();
    if (cached && cached.courseRev !== g.courseRev) {
      throw new Error('코스가 변경되었습니다. 다시 로그인하세요');
    }

    const key = doneKey(locIndex);
    const now = new Date().toISOString();
    const payload = {
      id: vault.id(s.classId, s.gid, locIndex),
      classId: s.classId, gid: s.gid, locIndex: locIndex,
      full: fullB64, thumb: thumbB64, mime: mime,
      operationId: operationId, rev: g.courseRev, savedAt: now
    };

    // 영구 거절 주입(e2e 「전송 오류」 케이스 — permission-denied 모사)
    // put은 같은 id(반/모둠/장소)를 덮어쓴다 = 오류 상태에서 다시 올린 사진이 보관함 항목을
    // **교체**한다(확정 23-⑵). 장소당 1장 불변식이 보관함에서도 유지된다.
    if (localStorage.getItem(DEMO_REJECT_KEY)) {
      await vault.put(payload);
      this._emit();
      return { status: 'error', code: localStorage.getItem(DEMO_REJECT_KEY) };
    }

    // 이전에 같은 장소가 실패 보관함에 있었으면 치운다(재업로드·재시도 성공 경로 공통).
    await vault.remove(payload.id);

    if (!navigator.onLine) {
      g.pending = g.pending || {};
      g.pending[key] = now;
      this._stagePhoto(s.classId, s.gid, locIndex, payload);
      this._saveGroup(s.classId, s.gid, g);
      this._emit();
      return { status: 'queued' };
    }

    this._commit(s.classId, s.gid, locIndex, payload);
    this._emit();
    return { status: 'synced' };
  }

  _stagePhoto(classId, gid, locIndex, payload) {
    const s = this._ensureStore();
    const path = classId + '/' + gid + '/' + locIndex;
    s.photos[path] = { full: payload.full, mime: payload.mime, locIndex: locIndex, operationId: payload.operationId, rev: payload.rev, createdAt: payload.savedAt };
    s.photoMeta[path] = { thumb: payload.thumb, mime: payload.mime, locIndex: locIndex, operationId: payload.operationId, rev: payload.rev, uploadedAt: payload.savedAt };
    this._write(s);
  }

  _commit(classId, gid, locIndex, payload) {
    this._stagePhoto(classId, gid, locIndex, payload);
    const g = this._group(classId, gid);
    const key = doneKey(locIndex);
    g.done = g.done || {};
    g.done[key] = new Date().toISOString();
    if (g.pending) delete g.pending[key];
    g.lastSyncAt = new Date().toISOString();
    this._saveGroup(classId, gid, g);
  }

  _flushPending() {
    const s = this.session;
    if (!s) return;
    const g = this._group(s.classId, s.gid);
    if (!g || !g.pending) return;
    const keys = Object.keys(g.pending);
    if (!keys.length) return;
    const self = this;
    keys.forEach(function (k) {
      const i = locIndexOfDoneKey(k);
      const store = self._ensureStore();
      const p = store.photos[s.classId + '/' + s.gid + '/' + i];
      if (p) {
        self._commit(s.classId, s.gid, i, {
          full: p.full, thumb: (store.photoMeta[s.classId + '/' + s.gid + '/' + i] || {}).thumb,
          mime: p.mime, operationId: p.operationId, rev: p.rev, savedAt: p.createdAt
        });
      } else {
        delete g.pending[k];
      }
    });
    this._saveGroup(s.classId, s.gid, this._group(s.classId, s.gid));
    this._emit();
  }

  // ── 실패 재시도 (수동 전용) ─────────────────────────────────────────────
  async retryFailed(locIndex) {
    const s = this.session;
    if (!s) throw new Error('로그인이 필요합니다');
    const rows = await vault.listFor(s.classId, s.gid);
    const row = rows.filter(function (r) { return r.locIndex === locIndex; })[0];
    if (!row) throw new Error('보관된 사진이 없습니다');
    return this.completeLocation(locIndex, row.full, row.thumb, row.mime, row.operationId);
  }

  async listFailed() {
    const s = this.session;
    if (!s) return [];
    return vault.listFor(s.classId, s.gid);
  }

  // ── 사진 조회 ───────────────────────────────────────────────────────────
  // 전송 대기·실패 보관분도 로컬에서 네컷 합성에 쓸 수 있다.
  async listMyPhotos() {
    const s = this.session;
    if (!s) return [];
    const state = await this.getState();
    const store = this._ensureStore();
    const failedRows = await vault.listFor(s.classId, s.gid);
    const out = [];
    (state.course || []).forEach(function (loc) {
      const st = statusOf(state, loc.locIndex);
      if (st !== 'synced' && st !== 'queued' && st !== 'error') return;
      const path = s.classId + '/' + s.gid + '/' + loc.locIndex;
      // 「전송 오류」인 장소는 보관함 사본이 그 장소의 최신 사진이다(확정 23-⑶).
      // 그 밖의 상태에서는 로컬 본체(= 서버에 간 것과 같은 사진)를 쓴다.
      let rec = null;
      if (st === 'error') {
        const f = failedRows.filter(function (r) { return r.locIndex === loc.locIndex; })[0];
        if (f) rec = { full: f.full, mime: f.mime, createdAt: f.savedAt };
      }
      if (!rec) rec = store.photos[path];
      if (!rec) return;
      out.push({
        locIndex: loc.locIndex, name: loc.name, status: st,
        full: rec.full, mime: rec.mime, uploadedAt: rec.createdAt
      });
    });
    out.sort(function (a, b) { return a.locIndex - b.locIndex; });
    return out;
  }

  async getPhoto(gid, locIndex) {
    const s = this.session;
    const classId = s ? s.classId : classIds[0];
    const store = this._ensureStore();
    return store.photos[classId + '/' + gid + '/' + locIndex] || null;
  }

  // 문구가 저장된 적이 없으면 기본값을 돌려준다 — 기본값의 단일 원천은 frames.js다(A-6).
  async getFrameTexts() {
    const saved = this._ensureStore().config.frameTexts;
    return {
      top: (saved && saved.top) || DEFAULT_FRAME_TEXTS.top,
      bottom: (saved && saved.bottom) || DEFAULT_FRAME_TEXTS.bottom
    };
  }

  // 프레임별 설정·자산 요약. 이미지 본문은 여기 없다(문서를 작게 유지한다).
  async getFrameAssetMeta() {
    const c = this._ensureStore().config || {};
    return c.frameAssetMeta || {};
  }

  // ── 지도 스팟 좌표 (§3-C) ───────────────────────────────────────────────
  // 읽기 실패는 던지지 않고 **빈 값**을 돌려준다 — 좌표가 없어도 업로드는 그대로 되어야 한다
  // (추정 6: 좌표 미지정 장소는 지도 아래 「위치 미지정」 줄로 내려가고 기능 저하가 0이다).
  _readMapSpots() {
    if (localStorage.getItem(DEMO_MAPSPOTS_FAIL_KEY)) {
      throw new Error('mapSpots를 읽지 못했습니다(데모 주입)');
    }
    return (this._ensureStore().config || {}).mapSpots || {};
  }

  async getMapSpots() {
    try {
      return normalizeMapSpots(this._readMapSpots());
    } catch (e) {
      return { byId: {} };
    }
  }

  // 한 프레임의 배경·오버레이 이미지 본문. 없는 슬롯은 키 자체를 넣지 않는다.
  async getFrameAssetImages(frameId) {
    const c = this._ensureStore().config || {};
    const imgs = c.frameImages || {};
    const out = {};
    FRAME_ASSET_KINDS.forEach(function (kind) {
      const d = imgs[frameAssetDocId(frameId, kind)];
      if (d && d.b64) out[kind] = { b64: d.b64, mime: d.mime };
    });
    return out;
  }

  // ── 사후 설문 (설문 v1 §3 단계 1) ───────────────────────────────────────
  // 데모 모드도 rosterPins 대조·PIN 자동 생성을 **실제로** 구현한다 — 그래야 PIN e2e가
  // 데모에서 성립한다(§3 단계 1). 다만 규칙의 서버 강제는 데모가 원리적으로 못 본다.
  // _ensureStore()는 호출할 때마다 localStorage를 **다시 파싱한 새 객체**를 돌려준다.
  // 그러므로 읽은 store와 쓰는 store가 같은 객체여야 한다 — 여기서 둘을 함께 돌려주고,
  // 쓰는 쪽은 반드시 이 store를 _write에 넘긴다. (다른 store로 쓰면 변경이 조용히 사라진다)
  _surveyNode(cid) {
    const store = this._ensureStore();
    if (!store.survey) store.survey = {};
    if (!store.survey[cid]) store.survey[cid] = {};
    const node = store.survey[cid];
    if (!node.roster) node.roster = { students: {} };
    if (!node.rosterPins) node.rosterPins = { pins: {} };
    if (!node.config) node.config = {};
    if (!node.answers) node.answers = {};
    return { store: store, node: node };
  }

  async getRoster(cid) {
    const n = this._surveyNode(cid).node;
    return { students: Object.assign({}, n.roster.students || {}), updatedAt: n.roster.updatedAt || null };
  }

  // 등록·재등록 공통 경로. 기존 학번의 PIN을 보존하고 신규 학번에만 발급한다(§5 금지 8d).
  async saveRoster(cid, students) {
    const norm = normalizeRoster(students);
    const ctx = this._surveyNode(cid);
    const merged = mergeRosterPins(ctx.node.rosterPins.pins, norm.sids);
    ctx.node.roster = { students: norm.students, updatedAt: new Date().toISOString() };
    ctx.node.rosterPins = { pins: merged.pins };
    this._write(ctx.store);
    return { count: norm.sids.length, kept: merged.kept, issued: merged.issued };
  }

  // 교사 전용. 학생 화면은 이 메서드를 부르지 않는다(규칙에서도 isTeacher()만 통과한다).
  async getRosterPins(cid) {
    const n = this._surveyNode(cid).node;
    return { pins: Object.assign({}, n.rosterPins.pins || {}) };
  }

  async getSurveyConfig(cid) {
    return normalizeSurveyConfig(this._surveyNode(cid).node.config);
  }

  // closed를 **항상 함께 쓴다**(기본 false) — 규칙의 .get('closed', false) 폴백과 이중 방어.
  async saveSurveyConfig(cid, cfg) {
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    const doc = { closed: src.closed === true, updatedAt: new Date().toISOString() };
    const ctx = this._surveyNode(cid);
    if (src.questions !== undefined) {
      const v = validateQuestions(src.questions);
      if (!v.ok) throw new Error(v.errors.join(' / '));
      doc.questions = v.questions;
    } else if (Array.isArray(ctx.node.config.questions)) {
      doc.questions = ctx.node.config.questions;
    }
    ctx.node.config = doc;
    this._write(ctx.store);
    return normalizeSurveyConfig(doc);
  }

  // 경로 비밀 — PIN이 틀리면 문서 주소가 달라져 읽히지 않는다. 조용히 null이다(추정 ③-d).
  async getSurveyAnswer(cid, sid, pin) {
    const aid = answerDocId(sid, pin);
    const a = this._surveyNode(cid).node.answers[aid];
    return a ? Object.assign({ aid: aid }, a) : null;
  }

  async submitSurveyAnswer(cid, sid, pin, payload) {
    const s = this.session;
    if (!s) throw new Error('로그인이 필요합니다');
    const sidOk = assertSid(sid);
    const pinOk = assertPin(pin);
    const ctx = this._surveyNode(cid);
    const n = ctx.node;
    const cfg = normalizeSurveyConfig(n.config);
    const name = (n.roster.students || {})[sidOk];
    if (!name) throw surveyDenied('명렬표에 없는 학번입니다');
    if ((n.rosterPins.pins || {})[sidOk] !== pinOk) throw surveyDenied('PIN이 맞지 않습니다');
    if (cfg.closed) throw surveyDenied('설문이 마감되었습니다');

    const aid = answerDocId(sidOk, pinOk);
    const prev = n.answers[aid] || null;
    const groupNo = prev ? prev.groupNo : s.groupNo;
    const body = buildAnswerBody(sidOk, name, groupNo, (payload || {}).answers);
    const now = new Date().toISOString();
    n.answers[aid] = Object.assign(body, {
      submittedAt: prev ? prev.submittedAt : now,
      updatedAt: now
    });
    this._write(ctx.store);
    return { aid: aid, updated: !!prev };
  }

  // 교사 전용. 학생 화면은 목록을 시도하지 않는다(§5 금지 8c).
  async listSurveyAnswers(cid) {
    const answers = this._surveyNode(cid).node.answers || {};
    return Object.keys(answers).sort().map(function (aid) {
      return Object.assign({ aid: aid, sid: sidOfAnswerId(aid) }, answers[aid]);
    });
  }

  // ── 구독 ────────────────────────────────────────────────────────────────
  onGroup(cb) {
    const self = this;
    this._subs.push(cb);
    this.getState().then(function (st) { if (st) cb(st); });
    return function () {
      self._subs = self._subs.filter(function (f) { return f !== cb; });
    };
  }

  onDashboard(classId, cb) {
    const self = this;
    const entry = { classId: classId, cb: cb };
    this._dashSubs.push(entry);
    this._emitDashboard(entry);
    return function () {
      self._dashSubs = self._dashSubs.filter(function (e) { return e !== entry; });
    };
  }

  _emit() {
    const self = this;
    this.getState().then(function (st) {
      if (st) self._subs.forEach(function (cb) { cb(st); });
    });
    this._dashSubs.forEach(function (e) { self._emitDashboard(e); });
  }

  _emitDashboard(entry) {
    const store = this._ensureStore();
    const groups = store.groups[entry.classId] || {};
    const rows = Object.keys(groups).sort().map(function (gid) {
      const g = groups[gid];
      const state = { course: g.course, done: g.done || {}, pending: g.pending || {}, failed: [] };
      return {
        gid: gid, groupNo: g.groupNo, course: g.course,
        done: g.done || {}, currentLocIndex: computeCurrentLocIndex(state),
        thumbs: (g.course || []).map(function (loc) {
          const m = store.photoMeta[entry.classId + '/' + gid + '/' + loc.locIndex];
          return m ? { locIndex: loc.locIndex, thumb: m.thumb, mime: m.mime, uploadedAt: m.uploadedAt } : null;
        })
      };
    });
    entry.cb(rows);
  }

  // ── 관리 (교사) ─────────────────────────────────────────────────────────
  get admin() {
    const self = this;
    return {
      // 비파괴(S-검토 A-5). 계정이 이미 있으면 거부하고(실서버의 auth/email-already-in-use 대응),
      // 계정만 지워진 재발급 상황에서는 모둠 문서의 course·done을 **건드리지 않는다.**
      async createGroup(classId, groupNo, password, course) {
        const gid = pad2(groupNo);
        const s = self._ensureStore();
        if (!s.classes[classId]) s.classes[classId] = { classId: classId, name: classLabels[classId] || classId, courseRev: 1 };
        if (!s.groups[classId]) s.groups[classId] = {};
        s.demoAuth = s.demoAuth || {};
        if (s.demoAuth[classId + '/' + gid]) throw new Error('이미 있는 모둠입니다');
        const existing = s.groups[classId][gid];
        if (existing) {
          existing.groupNo = gid;
          existing.email = groupEmail(classId, gid);
        } else {
          s.groups[classId][gid] = {
            gid: gid, groupNo: gid, email: groupEmail(classId, gid),
            courseRev: s.classes[classId].courseRev,
            course: course || demoCourse(gid), done: {}, pending: {}, lastSyncAt: null
          };
        }
        s.demoAuth[classId + '/' + gid] = String(password);
        self._write(s);
        self._emit();
        return { gid: gid, email: groupEmail(classId, gid), reissued: !!existing };
      },

      async updateCourse(classId, gid, course) {
        const g = self._group(classId, gid);
        if (!g) throw new Error('없는 모둠입니다');
        // 잠금 판정은 db.js의 단일 함수 하나만 쓴다(§3-C). 전송 대기는 잠그지 않는다.
        const hasDone = isCourseLocked(g.done);
        if (hasDone) {
          if (course.length < g.course.length) throw new Error('첫 완료 이후에는 장소를 삭제할 수 없습니다');
          for (let i = 0; i < g.course.length; i += 1) {
            if (course[i].locIndex !== g.course[i].locIndex) {
              throw new Error('첫 완료 이후에는 장소 순서를 바꿀 수 없습니다');
            }
          }
        }
        // spotId가 없는 항목에 여기서 부여한다 — 화면이 어느 경로로 보냈든 저장 시점에
        // 전 항목이 불변 식별자를 갖는다(§3-C ⑶). 이미 있는 id는 건드리지 않는다.
        g.course = ensureSpotIds(course);
        self._saveGroup(classId, gid, g);
        self._emit();
        return true;
      },

      // ── 지도 스팟 좌표 (§3-C) ─────────────────────────────────────────
      // 개별 필드 merge다 — 다른 스팟의 좌표를 지우지 않는다.
      async setMapSpot(spotId, xy) {
        const id = assertSpotId(spotId);
        const p = assertSpotXy(xy);
        const s = self._ensureStore();
        if (!s.config.mapSpots) s.config.mapSpots = { byId: {} };
        if (!s.config.mapSpots.byId) s.config.mapSpots.byId = {};
        s.config.mapSpots.byId[id] = p;
        self._write(s);
        self._emit();
        return p;
      },

      async clearMapSpot(spotId) {
        const id = assertSpotId(spotId);
        const s = self._ensureStore();
        if (s.config.mapSpots && s.config.mapSpots.byId) delete s.config.mapSpots.byId[id];
        self._write(s);
        self._emit();
        return true;
      },

      // courseRev를 올리고 사진·완료 집합을 500건 단위로 지운다. 중단 시 이어서 재개된다.
      async resetData(classId, onProgressText) {
        const s = self._ensureStore();
        const cls = s.classes[classId];
        if (!cls) throw new Error('없는 반입니다');
        const paths = Object.keys(s.photos).filter(function (p) { return p.indexOf(classId + '/') === 0; });
        let removed = 0;
        for (let i = 0; i < paths.length; i += 500) {
          const page = paths.slice(i, i + 500);
          page.forEach(function (p) { delete s.photos[p]; delete s.photoMeta[p]; });
          removed += page.length;
          self._write(s);
          if (onProgressText) onProgressText(removed + '건 삭제');
        }
        Object.keys(s.groups[classId] || {}).forEach(function (gid) {
          const g = s.groups[classId][gid];
          g.done = {}; g.pending = {}; g.lastSyncAt = null;
          g.courseRev = cls.courseRev + 1;
        });
        cls.courseRev += 1;
        self._write(s);
        await vault.clear();
        self._emit();
        return { removed: removed, courseRev: cls.courseRev };
      },

      async setFrameTexts(texts) {
        const s = self._ensureStore();
        s.config.frameTexts = texts;
        self._write(s);
        return true;
      },

      // 이미지 1장 저장. 데모 모드는 localStorage라 용량이 작아 실패할 수 있다 —
      // 그때는 조용히 삼키지 않고 무슨 일인지 말한다.
      async setFrameAsset(frameId, kind, asset) {
        const bytes = assertFrameAsset(kind, asset);
        const s = self._ensureStore();
        if (!s.config.frameImages) s.config.frameImages = {};
        if (!s.config.frameAssetMeta) s.config.frameAssetMeta = {};
        s.config.frameImages[frameAssetDocId(frameId, kind)] = { b64: asset.b64, mime: asset.mime };
        const entry = normalizeFrameOptions(s.config.frameAssetMeta[frameId]);
        entry[kind] = {
          mime: asset.mime, bytes: bytes,
          width: asset.width || null, height: asset.height || null,
          updatedAt: new Date().toISOString()
        };
        s.config.frameAssetMeta[frameId] = entry;
        try {
          self._write(s);
        } catch (e) {
          throw new Error('데모 모드는 이 기기 저장 공간이 작아 이미지를 담지 못했습니다(실서버 모드에서는 저장됩니다)');
        }
        return { bytes: bytes };
      },

      async clearFrameAsset(frameId, kind) {
        if (FRAME_ASSET_KINDS.indexOf(kind) < 0) throw new Error('알 수 없는 프레임 이미지 종류입니다: ' + kind);
        const s = self._ensureStore();
        if (s.config.frameImages) delete s.config.frameImages[frameAssetDocId(frameId, kind)];
        if (s.config.frameAssetMeta && s.config.frameAssetMeta[frameId]) {
          s.config.frameAssetMeta[frameId][kind] = null;
        }
        self._write(s);
        return true;
      },

      // 좌표판·문구 숨김만 바꾼다. 이미지 본문은 건드리지 않는다(비파괴).
      async setFrameOptions(frameId, options) {
        const s = self._ensureStore();
        if (!s.config.frameAssetMeta) s.config.frameAssetMeta = {};
        const entry = normalizeFrameOptions(s.config.frameAssetMeta[frameId]);
        if (options && options.layoutId) entry.layoutId = options.layoutId;
        if (options && typeof options.hideTexts === 'boolean') entry.hideTexts = options.hideTexts;
        s.config.frameAssetMeta[frameId] = entry;
        self._write(s);
        return true;
      }
    };
  }

  // ── 기기 데이터 지우기 (§2-2 버튼 · v3.1 선행 가드) ──────────────────────
  async wipeLocalData(opts) {
    const force = !!(opts && opts.force);
    const s = this.session;
    let pendingCount = 0;
    let failedCount = 0;
    if (s) {
      const g = this._group(s.classId, s.gid);
      pendingCount = g ? Object.keys(g.pending || {}).length : 0;
      failedCount = (await vault.listFor(s.classId, s.gid)).length;
    }
    const blocked = pendingCount + failedCount;
    if (blocked > 0 && !force) {
      return {
        ok: false, blocked: blocked, pendingCount: pendingCount, failedCount: failedCount,
        message: '아직 전송되지 않은 사진 ' + blocked + '장이 있습니다'
      };
    }
    await vault.clear();
    localStorage.removeItem(DEMO_KEY);
    localStorage.removeItem(DEMO_REJECT_KEY);
    this.session = null;
    return { ok: true, blocked: 0, pendingCount: pendingCount, failedCount: failedCount, message: '이 기기에 저장된 앱 데이터를 지웠습니다' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FirebaseDB — 실서버 모드. gstatic modular SDK를 동적 import 한다.
// 실제 Firebase 프로젝트 없이는 실행 검증이 불가하므로 이 경로는 정적 검사까지만 했다.
// ─────────────────────────────────────────────────────────────────────────
class FirebaseDB {
  constructor() {
    this.mode = 'firebase';
    this.session = null;
    this.sdk = null;
    this.app = null;
    this.auth = null;
    this.fs = null;
    this.memoryCacheOnly = false;
    this.offlineProtection = true;   // false면 화면이 「오프라인 보호 꺼짐」 배너를 띄운다(A-4)
    this._cachedCourse = null;
    this._pendingKeys = {};
    this._revMismatch = false;       // 서버 courseRev와 캐시본이 어긋났고 자가 재캐시도 실패한 상태(A-3)
  }

  async _loadSdk() {
    if (this.sdk) return this.sdk;
    const urls = sdkUrls();
    const mods = await Promise.all(urls.map(function (u) { return import(u); }));
    this.sdk = { app: mods[0], auth: mods[1], fs: mods[2] };
    return this.sdk;
  }

  // useMemoryCache=true 는 「메모리 캐시로 계속하기」 선택지에서만 넘어온다(§2-8).
  async init(useMemoryCache) {
    const sdk = await this._loadSdk();
    this.app = sdk.app.initializeApp(firebaseConfig);
    this.auth = sdk.auth.getAuth(this.app);
    await sdk.auth.setPersistence(this.auth, sdk.auth.browserLocalPersistence);

    if (useMemoryCache) {
      this.fs = sdk.fs.initializeFirestore(this.app, { localCache: sdk.fs.memoryLocalCache() });
      this.memoryCacheOnly = true;
      this.offlineProtection = false;
      return { persistence: 'memory', offlineProtection: false };
    }

    // 양성 확인(A-4). SDK는 IndexedDB를 못 써도 예외 없이 메모리 캐시로 폴백하므로,
    // 예외를 기다리지 않고 우리가 먼저 IndexedDB를 열어 보고 실패하면 우리가 던진다.
    const okIdb = await probeIndexedDB();
    if (!okIdb) {
      const probeErr = new Error('이 창에서는 저장소(IndexedDB)를 열 수 없어 오프라인 보호를 켤 수 없습니다');
      probeErr.kind = 'persistence';
      throw probeErr;
    }

    try {
      this.fs = sdk.fs.initializeFirestore(this.app, {
        localCache: sdk.fs.persistentLocalCache({ tabManager: sdk.fs.persistentMultipleTabManager() })
      });
    } catch (e) {
      // 시크릿 창·저장소 차단·용량 부족. 호출자가 §2-8 안내 화면을 띄운다.
      const err = new Error('지속 캐시를 초기화하지 못했습니다');
      err.kind = 'persistence';
      err.cause = e;
      throw err;
    }

    // 초기화 뒤 저장 가능 여부를 한 번 더 본다. 여기서 실패하면 오류 화면이 아니라
    // 상시 배너로 알린다 — 앱은 계속 쓸 수 있어야 한다(A-4).
    const okQuota = await probeStorageEstimate();
    this.offlineProtection = okQuota;
    return { persistence: 'persistent', offlineProtection: okQuota };
  }

  // 화면이 시작할 때 한 번 부른다. 지속 캐시 실패는 kind:'persistence' 예외로 올린다.
  // 「메모리 캐시로 계속하기」를 고르면 localStorage 플래그가 남고 그 뒤로는 메모리 캐시로 뜬다.
  async ensureReady() {
    if (this.fs) {
      return {
        persistence: this.memoryCacheOnly ? 'memory' : 'persistent',
        offlineProtection: this.offlineProtection
      };
    }
    const useMemory = localStorage.getItem('dku:memoryCache') === '1';
    return this.init(useMemory);
  }

  async login(classId, groupNo, password) {
    const sdk = await this._loadSdk();
    const gid = pad2(groupNo);
    const email = groupEmail(classId, gid);
    try {
      await sdk.auth.signInWithEmailAndPassword(this.auth, email, password);
    } catch (e) {
      throw new Error(loginErrorText(e && e.code));
    }
    this.session = { classId: classId, gid: gid, groupNo: gid, email: email };
    const snap = await sdk.fs.getDoc(this._groupRef());
    if (!snap.exists()) throw new Error(CREDENTIAL_ERROR_TEXT);
    const g = snap.data();
    this._writeCourseCache(g.course || [], g.courseRev);
    return this.getState();
  }

  // 코스 캐시를 한 곳에서만 쓴다 — 로그인·자가 재캐시가 같은 경로를 지난다(A-3).
  _writeCourseCache(course, courseRev) {
    const s = this.session;
    if (!s) return false;
    this._cachedCourse = { course: course || [], courseRev: courseRev };
    if (courseRev != null) s.courseRev = courseRev;
    try {
      localStorage.setItem('dku:course:' + s.classId + '/' + s.gid, JSON.stringify(this._cachedCourse));
      this._revMismatch = false;
      return true;
    } catch (e) {
      // 저장소가 막힌 창. 다음 새로고침이면 옛 판이 되살아나므로 불일치로 남겨 알린다.
      this._revMismatch = true;
      return false;
    }
  }

  // 서버 스냅샷의 courseRev를 캐시본과 **실제로 비교**한다(A-3).
  // 어긋나면 서버본으로 조용히 다시 캐시하고(무중단 자가 복구), 그것이 안 되면
  // _revMismatch를 세워 화면이 「로그아웃 후 다시 로그인」을 안내하게 한다.
  // 캐시 코스에는 spotId가 없는데 서버 코스에는 있는 상태인가 (재작업 A-1).
  //
  // 왜 필요한가: `admin.updateCourse`는 `course`만 쓰고 **`courseRev`를 올리지 않는다.**
  // spotId는 바로 거기서 처음 생긴다. 그런데 아래 _reconcileRev의 재캐시 조건은
  // courseRev 비교 하나뿐이고, getState·onGroup의 코스 조립은 캐시본을 항상 앞세운다.
  // 그래서 v3에서 이미 로그인해 둔 기기(리허설·행사 아침)는 교사가 좌표를 다 찍어도
  // 옛 캐시를 계속 써서 **핀이 0개인 지도**를 영구히 보게 된다. 재로그인 말고는 길이 없다.
  // courseRev 비교는 그대로 두고 이 조건을 OR로 얹어 자가 복구시킨다(A-3 계약 유지).
  _cacheLacksSpotIds(g) {
    if (!g || !Array.isArray(g.course)) return false;
    const serverHasAny = g.course.some(function (c) {
      return c && typeof c.spotId === 'string' && c.spotId;
    });
    if (!serverHasAny) return false;
    const cached = this.getCachedCourse();
    const list = cached ? cached.course : null;
    if (!Array.isArray(list)) return false;
    return list.some(function (c) {
      return !c || typeof c.spotId !== 'string' || !c.spotId;
    });
  }

  _reconcileRev(g, metadata) {
    const s = this.session;
    if (!s) return;
    this._settlePending(g, metadata);
    if (!g || g.courseRev == null) return;
    const cachedRev = this._cachedCourse ? this._cachedCourse.courseRev : s.courseRev;
    if (cachedRev === g.courseRev) {
      this._revMismatch = false;
      // 판은 같은데 좌표 키만 새로 생긴 경우. 여기서 서버본으로 다시 캐시한다.
      // 저장에 실패해도 **재로그인 사유가 아니다** — courseRev는 여전히 같으므로
      // _writeCourseCache가 세웠을 수 있는 불일치 표시를 되돌린다.
      if (this._cacheLacksSpotIds(g)) {
        const stored = this._writeCourseCache(g.course, g.courseRev);
        this._revMismatch = false;
        // 저장에 실패하는 창(iOS 프라이빗·쿼터 초과)에서는 메모리 사본으로만 이번 세션을
        // 버틴다 — 새로고침하면 spotId 없는 옛 캐시가 되살아나 지도가 다시 빈다.
        // 재로그인 안내를 띄울 사안은 아니지만(코스 판은 같다) 조용히 넘기지도 않는다(B-9).
        if (!stored && !this._spotCacheWarned) {
          this._spotCacheWarned = true;
          console.warn('[db] 지도 좌표 키를 이 창의 저장소에 남기지 못했습니다.'
            + ' 새로고침하면 지도가 빈 채로 뜰 수 있습니다(사생활 보호 창·저장 공간 부족).');
        }
      }
      return;
    }
    if (Array.isArray(g.course)) {
      this._writeCourseCache(g.course, g.courseRev);
    } else {
      this._revMismatch = true;
    }
  }

  // 화면에 넘길 done 집합 (재작업 A-2 — §5 금지 16 방어).
  //
  // 오프라인에서 completeLocation이 하는 batch.set(groupRef, {done:{L0:serverTimestamp()}})은
  // Firestore **지연 보상(latency compensation)** 때문에 로컬 스냅샷의 done에 그 키를
  // 즉시 만들어 넣는다(값은 null이지만 키는 존재한다). statusOf는 done을 pending보다 먼저
  // 보므로(db.js 상단) 그대로 넘기면 아직 전송도 못 한 사진이 「완료(동기화됨)」로 뜬다 —
  // 같은 화면의 미전송 배지와 정면으로 모순되고, 지도에서는 완료 스탬프·폴라로이드까지
  // 붙어 증폭된다. MockDB는 오프라인에 pending에만 넣으므로 데모에서는 재현되지 않는다.
  //
  // statusOf의 시그니처·본문은 건드리지 않는다(§5 금지 29). **넘기기 전에** 이 인스턴스가
  // 대기로 알고 있는 키를 done에서 뺀다.
  //
  // **불변식: 마스킹에 쓰는 집합 == state의 `pending` 필드를 채우는 집합.**
  // 둘이 어긋나면 그 장소가 done도 pending도 아닌 상태로 떨어져 「현재 장소」로 되돌아간다.
  // 그래서 두 자리가 _waitingKeys() **하나**를 부른다 — 한쪽만 넓히는 변형이 나올 수 없다.
  //
  // 서버가 확정하면 _settlePending이 대기 키를 지우므로(이 함수보다 먼저, _reconcileRev
  // 첫 줄에서 돈다) done이 정상 노출된다.
  //
  // 재작업 A-5: 예전 판은 메모리(_pendingKeys)만 봤다. 그런데 **오프라인 업로드 → 폰 잠금 →
  // 다음 장소로 이동 → 앱 재개(새 페이지 로드)** 는 행사 당일의 기본 동작이고, 그 창에서는
  // 메모리 맵이 비어 있다. 그러면 지연 보상된 done 키가 그대로 노출되어 「완료(동기화됨)」가
  // 뜨고, pending도 비어 **미전송 배지까지 사라진다** — A-2가 막으려던 화면이 경고 장치까지
  // 꺼진 채 재현된다. Firestore mutation queue의 대기 쓰기는 IndexedDB에 남아 있으므로
  // 영속 기록(localStorage)이 그 창에서 유일한 신호다.
  _waitingKeys() {
    return Object.assign({}, this._readPersistedPending(), this._pendingKeys);
  }

  _visibleDone(g) {
    const done = (g && g.done) || {};
    const waiting = this._waitingKeys();
    const keys = Object.keys(waiting);
    if (!keys.length) return done;
    const out = {};
    Object.keys(done).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(waiting, k)) out[k] = done[k];
    });
    return out;
  }

  // ── 전송 대기 키의 영속 기록 (A-7) ──────────────────────────────────────
  // _pendingKeys는 인스턴스 메모리라 새로고침이면 사라진다. Firestore mutation queue는
  // IndexedDB에 남으므로, 기기 정리 가드가 새로고침을 넘겨 그 사실을 볼 수 있도록
  // 같은 키를 localStorage에도 남긴다(mission.html의 operationId와 같은 패턴).
  _pendingStoreKey() {
    const s = this.session;
    return s ? 'dku:pending:' + s.classId + '/' + s.gid : null;
  }

  _readPersistedPending() {
    const k = this._pendingStoreKey();
    if (!k) return {};
    try {
      const raw = localStorage.getItem(k);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  }

  _markPending(key, at) {
    this._pendingKeys[key] = at;
    const k = this._pendingStoreKey();
    if (!k) return;
    const map = this._readPersistedPending();
    map[key] = at;
    try { localStorage.setItem(k, JSON.stringify(map)); } catch (e) { /* 저장 실패는 메모리 기록으로 둔다 */ }
  }

  _clearPending(key) {
    delete this._pendingKeys[key];
    const k = this._pendingStoreKey();
    if (!k) return;
    const map = this._readPersistedPending();
    delete map[key];
    try {
      if (Object.keys(map).length) localStorage.setItem(k, JSON.stringify(map));
      else localStorage.removeItem(k);
    } catch (e) { /* 무시 */ }
  }

  // 서버가 승인한 것으로 확인된 대기 키를 청소한다 (B-9).
  //
  // _clearPending은 commit 프라미스 핸들러에서만 불린다. 그런데 오프라인 업로드 뒤
  // **새로고침**하면 그 프라미스는 사라지고, 재개된 탭에서 Firestore mutation queue가
  // 스스로 쓰기를 재생해 서버 승인을 받는다 — 그 경로에는 청소하는 사람이 아무도 없다.
  // 대기 키가 영구히 남으면 wipeLocalData 가드가 늘 「아직 전송되지 않은 사진 N장」을
  // 띄우는 영구 오탐이 되어, 진짜 미전송분을 경고해도 무시하게 만든다.
  //
  // 판정 신호는 이미 스냅샷에 있다 — fromCache=false(서버가 준 스냅샷)이고
  // hasPendingWrites=false(이 문서에 대기 중인 로컬 쓰기가 없음)이면, 그 스냅샷의
  // done에 들어온 키는 **서버가 확정한 완료**다.
  _settlePending(g, metadata) {
    if (!metadata || metadata.fromCache || metadata.hasPendingWrites) return [];
    const done = (g && g.done) || {};
    const watching = Object.assign({}, this._readPersistedPending(), this._pendingKeys);
    const settled = Object.keys(watching).filter(function (k) {
      return Object.prototype.hasOwnProperty.call(done, k);
    });
    const self = this;
    settled.forEach(function (k) { self._clearPending(k); });
    return settled;
  }

  async logout() {
    const sdk = await this._loadSdk();
    await sdk.auth.signOut(this.auth);
    this.session = null;
    return true;
  }

  _groupRef() {
    const sdk = this.sdk;
    const s = this.session;
    return sdk.fs.doc(this.fs, 'classes', s.classId, 'groups', s.gid);
  }

  _photoRef(locIndex) {
    const sdk = this.sdk;
    const s = this.session;
    return sdk.fs.doc(this.fs, 'classes', s.classId, 'groups', s.gid, 'photos', String(locIndex));
  }

  _metaRef(locIndex) {
    const sdk = this.sdk;
    const s = this.session;
    return sdk.fs.doc(this.fs, 'classes', s.classId, 'groups', s.gid, 'photoMeta', String(locIndex));
  }

  // 오프라인에서도 캐시된 코스를 돌려준다. courseRev가 어긋나면 재로그인을 유도한다.
  getCachedCourse() {
    const s = this.session;
    if (!s) return null;
    if (this._cachedCourse) {
      return {
        course: this._cachedCourse.course,
        courseRev: this._cachedCourse.courseRev,
        // 서버 스냅샷과의 실비교 결과다(_reconcileRev). 두 값을 같은 자리에서 채워
        // 영원히 false가 되던 자기 비교를 걷어냈다(A-3).
        revMismatch: this._revMismatch === true
      };
    }
    try {
      const raw = localStorage.getItem('dku:course:' + s.classId + '/' + s.gid);
      const c = raw ? JSON.parse(raw) : null;
      return c ? { course: c.course, courseRev: c.courseRev, revMismatch: this._revMismatch === true } : null;
    } catch (e) { return null; }
  }

  async getState() {
    const sdk = await this._loadSdk();
    const s = this.session;
    if (!s) return null;
    const snap = await sdk.fs.getDoc(this._groupRef());
    const g = snap.exists() ? snap.data() : {};
    this._reconcileRev(g, snap.metadata);        // 서버 rev 실비교 + 자가 재캐시 (A-3) + 대기 키 청소 (B-9)
    const failed = await vault.listFor(s.classId, s.gid);
    const cached = this.getCachedCourse();
    return {
      classId: s.classId, gid: s.gid, groupNo: g.groupNo || s.gid,
      course: (cached && cached.course) || g.course || [],
      courseRev: g.courseRev,
      revMismatch: this._revMismatch === true,
      done: this._visibleDone(g),   // 지연 보상으로 앞서 나온 done 키를 걷어낸다(A-2)
      pending: this._waitingKeys(), // 마스킹과 **같은 집합**이어야 한다(A-5 불변식)
      failed: failed.map(function (f) { return doneKey(f.locIndex); }),
      lastSyncAt: g.lastSyncAt || null
    };
  }

  async currentLocIndex() {
    const state = await this.getState();
    return state ? computeCurrentLocIndex(state) : 0;
  }

  // batch 1회로 photos + photoMeta + group.done merge 를 함께 쓴다.
  // 오프라인이면 commit 프라미스가 대기 상태로 남고(mutation queue) 'queued'를 반환한다.
  // 별도 재전송 큐를 만들지 않는다(§5 금지 14).
  async completeLocation(locIndex, fullB64, thumbB64, mime, operationId) {
    const sdk = await this._loadSdk();
    const s = this.session;
    if (!s) throw new Error('로그인이 필요합니다');
    assertPureBase64(fullB64);
    assertPureBase64(thumbB64);
    assertPayloadSize(fullB64, thumbB64);

    // rev는 로컬 캐시가 아니라 **직전에 읽은 그룹 스냅샷**에서 취한다(A-3).
    // 오프라인이면 getDoc이 지속 캐시본을 돌려주므로 그 값이 쓰인다.
    let snapRev = null;
    try {
      const snap = await sdk.fs.getDoc(this._groupRef());
      const g = snap.exists() ? snap.data() : {};
      this._reconcileRev(g, snap.metadata);
      if (g.courseRev != null) snapRev = g.courseRev;
    } catch (e) {
      // 캐시본조차 없는 첫 오프라인 진입. 아래 캐시 값으로 내려간다.
    }
    const cached = this.getCachedCourse();
    const rev = snapRev != null ? snapRev : (cached ? cached.courseRev : s.courseRev);
    const key = doneKey(locIndex);
    const self = this;

    // 오류 상태에서 다시 올린 사진은 실패 보관함의 옛 항목을 **교체**한다(확정 23-⑵).
    // 여기서 먼저 지우므로 이 호출이 대기로 남아도 화면은 「전송 오류」가 아니라 「전송 대기」가
    // 되고, 다시 거절되면 아래 catch가 새 payload를 같은 id로 넣는다. 장소당 1장이 유지된다.
    await vault.remove(vault.id(s.classId, s.gid, locIndex));

    const batch = sdk.fs.writeBatch(this.fs);
    batch.set(this._photoRef(locIndex), {
      full: fullB64, mime: mime, locIndex: locIndex,
      operationId: operationId, rev: rev, createdAt: sdk.fs.serverTimestamp()
    });
    batch.set(this._metaRef(locIndex), {
      thumb: thumbB64, mime: mime, locIndex: locIndex,
      operationId: operationId, rev: rev, uploadedAt: sdk.fs.serverTimestamp()
    });
    const donePatch = {};
    donePatch[key] = sdk.fs.serverTimestamp();
    batch.set(this._groupRef(), { done: donePatch, rev: rev }, { merge: true });

    this._markPending(key, new Date().toISOString());

    const commit = batch.commit().then(function () {
      self._clearPending(key);
      if (self._onStatusChange) self._onStatusChange(locIndex, 'synced');
      return 'synced';
    }).catch(async function (e) {
      self._clearPending(key);
      // 영구 거절(권한·용량)은 재전송으로 풀리지 않는다 — 보관하고 수동 재시도로 넘긴다.
      await vault.put({
        id: vault.id(s.classId, s.gid, locIndex),
        classId: s.classId, gid: s.gid, locIndex: locIndex,
        full: fullB64, thumb: thumbB64, mime: mime,
        operationId: operationId, rev: rev, savedAt: new Date().toISOString(),
        code: e && e.code ? e.code : 'unknown'
      });
      if (self._onStatusChange) self._onStatusChange(locIndex, 'error');
      return 'error';
    });

    // 1.2초 안에 서버 승인이 오지 않으면 「전송 대기」로 화면에 알린다.
    const settled = await Promise.race([
      commit,
      new Promise(function (r) { setTimeout(function () { r('queued'); }, 1200); })
    ]);
    return { status: settled };
  }

  onStatusChange(cb) { this._onStatusChange = cb; }

  async retryFailed(locIndex) {
    const s = this.session;
    if (!s) throw new Error('로그인이 필요합니다');
    const rows = await vault.listFor(s.classId, s.gid);
    const row = rows.filter(function (r) { return r.locIndex === locIndex; })[0];
    if (!row) throw new Error('보관된 사진이 없습니다');
    await vault.remove(row.id);
    return this.completeLocation(locIndex, row.full, row.thumb, row.mime, row.operationId);
  }

  async listFailed() {
    const s = this.session;
    if (!s) return [];
    return vault.listFor(s.classId, s.gid);
  }

  async listMyPhotos() {
    const sdk = await this._loadSdk();
    const s = this.session;
    if (!s) return [];
    const state = await this.getState();
    const failedRows = await vault.listFor(s.classId, s.gid);
    const out = [];
    for (const loc of (state.course || [])) {
      const st = statusOf(state, loc.locIndex);
      if (st !== 'synced' && st !== 'queued' && st !== 'error') continue;
      let rec = null;
      // 보관함 사본은 그 장소가 지금 「전송 오류」일 때만 쓴다(확정 23-⑶).
      // 승인·대기 상태인데 옛 보관본을 앞세우면 재업로드한 새 사진이 가려져
      // 장소당 1장 불변식이 깨진다.
      const f = st === 'error'
        ? failedRows.filter(function (r) { return r.locIndex === loc.locIndex; })[0]
        : null;
      if (f) {
        rec = { full: f.full, mime: f.mime, createdAt: f.savedAt };
      } else {
        const snap = await sdk.fs.getDoc(this._photoRef(loc.locIndex));
        if (snap.exists()) {
          const d = snap.data();
          rec = { full: d.full, mime: d.mime, createdAt: d.createdAt };
        }
      }
      if (!rec) continue;
      out.push({
        locIndex: loc.locIndex, name: loc.name, status: st,
        full: rec.full, mime: rec.mime, uploadedAt: rec.createdAt
      });
    }
    out.sort(function (a, b) { return a.locIndex - b.locIndex; });
    return out;
  }

  async getPhoto(gid, locIndex) {
    const sdk = await this._loadSdk();
    const s = this.session;
    const ref = sdk.fs.doc(this.fs, 'classes', s.classId, 'groups', gid, 'photos', String(locIndex));
    const snap = await sdk.fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
  }

  // config/frames 문서가 없거나 값이 비어 있으면 기본 문구를 돌려준다(A-6).
  // 기본값의 단일 원천은 frames.js의 DEFAULT_FRAME_TEXTS 하나뿐이다.
  async getFrameTexts() {
    const sdk = await this._loadSdk();
    const snap = await sdk.fs.getDoc(sdk.fs.doc(this.fs, 'config', 'frames'));
    const saved = snap.exists() ? snap.data() : null;
    return {
      top: (saved && saved.top) || DEFAULT_FRAME_TEXTS.top,
      bottom: (saved && saved.bottom) || DEFAULT_FRAME_TEXTS.bottom
    };
  }

  // 프레임별 설정·자산 요약 1건 읽기. 작은 문서라 학생 화면에서 매번 읽어도 부담이 없다.
  async getFrameAssetMeta() {
    const sdk = await this._loadSdk();
    try {
      const snap = await sdk.fs.getDoc(sdk.fs.doc(this.fs, 'config', FRAME_ASSET_META_DOC));
      return snap.exists() ? (snap.data() || {}) : {};
    } catch (e) {
      // 오프라인 첫 진입이면 캐시본이 없다. 프레임 이미지는 색 프레임으로 대체 가능하므로
      // 여기서 던지지 않는다 — 네컷 만들기 자체를 막으면 안 된다.
      return {};
    }
  }

  // ── 지도 스팟 좌표 (§3-C) ───────────────────────────────────────────────
  // 작은 문서 1건이다. 화면 초기화에서 **1회만** 부른다 — 재렌더마다 부르면 용량 산식이
  // 깨진다(§3-B 캐시 계약 · §5 금지 35). 호출 횟수를 지키는 것은 화면 쪽 책임이다.
  async _readMapSpots() {
    const sdk = await this._loadSdk();
    const snap = await sdk.fs.getDoc(sdk.fs.doc(this.fs, 'config', MAP_SPOTS_DOC));
    return snap.exists() ? (snap.data() || {}) : {};
  }

  async getMapSpots() {
    try {
      return normalizeMapSpots(await this._readMapSpots());
    } catch (e) {
      // 오프라인 첫 진입이면 캐시본이 없다. 여기서 던지면 지도 화면 자체가 뜨지 않는다 —
      // 좌표 없이도 「위치 미지정」 줄과 목록 전환으로 기능이 유지되어야 한다(§6 ⑺).
      return { byId: {} };
    }
  }

  // 한 프레임의 이미지 본문(최대 2건). 슬롯마다 문서가 따로라 1MiB 한도를 장당으로 쓴다.
  async getFrameAssetImages(frameId) {
    const sdk = await this._loadSdk();
    const out = {};
    for (const kind of FRAME_ASSET_KINDS) {
      try {
        const snap = await sdk.fs.getDoc(sdk.fs.doc(this.fs, 'config', frameAssetDocId(frameId, kind)));
        const d = snap.exists() ? snap.data() : null;
        if (d && d.b64) out[kind] = { b64: d.b64, mime: d.mime };
      } catch (e) {
        // 한 슬롯을 못 읽어도 나머지는 쓴다.
      }
    }
    return out;
  }

  // ── 사후 설문 (설문 v1 §3 단계 1) ───────────────────────────────────────
  // 문서 4종: survey/config · survey/roster · survey/rosterPins(교사 전용) ·
  // surveyAnswers/{sid}-{pin}. 학생은 목록을 시도하지 않는다(§5 금지 8c) —
  // 목록이 열리면 문서 id에 실린 PIN이 통째로 샌다.
  _surveyRef(cid, docId) {
    return this.sdk.fs.doc(this.fs, 'classes', cid, SURVEY_COLLECTION, docId);
  }

  _answerRef(cid, aid) {
    return this.sdk.fs.doc(this.fs, 'classes', cid, SURVEY_ANSWERS_COLLECTION, aid);
  }

  async getRoster(cid) {
    const sdk = await this._loadSdk();
    const snap = await sdk.fs.getDoc(this._surveyRef(cid, SURVEY_DOC.roster));
    const d = snap.exists() ? (snap.data() || {}) : {};
    return { students: d.students || {}, updatedAt: d.updatedAt || null };
  }

  // 등록·재등록 공통 경로. 기존 학번의 PIN을 보존하고 신규 학번에만 발급한다(§5 금지 8d).
  // rosterPins는 교사 전용 문서다 — roster에는 pins를 싣지 않는다(§5 금지 8b).
  async saveRoster(cid, students) {
    const sdk = await this._loadSdk();
    const norm = normalizeRoster(students);
    const pinsSnap = await sdk.fs.getDoc(this._surveyRef(cid, SURVEY_DOC.rosterPins));
    const prevPins = pinsSnap.exists() ? ((pinsSnap.data() || {}).pins || {}) : {};
    const merged = mergeRosterPins(prevPins, norm.sids);
    const batch = sdk.fs.writeBatch(this.fs);
    batch.set(this._surveyRef(cid, SURVEY_DOC.roster), {
      students: norm.students, updatedAt: sdk.fs.serverTimestamp()
    });
    batch.set(this._surveyRef(cid, SURVEY_DOC.rosterPins), { pins: merged.pins });
    await batch.commit();
    return { count: norm.sids.length, kept: merged.kept, issued: merged.issued };
  }

  async getRosterPins(cid) {
    const sdk = await this._loadSdk();
    const snap = await sdk.fs.getDoc(this._surveyRef(cid, SURVEY_DOC.rosterPins));
    return { pins: snap.exists() ? ((snap.data() || {}).pins || {}) : {} };
  }

  async getSurveyConfig(cid) {
    const sdk = await this._loadSdk();
    const snap = await sdk.fs.getDoc(this._surveyRef(cid, SURVEY_DOC.config));
    return normalizeSurveyConfig(snap.exists() ? snap.data() : null);
  }

  // closed를 **항상 함께 쓴다**(기본 false) — 규칙의 .get('closed', false) 폴백과 이중 방어.
  async saveSurveyConfig(cid, cfg) {
    const sdk = await this._loadSdk();
    const src = cfg && typeof cfg === 'object' ? cfg : {};
    const doc = { closed: src.closed === true, updatedAt: sdk.fs.serverTimestamp() };
    if (src.questions !== undefined) {
      const v = validateQuestions(src.questions);
      if (!v.ok) throw new Error(v.errors.join(' / '));
      doc.questions = v.questions;
    }
    await sdk.fs.setDoc(this._surveyRef(cid, SURVEY_DOC.config), doc, { merge: true });
    return this.getSurveyConfig(cid);
  }

  // PIN이 틀리면 문서 주소가 달라져 읽히지 않는다. 거부도 조용히 null이다(추정 ③-d) —
  // 「PIN 틀림」과 「미제출」을 구분해 알려주면 그 응답 자체가 PIN 확인 채널이 된다.
  async getSurveyAnswer(cid, sid, pin) {
    const sdk = await this._loadSdk();
    const aid = answerDocId(sid, pin);
    try {
      const snap = await sdk.fs.getDoc(this._answerRef(cid, aid));
      return snap.exists() ? Object.assign({ aid: aid }, snap.data()) : null;
    } catch (e) {
      if (e && e.code === SURVEY_DENIED_CODE) return null;
      throw e;
    }
  }

  // 학생 경로. rosterPins를 읽지 않는다(읽을 수 없다) — PIN 대조는 규칙이 서버에서 한다.
  // 틀린 PIN은 읽기에서 조용하고 **쓰기에서 permission-denied로 터진다**. 화면은 그 코드를
  // PIN 오류로 안내하고 작성 내용을 기기에 보존한다(§3 단계 2).
  async submitSurveyAnswer(cid, sid, pin, payload) {
    const sdk = await this._loadSdk();
    const s = this.session;
    if (!s) throw new Error('로그인이 필요합니다');
    const sidOk = assertSid(sid);
    const pinOk = assertPin(pin);
    const roster = await this.getRoster(cid);
    const name = (roster.students || {})[sidOk];
    if (!name) throw surveyDenied('명렬표에 없는 학번입니다');

    const aid = answerDocId(sidOk, pinOk);
    const ref = this._answerRef(cid, aid);
    const prev = await this.getSurveyAnswer(cid, sidOk, pinOk);
    const groupNo = prev ? prev.groupNo : s.groupNo;
    const body = buildAnswerBody(sidOk, name, groupNo, (payload || {}).answers);
    body.updatedAt = sdk.fs.serverTimestamp();
    if (prev) {
      await sdk.fs.setDoc(ref, body, { merge: true });
    } else {
      body.submittedAt = sdk.fs.serverTimestamp();
      await sdk.fs.setDoc(ref, body);
    }
    return { aid: aid, updated: !!prev };
  }

  // 교사 전용. 규칙에서 list는 isTeacher()만 통과한다.
  async listSurveyAnswers(cid) {
    const sdk = await this._loadSdk();
    const snap = await sdk.fs.getDocs(sdk.fs.collection(this.fs, 'classes', cid, SURVEY_ANSWERS_COLLECTION));
    return snap.docs.map(function (d) {
      return Object.assign({ aid: d.id, sid: sidOfAnswerId(d.id) }, d.data());
    }).sort(function (a, b) { return String(a.aid) < String(b.aid) ? -1 : 1; });
  }

  onGroup(cb) {
    const sdk = this.sdk;
    if (!sdk || !this.fs) throw new Error('ensureReady()를 먼저 호출해야 합니다');
    const self = this;
    return sdk.fs.onSnapshot(this._groupRef(), { includeMetadataChanges: true }, function (snap) {
      const g = snap.exists() ? snap.data() : {};
      // 구독 중 판이 바뀌어도 여기서 잡는다(A-3). 새로고침 뒤 mutation queue가 스스로
      // 재생해 서버 승인을 받는 경로는 이 구독 콜백으로만 관측되므로, 대기 키 청소(B-9)도
      // 여기가 실질적인 회수 지점이다.
      self._reconcileRev(g, snap.metadata);
      vault.listFor(self.session.classId, self.session.gid).then(function (failed) {
        const cached = self.getCachedCourse();
        cb({
          classId: self.session.classId, gid: self.session.gid, groupNo: g.groupNo || self.session.gid,
          course: (cached && cached.course) || g.course || [],
          courseRev: g.courseRev,
          revMismatch: self._revMismatch === true,
          done: self._visibleDone(g),   // 지연 보상으로 앞서 나온 done 키를 걷어낸다(A-2)
          pending: self._waitingKeys(), // 마스킹과 **같은 집합**이어야 한다(A-5 불변식)
          failed: failed.map(function (f) { return doneKey(f.locIndex); }),
          hasPendingWrites: snap.metadata.hasPendingWrites,
          lastSyncAt: snap.metadata.fromCache ? null : new Date().toISOString()
        });
      });
    });
  }

  // 대시보드는 groups + photoMeta(thumb)까지만 구독한다. 원본은 getPhoto로 1건씩.
  onDashboard(classId, cb) {
    const sdk = this.sdk;
    if (!sdk || !this.fs) throw new Error('ensureReady()를 먼저 호출해야 합니다');
    const self = this;
    const groupsRef = sdk.fs.collection(this.fs, 'classes', classId, 'groups');
    const rows = {};
    const metaUnsubs = [];
    const emit = function () {
      cb(Object.keys(rows).sort().map(function (k) { return rows[k]; }));
    };
    const unsub = sdk.fs.onSnapshot(groupsRef, function (snap) {
      snap.docs.forEach(function (d) {
        const g = d.data();
        const state = { course: g.course || [], done: g.done || {}, pending: {}, failed: [] };
        rows[d.id] = {
          gid: d.id, groupNo: g.groupNo || d.id, course: g.course || [],
          done: g.done || {}, currentLocIndex: computeCurrentLocIndex(state),
          thumbs: (rows[d.id] && rows[d.id].thumbs) || []
        };
        if (!rows[d.id].__metaBound) {
          rows[d.id].__metaBound = true;
          metaUnsubs.push(sdk.fs.onSnapshot(
            sdk.fs.collection(self.fs, 'classes', classId, 'groups', d.id, 'photoMeta'),
            function (ms) {
              rows[d.id].thumbs = ms.docs.map(function (m) {
                const v = m.data();
                return { locIndex: v.locIndex, thumb: v.thumb, mime: v.mime, uploadedAt: v.uploadedAt };
              }).sort(function (a, b) { return a.locIndex - b.locIndex; });
              emit();
            }
          ));
        }
      });
      emit();
    });
    return function () {
      unsub();
      metaUnsubs.forEach(function (f) { f(); });
    };
  }

  get admin() {
    const self = this;
    return {
      // 확정 15′-⑷ 사슬: 보조 App(inMemoryPersistence)로 createUser →
      // 교사 세션으로 모둠 문서 기록 → 실패 시 방금 만든 사용자 삭제 시도 →
      // finally signOut · deleteApp.
      async createGroup(classId, groupNo, password, course) {
        const sdk = await self._loadSdk();
        const gid = pad2(groupNo);
        const email = groupEmail(classId, gid);
        const secondary = sdk.app.initializeApp(firebaseConfig, 'secondary-' + Date.now());
        const secAuth = sdk.auth.getAuth(secondary);
        let created = null;
        try {
          await sdk.auth.setPersistence(secAuth, sdk.auth.inMemoryPersistence);
          const cred = await sdk.auth.createUserWithEmailAndPassword(secAuth, email, password);
          created = cred.user;
          const clsRef = sdk.fs.doc(self.fs, 'classes', classId);
          const clsSnap = await sdk.fs.getDoc(clsRef);
          const rev = clsSnap.exists() ? clsSnap.data().courseRev : 1;
          // 반 문서를 **먼저 보장한다**(A-1). 보안 규칙의 revOk()가 이 문서를 get()하므로,
          // 이 문서가 없으면 학생 쓰기가 전량 거부된다. 하위 컬렉션을 써도 부모 문서는 생기지 않는다.
          await sdk.fs.setDoc(clsRef, { classId: classId, courseRev: rev }, { merge: true });

          // 비파괴(A-5). 이미 있는 모둠 문서는 계정 정보만 보정하고 course·done은 건드리지 않는다.
          const gRef = sdk.fs.doc(self.fs, 'classes', classId, 'groups', gid);
          const gSnap = await sdk.fs.getDoc(gRef);
          if (gSnap.exists()) {
            await sdk.fs.setDoc(gRef, { groupNo: gid, email: email }, { merge: true });
          } else {
            await sdk.fs.setDoc(gRef, {
              groupNo: gid, email: email, courseRev: rev,
              course: ensureSpotIds(course || []), done: {}, createdAt: sdk.fs.serverTimestamp()
            });
          }
          return { gid: gid, email: email, reissued: gSnap.exists() };
        } catch (e) {
          if (created) {
            try { await sdk.auth.deleteUser(created); } catch (ignored) { /* 보상 실패는 안내서 절차로 */ }
          }
          throw e;
        } finally {
          try { await sdk.auth.signOut(secAuth); } catch (ignored) { /* 무시 */ }
          try { await sdk.app.deleteApp(secondary); } catch (ignored) { /* 무시 */ }
        }
      },

      async updateCourse(classId, gid, course) {
        const sdk = await self._loadSdk();
        const ref = sdk.fs.doc(self.fs, 'classes', classId, 'groups', gid);
        const snap = await sdk.fs.getDoc(ref);
        if (!snap.exists()) throw new Error('없는 모둠입니다');
        const g = snap.data();
        // 잠금 판정은 db.js의 단일 함수 하나만 쓴다(§3-C).
        const hasDone = isCourseLocked(g.done);
        if (hasDone) {
          const old = g.course || [];
          if (course.length < old.length) throw new Error('첫 완료 이후에는 장소를 삭제할 수 없습니다');
          for (let i = 0; i < old.length; i += 1) {
            if (course[i].locIndex !== old[i].locIndex) {
              throw new Error('첫 완료 이후에는 장소 순서를 바꿀 수 없습니다');
            }
          }
        }
        // spotId 없는 항목에 저장 시점에 부여한다(§3-C ⑶). 이미 있는 id는 그대로 간다.
        await sdk.fs.updateDoc(ref, { course: ensureSpotIds(course) });
        return true;
      },

      // ── 지도 스팟 좌표 (§3-C) ─────────────────────────────────────────
      // 개별 필드 merge다 — 다른 스팟의 좌표를 지우지 않는다.
      // 규칙은 기존 config/{doc} 그대로 쓴다(§5 금지 25).
      async setMapSpot(spotId, xy) {
        const id = assertSpotId(spotId);
        const p = assertSpotXy(xy);
        const sdk = await self._loadSdk();
        const patch = { byId: {} };
        patch.byId[id] = p;
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', MAP_SPOTS_DOC), patch, { merge: true });
        return p;
      },

      async clearMapSpot(spotId) {
        const id = assertSpotId(spotId);
        const sdk = await self._loadSdk();
        const patch = { byId: {} };
        // deleteField()가 있으면 필드를 지우고, 없으면 null로 덮는다.
        // 읽기 쪽(normalizeMapSpots)이 0~1 유한수가 아닌 값을 버리므로 어느 쪽이든 결과가 같다.
        patch.byId[id] = typeof sdk.fs.deleteField === 'function' ? sdk.fs.deleteField() : null;
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', MAP_SPOTS_DOC), patch, { merge: true });
        return true;
      },

      // courseRev를 올리고 사진·완료 집합을 500건 배치로 지운다. 중단되면 다시 호출해 이어간다.
      async resetData(classId, onProgressText) {
        const sdk = await self._loadSdk();
        const groupsSnap = await sdk.fs.getDocs(sdk.fs.collection(self.fs, 'classes', classId, 'groups'));
        let removed = 0;
        for (const gDoc of groupsSnap.docs) {
          for (const sub of ['photos', 'photoMeta']) {
            let done = false;
            while (!done) {
              const q = sdk.fs.query(
                sdk.fs.collection(self.fs, 'classes', classId, 'groups', gDoc.id, sub),
                sdk.fs.limit(500)
              );
              const page = await sdk.fs.getDocs(q);
              if (page.empty) { done = true; break; }
              const batch = sdk.fs.writeBatch(self.fs);
              page.docs.forEach(function (d) { batch.delete(d.ref); });
              await batch.commit();
              removed += page.size;
              if (onProgressText) onProgressText(removed + '건 삭제');
              if (page.size < 500) done = true;
            }
          }
        }
        const clsRef = sdk.fs.doc(self.fs, 'classes', classId);
        const clsSnap = await sdk.fs.getDoc(clsRef);
        const nextRev = (clsSnap.exists() ? clsSnap.data().courseRev : 1) + 1;
        // 반 문서가 없을 수도 있다(옛 설치본). updateDoc은 없는 문서에 예외를 던지므로
        // merge 쓰기로 만들면서 올린다(A-1).
        await sdk.fs.setDoc(clsRef, { classId: classId, courseRev: nextRev }, { merge: true });
        const batch2 = sdk.fs.writeBatch(self.fs);
        groupsSnap.docs.forEach(function (d) {
          batch2.update(d.ref, { done: {}, courseRev: nextRev });
        });
        await batch2.commit();
        await vault.clear();
        return { removed: removed, courseRev: nextRev };
      },

      async setFrameTexts(texts) {
        const sdk = await self._loadSdk();
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', 'frames'), texts, { merge: true });
        return true;
      },

      // 이미지 1장 = 문서 1개(확정 27-⑶). 규칙은 기존 config/{doc} 그대로 쓴다(§5 금지 20).
      async setFrameAsset(frameId, kind, asset) {
        const bytes = assertFrameAsset(kind, asset);
        const sdk = await self._loadSdk();
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', frameAssetDocId(frameId, kind)), {
          b64: asset.b64, mime: asset.mime, bytes: bytes,
          width: asset.width || null, height: asset.height || null,
          frameId: frameId, kind: kind,
          updatedAt: sdk.fs.serverTimestamp()
        });
        // 메타는 merge로 얹는다 — 다른 프레임·다른 슬롯의 기록을 지우지 않는다(비파괴).
        const patch = {};
        patch[frameId] = {};
        patch[frameId][kind] = {
          mime: asset.mime, bytes: bytes,
          width: asset.width || null, height: asset.height || null
        };
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', FRAME_ASSET_META_DOC), patch, { merge: true });
        return { bytes: bytes };
      },

      async clearFrameAsset(frameId, kind) {
        if (FRAME_ASSET_KINDS.indexOf(kind) < 0) throw new Error('알 수 없는 프레임 이미지 종류입니다: ' + kind);
        const sdk = await self._loadSdk();
        await sdk.fs.deleteDoc(sdk.fs.doc(self.fs, 'config', frameAssetDocId(frameId, kind)));
        const patch = {};
        patch[frameId] = {};
        patch[frameId][kind] = null;
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', FRAME_ASSET_META_DOC), patch, { merge: true });
        return true;
      },

      async setFrameOptions(frameId, options) {
        const sdk = await self._loadSdk();
        const entry = {};
        if (options && options.layoutId) entry.layoutId = options.layoutId;
        if (options && typeof options.hideTexts === 'boolean') entry.hideTexts = options.hideTexts;
        const patch = {};
        patch[frameId] = entry;
        await sdk.fs.setDoc(sdk.fs.doc(self.fs, 'config', FRAME_ASSET_META_DOC), patch, { merge: true });
        return true;
      }
    };
  }

  // terminate → clearIndexedDbPersistence 순서를 지킨다(공식 선행 요건).
  // 전송 대기·실패 보관분이 남아 있으면 force 없이는 거부한다.
  //
  // 가드는 **영속 신호**를 본다(A-7). _pendingKeys는 인스턴스 메모리라 새로고침이면
  // 비어 버리는데, Firestore mutation queue의 대기 쓰기는 IndexedDB에 그대로 남는다.
  // 그래서 ⑴ localStorage에 남긴 대기 키와 ⑵ 캐시본 스냅샷의 metadata.hasPendingWrites 를
  // 함께 세어, 새로고침 뒤에도 미전송 사진을 무경고로 지우지 않는다.
  async wipeLocalData(opts) {
    const sdk = await this._loadSdk();
    const force = !!(opts && opts.force);
    const s = this.session;

    const memoryKeys = Object.keys(this._pendingKeys);
    const persistedKeys = Object.keys(this._readPersistedPending());
    const union = {};
    memoryKeys.concat(persistedKeys).forEach(function (k) { union[k] = true; });
    let pendingCount = Object.keys(union).length;

    let hasPendingWrites = false;
    if (s && this.fs) {
      try {
        const snap = await sdk.fs.getDocFromCache(this._groupRef());
        hasPendingWrites = !!(snap && snap.metadata && snap.metadata.hasPendingWrites);
      } catch (e) {
        hasPendingWrites = false;   // 캐시본이 없다 = 대기 쓰기도 없다
      }
    }
    if (hasPendingWrites && pendingCount === 0) pendingCount = 1;

    let failedCount = 0;
    if (s) failedCount = (await vault.listFor(s.classId, s.gid)).length;
    const blocked = pendingCount + failedCount;
    if (blocked > 0 && !force) {
      return {
        ok: false, blocked: blocked, pendingCount: pendingCount, failedCount: failedCount,
        message: '아직 전송되지 않은 사진 ' + blocked + '장이 있습니다'
      };
    }
    try { await sdk.auth.signOut(this.auth); } catch (ignored) { /* 무시 */ }
    await sdk.fs.terminate(this.fs);
    await sdk.fs.clearIndexedDbPersistence(this.app);
    await vault.clear();
    const pendingKey = this._pendingStoreKey();
    if (pendingKey) {
      try { localStorage.removeItem(pendingKey); } catch (ignored) { /* 무시 */ }
    }
    this._pendingKeys = {};
    this.session = null;
    return { ok: true, blocked: 0, pendingCount: pendingCount, failedCount: failedCount, message: '이 기기에 저장된 앱 데이터를 지웠습니다' };
  }
}

// ── 팩토리 ────────────────────────────────────────────────────────────────
// MODE 값만 보고 고른다. 초기화가 실패해도 데모로 자동 전환하지 않는다(§5 금지 10).
export function createDb() {
  return MODE === 'firebase' ? new FirebaseDB() : new MockDB();
}

export const db = createDb();
export { MockDB, FirebaseDB };
