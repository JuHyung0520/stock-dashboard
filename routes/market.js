/* 시세·프로필·검색·수급·뉴스 라우트.
 * 본문은 server.js 에서 그대로 옮겼다 — if 껍데기만 함수로 바뀌었을 뿐이다.
 * 각 항목은 path(정확히 일치) 또는 match(정규식) 중 하나로 자기 주소를 밝힌다. */
const fs = require('node:fs');
const path = require('node:path');
const toss = require('../toss');
const analysis = require('../analysis');
const M = require('../metrics');
const { KR_CODE, PEAK_CODE } = require('../public/pure.js');
const { sanitizeAlerts } = require('../lib/alerts');
const { PUBLIC_DIR, UA, cached, getJSON, num, mapMarketStatus, signed, sendJSON } = require('../lib/core');
const D = require('../lib/data');
const {
  krQuotes, krIndices, investorMarket, investorStock, usProfile, stockProfile, search,
  usQuotes, usIndicesAndFx, buildOverview, newsMain, newsForStock,
  ymd, RANGES, rangeFrom, naverDaily, dailyCached, patchToday, downsample, hlXyz, adrHistory,
} = D;

module.exports = [
  { path: '/api/overview',
    handle: async ({ req, res, url, p }) => {
      const data = await cached('overview', 5000, buildOverview);
      return sendJSON(res, 200, data);
    } },
  { path: '/api/quotes',
    handle: async ({ req, res, url, p }) => {
      // 값이 외부 URL 경로에 그대로 들어간다 — 형식과 개수를 여기서 잘라낸다
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 60);
      const krCodes = ids.filter((i) => /^KR:\d{6}$/.test(i)).map((i) => i.slice(3));
      const usCodes = ids.filter((i) => /^US:[\w.-]{1,20}$/.test(i)).map((i) => i.slice(3));
      const [kr, us] = await Promise.all([
        krCodes.length ? cached(`kr:${krCodes.join(',')}`, 4000, () => krQuotes(krCodes)) : [],
        usCodes.length ? cached(`us:${usCodes.join(',')}`, 4000, () => usQuotes(usCodes)) : [],
      ]);
      return sendJSON(res, 200, { quotes: [...kr, ...us] });
    } },
  { path: '/api/investor/market',
    handle: async ({ req, res, url, p }) => {
      return sendJSON(res, 200, await cached('inv:market', 45000, investorMarket));
    } },
  { match: /^\/api\/investor\/stock\/(\w+)$/,
    handle: async ({ req, res, url, p }, invStock) => {
      return sendJSON(res, 200, await cached(`inv:${invStock[1]}`, 60000, () => investorStock(invStock[1])));
    } },
  { match: /^\/api\/metrics\/(\w+)$/,
    handle: async ({ req, res, url, p }, metrics) => {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      return sendJSON(res, 200, await cached(`metrics:${metrics[1]}`, 600000, () => toss.stockMetrics(metrics[1])));
    } },
  { path: '/api/news/main',
    handle: async ({ req, res, url, p }) => {
      return sendJSON(res, 200, await cached('news:main', 60000, newsMain));
    } },
  { match: /^\/api\/news\/stock\/(.+)$/,
    handle: async ({ req, res, url, p }, newsStock) => {
      const id = decodeURIComponent(newsStock[1]);
      return sendJSON(res, 200, await cached(`news:${id}`, 60000, () => newsForStock(id)));
    } },
  { path: '/api/profiles',
    handle: async ({ req, res, url, p }) => {
      const ids = (url.searchParams.get('ids') || '')
        .split(',').map((c) => c.trim()).filter(Boolean).slice(0, 16);
      const list = await Promise.all(ids.map((id) => {
        const isUS = id.startsWith('US:');
        const sym = id.replace(/^(KR|US):/, '');
        if (!/^[\w.-]+$/.test(sym)) return null;
        return cached(`profile:${id}`, 1800000, () => (isUS ? usProfile(sym) : stockProfile(sym)))
          .then((r) => ({ id, ...r }))
          .catch((e) => {
            console.warn(`[프로필] ${id} 실패: ${e.message}`);
            return null;
          });
      }));
      return sendJSON(res, 200, { profiles: list.filter(Boolean) });
    } },
  { match: /^\/api\/orderbook\/(.+)$/,
    handle: async ({ req, res, url, p }, ob) => {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const sym = decodeURIComponent(ob[1]).replace(/^(KR|US):/, '');
      return sendJSON(res, 200, await cached(`ob:${sym}`, 2000, () => toss.orderbook(sym)));
    } },
  { match: /^\/api\/rankings\/(\w+)$/,
    handle: async ({ req, res, url, p }, rank) => {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const country = url.searchParams.get('country') === 'US' ? 'US' : 'KR';
      return sendJSON(res, 200,
        await cached(`rank:${rank[1]}:${country}`, 30000, () => toss.rankings(rank[1], { country })));
    } },
  { path: '/api/search',
    handle: async ({ req, res, url, p }) => {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJSON(res, 200, { results: [] });
      return sendJSON(res, 200, { results: await cached(`search:${q}`, 300000, () => search(q)) });
    } },
];
