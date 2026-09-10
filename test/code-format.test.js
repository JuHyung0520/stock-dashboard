/* 종목 코드 형식 규칙이 클라이언트와 서버에서 갈라지지 않는지
 *
 * 같은 규칙을 두 곳에 적어 두면 반드시 갈라진다. 실제로 그랬다:
 *  · 시총비교는 클라이언트·서버 모두 \d{6} 이라 영문이 붙는 단축코드(00104K = CJ4우(전환))를 거부했고,
 *    검색으로는 고를 수 있었기 때문에 고른 순간 **다음 새로고침에 두 종목 다 기본값으로 초기화**됐다.
 *  · 전고대비는 클라이언트 {1,12} 대소문자 구분 vs 서버 {3,10} 대소문자 무시로 어긋나 있었다.
 * 값이 아니라 '규칙 문자열이 양쪽에 같이 있는가'를 잠근다 — 한쪽만 고치면 여기서 걸린다. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('시총비교 — 국내 단축코드 규칙이 서버와 클라이언트에 같이 있다', () => {
  const rule = '[0-9A-Z]{6}';
  for (const f of ['server.js', 'public/marketcap.js']) {
    assert.ok(read(f).includes(rule), `${f} 에 ${rule} 이 없다 — 한쪽만 바뀌면 종목이 조용히 사라진다`);
  }
});

test('전고대비 — 코드 필터 규칙이 서버와 클라이언트에 같이 있다', () => {
  const rule = '[A-Z0-9]{3,10}';
  for (const f of ['server.js', 'public/peak.js']) {
    assert.ok(read(f).includes(rule), `${f} 에 ${rule} 이 없다`);
  }
});

test('규칙이 실제 코드를 제대로 가른다', () => {
  const kr = /^[0-9A-Z]{6}$/i;
  for (const ok of ['005930', '00104K', '005935']) assert.ok(kr.test(ok), `${ok} 를 거부했다`);
  for (const no of ['KOSPI', '12345', '1234567', '00104K ', '']) assert.ok(!kr.test(no), `${no} 를 통과시켰다`);

  const peak = /^[A-Z0-9]{3,10}$/i;
  for (const ok of ['KOSPI', 'KOSDAQ', '005930', '00104K', 'kospi']) assert.ok(peak.test(ok), `${ok} 를 거부했다`);
  for (const no of ['KP', '', 'KOSPI200EXTRA']) assert.ok(!peak.test(no), `${no} 를 통과시켰다`);
});
