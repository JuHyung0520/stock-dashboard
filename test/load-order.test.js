/* 페이지 스크립트 로드 순서 — public/*.html
 *
 * 브라우저가 모듈을 안 쓰는 클래식 스크립트라 두 가지 규칙이 있다. 둘 다 어기면 페이지가 즉사한다:
 *  ① 같은 이름을 두 스크립트의 최상위에 선언하면 안 된다 (Identifier already been declared)
 *     — 실제로 ui.js 의 const api 와 terminal.js 의 function api 가 부딪혀 터미널이 죽을 뻔했다
 *  ② 로드 즉시 실행되는 문장이 **아직 안 읽힌 뒤 스크립트**의 이름을 참조하면 안 된다
 *     — app.js·assets.js 를 여러 파일로 가르면서 생긴 제약이다. 한 파일일 땐 함수 선언이
 *       파일 전체로 호이스팅돼 순서가 안 드러났다. 이제는 순서가 곧 의존성이다.
 * 이 제약은 HTML 의 <script> 순서에 숨어 있어서 눈으로는 안 보인다. 그래서 테스트로 잠근다. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, '..', 'public');
const KW = new Set(('if else for while do return const let var function async await new typeof instanceof in of '
  + 'true false null undefined this class try catch finally throw switch case break continue default delete void yield').split(' '));
/* 코드만 남기는 스캐너 — 문자열·템플릿·정규식·주석을 공백으로 지운다.
 * 정규식 한 줄로 벗겨 보려다 실패했다: esc 의 /[&<>"']/ 안의 따옴표를 문자열 시작으로 착각해
 * 중괄호 깊이가 틀어졌고, pure.js 의 IIFE 안쪽을 '최상위'로 오판했다. 상태를 따라가야 한다.
 * 템플릿 안의 ${ … } 는 다시 코드라 중괄호 깊이를 스택으로 기억한다. */
/* 이 여는 중괄호가 '함수 본문'인가 — 앞 코드(tail)의 끝을 보고 판단한다.
 *   … => {                       화살표 함수 → 나중에 실행
 *   … ) {  에서 짝 ( 바로 앞이
 *        if·for·while·switch·catch   → 그 자리에서 실행되는 블록
 *        function [이름]             → 함수 본문
 *        그 밖의 이름(메서드 축약)    → 함수 본문
 *   class … {                    클래스 본문 → 나중에 실행
 *   그 밖(else·try·객체 리터럴·빈 블록) → 그 자리에서 실행
 * 짝 괄호를 거꾸로 찾는 이유: 매개변수 안에 `{ scroll = true } = {}` 같은 중괄호가 있어도,
 * 앞 함수의 본문이 섞여 들어와도 판정이 흔들리지 않는다. 문자열 치환으로는 둘 다 틀렸다. */
function isFnBody(tail) {
  const t = tail.replace(/\s+/g, ' ').trimEnd();
  if (/=>$/.test(t)) return true;
  if (/\bclass\b[^{};()]*$/.test(t)) return true;
  if (!t.endsWith(')')) return false;
  let d = 0, k = t.length - 1;
  for (; k >= 0; k--) { if (t[k] === ')') d++; else if (t[k] === '(') { d--; if (d === 0) break; } }
  if (k < 0) return false;
  const before = t.slice(0, k).trimEnd();
  if (/(?:^|[^\w$])(if|for|while|switch|catch|with)$/.test(before)) return false;
  if (/\bfunction\s*\*?\s*[\w$]*$/.test(before)) return true;
  return /[\w$]$/.test(before);   // 메서드 축약: name(…) {
}

function scan(src) {
  const lines = [];
  let depth = 0, mode = 'code', prev = '', buf = '', tail = '';
  let startDepth = 0, startMode = 'code', startLoad = true;
  const tmpl = [];                    // ${ 를 열 때의 깊이
  const kinds = [];                   // 여는 중괄호마다 'fn'(나중에 실행) / 'blk'(로드 시 실행)
  const loadTime = () => !kinds.includes('fn');
  const REGEX_BEFORE = '(,=:[!&|?{};+-*%<>~^';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') {
      tail = (tail + ' ').slice(-300);
      lines.push({ depth: startDepth, mode: startMode, load: startLoad, code: buf });
      buf = ''; if (mode === 'lc') mode = 'code';
      startDepth = depth; startMode = mode; startLoad = loadTime(); continue;
    }
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'lc'; buf += '  '; i++; continue; }
      if (c === '/' && n === '*') { mode = 'bc'; buf += '  '; i++; continue; }
      if (c === "'" || c === '"') { mode = c; buf += ' '; continue; }
      if (c === '`') { mode = 'tmpl'; buf += ' '; continue; }
      if (c === '/' && (prev === '' || REGEX_BEFORE.includes(prev) || /\b(return|typeof|case|in|of|void|throw)\s*$/.test(buf))) {
        mode = 're'; buf += ' '; continue;
      }
      if (c === '{') {
        kinds.push(isFnBody(tail) ? 'fn' : 'blk'); depth++;
      }
      if (c === '}') {
        if (tmpl.length && tmpl[tmpl.length - 1] === depth) { tmpl.pop(); mode = 'tmpl'; buf += ' '; tail += ' '; continue; }
        depth--; kinds.pop();
      }
      buf += c; tail = (tail + c).slice(-300); if (!/\s/.test(c)) prev = c; continue;
    }
    if (mode === "'" || mode === '"') {
      if (c === '\\') { buf += '  '; i++; continue; }
      if (c === mode) { mode = 'code'; prev = c; }
      buf += ' '; continue;
    }
    if (mode === 'tmpl') {
      if (c === '\\') { buf += '  '; i++; continue; }
      if (c === '`') { mode = 'code'; prev = '`'; buf += ' '; continue; }
      if (c === '$' && n === '{') { tmpl.push(depth); mode = 'code'; prev = '{'; buf += '  '; i++; continue; }
      buf += ' '; continue;
    }
    if (mode === 're' || mode === 'rc') {
      if (c === '\\') { buf += '  '; i++; continue; }
      if (mode === 're' && c === '[') mode = 'rc';
      else if (mode === 'rc' && c === ']') mode = 're';
      else if (mode === 're' && c === '/') {
        mode = 'code'; prev = '/';
        while (/[a-z]/.test(src[i + 1] || '')) { i++; buf += ' '; }   // 플래그(g·i·u…)는 이름이 아니다
      }
      buf += ' '; continue;
    }
    if (mode === 'bc' && c === '*' && n === '/') { mode = 'code'; buf += '  '; i++; continue; }
    buf += ' ';
  }
  lines.push({ depth: startDepth, mode: startMode, load: startLoad, code: buf });
  return lines;
}

// 선언을 찾을 땐 깊이 0 줄만, 로드 시점 실행을 찾을 땐 '함수 본문 밖'의 모든 줄을 본다
// (최상위 if·for 블록 안도 로드 즉시 실행된다 — 깊이만 보면 놓친다)
function topLevel(src, fn) {
  const raw = src.split('\n');
  scan(src).forEach((l, i) => { if (l.depth === 0 && l.mode === 'code') fn(raw[i], l.code.trim(), i + 1); });
}
function loadTimeLines(src, fn) {
  const raw = src.split('\n');
  scan(src).forEach((l, i) => { if (l.load && l.mode === 'code') fn(raw[i], l.code.trim(), i + 1); });
}

function check(scripts) {
  const declaredIn = {}, dup = [], late = [];
  scripts.forEach((f, i) => topLevel(fs.readFileSync(path.join(PUB, f), 'utf8'), (line) => {
    const m = line.match(/^(?:async function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/);
    if (!m) return;
    if (declaredIn[m[1]] !== undefined && declaredIn[m[1]] !== i) dup.push(`${m[1]}: ${scripts[declaredIn[m[1]]]} ↔ ${f}`);
    else declaredIn[m[1]] = i;
  }));
  scripts.forEach((f, i) => loadTimeLines(fs.readFileSync(path.join(PUB, f), 'utf8'), (line, t, n) => {
    if (!t || /^(\/\*|\*)/.test(t)) return;
    if (/^(async function|function|class) /.test(t)) return;   // 선언만 하고 본문은 나중에 실행된다
    // const f = (…) => … / const f = function … 도 본문은 나중에 실행된다
    if (/^(const|let|var)\s+[\w$]+\s*=\s*(async\s+)?(\([^)]*\)|[\w$]+)\s*=>/.test(t)) return;
    if (/^(const|let|var)\s+[\w$]+\s*=\s*(async\s+)?function\b/.test(t)) return;
    for (const m of t.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      if (KW.has(m[1])) continue;
      const at = declaredIn[m[1]];
      if (at !== undefined && at > i) late.push(`${f}:${n} → ${m[1]} (${scripts[at]} 에 있음, 아직 안 읽힘)`);
    }
  }));
  return { dup, late };
}

const pages = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
const scriptsOf = (html) => [...fs.readFileSync(path.join(PUB, html), 'utf8')
  .matchAll(/<script src="([^"]+\.js)"><\/script>/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));

test('검사기가 실제로 문다 — 부팅 스크립트를 앞으로 당기면 잡혀야 한다', () => {
  // 통과만 보면 검사기가 헛도는지 모른다. 실제로 첫 버전은 startPolling(refreshGap) 처럼
  // '부르지 않고 넘기는' 참조를 놓쳐서, 순서를 틀려도 통과했다.
  // (한 칸만 당기는 건 변이가 아니다 — assets-boot 는 grid 를 안 불러서 원래 문제가 없다.
  //  그래서 페이지 자기 스크립트 맨 앞으로 당긴다. 그러면 반드시 뒤 파일을 참조하게 된다.)
  const SHARED = new Set(['pure.js', 'ui.js', 'nav.js', 'chart.js']);
  for (const [html, boot] of [['index.html', 'app-boot.js'], ['assets.html', 'assets-boot.js']]) {
    const s = scriptsOf(html).filter((x) => x !== boot);
    const at = s.findIndex((x) => !SHARED.has(x));
    const wrong = [...s.slice(0, at), boot, ...s.slice(at)];
    assert.ok(check(wrong).late.length > 0, `${html}: 부팅을 맨 앞에 뒀는데 못 잡았다 — 검사기가 헛돈다`);
  }
});

test('검사기가 이름 충돌도 문다', () => {
  // 같은 파일을 두 번 넣으면 모든 최상위 이름이 겹친다 — 하나도 못 잡으면 검사기가 헛도는 것
  const { dup } = check(['ui.js', 'ui.js']);
  assert.ok(dup.some((x) => x.startsWith('$:')) && dup.some((x) => x.startsWith('api:')), `못 잡음: ${dup.join(' | ')}`);
});

test('검사기가 매개변수 구조분해에 속지 않는다', () => {
  // async function selectStock(id, { scroll = true } = {}) { … } 의 본문을 '로드 시점'으로 오판했었다
  const { late } = check(scriptsOf('index.html'));
  assert.ok(!late.some((x) => x.includes('app-detail.js')), `함수 본문을 로드 시점으로 오판: ${late.join(' | ')}`);
});

test('검사기가 최상위 if 블록 안도 본다', () => {
  // app-boot.js 의 `if (state.view === 'card') { loadProfiles().then(renderCards); }` 는
  // 함수가 아니라서 로드 즉시 실행된다. 깊이만 보면 놓친다 — 실제로 첫 버전이 놓쳤다.
  const s = scriptsOf('index.html');
  const wrong = s.filter((x) => x !== 'app-list.js').concat('app-list.js');   // 카드 뷰를 부팅보다 뒤로
  const late = check(wrong).late;
  assert.ok(late.some((x) => /app-boot\.js.*(loadProfiles|renderCards)/.test(x)),
    `if 블록 안의 loadProfiles/renderCards 를 못 잡았다: ${late.join(' | ')}`);
});

for (const html of pages) {
  test(`${html} — 스크립트 순서와 이름 충돌`, () => {
    const scripts = scriptsOf(html);
    assert.ok(scripts.length > 0, `${html}: 스크립트를 하나도 못 읽었다`);
    for (const s of scripts) assert.ok(fs.existsSync(path.join(PUB, s)), `${html}: ${s} 파일이 없다`);
    const { dup, late } = check(scripts);
    assert.deepEqual(dup, [], `${html}: 같은 이름이 두 스크립트에 선언됐다`);
    assert.deepEqual(late, [], `${html}: 로드 시점에 아직 안 읽힌 스크립트를 참조한다`);
  });
}
