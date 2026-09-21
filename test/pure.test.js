/* public/pure.js — 브라우저와 서버가 같이 쓰는 순수 로직
 *
 * 이 파일들이 생기기 전, 프론트 5,392줄에는 직접 테스트가 하나도 없었다.
 * 로직이 모듈 스코프에 묶여 있어 부를 수가 없었기 때문이다.
 * 여기 있는 것들은 전부 실제로 버그가 났던 자리다. */
const test = require('node:test');
const assert = require('node:assert');
const Pure = require('../public/pure.js');

/* ── 종목 코드 형식 ──
 * 규칙이 클라이언트·서버 두 곳에 따로 있다가 갈라졌다. 이제 한 곳이다. */
test('국내 단축코드 — 영문이 붙는 코드도 받는다', () => {
  // 00104K(CJ4우(전환))를 거부해서, 검색으로 고르면 다음 새로고침에 두 종목 다 초기화됐다
  for (const ok of ['005930', '00104K', '005935', '00104k']) {
    assert.ok(Pure.isKrCode(ok), `${ok} 를 거부했다`);
  }
  for (const no of ['KOSPI', '12345', '1234567', '00104K ', '', null, undefined]) {
    assert.ok(!Pure.isKrCode(no), `${JSON.stringify(no)} 를 통과시켰다`);
  }
});

test('전고대비 코드 — 지수와 종목을 함께 받는다', () => {
  for (const ok of ['KOSPI', 'KOSDAQ', 'KPI200', '005930', '00104K', 'kospi']) {
    assert.ok(Pure.isPeakCode(ok), `${ok} 를 거부했다`);
  }
  for (const no of ['KP', '', 'KOSPI200EXTRA', null]) {
    assert.ok(!Pure.isPeakCode(no), `${JSON.stringify(no)} 를 통과시켰다`);
  }
});

test('서버와 화면이 같은 규칙 객체를 쓴다', () => {
  // require 로 얻은 것과 화면이 쓰는 것이 같은 파일이므로, 갈라질 자리가 없다
  const { KR_CODE, PEAK_CODE } = require('../public/pure.js');
  assert.equal(KR_CODE.source, Pure.KR_CODE.source);
  assert.equal(PEAK_CODE.source, Pure.PEAK_CODE.source);
});

/* ── 프로필 값을 현재가 시점으로 ── */
test('liveFacts — 가격이 오른 만큼 시총·PER·PBR 도 같이 올린다', () => {
  const p = { price: 100, marketCap: 1000, per: 10, pbr: 2, targetMean: 150 };
  const r = Pure.liveFacts(p, { price: 110 });   // +10%
  assert.equal(r.marketCap, 1100);
  assert.equal(Math.round(r.per * 100) / 100, 11);
  assert.equal(Math.round(r.pbr * 100) / 100, 2.2);
  // 상승여력은 목표가 대비라 현재가로 다시 계산한다 (150/110 - 1 = 36.4%)
  assert.equal(Math.round(r.upside * 10) / 10, 36.4);
});

test('liveFacts — 시세가 없으면 프로필 값을 그대로 둔다', () => {
  const p = { price: 100, marketCap: 1000, per: 10, pbr: 2, targetUpside: 20 };
  const r = Pure.liveFacts(p, null);
  assert.deepEqual([r.marketCap, r.per, r.pbr, r.upside], [1000, 10, 2, 20]);
});

test('liveFacts — 없는 값은 곱하지 않고 null 로 둔다', () => {
  // 0 이나 NaN 으로 바뀌면 화면에 '0조원' 같은 거짓 숫자가 뜬다
  const r = Pure.liveFacts({ price: 100, marketCap: null, per: null, pbr: null }, { price: 200 });
  assert.deepEqual([r.marketCap, r.per, r.pbr], [null, null, null]);
  assert.equal(Pure.liveFacts(null, { price: 1 }), null);
});

/* ── 긴 목록 줄이기 ── */
test('brief — 저장 바가 한 줄을 넘지 않게 앞 2건만', () => {
  assert.equal(Pure.brief(['가', '나']), '가 · 나');
  assert.equal(Pure.brief(['가', '나', '다', '라']), '가 · 나 외 2개');
  assert.equal(Pure.brief([]), '');
  assert.equal(Pure.brief(null), '');
});

/* ── 데몬 실패율 ── */
test('healthSummary — 기록이 없으면 아무것도 말하지 않는다', () => {
  for (const empty of [null, undefined, {}, { runs: 0 }]) {
    assert.equal(Pure.healthSummary(empty), null);
  }
});

test('healthSummary — 최근 창과 누적을 따로 센다', () => {
  const now = Date.now();
  const s = Pure.healthSummary({ runs: 5000, fails: 300, recent: '1'.repeat(90) + '0'.repeat(10) }, now);
  assert.equal(s.recentTotal, 100);
  assert.equal(s.recentFails, 10);
  assert.equal(s.ratePct, 10);
  assert.equal(s.runs, 5000);
  assert.equal(s.fails, 300);
});

test('healthSummary — 20% 넘으면 경고, 하나도 없으면 정상', () => {
  const lv = (recent) => Pure.healthSummary({ runs: 10, recent }).level;
  assert.equal(lv('1111111111'), 'good');
  assert.equal(lv('1111111110'), 'meh');    // 10%
  assert.equal(lv('1111111100'), 'bad');    // 20% — 경계 포함
  assert.equal(lv('0000000000'), 'bad');
});

test('healthSummary — 마지막 실패 경과를 분으로 준다', () => {
  const now = Date.UTC(2026, 8, 10, 5, 0, 0);
  const s = Pure.healthSummary({ runs: 3, recent: '110', lastFailAt: now - 90 * 60000, lastFailMsg: 'fetch failed' }, now);
  assert.equal(s.lastFailAgoMin, 90);
  assert.equal(s.lastFailMsg, 'fetch failed');
  assert.equal(Pure.healthSummary({ runs: 3, recent: '111' }, now).lastFailAgoMin, null);
});

/* ── 세대 가드 ──
 * 곳곳에 손으로 박다 보니 ram.js 는 통째로 빠져 있었다. 하나로 만들어 빠뜨릴 수 없게 했다. */
test('makeGuard — 마지막으로 시작한 것만 통과한다', () => {
  const g = Pure.makeGuard();
  const a = g.start();
  assert.ok(g.current(a), '방금 시작한 것은 통과해야 한다');
  const b = g.start();               // 사용자가 다른 탭으로 갔다
  assert.ok(!g.current(a), '옛 요청이 통과했다 — 새 화면을 덮는다');
  assert.ok(g.current(b));
});

test('makeGuard — 여러 번 겹쳐도 최신 하나만', () => {
  const g = Pure.makeGuard();
  const tokens = [g.start(), g.start(), g.start()];
  assert.deepEqual(tokens.map((t) => g.current(t)), [false, false, true]);
});

test('makeGuard — 가드끼리 섞이지 않는다', () => {
  // 한 페이지에 차트가 여럿이면(터미널: 상대강도 + 바이낸스) 각자 세어야 한다
  const a = Pure.makeGuard(), b = Pure.makeGuard();
  const ta = a.start(); b.start(); b.start();
  assert.ok(a.current(ta), '다른 차트의 전환이 내 요청을 무효로 만들었다');
});

/* ── 표시 헬퍼 ──
 * 11개 페이지가 각자 갖고 있던 것들. pct 는 소수 자릿수가 3종으로 갈라져 있었다. */
test('esc — HTML 특수문자 다섯 개를 막는다', () => {
  assert.equal(Pure.esc(`<img src=x onerror="alert('&')">`),
    '&lt;img src=x onerror=&quot;alert(&#39;&amp;&#39;)&quot;&gt;');
  assert.equal(Pure.esc(null), 'null');   // 문자열로 바꿔서라도 반드시 이스케이프한다
});

test('cls — 모르는 값(null)을 하락으로 칠하지 않는다', () => {
  assert.deepEqual([1, -1, 0, null, undefined].map(Pure.cls), ['up', 'down', 'flat', 'flat', 'flat']);
});

test('pct — 부호는 하이픈이 아니라 −(U+2212)', () => {
  // 하이픈은 숫자 옆에서 너무 짧아 마이너스로 안 읽힌다
  assert.equal(Pure.pct(-1.234), '−1.23%');
  assert.equal(Pure.pct(1.234), '+1.23%');
  assert.equal(Pure.pct(0), '0.00%');
  assert.equal(Pure.pct(null), '—');
  assert.equal(Pure.pct(NaN), '—');
});

test('pct — 자릿수를 넘기면 그대로 따른다 (전고대비는 1자리)', () => {
  assert.equal(Pure.pct(-38.44, 1), '−38.4%');
  assert.equal(Pure.pct(-38.44), '−38.44%');
});

test('money — 단위를 넘길 때마다 자릿수가 줄어든다', () => {
  assert.deepEqual([2.34e9, 1.5e6, 1500, null].map(Pure.money), ['$2.34B', '$1.5M', '$2K', '—']);
});

/* ── 그리드 매매 ──
 * cellState 가 없는 그리드 하나가 렌더러의 g.cellState.map 에서 터져 그리드 탭 전체가 비었다.
 * 백업 가져오기로 충분히 들어오는 경로라 불러올 때 고친다. 원칙: 지우지 않고 고친다. */
const base = { uid: 'g1', id: 'KR:005930', name: '삼성전자', lower: 250000, upper: 300000, cells: 10, qty: 1, start: 270000, fills: [] };

test('initialCellState — 시작가 이상에서 사는 칸은 보유로 시작한다', () => {
  const cs = Pure.initialCellState(250000, 300000, 10, 270000);   // 칸 간격 5,000
  assert.equal(cs.length, 10);
  assert.deepEqual(cs.map((c) => c.state), ['cash', 'cash', 'cash', 'cash', 'held', 'held', 'held', 'held', 'held', 'held']);
  assert.equal(cs[4].entryPx, 270000);
});

test('repairGrid — cellState 가 없으면 생성 규칙대로 다시 만든다', () => {
  const { grid, repaired } = Pure.repairGrid({ ...base });
  assert.ok(repaired);
  assert.ok(Pure.isUsableGrid(grid), '복구했는데도 못 쓰는 그리드다');
  assert.deepEqual(grid.cellState, Pure.initialCellState(250000, 300000, 10, 270000));
});

test('repairGrid — 멀쩡한 칸 상태(실제 체결 이력)는 보존한다', () => {
  // 복구가 사용자의 매매 기록을 초기값으로 덮어쓰면 그게 더 큰 사고다
  const cs = Pure.initialCellState(250000, 300000, 10, 270000);
  cs[0] = { state: 'held', entryPx: 251000 };   // 실제로 체결된 칸
  const { grid, repaired } = Pure.repairGrid({ ...base, cellState: cs });
  assert.equal(repaired, false);
  assert.deepEqual(grid.cellState[0], { state: 'held', entryPx: 251000 });
});

test('repairGrid — 망가진 칸만 골라 고치고 나머지는 둔다', () => {
  const cs = Pure.initialCellState(250000, 300000, 10, 270000);
  cs[0] = { state: 'held', entryPx: 251000 };
  cs[3] = null;                                  // 손상
  const { grid, repaired } = Pure.repairGrid({ ...base, cellState: cs });
  assert.ok(repaired);
  assert.deepEqual(grid.cellState[0], { state: 'held', entryPx: 251000 }, '멀쩡한 칸까지 덮었다');
  assert.deepEqual(grid.cellState[3], { state: 'cash' });
});

test('repairGrid — 문자열 숫자(다른 도구에서 만든 JSON)를 숫자로', () => {
  const { grid } = Pure.repairGrid({ ...base, lower: '250000', upper: '300000', cells: '10' });
  assert.deepEqual([grid.lower, grid.upper, grid.cells], [250000, 300000, 10]);
  assert.ok(Pure.isUsableGrid(grid));
});

test('repairGrid — 범위가 성립 안 하면 고치지 않고 못 쓴다고 알린다 (지우지도 않는다)', () => {
  for (const bad of [{ upper: 250000 }, { upper: 200000 }, { cells: 0 }, { cells: 2.5 }, { lower: 'x' }]) {
    const { grid } = Pure.repairGrid({ ...base, ...bad });
    assert.ok(!Pure.isUsableGrid(grid), `${JSON.stringify(bad)} 를 쓸 수 있다고 판정했다`);
    assert.equal(grid.uid, 'g1', '데이터를 지웠다');
  }
});
