/* ETF 괴리율 라우트.
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
    /* ── ETF NAV·괴리율 ──
     * 네이버 integration의 etfKeyIndicator가 iNAV와 괴리율을 직접 준다.
     * 시세는 5초 폴링과 함께 오지만 NAV는 2분 캐시 — 괴리율은 최신 시세로 직접 재계산한다. */
  { path: '/api/etf',
    handle: async ({ req, res, url, p }) => {
      const codes = (url.searchParams.get('codes') || '')
        .split(',').map((c) => c.trim()).filter((c) => /^\w+$/.test(c)).slice(0, 20);
      if (!codes.length) return sendJSON(res, 200, { rows: [] });

      /* ⚠️ 여기서 크게 틀렸던 것 (2026-08-24 실측으로 확인)
       * 네이버 etfKeyIndicator 의 `nav` 는 실시간 iNAV 가 아니라 **전일 기준 NAV** 다.
       * 그걸 현재가와 비교해 괴리를 내면, 그날 많이 움직인 종목에서 괴리가 통째로 틀린다.
       *   실측: 삼성전자 −6.8% 인 날, 2배 레버리지 ETF 가
       *         우리 계산 −15.15% vs 실제 −0.47%  (30배 차이)
       *   근거: 7개 종목 전부 nav 가 '전일 종가 ÷ (1+등락률)' 과 2% 이내로 일치했다.
       *
       * 반대로 `deviationRate` 는 실시간이다(가격을 따라 움직이는 것을 확인).
       * 그래서 실시간 iNAV 는 그 괴리에서 역산한다: iNAV = 현재가 ÷ (1 + 괴리).
       * 예전에 이 증상을 'NAV 캐시가 낡아서'로 오진하고 캐시를 2분→20초로 줄였는데,
       * 원인은 신선도가 아니라 **애초에 다른 값** 이었다. */
      const [quotes, navs] = await Promise.all([
        cached(`kr:${codes.join(',')}`, 4000, () => krQuotes(codes)),
        Promise.all(codes.map((c) =>
          cached(`nav:${c}`, 20000, async () => {
            const d = await getJSON(`https://m.stock.naver.com/api/stock/${c}/integration`);
            const e = d?.etfKeyIndicator || {};
            return {
              code: c,
              navPrevClose: num(e.nav),                    // 전일 기준 NAV
              deviationPct: e.deviationRate != null
                ? (e.deviationSign === '-' ? -1 : 1) * num(e.deviationRate) : null,
            };
          }).catch(() => ({ code: c, navPrevClose: null, deviationPct: null })))),
      ]);

      const navBy = Object.fromEntries(navs.map((n) => [n.code, n]));
      const rows = codes.map((c) => {
        const q = quotes.find((x) => x.code === c);
        const n = navBy[c] || {};
        const price = q?.price ?? null;
        const gap = n.deviationPct ?? null;
        // 실시간 iNAV 역산 — 네이버가 값 자체는 안 주고 괴리만 준다
        const inav = price != null && gap != null ? price / (1 + gap / 100) : null;
        return {
          id: `KR:${c}`, code: c,
          name: q?.name || c,
          price,
          // 프론트가 요일만 보고 장 상태를 추측하면 공휴일에 거짓말을 한다.
          // 거래소 기준을 아는 건 서버뿐이므로 반드시 함께 내린다.
          marketState: q?.marketState ?? null,
          changePct: q?.changePct ?? null,
          extPrice: q?.extPrice ?? null,
          extPct: q?.extPct ?? null,
          inav,                       // 실시간 (역산)
          navPrevClose: n.navPrevClose ?? null,
          gapPct: gap,                // 네이버 제공 — 이게 신뢰할 값
          // 전일 NAV 기준으로 보면 얼마인지 (참고용, 실시간 괴리 아님)
          vsPrevNavPct: price && n.navPrevClose ? ((price - n.navPrevClose) / n.navPrevClose) * 100 : null,
        };
      });
      return sendJSON(res, 200, { rows });
    } },
];
