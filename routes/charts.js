/* 지수·시총비교·전고대비·ADR 라우트.
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
    /* ── 지수 (/idx) ──────────────────────────
     * 낮에는 KRX 현물, 밤에는 Hyperliquid 선물.
     * 코스피200 선물(xyz:KR200)이 24시간 돌기 때문에 국장이 닫힌 뒤에도
     * "지금 코스피가 어디쯤인가"를 추정할 수 있다.
     * 환산식: 코스피 추정 = 코스피 현재값 × (KR200 선물 / 코스피200 현물)
     *   — 선물/현물 비율(베이시스)을 그대로 코스피에 옮긴다. 장중에는 이 값이
     *     실제 코스피와 거의 같아야 하므로 식이 맞는지 화면에서 바로 검산된다. */
  { path: '/api/idx',
    handle: async ({ req, res, url, p }) => {
      const data = await cached('idx', 5000, async () => {
        const [dom, wld, hl, usdkrw] = await Promise.all([
          getJSON('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ,KPI200'),
          getJSON('https://polling.finance.naver.com/api/realtime/worldstock/index/.INX,.IXIC').catch(() => ({})),
          hlXyz().catch(() => ({})),
          getJSON('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW')
            .then((r) => r.result).catch(() => null),
        ]);

        const NAMES = { KOSPI: '코스피', KOSDAQ: '코스닥', KPI200: '코스피200' };
        const spot = (dom.datas || []).map((d) => ({
          id: d.itemCode,
          name: NAMES[d.itemCode] || d.itemCode,
          value: num(d.closePriceRaw ?? d.closePrice),
          change: signed(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, d.compareToPreviousPrice?.name),
          changePct: signed(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, d.compareToPreviousPrice?.name),
          open: num(d.openPriceRaw), high: num(d.highPriceRaw), low: num(d.lowPriceRaw),
          tradingValue: num(d.accumulatedTradingValueRaw),
          marketState: mapMarketStatus(d.marketStatus),
          tradedAt: d.localTradedAt || null,
        }));

        const f = (sym, label) => (hl[sym] ? { ...hl[sym], label } : null);
        const kospi = spot.find((x) => x.id === 'KOSPI');
        const kpi200 = spot.find((x) => x.id === 'KPI200');
        const kr200 = hl['xyz:KR200'];

        // 선물/현물 베이시스를 코스피로 옮긴 환산값
        let implied = null;
        if (kr200 && !kr200.stale && kpi200?.value && kospi?.value) {
          const factor = kr200.mark / kpi200.value;
          implied = {
            kospi: kospi.value * factor,
            kpi200: kr200.mark,
            factor,
            basisPct: (factor - 1) * 100,        // 선물이 현물보다 비싼 정도
            spotBasis: kpi200.value,
            // 장중이면 현물과 나란히 놓고 검산할 수 있다는 뜻
            live: kospi.marketState === 'OPEN',
          };
        }

        const usd = num(usdkrw?.calcPrice);
        const global = [
          ...(wld.datas || []).map((d) => ({
            id: d.reutersCode,
            name: d.reutersCode === '.INX' ? 'S&P 500' : '나스닥',
            value: num(d.closePriceRaw ?? d.closePrice),
            changePct: signed(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, d.compareToPreviousPrice?.name),
            marketState: mapMarketStatus(d.marketStatus),
            source: '네이버 · 미국장',
          })),
          usd ? {
            id: 'FX_USDKRW', name: '원/달러', value: usd,
            changePct: signed(usdkrw.fluctuationsRatio, usdkrw.fluctuationsType?.name),
            source: '하나은행 고시',
          } : null,
          hl['xyz:JPY'] && !hl['xyz:JPY'].stale
            ? { id: 'JPY', name: '엔/달러', value: hl['xyz:JPY'].mark, changePct: hl['xyz:JPY'].changePct, source: 'Hyperliquid' }
            : null,
        ].filter(Boolean);

        return {
          spot, implied, global,
          futures: [
            f('xyz:KR200', '코스피200 선물'),
            f('xyz:EWY', 'EWY (한국 ETF)'),
            f('xyz:KORU', 'KORU (한국 3배)'),
            f('xyz:SP500', 'S&P500 선물'),
            f('xyz:JP225', '닛케이225 선물'),
            f('xyz:GOLD', '금'),
          ].filter(Boolean),
          asOf: Date.now(),
        };
      });
      return sendJSON(res, 200, data);
    } },
    /* ── 시총비교 (/marketcap) ──────────────────
     * 시총 = 일별 종가 × 현재 발행주식수.
     * 발행주식수가 기간 내내 일정하다고 가정하는 근사다(자사주 소각·증자 미반영).
     * 과거 시총의 정확한 값이 아니라 두 회사의 상대 크기 추이를 보는 용도. */
  { path: '/api/marketcap',
    handle: async ({ req, res, url, p }) => {
      const codes = (url.searchParams.get('codes') || '005930,000660')
        .split(',').map((s) => s.trim().toUpperCase()).filter((c) => KR_CODE.test(c)).slice(0, 2);
      if (codes.length < 2) return sendJSON(res, 400, { error: '비교할 두 종목이 필요합니다' });
      const withPref = url.searchParams.get('pref') === '1';
      /* ⚠️ 시총 = 수정주가 × 현재 발행주식수 는 주식수가 안 변한 구간에서만 맞다.
       * 액면분할·무상증자는 시총이 안 변하니 괜찮지만, 감자·유상증자·자사주 소각은 틀린다.
       * 실측: SK하이닉스는 2002년 21:1 감자를 겪어 1999년 수정종가가 718,108원으로 잡히고,
       *       여기에 현재 주식수를 곱하면 524조 — 당시 코스피 전체 시총을 넘는 허구가 나온다.
       * 그래서 10년을 상한으로 둔다. 감자·출자전환 같은 대형 이벤트는 대개 그 밖에 있다. */
      const MAX_RANGE = '10Y';
      const asked = url.searchParams.get('range');
      const valid = Object.hasOwn(RANGES, asked) ? asked : '1Y';
      const capped = valid === 'ALL';
      const range = capped ? MAX_RANGE : valid;
      const from = rangeFrom(range);

      const data = await cached(`mcap:${codes.join(',')}:${range}:${withPref ? 1 : 0}`, 60000, async () => {
        // 우선주 코드는 보통주 끝자리 0 → 5. 없는 종목도 많아서 실패하면 조용히 건너뛴다.
        const partsOf = (code) => (withPref && code.endsWith('0') ? [code, `${code.slice(0, 5)}5`] : [code]);
        const allParts = codes.flatMap(partsOf);

        // 발행주식수 — 토스가 유일한 소스. 없으면 시총 계산 자체가 불가능하다.
        let sharesBy = {};
        if (toss.enabled) {
          try {
            const s = await toss.call('/api/v1/stocks', { symbols: [...new Set(allParts)].join(',') });
            sharesBy = Object.fromEntries((Array.isArray(s) ? s : [s])
              .filter(Boolean).map((x) => [x.symbol, { shares: num(x.sharesOutstanding), name: x.name }]));
          } catch (e) { console.warn(`[시총] 발행주식수 실패: ${e.message}`); }
        }
        if (!codes.every((c) => sharesBy[c]?.shares)) {
          return { unavailable: true, reason: '발행주식수를 가져오지 못했습니다 (토스 API 필요)' };
        }

        const [quotes, dailies] = await Promise.all([
          krQuotes([...new Set(allParts)]).catch(() => []),
          Promise.all(allParts.map((c) =>
            dailyCached(c, from).catch(() => null))),
        ]);
        const dailyBy = Object.fromEntries(allParts.map((c, i) => [c, dailies[i]]));
        const quoteBy = Object.fromEntries(quotes.map((q) => [q.code, q]));

        // 실제로 쓸 수 있는 구성 종목만 남긴다 (우선주 없는 종목 대비)
        const entities = codes.map((code) => {
          const parts = partsOf(code)
            .filter((c) => dailyBy[c] && sharesBy[c]?.shares)
            .map((c) => ({ code: c, name: sharesBy[c].name, shares: sharesBy[c].shares, price: quoteBy[c]?.price ?? null }));
          return { code, label: sharesBy[code].name, parts, prefIncluded: parts.length > 1 };
        });

        // 두 종목의 거래일이 완전히 같지는 않을 수 있다 → 기준 종목 날짜에 맞춰 정렬
        const mapOf = (c) => new Map(patchToday(dailyBy[c], quoteBy[c]?.price).map((r) => [r.date, r]));
        const maps = Object.fromEntries(allParts.filter((c) => dailyBy[c]).map((c) => [c, mapOf(c)]));

        const dates = [...maps[codes[0]].keys()];
        const full = [];
        for (const date of dates) {
          const caps = entities.map((e) => {
            let cap = 0;
            for (const pt of e.parts) {
              const row = maps[pt.code].get(date);
              if (!row) return null;                  // 한 구성종목이라도 결측이면 그 날은 버린다
              cap += row.close * pt.shares;
            }
            return cap;
          });
          if (caps.some((c) => c == null)) continue;
          full.push({ date, caps, ratio: caps[1] ? caps[0] / caps[1] : null });
        }
        if (!full.length) return { unavailable: true, reason: '겹치는 거래일이 없습니다' };

        const gaps = full.map((r) => r.caps[0] - r.caps[1]);
        const iMax = gaps.indexOf(Math.max(...gaps));
        const iMin = gaps.indexOf(Math.min(...gaps));
        const last = full[full.length - 1];

        return {
          range, from,
          entities: entities.map((e, i) => ({
            ...e,
            cap: last.caps[i],
            changePct: quoteBy[e.code]?.changePct ?? null,
            marketState: quoteBy[e.code]?.marketState ?? null,
          })),
          points: downsample(full),
          tradingDays: full.length,
          stats: {
            gap: gaps[gaps.length - 1],
            ratio: last.ratio,
            maxGap: { date: full[iMax].date, value: gaps[iMax] },
            minGap: { date: full[iMin].date, value: gaps[iMin] },
            // 한 번이라도 역전된 적이 있는가 (하닉 > 삼전 같은 사건)
            everFlipped: Math.min(...gaps) < 0,
          },
          note: '수정종가 × 현재 발행주식수 — 액면분할은 시총이 안 변해 정확하지만, 감자·유상증자·자사주 소각은 반영되지 않아 과거로 갈수록 오차가 커집니다',
        };
      });
      // capped는 요청에 달린 값이라 캐시 본문에 넣으면 안 된다 (ALL과 10Y가 같은 키를 공유한다)
      return sendJSON(res, 200, { ...data, capped });
    } },
    /* ── 전고대비 (/peak) ───────────────────────
     * 전고점 대비 낙폭과 "원금 회복에 필요한 상승률"을 같이 낸다.
     * −50%는 +100%가 있어야 돌아온다 — 하락률만 보면 이 비대칭이 안 보인다. */
  { path: '/api/peak',
    handle: async ({ req, res, url, p }) => {
      const syms = (url.searchParams.get('codes') || 'KOSPI,KOSDAQ,005930,000660')
        .split(',').map((s) => s.trim()).filter((c) => PEAK_CODE.test(c)).slice(0, 24);
      const range = Object.hasOwn(RANGES, url.searchParams.get('range') ?? '') ? url.searchParams.get('range') : '1Y';
      const from = rangeFrom(range);

      const data = await cached(`peak:${syms.join(',')}:${range}`, 60000, async () => {
        const INDEX_NAMES = { KOSPI: '코스피', KOSDAQ: '코스닥', KPI200: '코스피200' };
        const stockCodes = syms.filter((s) => /^\d{6}$/.test(s));
        const indexCodes = syms.filter((s) => !/^\d{6}$/.test(s));

        const [quotes, idxLive, dailies] = await Promise.all([
          stockCodes.length ? krQuotes(stockCodes).catch(() => []) : [],
          indexCodes.length
            ? getJSON(`https://polling.finance.naver.com/api/realtime/domestic/index/${indexCodes.join(',')}`)
              .then((r) => r.datas || []).catch(() => [])
            : [],
          Promise.all(syms.map((s) => dailyCached(s, from).catch((e) => {
            console.warn(`[전고] ${s} 실패: ${e.message}`);
            return null;
          }))),
        ]);

        const liveBy = {
          ...Object.fromEntries(quotes.map((q) => [q.code, { name: q.name, price: q.price, changePct: q.changePct, marketState: q.marketState }])),
          ...Object.fromEntries(idxLive.map((d) => [d.itemCode, {
            name: INDEX_NAMES[d.itemCode] || d.itemCode,
            price: num(d.closePriceRaw ?? d.closePrice),
            changePct: signed(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, d.compareToPreviousPrice?.name),
            marketState: mapMarketStatus(d.marketStatus),
          }])),
        };

        const today = ymd(new Date());
        const rows = syms.map((sym, i) => {
          const hist = dailies[i];
          if (!hist?.length) return null;
          const live = liveBy[sym] || {};
          const rowsPatched = patchToday(hist, live.price);
          const current = live.price ?? rowsPatched[rowsPatched.length - 1].close;

          // 전고점은 장중 고가 기준 (통상적 의미). 종가 기준도 같이 내서 해석 여지를 남긴다.
          let peak = -Infinity, peakDate = null, low = Infinity, lowDate = null;
          let peakClose = -Infinity, peakCloseDate = null;
          for (const r of rowsPatched) {
            if (r.high > peak) { peak = r.high; peakDate = r.date; }
            if (r.close > peakClose) { peakClose = r.close; peakCloseDate = r.date; }
            if (r.low < low) { low = r.low; lowDate = r.date; }
          }
          const dt = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
          const daysSince = Math.round((dt(today) - dt(peakDate)) / 86400000);

          return {
            code: sym,
            name: live.name || INDEX_NAMES[sym] || sym,
            isIndex: !/^\d{6}$/.test(sym),
            current, changePct: live.changePct ?? null, marketState: live.marketState ?? null,
            peak, peakDate, daysSincePeak: daysSince,
            peakClose, peakCloseDate,
            low, lowDate,
            drawdownPct: peak ? (current / peak - 1) * 100 : null,     // 음수 = 전고 대비 하락
            recoveryPct: current ? (peak / current - 1) * 100 : null,  // 전고 회복에 필요한 상승률
            fromLowPct: low ? (current / low - 1) * 100 : null,
            isNewHigh: current >= peak,
            firstDate: rowsPatched[0].date,
            tradingDays: rowsPatched.length,
            points: downsample(rowsPatched, 180).map((r) => ({ d: r.date, c: r.close })),
          };
        }).filter(Boolean);

        rows.sort((a, b) => (a.drawdownPct ?? 0) - (b.drawdownPct ?? 0));   // 많이 빠진 순
        return { range, from, rows, asOf: Date.now() };
      });
      return sendJSON(res, 200, data);
    } },
    /* ── 하닉 ADR (/adr) ─────────────────────────
     * SK하이닉스는 미국에 ADR(SKHY.O)로도 거래된다.
     * ⚠️ ADR 비율을 틀리면 괴리율이 통째로 무의미해진다.
     *    실측 검증: 네이버가 주는 ADR 시가총액 ÷ ADR 주가 = 총 ADR 수 = 7,288,655,000
     *    ÷ 발행주식수 730,492,365 = 9.978 → 1주 = 10 ADR.
     *    같은 계산을 매 요청마다 다시 해서 화면에 노출한다 (하드코딩하지 않는다).
     * 지금 ADR은 한국 대비 약 +28% 프리미엄에 거래된다 — 그게 이 페이지의 주제다. */
  { path: '/api/adr',
    handle: async ({ req, res, url, p }) => {
      const data = await cached('adr', 10000, async () => {
        const [adrQ, krQ, fx, hl, tossAdr] = await Promise.all([
          getJSON('https://polling.finance.naver.com/api/realtime/worldstock/stock/SKHY.O')
            .then((r) => r.datas?.[0] || null).catch(() => null),
          krQuotes(['000660']).then((r) => r[0] || null).catch(() => null),
          getJSON('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW')
            .then((r) => r.result).catch(() => null),
          hlXyz().catch(() => ({})),
          // 네이버 폴링이 한 세션 뒤처지는 경우가 있다(실측: 네이버 163.08 vs 토스·HL 167.5)
          toss.enabled
            ? cached('adr:toss', 60000, () => toss.candles('SKHY.O', { interval: '1d', count: 3 }))
              .then((c) => c[0] || null).catch(() => null)
            : null,
        ]);
        if (!adrQ || !krQ || !fx) return { unavailable: true, reason: 'ADR·한국시세·환율 중 일부를 가져오지 못했습니다' };

        const SHARES = 730492365;
        const adrPx = num(adrQ.closePriceRaw ?? adrQ.closePrice);
        const mvUsd = num(adrQ.marketValueFullRaw);
        const usdkrw = num(fx.calcPrice);
        const krPx = krQ.price;

        // ADR 비율 역산 — 매번 계산해서 소스가 바뀌면 화면에서 바로 보이게
        const derived = mvUsd && adrPx ? (mvUsd / adrPx) / SHARES : null;
        const ratio = derived ? Math.round(derived) : 10;      // 통상 정수배
        const ratioTrusted = derived != null && Math.abs(derived - ratio) / ratio < 0.03;

        // 이력도 같은 비율로 계산해야 차트와 헤드라인이 어긋나지 않는다
        const hist = await adrHistory(ratio)
          .catch((e) => { console.warn(`[ADR] 이력 실패: ${e.message}`); return []; });

        // 비교 기준: ADR 1주분 가치를 원화로 환산해 한국 주가와 견준다
        const adrKrw = adrPx * ratio * usdkrw;
        const overPx = adrQ.overMarketPriceInfo?.overMarketStatus === 'OPEN'
          ? num(adrQ.overMarketPriceInfo.overPrice) : null;

        const skhy = hl['xyz:SKHY'], skhx = hl['xyz:SKHX'];
        const hlKrw = skhy && !skhy.stale ? skhy.mark * ratio * usdkrw : null;

        /* ── 두 종류의 ADR 가격을 구분해서 낸다 ──
         * (1) 정규장 종가: 네이버 SKHY.O. 공식이지만 미국장이 닫혀 있으면 낡는다.
         * (2) 24시간 시세: 토스 최신 일봉과 HL xyz:SKHY. 실측하니 이 둘이 서로 일치한다.
         *     ⚠️ HL의 markPx == oraclePx 인 것을 확인했다 — 독립적 가격발견이 아니라
         *        오라클(ADR 현물 피드)을 그대로 따라간다는 뜻이다. 둘이 같은 값인 게 정상이며
         *        "선물이 별도로 말해주는 가격"처럼 읽히면 안 된다. */
        const naverDate = (adrQ.localTradedAt || '').slice(0, 10);
        const tossNewer = tossAdr?.date && naverDate && tossAdr.date > naverDate;

        const liveCandidates = [
          tossAdr?.close != null ? { price: tossAdr.close, src: '토스 일봉', asOf: tossAdr.date } : null,
          skhy && !skhy.stale ? { price: skhy.mark, src: 'Hyperliquid', asOf: null } : null,
        ].filter(Boolean);
        const live = liveCandidates.length ? {
          price: liveCandidates[0].price,
          sources: liveCandidates.map((x) => x.src),
          asOf: liveCandidates[0].asOf,
          // 두 소스가 얼마나 벌어져 있나 — 벌어지면 어느 쪽을 믿을지 판단이 필요하다
          spreadPct: liveCandidates.length > 1
            ? Math.abs(liveCandidates[0].price / liveCandidates[1].price - 1) * 100 : null,
          oracleTracking: !!(skhy && skhy.oracle != null && skhy.mark != null
            && Math.abs(skhy.mark - skhy.oracle) < 1e-9),
        } : null;

        // 헤드라인은 가장 신선한 값 — 낡은 정규장 종가로 프리미엄을 내면 몇 %p가 통째로 틀린다
        const best = (tossNewer && live)
          ? { price: live.price, asOf: live.asOf, source: live.sources.join(' · '), live: true }
          : { price: adrPx, asOf: naverDate, source: '네이버 정규장 종가', live: false };
        const bestKrw = best.price * ratio * usdkrw;

        return {
          ratio: {
            value: ratio, derived,
            trusted: ratioTrusted,
            basis: `네이버 ADR 시총 $${Math.round(mvUsd).toLocaleString('en-US')} ÷ ADR가 $${adrPx} ÷ 발행주식수 ${SHARES.toLocaleString('ko-KR')}주`,
          },
          kr: {
            price: krPx, changePct: krQ.changePct, marketState: krQ.marketState,
            extPrice: krQ.extPrice, extPct: krQ.extPct,
            usd: usdkrw ? krPx / usdkrw : null,
          },
          adr: {
            price: adrPx, changePct: signed(adrQ.fluctuationsRatioRaw ?? adrQ.fluctuationsRatio, adrQ.compareToPreviousPrice?.name),
            marketState: mapMarketStatus(adrQ.marketStatus),
            tradedAt: adrQ.localTradedAt || null,
            sessionType: adrQ.overMarketPriceInfo?.tradingSessionType || null,
            overPrice: overPx,
            high: num(adrQ.highPriceRaw), low: num(adrQ.lowPriceRaw),
            volume: num(adrQ.accumulatedTradingVolumeRaw),
            krwPerShare: adrKrw,
            marketCapKrw: num(adrQ.marketValueKrwRaw),
          },
          hl: skhy && !skhy.stale ? {
            mark: skhy.mark, oracle: skhy.oracle, changePct: skhy.changePct,
            volUsd: skhy.volUsd, oiUsd: skhy.oiUsd, krwPerShare: hlKrw,
          } : null,
          live: live ? { ...live, krwPerShare: live.price * ratio * usdkrw } : null,
          hlCommon: skhx && !skhx.stale ? { mark: skhx.mark, changePct: skhx.changePct, volUsd: skhx.volUsd } : null,
          fx: { usdkrw, changePct: signed(fx.fluctuationsRatio, fx.fluctuationsType?.name) },
          // 헤드라인용 — 가장 신선한 ADR 가격과 그 출처
          best: { ...best, krwPerShare: bestKrw, naverIsStale: !!tossNewer },
          premium: {
            headline: krPx ? (bestKrw / krPx - 1) * 100 : null,
            adr: krPx ? (adrKrw / krPx - 1) * 100 : null,
            hl: krPx && hlKrw ? (hlKrw / krPx - 1) * 100 : null,
          },
          history: hist,
          note: 'ADR 1주는 보통주 1/' + ratio + '주. 한국은 장중·ADR은 미국장 기준이라 시점차가 섞입니다.',
        };
      });
      return sendJSON(res, 200, data);
    } },
];
