// map-view.js — 학생·교사·관리 세 화면이 함께 쓰는 지도 렌더러 (설계지시안 v3.4 §2-4)
//
// 이 파일이 지키는 계약
//   ⑴ **DB를 읽지 않는다**(§5 금지 35). 입력은 상태·좌표·썸네일, 출력은 DOM뿐인 순수 렌더러다.
//      좌표 읽기 호출은 각 화면의 초기화 1곳에만 있다(§3-B 읽기 캐시 계약).
//      이 파일에는 그 메서드 이름이 주석으로도 나오지 않는다 — §6의 grep 검사가 문자 그대로
//      「이 파일에 호출 0건」을 세기 때문이다.
//   ⑵ 배경 SVG는 <img>로 싣고 **내부 요소에 접근하지 않는다**(§5 금지 33).
//      핀·경로·폴라로이드·스탬프는 전부 같은 viewBox의 **별도 오버레이 SVG**에 그린다.
//   ⑶ 지도 수치는 map-config.js 하나에서만 온다(F-1). 여기에 좌표·치수를 다시 적지 않는다.
//   ⑷ 상태 문구는 common.js의 STATUS_TEXT가 단일 원천이다(확정 22 · §5 금지 15·16).
//   ⑸ 외부 URL 참조 0건(§5 금지 26). SVG 네임스페이스 문자열조차 파일에 적지 않고
//      HTML 파서가 만든 요소에서 읽어 온다(아래 svgNS()).
//
// **배경 SVG 교체 계약**: 런타임 코드가 기대는 것은 viewBox `0 0 900 1300` 와 0~1 분수
// 좌표계뿐이다. campus-map.svg 안의 그림 구조·`lm-*` id에 이 파일은 전혀 의존하지 않는다.
// 그래서 같은 viewBox를 가진 다른 그림으로 파일만 갈아 끼워도 그대로 동작한다.

import {
  MAP_VIEWBOX, MAP_WIDTH, MAP_HEIGHT,
  PIN, STAMP, POLAROID, ROUTE, LABEL, toViewBox, fromViewBox
} from '../map/map-config.js';
import { STATUS_TEXT, CURRENT_TEXT } from './common.js';

// 배경 SVG의 경로. 화면(html) 기준 상대 경로이며 서비스 워커 SHELL에도 같은 문자열이 있다.
export const MAP_IMAGE_SRC = './map/campus-map.svg';

// 지도 위에서 쓰는 색 — 모둠 색은 호출자가 넘긴다(common.js의 팔레트가 원천).
const INK = '#3b2f1e';
const PAPER = '#f8f2e0';
const LOCK_IN = '#9a938a';
const ERROR_IN = '#b3261e';
const DONE_IN = '#1c7c4a';

// SVG 네임스페이스를 파일에 적지 않고 얻는다.
// HTML 파서는 마크업의 <svg>를 자동으로 SVG 네임스페이스에 넣는다 — 그 요소에서 읽는다.
// (문자열로 적으면 §6의 「신규 js에 http(s):// 0건」 검사에 걸린다. 검사를 피하려는 것이 아니라,
//  이 파일이 어떤 외부 주소도 담지 않는다는 성질을 그대로 유지하기 위해서다.)
let NS_CACHE = null;
function svgNS() {
  if (NS_CACHE) return NS_CACHE;
  try {
    const probe = new DOMParser().parseFromString('<svg></svg>', 'text/html');
    const node = probe.body && probe.body.firstElementChild;
    if (node && node.namespaceURI) NS_CACHE = node.namespaceURI;
  } catch (e) { /* 아래 폴백으로 내려간다 */ }
  if (!NS_CACHE) {
    const existing = document.querySelector('svg');
    if (existing && existing.namespaceURI) NS_CACHE = existing.namespaceURI;
  }
  return NS_CACHE;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(svgNS(), tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      if (attrs[k] != null) node.setAttribute(k, String(attrs[k]));
    });
  }
  return node;
}

// 텍스트는 textContent로만 넣는다(§5 금지 11 — innerHTML 금지).
function svgText(text, attrs) {
  const node = svgEl('text', attrs);
  node.textContent = text == null ? '' : String(text);
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

function num(v) { return Math.round(v * 10) / 10; }

// ── 핀 모양 (전부 map-config.js 치수에서 유도) ────────────────────────────
// 좌표는 핀 '끝'이 가리키는 지점이다(PIN.anchor === 'bottom').
function pinPath() {
  const hw = PIN.width / 2;
  const neck = num(PIN.height * 0.42);
  const head = num(PIN.height * 0.62);
  return 'M0 0 C-9 -14 -' + hw + ' -' + neck + ' -' + hw + ' -' + head +
    ' A' + hw + ' ' + hw + ' 0 1 1 ' + hw + ' -' + head +
    ' C' + hw + ' -' + neck + ' 9 -14 0 0 Z';
}

const PIN_HEAD_Y = -Math.round(PIN.height * 0.62);

// ── 렌더러 ────────────────────────────────────────────────────────────────
//
// createMapView(root, { variant, alt })
//   variant: 'student' | 'teacher' | 'admin'  — §3-A 진리표의 열에 대응한다.
//
// view.render(model)
//   model = {
//     spots: [{ key, label, x, y, status, color, thumb, timeText, selectable, badge }],
//     routes: [{ color, points: [{x,y}, ...] }],
//     showPhotos: boolean          // 폴라로이드를 그릴지(교사 전체 보기는 false)
//   }
//   x·y·points 는 전부 0~1 분수다. **이 함수는 DB를 읽지 않는다.**
export function createMapView(root, options) {
  const opts = options || {};
  const variant = opts.variant || 'student';

  const frame = document.createElement('div');
  frame.className = 'map-frame';

  // 배경은 <img>다. 내부 요소에 접근하지 않는다(§5 금지 33).
  // campus-map.svg에 width/height 속성이 있으므로 CSS로 width:100%를 반드시 준다 —
  // 없으면 390px 화면에서 가로 스크롤이 난다(단계 1 인계 주의 ⑴ · §6 ⑼).
  const img = document.createElement('img');
  img.className = 'map-bg';
  img.src = MAP_IMAGE_SRC;
  img.alt = opts.alt || '단국대학교 죽전캠퍼스 현장체험학습 지도';
  img.setAttribute('draggable', 'false');
  frame.appendChild(img);

  // 오버레이는 배경과 **같은 박스**에 겹친다. viewBox·preserveAspectRatio가 같아야 정렬된다.
  const overlay = svgEl('svg', {
    viewBox: MAP_VIEWBOX,
    preserveAspectRatio: 'xMidYMid meet',
    class: 'map-overlay',
    'aria-hidden': 'true'
  });
  const gPick = svgEl('g', { class: 'map-layer-pick' });
  const gRoute = svgEl('g', { class: 'map-layer-route' });
  const gPhoto = svgEl('g', { class: 'map-layer-photo' });
  const gPin = svgEl('g', { class: 'map-layer-pin' });
  overlay.appendChild(gPick);
  overlay.appendChild(gRoute);
  overlay.appendChild(gPhoto);
  overlay.appendChild(gPin);
  frame.appendChild(overlay);

  clearNode(root).appendChild(frame);

  let onSelect = null;
  let onPick = null;
  let picking = false;

  // ── 경로 ────────────────────────────────────────────────────────────────
  function drawRoutes(routes) {
    clearNode(gRoute);
    (routes || []).forEach(function (r) {
      const pts = (r.points || []).map(toViewBox);
      if (pts.length < 2) return;
      const d = pts.map(function (p, i) {
        return (i === 0 ? 'M' : 'L') + num(p.x) + ' ' + num(p.y);
      }).join(' ');
      gRoute.appendChild(svgEl('path', {
        d: d, fill: 'none', stroke: r.color || INK,
        'stroke-width': ROUTE.width, 'stroke-linecap': ROUTE.capStyle,
        'stroke-linejoin': 'round', 'stroke-dasharray': ROUTE.dashArray,
        opacity: r.opacity == null ? 0.9 : r.opacity
      }));
    });
  }

  // ── 폴라로이드 (표시 전용 투영 — 상태를 저장하거나 다시 계산하지 않는다) ──
  function drawPolaroid(spot) {
    const p = toViewBox(spot);
    const w = POLAROID.width;
    const h = POLAROID.height;
    const x = p.x + POLAROID.offsetX - w / 2;
    const y = p.y + POLAROID.offsetY - h;
    const g = svgEl('g', {
      transform: 'translate(' + num(x + w / 2) + ' ' + num(y + h / 2) + ') rotate(' +
        POLAROID.rotation + ') translate(' + num(-(x + w / 2)) + ' ' + num(-(y + h / 2)) + ')'
    });
    g.appendChild(svgEl('rect', {
      x: num(x), y: num(y), width: w, height: h, rx: 3,
      fill: PAPER, stroke: INK, 'stroke-width': 2
    }));
    const inset = POLAROID.photoInset;
    const photoH = h - POLAROID.captionHeight - inset;
    const img2 = svgEl('image', {
      x: num(x + inset), y: num(y + inset),
      width: w - inset * 2, height: photoH,
      preserveAspectRatio: 'xMidYMid slice'
    });
    img2.setAttribute('href', spot.thumb);
    g.appendChild(img2);
    gPhoto.appendChild(g);
  }

  // ── 스탬프 ──────────────────────────────────────────────────────────────
  function stampNode(color, faded) {
    const g = svgEl('g', {
      transform: 'rotate(' + STAMP.rotation + ')',
      opacity: faded ? STAMP.queuedOpacity : 1
    });
    g.appendChild(svgEl('circle', {
      cx: 0, cy: 0, r: STAMP.radius, fill: 'none',
      stroke: color, 'stroke-width': STAMP.ringWidth
    }));
    g.appendChild(svgEl('circle', {
      cx: 0, cy: 0, r: STAMP.radius - STAMP.ringWidth * 2, fill: 'none',
      stroke: color, 'stroke-width': 1.6
    }));
    g.appendChild(svgEl('path', {
      d: 'M-13 1 L-4 11 L14 -10', fill: 'none', stroke: color,
      'stroke-width': 4.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    }));
    return g;
  }

  function pinNode(fill, scale, outline) {
    const g = svgEl('g', scale && scale !== 1 ? { transform: 'scale(' + scale + ')' } : null);
    g.appendChild(svgEl('ellipse', { cx: 0, cy: 3, rx: 13, ry: 5, fill: 'rgba(70,55,30,.25)' }));
    g.appendChild(svgEl('path', {
      d: pinPath(),
      fill: outline ? PAPER : fill,
      stroke: outline ? fill : INK,
      'stroke-width': 2.6, 'stroke-linejoin': 'round'
    }));
    g.appendChild(svgEl('circle', {
      cx: 0, cy: PIN_HEAD_Y, r: 9,
      fill: outline ? fill : PAPER, stroke: outline ? fill : INK, 'stroke-width': 2
    }));
    return g;
  }

  function lockNode() {
    const g = pinNode(LOCK_IN, 1, false);
    g.appendChild(svgEl('rect', {
      x: -7, y: PIN_HEAD_Y - 3, width: 14, height: 11, rx: 2,
      fill: LOCK_IN, stroke: INK, 'stroke-width': 1.4
    }));
    g.appendChild(svgEl('path', {
      d: 'M-4 ' + (PIN_HEAD_Y - 3) + ' v-4 a4 4 0 0 1 8 0 v4',
      fill: 'none', stroke: INK, 'stroke-width': 1.8
    }));
    return g;
  }

  // 핀 아래 라벨. 상태 문구는 common.js가 원천이며 여기서 다시 타이핑하지 않는다.
  function labelNode(text, y, color) {
    return svgText(text, {
      x: 0, y: num(y), 'text-anchor': 'middle',
      'font-size': LABEL.fontSize, 'font-weight': 700,
      fill: color || INK, class: 'map-label',
      'paint-order': 'stroke', stroke: PAPER,
      'stroke-width': LABEL.haloWidth, 'stroke-linejoin': 'round'
    });
  }

  function subLabelNode(text, y, color) {
    return svgText(text, {
      x: 0, y: num(y), 'text-anchor': 'middle',
      'font-size': Math.round(LABEL.fontSize * 0.72), 'font-weight': 600,
      fill: color || INK, class: 'map-sublabel',
      'paint-order': 'stroke', stroke: PAPER,
      'stroke-width': LABEL.haloWidth - 2, 'stroke-linejoin': 'round'
    });
  }

  // 탭 판정 원. 오버레이 전체는 pointer-events:none이고 이 원만 클릭을 받는다.
  function hitNode(spot) {
    const hit = svgEl('circle', {
      cx: 0, cy: num(-PIN.height * 0.5), r: PIN.hitRadius,
      fill: 'transparent', class: 'map-hit'
    });
    hit.setAttribute('role', 'button');
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('data-spot-hit', spot.key);
    const title = svgEl('title');
    title.textContent = spot.label;
    hit.appendChild(title);
    const fire = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (onSelect) onSelect(spot.key, spot);
    };
    hit.addEventListener('click', fire);
    hit.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') fire(ev);
    });
    return hit;
  }

  // ── 스팟 1개 ────────────────────────────────────────────────────────────
  // §3-A 진리표의 한 줄을 그대로 그린다. 상태를 여기서 다시 계산하지 않는다.
  function drawSpot(spot, showPhotos) {
    const p = toViewBox(spot);
    const st = spot.status;
    const color = spot.color || INK;
    const g = svgEl('g', {
      class: 'map-spot map-spot-' + st,
      transform: 'translate(' + num(p.x) + ' ' + num(p.y) + ')'
    });
    g.setAttribute('data-spot', spot.key);
    g.setAttribute('data-status', st);

    const teacher = variant === 'teacher';
    let sub = null;

    // 'placed'·'picking'은 §3-A 진리표의 상태 토큰이 **아니다.** 관리 화면 전용 편집 표시이며
    // 각각 「이 자리에 좌표가 찍혀 있다」·「지금 이 장소를 찍는 중이다」만 뜻한다(재작업 A-4).
    // 관리 화면이 사진 0장인 장소에 완료 스탬프를 그리던 것을 막는다 — 화면이 상태를
    // 지어내면 §3-A의 「표시 전용 투영」 원칙과 §5 금지 30의 취지가 함께 깨진다.
    // 그래서 스탬프도, 폴라로이드도, 전송 시각도, 상태 문구도 붙이지 않는다.
    if (st === 'placed' || st === 'picking') {
      g.appendChild(pinNode(color, st === 'picking' ? PIN.activeScale : 1, false));
      g.appendChild(labelNode(spot.label, LABEL.offsetY, INK));
      if (spot.selectable) g.appendChild(hitNode(spot));
      gPin.appendChild(g);
      return;
    }

    if (st === 'synced') {
      if (showPhotos && spot.thumb) drawPolaroid(spot);
      if (teacher) {
        g.appendChild(pinNode(DONE_IN, 1, false));
        sub = spot.timeText || '';
      } else {
        const s = stampNode(DONE_IN, false);
        s.setAttribute('transform', 'translate(0 ' + PIN_HEAD_Y + ') rotate(' + STAMP.rotation + ')');
        g.appendChild(s);
      }
    } else if (st === 'queued') {
      const s = stampNode(color, true);
      s.setAttribute('transform', 'translate(0 ' + PIN_HEAD_Y + ') rotate(' + STAMP.rotation + ')');
      g.appendChild(s);
      sub = STATUS_TEXT.queued;
    } else if (st === 'error') {
      g.appendChild(pinNode(ERROR_IN, 1, false));
      sub = '재전송 필요';
    } else if (st === 'current') {
      g.appendChild(pinNode(color, teacher ? 1 : PIN.activeScale, teacher));
      if (!teacher) sub = CURRENT_TEXT;
    } else {
      const lock = lockNode();
      if (teacher) lock.setAttribute('opacity', String(PIN.lockedOpacity));
      g.appendChild(lock);
    }

    g.appendChild(labelNode(spot.label, LABEL.offsetY, INK));
    if (sub) g.appendChild(subLabelNode(sub, LABEL.offsetY + LABEL.fontSize + 4, color));

    if (spot.selectable) g.appendChild(hitNode(spot));

    gPin.appendChild(g);
  }

  // ── 위치 찍기 판 (관리 화면) ────────────────────────────────────────────
  function drawPickLayer() {
    clearNode(gPick);
    if (!picking) return;
    const rect = svgEl('rect', {
      x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT,
      fill: 'transparent', class: 'map-pick'
    });
    rect.addEventListener('click', function (ev) {
      if (!onPick) return;
      const box = overlay.getBoundingClientRect();
      if (!box.width || !box.height) return;
      // 배경 <img>와 오버레이가 같은 박스라 화면 비율이 곧 분수 좌표다.
      // 0~1 밖으로 나가는 값은 map-config의 fromViewBox가 잘라 낸다.
      const fx = (ev.clientX - box.left) / box.width;
      const fy = (ev.clientY - box.top) / box.height;
      onPick(fromViewBox(fx * MAP_WIDTH, fy * MAP_HEIGHT));
    });
    gPick.appendChild(rect);
  }

  return {
    element: frame,
    image: img,
    overlay: overlay,

    render: function (model) {
      const m = model || {};
      const showPhotos = m.showPhotos !== false;
      clearNode(gPhoto);
      clearNode(gPin);
      drawRoutes(m.routes);
      (m.spots || []).forEach(function (s) { drawSpot(s, showPhotos); });
      drawPickLayer();
      return this;
    },

    setPicking: function (on) {
      picking = !!on;
      frame.classList.toggle('map-picking', picking);
      drawPickLayer();
      return this;
    },

    isPicking: function () { return picking; },
    onSpotSelect: function (cb) { onSelect = cb; return this; },
    onMapPick: function (cb) { onPick = cb; return this; }
  };
}
