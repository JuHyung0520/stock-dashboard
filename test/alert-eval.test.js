/* 알림 판정 로직 — alert.js
 *
 * 이 데몬은 조용히 틀린다. 안 울려야 할 때 울리면 시끄러워서 바로 알지만,
 * 울려야 할 때 안 울리면 증상이 '침묵'이라 며칠 지나도 모른다.
 * 그래서 '발화하지 않아야 하는 경우'를 특히 촘촘히 잠근다. */
const test = require('node:test');
const assert = require('node:assert');
const { evalTarget, evalGrid, marketWindow, cooldownMs, priceOf } = require('../alert.js');

const T0 = Date.UTC(2026, 8, 8, 2, 0, 0);   // 아무 기준 시각
const tgt = (o = {}) => ({ symbol: 'KR:005930', name: 'T', price: 70000, op: '>=', cooldownMin: 60, rearmPct: 0.005, ...o });
const grd = (o = {}) => ({ symbol: 'KR:005930', name: 'G', lower: 60000, upper: 70000, cells: 10, cooldownMin: 15, ...o });

/* ── 장 시간대 ── */
test('marketWindow — 주말엔 어떤 시각도 창이 아니다', () => {
  for (const d of ['Sat', 'Sun']) {
    assert.equal(marketWindow({ weekday: d, minutes: 10 * 60 }), null);
  }
});

test('marketWindow — 경계값', () => {
  const w = (m) => marketWindow({ weekday: 'Mon', minutes: m });
  assert.equal(w(8 * 60 + 49), null);        // 개장 1분 전
  assert.equal(w(8 * 60 + 50), 'regular');   // 개장
  assert.equal(w(15 * 60 + 35), 'regular');  // 정규장 끝
  assert.equal(w(15 * 60 + 36), 'nxt');      // NXT 시작
  assert.equal(w(20 * 60), 'nxt');           // NXT 끝
  assert.equal(w(20 * 60 + 1), null);        // 그 뒤
});

test('priceOf — NXT 창에서는 정규장 종가가 아니라 NXT 가격을 본다', () => {
  // 정규장이 끝나면 q.price 는 15:30 종가에 얼어붙는다. 그걸로 교차를 보면 장후 알림이 구조적으로 0건이 된다
  assert.equal(priceOf({ price: 70000, extPrice: 71000 }, 'nxt'), 71000);
  assert.equal(priceOf({ price: 70000, extPrice: 71000 }, 'regular'), 70000);
  assert.equal(priceOf({ price: 70000 }, 'nxt'), 70000);   // NXT 가격이 없으면 폴백
  assert.equal(priceOf({}, 'regular'), null);
});

test('cooldownMs — 잘못된 값은 기본값으로, 단위는 분→ms', () => {
  assert.equal(cooldownMs(5, 60), 5 * 60000);
  assert.equal(cooldownMs(0, 60), 60 * 60000);      // 하한 미만
  assert.equal(cooldownMs('abc', 15), 15 * 60000);
  assert.equal(cooldownMs(null, 15), 15 * 60000);
});

/* ── 목표가 ── */
test('첫 관측에는 절대 발화하지 않는다', () => {
  const st = {};
  // 이미 목표가를 넘긴 상태로 처음 봤다 — 교차가 아니라 '원래 거기 있었다'
  assert.equal(evalTarget(tgt(), { price: 80000 }, st, T0, 'regular', false), null);
});

test('상향 교차에 발화한다', () => {
  const st = {}, t = tgt();
  evalTarget(t, { price: 69000 }, st, T0, 'regular', false);            // 기준 기록
  const r = evalTarget(t, { price: 70500 }, st, T0 + 60000, 'regular', false);
  assert.ok(r, '교차했는데 안 울렸다');
  assert.match(r.subtitle, /도달/);
  assert.equal(st.armed, false);
});

test('목표가에 못 미치면 안 울린다', () => {
  const st = {}, t = tgt();
  evalTarget(t, { price: 69000 }, st, T0, 'regular', false);
  assert.equal(evalTarget(t, { price: 69900 }, st, T0 + 60000, 'regular', false), null);
});

test('창이 바뀌면 직전값을 쓰지 않는다 — 거래 없이 울리는 것을 막는다', () => {
  const st = {}, t = tgt();
  evalTarget(t, { price: 69000 }, st, T0, 'regular', false);
  // 다음 회차가 NXT 창이면 69000 은 다른 시장의 값이라 교차 판정에 쓸 수 없다
  assert.equal(evalTarget(t, { price: 70500, extPrice: 70500 }, st, T0 + 60000, 'nxt', false), null);
});

test('쿨다운 중에는 안 울린다', () => {
  const st = {}, t = tgt({ cooldownMin: 60 });
  evalTarget(t, { price: 69000 }, st, T0, 'regular', false);
  assert.ok(evalTarget(t, { price: 70500 }, st, T0 + 60000, 'regular', false));
  // 다시 아래로 갔다 올라와도 60분 안이면 침묵
  evalTarget(t, { price: 69000 }, st, T0 + 120000, 'regular', false);
  assert.equal(evalTarget(t, { price: 70500 }, st, T0 + 180000, 'regular', false), null);
  // 60분 지나면 다시 울린다
  evalTarget(t, { price: 69000 }, st, T0 + 3600000, 'regular', false);
  assert.ok(evalTarget(t, { price: 70500 }, st, T0 + 3660000 + 1, 'regular', false));
});

test('once 는 한 번만 울린다', () => {
  const st = {}, t = tgt({ once: true, cooldownMin: 1 });
  evalTarget(t, { price: 69000 }, st, T0, 'regular', false);
  assert.ok(evalTarget(t, { price: 70500 }, st, T0 + 60000, 'regular', false));
  assert.equal(st.disabled, true);
  evalTarget(t, { price: 69000 }, st, T0 + 600000, 'regular', false);
  assert.equal(evalTarget(t, { price: 70500 }, st, T0 + 660000, 'regular', false), null);
});

test('조건을 고치면 소진된 once 가 되살아난다', () => {
  // 예전엔 disabled 를 푸는 길이 '삭제'뿐이라, 가격을 바꿔 저장해도 데몬이 계속 걸러냈다
  const st = {}, t = tgt({ once: true, cooldownMin: 1 });
  evalTarget(t, { price: 69000 }, st, T0, 'regular', false);
  evalTarget(t, { price: 70500 }, st, T0 + 60000, 'regular', false);
  assert.equal(st.disabled, true);

  const t2 = tgt({ once: true, cooldownMin: 1, price: 75000 });   // 목표가 변경
  evalTarget(t2, { price: 74000 }, st, T0 + 120000, 'regular', false);
  assert.equal(st.disabled, false, '조건을 바꿨는데 소진 상태가 안 풀렸다');
  assert.ok(evalTarget(t2, { price: 75500 }, st, T0 + 180000, 'regular', false));
});

test('record 회차는 기준만 기록하고 방아쇠를 건드리지 않는다', () => {
  const st = {}, t = tgt();
  evalTarget(t, { price: 69000 }, st, T0, 'regular', true);
  assert.equal(evalTarget(t, { price: 70500 }, st, T0 + 60000, 'regular', true), null);
  assert.equal(st.lastFiredAt, undefined, 'record 회차가 발화 시각을 남겼다');
  assert.equal(st.prev, 70500, '기준값은 기록되어야 한다');
});

/* ── 그리드 ── */
test('그리드 — 라인을 넘으면 울리고, 같은 라인은 두 번 울리지 않는다', () => {
  const st = {}, g = grd();                       // 60000~70000 을 10칸 → 1000 간격
  evalGrid(g, { price: 64500 }, st, T0, 'regular', false);
  const r = evalGrid(g, { price: 65500 }, st, T0 + 60000, 'regular', false);   // 65000 상향 통과
  assert.ok(r);
  assert.equal(st.lastLine, 5);
  // 되돌아왔다 다시 같은 라인을 넘어도 lastLine 이 같으면 침묵 (진동 방지)
  evalGrid(g, { price: 64500 }, st, T0 + 3600000, 'regular', false);
  assert.equal(evalGrid(g, { price: 65500 }, st, T0 + 3660000, 'regular', false), null);
});

test('그리드 — 한 번에 여러 라인을 지나면 멈춘 쪽에 가장 가까운 라인을 알린다', () => {
  const st = {}, g = grd();
  evalGrid(g, { price: 61500 }, st, T0, 'regular', false);
  const r = evalGrid(g, { price: 65500 }, st, T0 + 60000, 'regular', false);   // 62·63·64·65천 통과
  assert.equal(st.lastLine, 5, '가장 먼 라인을 알리면 되돌림 알림까지 막힌다');
  assert.match(r.message, /외 3개 라인/);
});

test('그리드 — 잘못된 구간은 조용히 건너뛴다', () => {
  const st = { prev: 64500, prevWin: 'regular' };
  assert.equal(evalGrid(grd({ upper: 60000 }), { price: 65500 }, st, T0, 'regular', false), null);
  assert.equal(evalGrid(grd({ cells: 0 }), { price: 65500 }, st, T0, 'regular', false), null);
});
