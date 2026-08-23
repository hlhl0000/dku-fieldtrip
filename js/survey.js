// survey.js — 사후 설문의 데이터 계약. 화면(html)도 저장(db.js)도 이 파일 하나를 원천으로 쓴다.
// 설계지시안_설문기능_v1.md §3 단계 1 / §4-1 F-1(단일 원천)·F-2(역할별 파일 분리) 적용.
//
// 이 파일이 갖는 것
//   ⑴ DEFAULT_SURVEY_QUESTIONS — 기본 양식 6문항의 단일 원천(문항 문면을 다른 파일에 타이핑하지 않는다)
//   ⑵ 문항 스키마 {id, type, label, options?, required} 검증
//   ⑶ CSV 생성기 (RFC 4180 + 선두 BOM + CRLF + 수식 주입 방어)
//   ⑷ 서술 상한 2,000자
//   ⑸ 학번·PIN·응답 문서 id 규약 (경로 비밀: 문서 id = {sid}-{pin})
//   ⑹ PIN 발급·보존 머지 (재등록이 기존 학번의 PIN을 바꾸지 않는다 — §5 금지 8d)
//   ⑺ 문항 렌더러 — 학생 화면과 관리 화면 미리보기가 **같은 함수**를 쓴다(§8 D절)
//
// 이 파일이 갖지 않는 것: PIN 값 자체(교사 전용 rosterPins 문서에만 있다 · §5 금지 8b),
// 네트워크 접근(저장은 db.js).

// ── 문서 경로 (§3 단계 1 「문서 경로 4종」 · F-1) ───────────────────────────
// 경로 문자열을 화면·db에 다시 타이핑하지 않는다.
export const SURVEY_COLLECTION = 'survey';          // classes/{cid}/survey/{doc}
export const SURVEY_ANSWERS_COLLECTION = 'surveyAnswers'; // classes/{cid}/surveyAnswers/{aid}
export const SURVEY_DOC = {
  config: 'config',
  roster: 'roster',
  rosterPins: 'rosterPins'
};

// ── 상한값 (§0 증보 4 — 사용자 확정) ───────────────────────────────────────
export const SURVEY_TEXT_MAX = 2000;

// ── 문항 유형 ─────────────────────────────────────────────────────────────
export const QUESTION_TYPES = ['scale5', 'choice', 'text'];

// 유형 이름의 단일 원천(F-1). 관리 화면 문항 편집기의 유형 고르개가 이것을 쓴다.
export const QUESTION_TYPE_LABELS = {
  scale5: '5점 척도',
  choice: '객관식',
  text: '서술형'
};

// 5점 척도의 눈금 문면. 화면·CSV가 같은 말을 쓴다.
export const SCALE5_LABELS = ['전혀 아니다', '아니다', '보통이다', '그렇다', '매우 그렇다'];
export const SCALE5_MIN = 1;
export const SCALE5_MAX = 5;

// ── 기본 양식 (§0 합의문 3 + §3 단계 1 · 사용자 확정 문면) ─────────────────
// 여섯 문항의 주제·유형·순서는 고정이다. 교사가 문항을 편집하지 않으면 이 양식이 적용된다.
// id는 CSV 열 키이자 응답 맵의 키다 — 한 번 나간 뒤에는 바꾸지 않는다.
export const DEFAULT_SURVEY_QUESTIONS = [
  { id: 'q_place', type: 'scale5', label: '방문 장소는 만족스러웠다', required: true },
  { id: 'q_safety', type: 'scale5', label: '일정은 안전하게 운영되었다', required: true },
  { id: 'q_selfgov', type: 'scale5', label: '모둠 자치 활동은 만족스러웠다', required: true },
  {
    id: 'q_activity', type: 'text', required: true,
    label: '우리 모둠이 오늘 함께한 활동을 기록해 주세요(어디서 무엇을 했는지)'
  },
  {
    id: 'q_recommend', type: 'text', required: true,
    label: '후배 학년에게 추천하고 싶은 장소와 그 이유'
  },
  {
    id: 'q_major', type: 'text', required: true,
    label: '캠퍼스 탐방에서 조사한 관심 학과·전공에 대한 소감'
  }
];

// 기본 양식의 사본을 돌려준다. 호출자가 편집해도 원본이 오염되지 않는다.
export function defaultQuestions() {
  return DEFAULT_SURVEY_QUESTIONS.map(function (q) { return cloneQuestion(q); });
}

function cloneQuestion(q) {
  const out = { id: q.id, type: q.type, label: q.label, required: q.required !== false };
  if (q.type === 'choice') out.options = (q.options || []).slice();
  return out;
}

// ── 학번·PIN 형식 (§1-1 #5 · 추정 ③-a) ────────────────────────────────────
// 학번 5자리, PIN 4자리(1000~9999 — 선행 0 없음). 규칙의 정규식과 같은 형식이다.
export const SID_PATTERN = '^[0-9]{5}$';
export const PIN_PATTERN = '^[0-9]{4}$';
export const ANSWER_ID_PATTERN = '^[0-9]{5}-[0-9]{4}$';
const SID_RE = new RegExp(SID_PATTERN);
const PIN_RE = new RegExp(PIN_PATTERN);
const ANSWER_ID_RE = new RegExp(ANSWER_ID_PATTERN);

export function isSid(v) { return typeof v === 'string' && SID_RE.test(v); }
export function isPin(v) { return typeof v === 'string' && PIN_RE.test(v); }
export function isAnswerId(v) { return typeof v === 'string' && ANSWER_ID_RE.test(v); }

export function assertSid(v) {
  const s = String(v == null ? '' : v).trim();
  if (!isSid(s)) throw new Error('학번은 숫자 5자리입니다(예: 10401): ' + s);
  return s;
}

export function assertPin(v) {
  const s = String(v == null ? '' : v).trim();
  if (!isPin(s)) throw new Error('PIN은 숫자 4자리입니다');
  return s;
}

// 응답 문서 id = {sid}-{pin} (경로 비밀 · 추정 ③-b).
// PIN을 모르면 이 주소를 만들 수 없어 읽기까지 막힌다.
export function answerDocId(sid, pin) {
  return assertSid(sid) + '-' + assertPin(pin);
}

// 문서 id에서 학번만 떼어낸다. 형식이 아니면 null — 목록 화면이 조용히 건너뛴다.
export function sidOfAnswerId(aid) {
  if (!isAnswerId(aid)) return null;
  return String(aid).split('-')[0];
}

// ── PIN 발급 (§3 단계 1 · §5 금지 8d) ─────────────────────────────────────
// 1000~9999의 문자열. 숫자로 저장하면 규칙의 문자열 결합 대조가 타입 오류가 되어
// 전 학급 제출이 거부된다(§1-1 #12b) — 반환은 항상 문자열이다.
export function generatePin() {
  const n = 1000 + Math.floor(Math.random() * 9000);
  return String(n);
}

// 재등록 머지: 기존 학번의 PIN은 그대로 두고 신규 학번에만 발급한다.
// 명렬표에서 빠진 학번의 PIN도 지우지 않는다 — 그 학생의 기존 응답 경로를 살려 둔다.
// 반환 pins의 값은 전부 문자열이다.
export function mergeRosterPins(existingPins, sids) {
  const prev = existingPins && typeof existingPins === 'object' ? existingPins : {};
  const pins = {};
  Object.keys(prev).forEach(function (k) {
    if (isSid(k) && prev[k] != null) pins[k] = String(prev[k]);
  });
  const kept = [];
  const issued = [];
  (sids || []).forEach(function (raw) {
    const sid = assertSid(raw);
    if (isPin(pins[sid])) { kept.push(sid); return; }
    pins[sid] = generatePin();
    issued.push(sid);
  });
  return { pins: pins, kept: kept, issued: issued };
}

// 명렬표 정규화 — 저장 직전에 학번 형식과 이름 유무를 검사한다.
// 학번 키 맵 {"10401":"홍길동"}이 유일한 저장 모양이다(규칙의 `in` 검사용).
export function normalizeRoster(students) {
  const src = students && typeof students === 'object' ? students : {};
  const out = {};
  const sids = Object.keys(src).sort();
  sids.forEach(function (raw) {
    const sid = assertSid(raw);
    const name = String(src[raw] == null ? '' : src[raw]).trim();
    if (!name) throw new Error('이름이 비어 있습니다: ' + sid);
    out[sid] = name;
  });
  return { students: out, sids: Object.keys(out).sort() };
}

// 붙여넣기 명렬표 파싱 — 「학번[탭/공백]이름」 한 줄에 한 사람.
// 빈 줄은 건너뛰고, 형식이 틀린 줄과 중복 학번은 **줄 번호와 함께** 오류로 돌려준다.
// 오류가 하나라도 있으면 등록하지 않는다 — 오타 한 줄이 남의 응답 경로를 만들면
// 그 학생의 기록은 되찾을 길이 없다.
export function parseRosterText(text) {
  const students = {};
  const errors = [];
  const seenAt = {};
  String(text == null ? '' : text).split(/\r?\n/).forEach(function (raw, i) {
    const line = raw.trim();
    if (!line) return;
    const at = (i + 1) + '번째 줄: ';
    const m = line.match(/^(\S+)[\t ]+(.+)$/);
    if (!m) { errors.push(at + '「학번 이름」 형식이 아닙니다 — ' + line); return; }
    const sid = m[1];
    const name = m[2].trim();
    if (!isSid(sid)) { errors.push(at + '학번이 숫자 5자리가 아닙니다 — ' + sid); return; }
    if (!name) { errors.push(at + '이름이 비어 있습니다 — ' + sid); return; }
    if (seenAt[sid]) { errors.push(at + '학번이 ' + seenAt[sid] + '번째 줄과 중복입니다 — ' + sid); return; }
    seenAt[sid] = i + 1;
    students[sid] = name;
  });
  const sids = Object.keys(students).sort();
  if (!sids.length && !errors.length) errors.push('등록할 줄이 없습니다');
  return { students: students, sids: sids, count: sids.length, errors: errors };
}

// 재등록 미리보기 — 실제로 쓰기 전에 「보존 N건 / 신규 M건」을 계산한다.
export function rosterPinPreview(existingPins, sids) {
  const prev = existingPins && typeof existingPins === 'object' ? existingPins : {};
  const kept = [];
  const issued = [];
  (sids || []).forEach(function (sid) {
    if (isPin(prev[sid])) kept.push(sid); else issued.push(sid);
  });
  const dropped = Object.keys(prev).filter(function (sid) { return (sids || []).indexOf(sid) < 0; }).sort();
  return { kept: kept, issued: issued, dropped: dropped };
}

// ── 문항 스키마 검증 (§3 단계 1 ⑵) ────────────────────────────────────────
// 반환은 {ok, errors, questions}. 던지지 않는다 — 화면이 오류 목록을 그대로 보여 준다.
export function validateQuestions(list) {
  const errors = [];
  if (!Array.isArray(list)) {
    return { ok: false, errors: ['문항 목록이 배열이 아닙니다'], questions: [] };
  }
  if (list.length === 0) errors.push('문항이 하나도 없습니다');
  const seen = {};
  const questions = [];
  list.forEach(function (q, i) {
    const at = '문항 ' + (i + 1) + ': ';
    if (!q || typeof q !== 'object') { errors.push(at + '형식이 잘못되었습니다'); return; }
    const id = typeof q.id === 'string' ? q.id.trim() : '';
    if (!id) errors.push(at + 'id가 없습니다');
    else if (!/^[A-Za-z0-9_]{1,40}$/.test(id)) errors.push(at + 'id는 영문·숫자·밑줄 1~40자입니다: ' + id);
    else if (seen[id]) errors.push(at + 'id가 중복입니다: ' + id);
    if (id) seen[id] = true;
    if (QUESTION_TYPES.indexOf(q.type) < 0) errors.push(at + '유형이 scale5·choice·text 중 하나가 아닙니다');
    const label = typeof q.label === 'string' ? q.label.trim() : '';
    if (!label) errors.push(at + '문항 내용이 비어 있습니다');
    if (q.type === 'choice') {
      const opts = Array.isArray(q.options)
        ? q.options.map(function (o) { return String(o).trim(); }).filter(Boolean)
        : [];
      if (opts.length < 2) errors.push(at + '객관식은 선택지가 2개 이상이어야 합니다');
      questions.push({ id: id, type: q.type, label: label, options: opts, required: q.required !== false });
      return;
    }
    questions.push({ id: id, type: q.type, label: label, required: q.required !== false });
  });
  return { ok: errors.length === 0, errors: errors, questions: questions };
}

// 저장본을 화면이 쓰는 모양으로. 비었거나 형식이 깨졌으면 기본 양식으로 되돌린다
// (교사가 편집하지 않은 상태 = 기본 양식 적용 · §0 합의문 2-⑵).
export function normalizeQuestions(list) {
  if (!Array.isArray(list) || list.length === 0) return defaultQuestions();
  const v = validateQuestions(list);
  return v.ok ? v.questions : defaultQuestions();
}

// ── 응답 검증 (§3 단계 2 제출 직전) ───────────────────────────────────────
// answers = { qid: 값 }. 척도는 1~5 정수, 객관식은 선택지 문자열, 서술은 2,000자 이하.
export function validateAnswers(questions, answers) {
  const errors = [];
  const src = answers && typeof answers === 'object' ? answers : {};
  const out = {};
  (questions || []).forEach(function (q) {
    const raw = src[q.id];
    if (q.type === 'scale5') {
      const n = Number(raw);
      if (raw === undefined || raw === null || raw === '') {
        if (q.required) errors.push(q.label + ' — 답하지 않았습니다');
        return;
      }
      if (!Number.isInteger(n) || n < SCALE5_MIN || n > SCALE5_MAX) {
        errors.push(q.label + ' — 1~5 중에서 고르세요');
        return;
      }
      out[q.id] = n;
      return;
    }
    if (q.type === 'choice') {
      const s = raw == null ? '' : String(raw);
      if (!s) {
        if (q.required) errors.push(q.label + ' — 답하지 않았습니다');
        return;
      }
      if ((q.options || []).indexOf(s) < 0) {
        errors.push(q.label + ' — 선택지에 없는 값입니다');
        return;
      }
      out[q.id] = s;
      return;
    }
    const t = raw == null ? '' : String(raw);
    if (!t.trim()) {
      if (q.required) errors.push(q.label + ' — 답하지 않았습니다');
      return;
    }
    if (t.length > SURVEY_TEXT_MAX) {
      errors.push(q.label + ' — ' + SURVEY_TEXT_MAX + '자를 넘었습니다(' + t.length + '자)');
      return;
    }
    out[q.id] = t;
  });
  return { ok: errors.length === 0, errors: errors, answers: out };
}

// ── 응답 목록 진단 (불변식 ③-c: 한 sid에 응답 1건) ────────────────────────
// doc id의 sid 접두가 겹치면 PIN이 바뀐 이력이 있다는 뜻이다. 감지해서 알린다.
export function duplicateSids(answers) {
  const bySid = {};
  (answers || []).forEach(function (a) {
    const sid = a && a.sid ? a.sid : sidOfAnswerId(a && a.aid);
    if (!sid) return;
    bySid[sid] = (bySid[sid] || 0) + 1;
  });
  return Object.keys(bySid).filter(function (sid) { return bySid[sid] > 1; }).sort();
}

export function duplicateWarningText(sids) {
  if (!sids || !sids.length) return '';
  return '⚠ 학번 ' + sids.join(', ') + ' 응답 2건 이상 — PIN 변경 이력 확인';
}

// ── 문항 렌더러 (§3 단계 2·3b — 학생 화면과 미리보기가 같은 함수를 쓴다) ──
// innerHTML을 쓰지 않는다(§5 금지 11). 노드를 하나씩 만든다.
function mk(doc, tag, className, text) {
  const n = doc.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderChoiceRow(doc, name, value, labelText, checked, readOnly, onChange) {
  const row = mk(doc, 'label', 'survey-option');
  const input = doc.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = String(value);
  if (checked) input.checked = true;
  if (readOnly) input.disabled = true;
  if (typeof onChange === 'function') input.addEventListener('change', onChange);
  row.appendChild(input);
  row.appendChild(mk(doc, 'span', null, labelText));
  return row;
}

// options: { values, readOnly, idPrefix, onChange }
// 반환값의 read()가 화면에서 값을 거둬 온다 — 화면이 DOM 질의를 다시 짜지 않는다.
export function renderQuestions(root, questions, options) {
  const opts = options || {};
  const doc = root.ownerDocument;
  const list = normalizeQuestions(questions);
  const values = opts.values || {};
  const readOnly = opts.readOnly === true;
  const prefix = opts.idPrefix || 'sq-';
  clearNode(root);

  list.forEach(function (q, i) {
    const block = mk(doc, 'section', 'survey-q');
    block.setAttribute('data-qid', q.id);
    const head = mk(doc, 'p', 'survey-q-label', (i + 1) + '. ' + q.label);
    block.appendChild(head);

    if (q.type === 'scale5') {
      const wrap = mk(doc, 'div', 'survey-scale');
      wrap.setAttribute('role', 'radiogroup');
      wrap.setAttribute('aria-label', q.label);
      for (let n = SCALE5_MIN; n <= SCALE5_MAX; n += 1) {
        wrap.appendChild(renderChoiceRow(doc, prefix + q.id, n,
          n + '. ' + SCALE5_LABELS[n - SCALE5_MIN],
          String(values[q.id]) === String(n), readOnly, opts.onChange));
      }
      block.appendChild(wrap);
    } else if (q.type === 'choice') {
      const wrap = mk(doc, 'div', 'survey-choice');
      wrap.setAttribute('role', 'radiogroup');
      wrap.setAttribute('aria-label', q.label);
      (q.options || []).forEach(function (o) {
        wrap.appendChild(renderChoiceRow(doc, prefix + q.id, o, o,
          String(values[q.id]) === String(o), readOnly, opts.onChange));
      });
      block.appendChild(wrap);
    } else {
      const ta = doc.createElement('textarea');
      ta.name = prefix + q.id;
      ta.rows = 4;
      ta.maxLength = SURVEY_TEXT_MAX;
      ta.value = values[q.id] === undefined || values[q.id] === null ? '' : String(values[q.id]);
      if (readOnly) ta.readOnly = true;
      const count = mk(doc, 'p', 'note survey-count', ta.value.length + ' / ' + SURVEY_TEXT_MAX + '자');
      ta.addEventListener('input', function () {
        count.textContent = ta.value.length + ' / ' + SURVEY_TEXT_MAX + '자';
        if (typeof opts.onChange === 'function') opts.onChange();
      });
      block.appendChild(ta);
      block.appendChild(count);
    }
    root.appendChild(block);
  });

  return {
    questions: list,
    read: function () { return readQuestionValues(root, list, prefix); }
  };
}

// 렌더된 화면에서 값을 거둔다. 척도는 숫자로, 나머지는 문자열로.
export function readQuestionValues(root, questions, idPrefix) {
  const prefix = idPrefix || 'sq-';
  const out = {};
  (questions || []).forEach(function (q) {
    if (q.type === 'text') {
      const ta = root.querySelector('textarea[name="' + prefix + q.id + '"]');
      if (ta) out[q.id] = ta.value;
      return;
    }
    const picked = root.querySelector('input[name="' + prefix + q.id + '"]:checked');
    if (!picked) return;
    out[q.id] = q.type === 'scale5' ? Number(picked.value) : picked.value;
  });
  return out;
}

// ── CSV 생성기 (§3 단계 3b · X-2 방어) ────────────────────────────────────
export const CSV_BOM = '\uFEFF';
const CSV_EOL = '\r\n';

// 상태 열 값. 「제출 여부」의 단일 원천이다.
export const CSV_STATUS = {
  submitted: '제출',
  missing: '미제출',
  duplicate: '중복',
  offRoster: '명렬표 밖'
};

export const CSV_FIXED_HEADERS = ['학번', '이름', '모둠', '상태', '제출시각', '수정시각'];

// 삭제된 문항의 열 라벨. 응답에만 남은 qid가 이 이름으로 CSV에 살아남는다.
export function deletedColumnLabel(qid) {
  return '[삭제된 문항 ' + qid + ']';
}

// 수식 주입 방어 — `=대학…`·`- 캠퍼스…` 같은 응답이 스프레드시트에서 수식으로 해석되면
// 그 학생의 기록이 사라진다. 홑따옴표를 앞에 붙여 문자열로 고정한다.
function guardFormula(s) {
  if (!s) return s;
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// RFC 4180 — 쉼표·큰따옴표·CR·LF가 있으면 큰따옴표로 감싸고 내부 따옴표를 겹친다.
export function csvEscape(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  const s = guardFormula(raw);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function csvRow(cells) {
  return (cells || []).map(csvEscape).join(',');
}

// 열 구성 = 현재 문항 ∪ 응답에 실제로 등장한 qid (합집합).
// 사라진 문항의 응답도 열을 남긴다 — 세특 재료 소실 방지(§3 단계 3b ⑹).
export function csvColumns(questions, answers) {
  const cols = [];
  const seen = {};
  (questions || []).forEach(function (q) {
    if (seen[q.id]) return;
    seen[q.id] = true;
    cols.push({ qid: q.id, label: q.label, type: q.type, deleted: false });
  });
  (answers || []).forEach(function (a) {
    const map = (a && a.answers) || {};
    Object.keys(map).forEach(function (qid) {
      if (seen[qid]) return;
      seen[qid] = true;
      cols.push({ qid: qid, label: deletedColumnLabel(qid), type: null, deleted: true });
    });
  });
  return cols;
}

function cellValue(col, answer) {
  if (!answer || !answer.answers) return '';
  const v = answer.answers[col.qid];
  if (v === undefined || v === null) return '';
  return String(v);
}

// 행 조립 — 명렬표 순서가 기준이고, 미제출자도 한 행을 차지한다(§0 증보 4).
// 명렬표에서 빠졌는데 응답만 남은 학번도 버리지 않고 뒤에 붙인다(상태 「명렬표 밖」).
export function csvRows(roster, answers, formatTimeFn) {
  const fmt = typeof formatTimeFn === 'function' ? formatTimeFn : function (v) { return v ? String(v) : ''; };
  const students = roster && typeof roster === 'object' ? roster : {};
  const bySid = {};
  (answers || []).forEach(function (a) {
    const sid = a && a.sid ? a.sid : sidOfAnswerId(a && a.aid);
    if (!sid) return;
    if (!bySid[sid]) bySid[sid] = [];
    bySid[sid].push(a);
  });
  const rows = [];
  const push = function (sid, name, list, offRoster) {
    if (!list || !list.length) {
      rows.push({ sid: sid, name: name, groupNo: '', status: CSV_STATUS.missing, submittedAt: '', updatedAt: '', answer: null });
      return;
    }
    list.forEach(function (a) {
      rows.push({
        sid: sid,
        name: a.name || name,
        groupNo: a.groupNo || '',
        status: offRoster ? CSV_STATUS.offRoster
          : (list.length > 1 ? CSV_STATUS.duplicate : CSV_STATUS.submitted),
        submittedAt: fmt(a.submittedAt),
        updatedAt: fmt(a.updatedAt),
        answer: a
      });
    });
  };
  Object.keys(students).sort().forEach(function (sid) {
    push(sid, students[sid], bySid[sid], false);
    delete bySid[sid];
  });
  Object.keys(bySid).sort().forEach(function (sid) {
    push(sid, (bySid[sid][0] && bySid[sid][0].name) || '', bySid[sid], true);
  });
  return rows;
}

// 최종 CSV 문자열. 선두 BOM + CRLF 줄바꿈 + RFC 4180 이스케이프.
// PIN 열은 넣지 않는다(§5 금지 8b).
export function buildSurveyCsv(input) {
  const src = input || {};
  const questions = normalizeQuestions(src.questions);
  const answers = src.answers || [];
  const cols = csvColumns(questions, answers);
  const rows = csvRows(src.roster, answers, src.formatTime);
  const lines = [];
  lines.push(csvRow(CSV_FIXED_HEADERS.concat(cols.map(function (c) { return c.label; }))));
  rows.forEach(function (r) {
    const fixed = [r.sid, r.name, r.groupNo, r.status, r.submittedAt, r.updatedAt];
    const cells = cols.map(function (c) { return cellValue(c, r.answer); });
    lines.push(csvRow(fixed.concat(cells)));
  });
  return CSV_BOM + lines.join(CSV_EOL) + CSV_EOL;
}

// 파일명 — 설문_{cid}_{YYYYMMDD}.csv (§3 단계 3b ⑹)
export function csvFileName(classId, date) {
  const d = date instanceof Date ? date : new Date();
  const p = function (n) { return ('0' + n).slice(-2); };
  const ymd = String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate());
  return '설문_' + String(classId || '') + '_' + ymd + '.csv';
}

// ── CSV 되읽기 (§6 왕복 검산 · e2e에서 쓴다) ──────────────────────────────
// 생성기와 짝을 이루는 파서. 왕복이 일치하지 않으면 이스케이프가 틀린 것이다.
export function parseCsv(text) {
  let s = text == null ? '' : String(text);
  if (s.charAt(0) === '\uFEFF') s = s.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const pushField = function () { row.push(field); field = ''; };
  const pushRow = function () { pushField(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { pushField(); i += 1; continue; }
    if (c === '\r' && s.charAt(i + 1) === '\n') { pushRow(); i += 2; continue; }
    if (c === '\n' || c === '\r') { pushRow(); i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) pushRow();
  return rows;
}
