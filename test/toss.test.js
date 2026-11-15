/* 토스 연결이 막혔을 때 — toss.js
 *
 * 2026-11-15 집 공인 IP 가 바뀌어(유동 IP) 토스 쪽이 전부 멈췄다. 그때 라우트 절반은 502,
 * 절반은 '빈 결과'를 10분씩 캐시해서 화면은 그냥 "데이터 없음"이었다 — 이유를 알 방법이 없었다.
 * 인증 단계 실패는 TOSS_BLOCKED 표식 + '무엇을 하면 풀리는지'로 던지고, 막힌 동안은 1분에 한 번만 다시 시도한다.
 * fetch 를 가짜로 바꿔서 네트워크 없이 검사한다. 모듈 상태(토큰·막힘)가 남지 않게 테스트마다 새로 불러온다. */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const TOSS = path.join(__dirname, '..', 'toss.js');
function freshToss(fetchImpl) {
  delete require.cache[require.resolve(TOSS)];
  process.env.TOSS_CLIENT_ID = process.env.TOSS_CLIENT_ID || 'test-id';
  process.env.TOSS_CLIENT_SECRET = process.env.TOSS_CLIENT_SECRET || 'test-secret';
  global.fetch = fetchImpl;
  return require(TOSS);
}
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; delete require.cache[require.resolve(TOSS)]; });

const resp = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});

test('authReason — 막힌 이유를 사람이 할 일로 바꾼다', () => {
  const t = freshToss(realFetch);
  assert.match(t.authReason(403, '{"error":"access_denied","error_description":"IP address not allowed"}'),
    /허용 IP.*토스증권 PC웹 → 설정 → Open API → 허용 IP 관리/, 'IP 차단이면 어디서 고치는지까지 말해야 한다');
  assert.match(t.authReason(401, '{"error":"invalid_client"}'), /키가 거부/);
  assert.match(t.authReason(500, 'boom'), /인증 실패 \(500\)/);
});

test('IP 가 막히면 TOSS_BLOCKED 로 던지고, status 가 이유를 말한다', async () => {
  const t = freshToss(async () => resp(403, { error: 'access_denied', error_description: 'IP address not allowed' }));
  await assert.rejects(t.call('/api/v1/stocks', { symbols: '005930' }), (e) => e.code === 'TOSS_BLOCKED' && /허용 IP/.test(e.message));
  const st = t.status();
  assert.equal(st.ok, false);
  assert.match(st.reason, /허용 IP/);
});

test('막힌 동안엔 인증 서버를 다시 두드리지 않는다 (1분 백오프)', async () => {
  let authCalls = 0;
  const t = freshToss(async (url) => {
    if (String(url).includes('/oauth2/token')) authCalls++;
    return resp(403, { error: 'access_denied', error_description: 'IP address not allowed' });
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(t.call('/api/v1/stocks'), (e) => e.code === 'TOSS_BLOCKED');
  }
  assert.equal(authCalls, 1, `5번 요청에 인증 서버를 ${authCalls}번 불렀다 — 매번 두드리면 안 된다`);
});

test('종목별 오류를 삼키던 지표도 막힘만은 감추지 않는다 (빈 배열로 캐시되면 10분간 빈 화면)', async () => {
  const t = freshToss(async () => resp(403, { error: 'access_denied', error_description: 'IP address not allowed' }));
  await assert.rejects(t.stockMetrics('005930'), (e) => e.code === 'TOSS_BLOCKED');
});

test('다른 이유의 지표 실패는 예전처럼 빈 배열 (한 지표 때문에 나머지를 버리지 않는다)', async () => {
  const t = freshToss(async (url) => (String(url).includes('/oauth2/token')
    ? resp(200, { access_token: 'tok', expires_in: 86400 })
    : String(url).includes('short-selling') ? resp(500, 'boom') : resp(200, { result: { records: [{ date: '2026-11-14' }] } })));
  const m = await t.stockMetrics('005930');
  assert.deepEqual(m.shortSelling, [], '실패한 지표만 비어야 한다');
  assert.equal(m.program.length, 1, '성공한 지표는 남아야 한다');
  assert.equal(t.status().ok, true);
});

test('IP 를 고치면 다음 시도에 바로 정상으로 돌아온다', async () => {
  let fixed = false;
  const t = freshToss(async (url) => {
    if (String(url).includes('/oauth2/token')) {
      return fixed ? resp(200, { access_token: 'tok', expires_in: 86400 })
        : resp(403, { error: 'access_denied', error_description: 'IP address not allowed' });
    }
    return resp(200, { result: [{ symbol: '005930' }] });
  });
  await assert.rejects(t.call('/api/v1/stocks'));
  assert.equal(t.status().ok, false);
  fixed = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;   // 백오프가 지난 뒤
  try {
    const r = await t.call('/api/v1/stocks');
    assert.deepEqual(r, [{ symbol: '005930' }]);
    assert.equal(t.status().ok, true, '풀렸는데 계속 막혔다고 말한다');
  } finally { Date.now = realNow; }
});
