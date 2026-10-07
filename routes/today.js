/* 오늘의 장 정리 — /today 페이지가 쓰는 한 덩어리 응답.
 * 지수 1분 시세(네이버) + 수급(토스, 네이버 폴백) + 랭킹(토스)을 모아 글 요약까지 붙인다.
 * 글 요약은 pure.js 의 템플릿이다 — 서버가 문장을 만들어 두면 화면은 그대로 보여주기만 한다. */
const toss = require('../toss');
const { cached, sendJSON } = require('../lib/core');
const { krIndices, krIntraday, investorMarket } = require('../lib/data');
const Pure = require('../public/pure.js');

async function buildToday() {
  const empty = { date: null, points: [] };
  const rank = (k) => (toss.enabled
    ? cached(`rank:${k}:KR`, 30000, () => toss.rankings(k, { country: 'KR' })).catch(() => null)   // 랭킹 라우트와 같은 키 — 캐시를 나눠 쓴다
    : Promise.resolve(null));
  const [idx, kospi, kosdaq, flow, series, gainers, losers, amount] = await Promise.all([
    krIndices(),
    krIntraday('KOSPI').catch(() => empty),
    krIntraday('KOSDAQ').catch(() => empty),
    cached('inv:market', 45000, investorMarket).catch(() => null),
    toss.enabled ? toss.marketFlowSeries('KOSPI', 40).catch(() => []) : Promise.resolve([]),
    rank('gainers'), rank('losers'), rank('amount'),
  ]);

  const byId = Object.fromEntries(idx.map((i) => [i.id, i]));
  const index = (id, intra) => {
    const live = byId[id];
    // 전일 종가 = 현재값 − 전일 대비. 장중엔 현재값이 움직이지만 이 차이는 그대로다
    const prevClose = live && live.value != null && live.change != null ? live.value - live.change : null;
    const stats = Pure.sessionStats(intra.points, prevClose);
    return {
      id, name: live ? live.name : id, prevClose, marketState: live ? live.marketState : null,
      value: live ? live.value : null, changePct: live ? live.changePct : null,
      points: intra.points, stats, narrative: Pure.sessionNarrative(stats),
    };
  };

  // 토스 시계열은 최신이 index 0 — 연속일은 거기서부터 센다 (오늘 잠정치 포함)
  const streaks = {
    foreign: Pure.streak(series.map((r) => r.foreign)),
    institution: Pure.streak(series.map((r) => r.institution)),
    individual: Pure.streak(series.map((r) => r.individual)),
  };
  const kospiFlow = flow && flow.markets ? flow.markets.find((m) => m.market === '코스피') || flow.markets[0] : null;

  return {
    date: kospi.date || kosdaq.date || null,
    indices: [index('KOSPI', kospi), index('KOSDAQ', kosdaq)],
    flow: flow ? { ...flow, streaks, narrative: Pure.flowNarrative(kospiFlow, streaks) } : null,
    rankings: { gainers, losers, amount },
  };
}

module.exports = [
  { path: '/api/today',
    handle: async ({ res }) => sendJSON(res, 200, await cached('today', 60000, buildToday)) },
];
