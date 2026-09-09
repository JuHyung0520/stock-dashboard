/* 알림 설정 저장 검증 — server.js 의 sanitizeAlerts()
 *
 * 이 파일이 존재하는 이유: 2026-09-07 에 여기서 회귀가 났다.
 * `!g.lower` 를 `!(g.lower >= 0)` 로 바꿨는데 **JS 에서 `null >= 0` 은 참**이라
 * 빈 하단이 검증을 통과했고, 서버는 `Number(null)` = 0 이라 '0원'으로 조용히 저장했다.
 * 에이전트를 64개 돌려서 찾았다. 아래 첫 테스트 하나면 3초에 잡혔을 것이다. */
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeAlerts } = require('../server.js');

const grid = (over = {}) => ({ symbol: 'KR:005930', name: 'G', lower: 60000, upper: 70000, cells: 10, ...over });
const target = (over = {}) => ({ symbol: 'KR:005930', name: 'T', price: 70000, ...over });

test('빈 구간은 0 으로 저장되지 않고 버려진다 (null >= 0 회귀)', () => {
  for (const empty of [null, undefined, '']) {
    const r = sanitizeAlerts({ grids: [grid({ lower: empty })] });
    assert.equal(r.clean.grids.length, 0, `lower=${JSON.stringify(empty)} 가 통과했다`);
    assert.match(r.dropped[0], /구간·칸 수/);
  }
});

test('상단 <= 하단이면 버린다', () => {
  assert.equal(sanitizeAlerts({ grids: [grid({ lower: 70000, upper: 70000 })] }).clean.grids.length, 0);
  assert.equal(sanitizeAlerts({ grids: [grid({ lower: 70000, upper: 60000 })] }).clean.grids.length, 0);
});

test('칸 수가 정수가 아니면 버린다 — 2.5칸은 경계선이 상단에 안 닿는다', () => {
  assert.equal(sanitizeAlerts({ grids: [grid({ cells: 2.5 })] }).clean.grids.length, 0);
  assert.equal(sanitizeAlerts({ grids: [grid({ cells: 10 })] }).clean.grids.length, 1);
});

test('정상 그리드는 통과한다', () => {
  const { clean, dropped } = sanitizeAlerts({ grids: [grid()] });
  assert.equal(dropped.length, 0);
  assert.deepEqual(
    { lower: clean.grids[0].lower, upper: clean.grids[0].upper, cells: clean.grids[0].cells },
    { lower: 60000, upper: 70000, cells: 10 });
});

test('가격·등락률이 둘 다 비면 목표가를 버린다', () => {
  assert.equal(sanitizeAlerts({ targets: [target({ price: null })] }).clean.targets.length, 0);
  assert.equal(sanitizeAlerts({ targets: [target({ price: null, changePct: -3 })] }).clean.targets.length, 1);
});

test('id 가 프로토타입 오염 이름이면 갈아끼운다', () => {
  // state.targets["__proto__"] 대입은 "첫 실행은 발화하지 않는다"는 방어를 통째로 무력화한다
  for (const evil of ['__proto__', 'constructor', 'prototype']) {
    const id = sanitizeAlerts({ targets: [target({ id: evil })] }).clean.targets[0].id;
    assert.notEqual(id, evil);
    assert.match(id, /^t[a-z0-9]+$/);
  }
});

test('중복 id 는 서로 달라진다 — 같은 상태를 공유하면 첫 실행에 오발화한다', () => {
  const { clean } = sanitizeAlerts({ targets: [target({ id: 'same' }), target({ id: 'same' })] });
  assert.equal(clean.targets.length, 2);
  assert.notEqual(clean.targets[0].id, clean.targets[1].id);
});

test('마스터 스위치는 fail-open 되지 않는다', () => {
  for (const off of [false, 'false', 0]) {
    assert.equal(sanitizeAlerts({ enabled: off }).clean.enabled, false, `${JSON.stringify(off)} 가 켜짐으로 읽혔다`);
  }
  assert.equal(sanitizeAlerts({}).clean.enabled, true);
});

test('sound:false 는 무음이라는 유효한 선택 — 기본값으로 덮지 않는다', () => {
  assert.equal(sanitizeAlerts({ targets: [target({ sound: false })] }).clean.targets[0].sound, false);
  assert.equal(sanitizeAlerts({ targets: [target({ sound: 'Ping' })] }).clean.targets[0].sound, 'Ping');
  assert.equal(sanitizeAlerts({ targets: [target({ sound: '../evil' })] }).clean.targets[0].sound, 'Glass');
});

test('종목 코드 형식이 아니면 버린다', () => {
  for (const bad of ['005930', 'KR:', 'XX:005930', '', null]) {
    assert.equal(sanitizeAlerts({ targets: [target({ symbol: bad })] }).clean.targets.length, 0, `${bad} 가 통과했다`);
  }
});

test('범위 밖 쿨다운은 기본값으로 떨어진다', () => {
  const c = (v) => sanitizeAlerts({ targets: [target({ cooldownMin: v })] }).clean.targets[0].cooldownMin;
  assert.equal(c(0), 60);        // 하한 미만
  assert.equal(c(99999), 60);    // 상한 초과
  assert.equal(c('abc'), 60);
  assert.equal(c(30), 30);
});

test('배열이 아닌 targets/grids 는 빈 배열로 읽는다', () => {
  const { clean } = sanitizeAlerts({ targets: 'nope', grids: 42 });
  assert.deepEqual([clean.targets, clean.grids], [[], []]);
});

test('개수 상한을 넘기지 않는다', () => {
  const many = Array.from({ length: 300 }, () => target());
  assert.equal(sanitizeAlerts({ targets: many }).clean.targets.length, 100);
});
