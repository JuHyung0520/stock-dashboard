/* 세력 좌표 라우트.
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
    /* ── 세력 좌표 (/flow) ── */
  { path: '/api/flow/market',
    handle: async ({ req, res, url, p }) => {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const market = url.searchParams.get('market') === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
      // 과거 99일은 하루가 지나야 바뀌므로 길게 캐싱해도 되지만,
      // 당일 잠정치가 장중 계속 갱신되므로 60초로 맞춘다.
      const data = await cached(`flow:${market}`, 60000, async () =>
        analysis.buildMarket(await toss.marketFlowSeries(market, 100)));
      return sendJSON(res, 200, { market, ...data });
    } },
  { path: '/api/flow/scan',
    handle: async ({ req, res, url, p }) => {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const codes = (url.searchParams.get('codes') || '')
        .split(',').map((c) => c.trim()).filter((c) => /^\w+$/.test(c)).slice(0, 12);
      if (!codes.length) return sendJSON(res, 200, { stocks: [] });

      const data = await cached(`scan:${codes.join(',')}`, 120000, async () => {
        // STOCK_TRADING_TREND 10/s · MARKET_DATA_CHART 20/s — 3종목씩 끊어 여유 있게
        const out = [];
        for (let i = 0; i < codes.length; i += 3) {
          const batch = await Promise.all(codes.slice(i, i + 3).map(async (code) => {
            try {
              const [flows, candles] = await Promise.all([
                toss.stockFlowSeries(code, 100),
                toss.candles(code, { count: 100 }),
              ]);
              return analysis.scanStock({ code, name: code, flows, candles });
            } catch (e) {
              console.warn(`[스캔] ${code} 실패: ${e.message}`);
              return null;
            }
          }));
          out.push(...batch.filter(Boolean));
        }
        return { stocks: out };
      });
      return sendJSON(res, 200, data);
    } },
];
