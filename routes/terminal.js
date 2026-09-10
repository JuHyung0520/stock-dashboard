/* 터미널 라우트.
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
    /* ── 터미널 — 종목 재무카드 + 지수/환율 레일 + 글로벌 반도체(바이낸스 토큰화) ──
     * 바이낸스 토큰화 주식(perp)은 24시간 거래라 미국장 마감 후·주말에도 살아 있다.
     * 램값(DRAMUSDT)은 여기서만 구할 수 있는 지표다. */
  { path: '/api/terminal',
    handle: async ({ req, res, url, p }) => {
      const data = await cached('terminal', 5000, async () => {
        const CODES = ['005930', '000660'];
        const [quotes, integrations, indices, usdkrw, jpykrw, binance] = await Promise.all([
          krQuotes(CODES),
          Promise.all(CODES.map((c) =>
            getJSON(`https://m.stock.naver.com/api/stock/${c}/integration`).catch(() => ({})))),
          krIndices(),
          getJSON('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW')
            .then((r) => r.result).catch(() => null),
          getJSON('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_JPYKRW')
            .then((r) => r.result).catch(() => null),
          fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: AbortSignal.timeout(8000) })
            .then((r) => r.json()).catch(() => []),
        ]);

        const binBy = Object.fromEntries((Array.isArray(binance) ? binance : []).map((x) => [x.symbol, x]));
        const bin = (sym, name) => {
          const x = binBy[sym];
          if (!x) return null;
          return {
            symbol: sym, name,
            price: num(x.lastPrice),
            changePct: num(x.priceChangePercent),
            volUsd: num(x.quoteVolume),
            high: num(x.highPrice), low: num(x.lowPrice),
          };
        };

        // 재무지표: totalInfos의 key-value 목록에서 뽑는다
        const pick = (infos, key) => (infos || []).find((x) => x.key === key)?.value ?? null;
        const stocks = CODES.map((code, i) => {
          const q = quotes.find((x) => x.code === code);
          const it = integrations[i] || {};
          const infos = it.totalInfos || [];
          const target = num(it.consensusInfo?.priceTargetMean);
          return {
            code, name: q?.name || code,
            price: q?.price ?? null, change: q?.change ?? null, changePct: q?.changePct ?? null,
            marketState: q?.marketState ?? null,
            extPrice: q?.extPrice ?? null, extPct: q?.extPct ?? null,
            per: pick(infos, 'PER'), perFwd: pick(infos, '추정PER'), pbr: pick(infos, 'PBR'),
            foreignRate: pick(infos, '외인소진율'), dividendYield: pick(infos, '배당수익률'),
            marketCap: pick(infos, '시총'),
            high52: pick(infos, '52주 최고'), low52: pick(infos, '52주 최저'),
            target,
            targetUpside: target && q?.price ? ((target / q.price) - 1) * 100 : null,
          };
        });

        // 엔/달러 — 직접 주는 API가 없어 원화 교차환율로 역산 (JPYKRW는 100엔당)
        const usd = num(usdkrw?.calcPrice);
        const jpy100 = num(jpykrw?.calcPrice);
        const usdjpy = usd && jpy100 ? usd / (jpy100 / 100) : null;

        return {
          stocks,
          rails: [
            ...indices.map((x) => ({ name: x.name, value: x.value, changePct: x.changePct, digits: 2 })),
            // 네이버는 하락 시 이미 음수로 준다 — 방향으로 한 번 더 뒤집으면 부호가 반대가 된다(실측 버그)
            usd ? { name: '원/달러', value: usd, changePct: signed(usdkrw.fluctuationsRatio, usdkrw.fluctuationsType?.name), digits: 2 } : null,
            usdjpy ? { name: '엔/달러', value: usdjpy, changePct: null, digits: 2, note: '교차환율 역산' } : null,
          ].filter(Boolean),
          semis: [bin('DRAMUSDT', 'DRAM'), bin('MUUSDT', '마이크론'), bin('NVDAUSDT', '엔비디아'), bin('TSMUSDT', 'TSMC')].filter(Boolean),
          binance: [
            bin('SKHYNIXUSDT', 'SK하이닉스'), bin('SKHYUSDT', '하이닉스 ADR'),
            bin('MUUSDT', '마이크론'), bin('SAMSUNGUSDT', '삼성전자'),
            bin('DRAMUSDT', 'DRAM'), bin('SNDKUSDT', '샌디스크'),
          ].filter(Boolean),
        };
      });
      return sendJSON(res, 200, data);
    } },
  { match: /^\/api\/binance\/klines$/,
    handle: async ({ req, res, url, p }, bk) => {
      const sym = (url.searchParams.get('symbol') || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
      const interval = ['5m', '15m', '1h', '4h', '1d'].includes(url.searchParams.get('interval')) ? url.searchParams.get('interval') : '15m';
      if (!sym) return sendJSON(res, 400, { error: 'symbol 필요' });
      const rows = await cached(`bk:${sym}:${interval}`, 20000, async () => {
        const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=96`,
          { signal: AbortSignal.timeout(8000) }).then((x) => x.json());
        return (Array.isArray(r) ? r : []).map((k) => ({
          t: k[0], o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]),
        }));
      });
      return sendJSON(res, 200, { symbol: sym, interval, candles: rows });
    } },
    /* 상대수익률 차트 — 여러 종목을 같은 기준일=0% 로 정규화 */
  { path: '/api/relative',
    handle: async ({ req, res, url, p }) => {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const codes = (url.searchParams.get('codes') || '005930,000660')
        .split(',').map((c) => c.trim()).filter((c) => /^\w+$/.test(c)).slice(0, 6);
      const range = url.searchParams.get('range') || '1D';
      const CFG = {
        // 1D는 분봉 — 토스 캔들 최대 200개라 최근 200분까지만 커버된다
        '1D': { interval: '1m', count: 200 },
        '1M': { interval: '1d', count: 22 },
        '3M': { interval: '1d', count: 64 },
        '6M': { interval: '1d', count: 126 },
        '1Y': { interval: '1d', count: 200 },   // 토스 상한 200
      };
      const cfg = Object.hasOwn(CFG, range) ? CFG[range] : CFG['1D'];
      const data = await cached(`rel:${codes.join(',')}:${range}`, range === '1D' ? 20000 : 300000, async () => {
        const series = await Promise.all(codes.map(async (c) => {
          try {
            const cd = await toss.candles(c, cfg);       // 최신이 index 0
            const asc = [...cd].reverse();
            const base = asc[0]?.close;
            if (!base) return null;
            return {
              code: c,
              points: asc.map((x) => ({ t: x.date, v: ((x.close / base) - 1) * 100, close: x.close })),
            };
          } catch { return null; }
        }));
        return { range, series: series.filter(Boolean) };
      });
      return sendJSON(res, 200, data);
    } },
];
