// firebase-config.js — 실행 모드 · SDK 버전 · 반 목록의 단일 원천 (규약 F-1)
// 설계지시안 v3.1 §2-8 / §1-3 「반 목록의 원천」 / §5 금지 10 적용.
//
// 이 파일에서만 바꾸는 값 3가지
//   1) MODE          : "demo" 또는 "firebase" — 자동 전환하지 않는다(§5 금지 10)
//   2) firebaseConfig: Firebase 콘솔에서 복사한 값 (MODE가 "firebase"일 때만 쓰인다)
//   3) classIds      : 운영할 반 ID 목록 — 로그인 화면 드롭다운의 단일 원천

// 앱 셸 캐시 버전. 사이트 파일을 고치면 이 값을 올린다(서비스 워커가 캐시를 갈아낀다).
export const APP_VERSION = 'v4';

// gstatic Firebase SDK 버전 — 이 상수 1곳에서만 조립한다(F-1, v3.1 §1-3 B-6).
export const SDK_VERSION = '12.0.0';

// 실행 모드. 명시 필드이며 초기화 실패 시에도 자동으로 "demo"로 내려가지 않는다.
export const MODE = 'firebase';

// 반 ID 목록 — 인증 전에 Firestore를 읽지 않기 위한 클라이언트 상수(v3.1 §1-3, §5 금지 5 단서).
// 반을 늘릴 때: 이 배열에 ID를 추가하고 관리 화면에서 그 반을 생성한다.
export const classIds = ['1-4'];

// 반 ID → 화면 표기 이름. 표기가 없으면 ID를 그대로 쓴다.
export const classLabels = { '1-4': '1학년 4반' };

// 데모 모드에서 쓰는 가상 프로젝트 ID(모둠 이메일 조립용). 실제 프로젝트가 아니다.
export const DEMO_PROJECT_ID = 'demo-dku-fourcut';

// Firebase 콘솔 → 프로젝트 설정 → 웹앱 → SDK 설정에서 복사해 붙여넣는다.
// MODE가 "demo"인 동안에는 사용되지 않는다.
export const firebaseConfig = {
  apiKey: 'AIzaSyAMe_8AmLEobI__PgRMnC26fDcGwIqf1SM',
  authDomain: 'dku-fieldtrip-2026.firebaseapp.com',
  projectId: 'dku-fieldtrip-2026',
  appId: '1:1092062613691:web:94eee25f1f649b7bde199e'
};

// 지금 모드에서 모둠 이메일 조립에 쓸 프로젝트 ID.
export function activeProjectId() {
  return MODE === 'firebase' ? firebaseConfig.projectId : DEMO_PROJECT_ID;
}

// 서비스 워커가 캐시해야 하는 gstatic 모듈 3개.
// firebase-firestore.js가 firebase-app.js를 절대 URL로 import하므로 셋 다 필요하다(v3.1 §1-3 B-6).
export function sdkUrls() {
  const base = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  return [
    base + 'firebase-app.js',
    base + 'firebase-auth.js',
    base + 'firebase-firestore.js'
  ];
}

// ── 초기화 실패 화면 (§2-8) ───────────────────────────────────────────────
// kind: 'persistence' = 지속 캐시(IndexedDB) 초기화 실패 — 시크릿 창·저장소 차단·용량 부족
//       'fatal'       = 그 밖의 초기화 실패
// 재시도만 반복하는 UI를 만들지 않는다. 'persistence'에서는 원인 안내와
// 「메모리 캐시로 계속하기」 선택지를 함께 준다.
export function renderInitError(container, opts) {
  const kind = opts && opts.kind ? opts.kind : 'fatal';
  const detail = opts && opts.detail ? String(opts.detail) : '';
  container.textContent = '';

  const box = document.createElement('div');
  box.className = 'init-error';
  box.setAttribute('role', 'alert');

  const h = document.createElement('h2');
  h.textContent = kind === 'persistence' ? '이 창에서는 오프라인 보호를 켤 수 없습니다' : '앱을 시작하지 못했습니다';
  box.appendChild(h);

  const p = document.createElement('p');
  p.textContent = kind === 'persistence'
    ? '사생활 보호(시크릿) 창에서는 사용할 수 없습니다. 일반 창에서 다시 열어 주세요.'
    : '네트워크 상태를 확인한 뒤 다시 시도해 주세요.';
  box.appendChild(p);

  if (detail) {
    const d = document.createElement('p');
    d.className = 'init-error-detail';
    d.textContent = detail;
    box.appendChild(d);
  }

  const actions = document.createElement('div');
  actions.className = 'init-error-actions';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.id = 'init-retry';
  retry.textContent = '다시 시도';
  retry.addEventListener('click', function () { if (opts && opts.onRetry) opts.onRetry(); });
  actions.appendChild(retry);

  if (kind === 'persistence' && opts && opts.onMemoryCache) {
    const mem = document.createElement('button');
    mem.type = 'button';
    mem.id = 'init-memory-cache';
    mem.className = 'secondary';
    mem.textContent = '메모리 캐시로 계속하기';
    mem.addEventListener('click', function () { opts.onMemoryCache(); });
    actions.appendChild(mem);

    const warn = document.createElement('p');
    warn.className = 'init-error-warn';
    warn.textContent = '메모리 캐시로 계속하면 오프라인 보호가 없습니다. 창을 닫거나 새로고침하면 전송 대기 중이던 사진이 사라집니다.';
    box.appendChild(warn);
  }

  box.appendChild(actions);
  container.appendChild(box);
}

// ── 오프라인 보호 꺼짐 배너 (S-검토 A-4) ──────────────────────────────────
// 지속 캐시를 **양성 확인**하지 못한 창(사생활 보호 창·저장소 차단·「메모리 캐시로 계속하기」)에
// 상시로 띄운다. 오류 화면이 아니다 — 앱은 계속 쓸 수 있어야 한다.
// 아침 점검은 「이 배너가 없는 것」을 눈으로 확인하는 양성 확인 절차가 된다.
export const PERSISTENCE_BANNER_TEXT = '이 창에서는 오프라인 보호가 꺼져 있습니다';

export function renderPersistenceBanner(container) {
  if (!container || document.getElementById('persistence-banner')) return null;

  const box = document.createElement('p');
  box.id = 'persistence-banner';
  box.className = 'error offline-warning';
  box.setAttribute('role', 'alert');
  box.textContent = PERSISTENCE_BANNER_TEXT
    + ' — 새로고침하거나 창을 닫으면 전송 대기 중이던 사진이 사라질 수 있습니다.'
    + ' 사생활 보호(시크릿) 창이면 일반 창에서 다시 열어 주세요.';

  container.insertBefore(box, container.firstChild);
  return box;
}
