/* 램값·김프·HL 캔들 라우트.
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
    /* ── 김프 트래커 — Hyperliquid 한국주식 무기한선물 × 업비트 환율 ──
     * 삼전(xyz:SMSN)·하이닉스(xyz:SKHX) 달러 선물가를 USDT/KRW로 환산해
     * 한국 시세와의 괴리를 계산한다. 선물은 24시간 거래라 장 마감 후·주말에도 움직인다. */
  { path: '/api/gap',
    handle: async ({ req, res, url, p }) => {
      const data = await cached('gap', 5000, async () => {
        const [hl, upbit, krRes] = await Promise.all([
          hlXyz(),
          fetch('https://api.upbit.com/v1/ticker?markets=KRW-USDT', {
            signal: AbortSignal.timeout(8000),
          }).then((r) => r.json()),
          krQuotes(['005930', '000660']),
        ]);

        const usdtKrw = upbit?.[0]?.trade_price;

        const MAP = [
          { hl: 'xyz:SMSN', kr: 'KR:005930', name: '삼성전자' },
          { hl: 'xyz:SKHX', kr: 'KR:000660', name: 'SK하이닉스' },
        ];
        const rows = MAP.map(({ hl: sym, kr, name }) => {
          const c = hl[sym];
          const q = krRes.find((x) => x.id === kr);
          if (!c || c.stale || !q || !usdtKrw) return null;
          const usd = c.mark;
          const krw = usd * usdtKrw;                       // 환산가

          /* 비교 기준을 하나로 고정하지 않고 셋 다 계산해서 넘긴다.
           * 같은 선물 가격도 무엇과 비교하느냐에 따라 프리미엄이 크게 달라진다 —
           * 주말엔 금요일 종가와 비교하게 되므로 특히 그렇다. */
          const prevClose = q.price != null && q.change != null ? q.price - q.change : null;
          const bases = [
            { key: 'live', label: q.marketState === 'OPEN' ? '장중' : '종가', price: q.price },
            q.extPrice ? { key: 'nxt', label: 'NXT', price: q.extPrice } : null,
            prevClose ? { key: 'prev', label: '전일종가', price: prevClose } : null,
          ].filter(Boolean).map((b) => ({
            ...b, gapPct: b.price ? ((krw / b.price) - 1) * 100 : null,
          }));

          // 기본 선택: 장중이면 현재가, 마감 후 NXT가 열려 있으면 NXT, 아니면 종가
          const defaultKey = q.marketState === 'OPEN' ? 'live' : (q.extPrice ? 'nxt' : 'live');
          const chosen = bases.find((b) => b.key === defaultKey) || bases[0];

          const fh = c.fundingHourPct;                     // HL 펀딩은 시간당 (실측 검증됨)
          return {
            name, kr, code: kr.slice(3),
            usd, krw: Math.round(krw),
            marketState: q.marketState,
            bases, defaultBasis: chosen.key,
            krPrice: chosen.price, krBasis: chosen.label,
            gapPct: chosen.gapPct,
            hlChangePct: c.changePct,
            // 시간당 값은 소수 2자리로 찍으면 전부 0.00%이 된다 — 8시간·연율을 같이 준다
            fundingHourPct: fh,
            funding8hPct: fh != null ? fh * 8 : null,
            fundingAnnualPct: fh != null ? fh * 24 * 365 : null,
            openInterestUsd: c.oiUsd,
            volUsd: c.volUsd,
            oracle: c.oracle,
          };
        }).filter(Boolean);

        return { usdtKrw, rows, asOf: Date.now() };
      });
      return sendJSON(res, 200, data);
    } },
    /* Hyperliquid 캔들 — 야간 선물 차트. dex 접두사(xyz:)를 그대로 coin에 넣는다. */
  { path: '/api/hl/candles',
    handle: async ({ req, res, url, p }) => {
      const coin = url.searchParams.get('coin') || 'xyz:KR200';
      if (!/^xyz:[A-Z0-9]{1,12}$/.test(coin)) return sendJSON(res, 400, { error: 'coin 형식 오류' });
      const interval = ['5m', '15m', '1h', '4h', '1d'].includes(url.searchParams.get('interval'))
        ? url.searchParams.get('interval') : '1h';
      const SPAN = { '5m': 1, '15m': 2, '1h': 10, '4h': 40, '1d': 400 };   // 일 단위 조회 폭
      const candles = await cached(`hlc:${coin}:${interval}`, 20000, async () => {
        const end = Date.now();
        const start = end - SPAN[interval] * 86400000;
        const r = await fetch('https://api.hyperliquid.xyz/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }),
          signal: AbortSignal.timeout(10000),
        }).then((x) => x.json());
        return (Array.isArray(r) ? r : []).map((k) => ({
          t: k.t, o: num(k.o), h: num(k.h), l: num(k.l), c: num(k.c), v: num(k.v),
        }));
      });
      return sendJSON(res, 200, { coin, interval, candles });
    } },
    /* ── 램값 (/ram) ────────────────────────────
     * ⚠️ 흔한 오해: DRAMUSDT는 "램 칩 가격"이 아니다. 실측으로 확인했다.
     *   - exchangeInfo: underlyingType = "EQUITY" (금 XAUUSDT는 "COMMODITY"로 따로 있다)
     *   - constituents: dxfeed `DRAM:USLF24` / kaiko `KK_RFR_DRAMUSD` / pyth `DRAM`
     *     → 마이크론(MU:USLF24)과 완전히 같은 '미국 상장 종목' 템플릿이다
     *   - 요일별 변동성: 평일 4.1~6.7% vs 토 1.31% / 일 1.78% — 미국 증시 리듬을 따른다
     *   즉 티커 DRAM인 미국 상장 메모리 반도체 ETF다. DDR5 계약가와는 다른 것이다.
     *
     * 그래도 쓸모가 있는 이유: 24시간 거래되기 때문에 국장이 열리기 전 아침에
     * "밤사이 메모리 섹터가 어디로 갔는지"를 볼 수 있다. 그게 이 페이지의 목적이다. */
  { path: '/api/ram',
    handle: async ({ req, res, url, p }) => {
      const interval = ['15m', '1h', '4h', '1d'].includes(url.searchParams.get('interval'))
        ? url.searchParams.get('interval') : '1h';

      const data = await cached(`ram:${interval}`, 20000, async () => {
        const PEERS = [
          { sym: 'SKHYNIXUSDT', name: 'SK하이닉스' },
          { sym: 'MUUSDT', name: '마이크론' },
          { sym: 'SNDKUSDT', name: '샌디스크' },
          { sym: 'WDCUSDT', name: 'WDC' },
          { sym: 'SAMSUNGUSDT', name: '삼성전자' },
          { sym: 'NVDAUSDT', name: '엔비디아' },
        ];
        const bk = (sym, iv, limit, startTime) =>
          fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${limit}${startTime ? `&startTime=${startTime}` : ''}`,
            { signal: AbortSignal.timeout(9000) })
            .then((r) => r.json())
            .then((r) => (Array.isArray(r) ? r : []))
            .catch(() => []);

        const [tickers, hl, chart, dailyAll] = await Promise.all([
          fetch('https://fapi.binance.com/fapi/v1/ticker/24hr', { signal: AbortSignal.timeout(9000) })
            .then((r) => r.json()).catch(() => []),
          hlXyz().catch(() => ({})),
          bk('DRAMUSDT', interval, 200),
          // 상관 계산용 일봉 — DRAM 상장(2026-05-18) 이후 전 구간
          Promise.all([['DRAMUSDT'], ...PEERS.map((x) => [x.sym])].map(([s]) => bk(s, '1d', 200))),
        ]);

        const tBy = Object.fromEntries((Array.isArray(tickers) ? tickers : []).map((x) => [x.symbol, x]));
        const one = (sym, name) => {
          const t = tBy[sym];
          if (!t) return null;
          return {
            symbol: sym, name,
            price: num(t.lastPrice), changePct: num(t.priceChangePercent),
            high: num(t.highPrice), low: num(t.lowPrice), volUsd: num(t.quoteVolume),
          };
        };

        /* 상관·베타 — 가격 수준이 아니라 일간 수익률로 계산해야 허위상관을 피한다.
         * 심볼마다 상장일이 달라 캔들 개수가 다르다(DRAM 96개 vs SK하이닉스 81개).
         * 개수만 맞춰 끝에서 자르는 방식은 "일봉에 갭이 없다"는 가정에 기대는데,
         * 그 가정이 깨지면 서로 다른 날짜를 짝지어놓고 상관을 내게 된다.
         * 그래서 타임스탬프로 명시적으로 교집합을 잡는다. */
        const dramDaily = dailyAll[0];
        const retByTs = (rows) => {
          const m = new Map();
          for (let i = 1; i < rows.length; i++) {
            const prev = num(rows[i - 1][4]), cur = num(rows[i][4]);
            if (prev && cur) m.set(rows[i][0], cur / prev - 1);
          }
          return m;
        };
        const dramRet = retByTs(dramDaily);

        const peerStats = PEERS.map((pr, i) => {
          const rows = dailyAll[i + 1];
          if (!rows?.length) return null;
          const peerRet = retByTs(rows);
          const a = [], b = [];
          for (const [ts, v] of dramRet) {
            if (peerRet.has(ts)) { a.push(v); b.push(peerRet.get(ts)); }
          }
          const c = M.correlation(a, b);
          return {
            ...one(pr.sym, pr.name),
            corr: c ? c.r : null,
            beta: M.beta(b, a),        // DRAM 1% 변동 → 이 종목 몇 %
            samples: c ? c.n : 0,
          };
        }).filter((x) => x && x.symbol);

        const dram = one('DRAMUSDT', 'DRAM');
        const hlDram = hl['xyz:DRAM'] || null;
        const first = dramDaily[0];

        /* ── 밤사이 변화 ──
         * 이 페이지에서 가장 실용적인 숫자. 국장 마감(15:30 KST) 이후 메모리 섹터가
         * 어디로 갔는지가 다음 날 하이닉스·삼전 시초가의 힌트가 된다.
         * 15분봉으로 마지막 KRX 마감 시각을 찾아 그때 종가와 현재를 비교한다. */
        const overnight = await (async () => {
          const now = new Date();

          /* 가장 최근에 '지나간' 국장 마감(15:30 KST = 06:30 UTC)을 찾는다.
           *
           * 요일만 보고 토·일을 건너뛰는 방식이었는데, 그러면 공휴일이 그대로 통과한다 —
           * 추석 다음 날 아침에 '열리지도 않은 추석 당일 15:30'을 기준으로 잡아
           * 실제 밤사이가 아니라 연휴 전체를 하룻밤으로 세게 된다.
           * 공휴일 달력을 따로 들고 다니지 않고, 실제 거래일을 아는 곳에 물어본다:
           * 네이버 일봉은 휴장일에 행 자체가 없다 → 삼성전자 일봉이 곧 KRX 영업일 달력이다. */
          const closeTsOf = (d8) =>
            Date.UTC(+d8.slice(0, 4), +d8.slice(4, 6) - 1, +d8.slice(6, 8), 6, 30);

          let target = null;
          const krDays = await dailyCached('005930', ymd(new Date(Date.now() - 40 * 86400000))).catch(() => null);
          if (krDays?.length) {
            for (let i = krDays.length - 1; i >= 0; i--) {
              const t = closeTsOf(krDays[i].date);
              if (t <= now.getTime()) { target = t; break; }
            }
          }
          if (target == null) {
            // 달력을 못 받았을 때만 요일 근사로 되돌아간다 (공휴일은 못 거른다)
            const close = new Date(now);
            close.setUTCHours(6, 30, 0, 0);
            if (close > now) close.setUTCDate(close.getUTCDate() - 1);
            for (let i = 0; i < 7; i++) {
              const kd = new Date(close.getTime() + 9 * 3600000).getUTCDay();   // 0=일 6=토
              if (kd !== 0 && kd !== 6) break;
              close.setUTCDate(close.getUTCDate() - 1);
            }
            target = close.getTime();
          }

          /* 기준 시각부터 받는다. 고정 400개(99.8시간)는 연휴 공백(추석 뒤 월요일 아침 = 112시간)보다 짧아
           * 기준 봉이 조회 범위 밖으로 밀려 null 이 됐다. */
          const rows = await bk('DRAMUSDT', '15m', 1500, target - 15 * 60000);
          if (!rows.length) return null;

          /* 15분봉의 openTime 이 t 면 그 봉은 [t, t+15분) 구간이다.
           * `k[0] <= target` 로 마지막 봉을 고르면 15:30을 '포함하는' 봉(15:30~15:45)이 잡혀
           * 종가가 15:45 가격이 된다 — 마감 이후 15분이 밤사이에서 빠진다.
           * 마감 시각에 '끝나는' 봉, 즉 openTime + 15분 <= target 인 마지막 봉을 써야 한다. */
          const FIFTEEN = 15 * 60000;
          let base = null;
          for (const k of rows) { if (k[0] + FIFTEEN <= target) base = k; else break; }
          if (!base) return null;
          const from = num(base[4]), to = dram?.price;
          if (!from || !to) return null;
          return { from, to, pct: (to / from - 1) * 100, since: target };
        })().catch(() => null);

        return {
          dram: dram ? {
            ...dram,
            // HL은 미결제약정·펀딩을 준다 (바이낸스 24hr에는 없음)
            oiUsd: hlDram && !hlDram.stale ? hlDram.oiUsd : null,
            fundingHourPct: hlDram && !hlDram.stale ? hlDram.fundingHourPct : null,
            hlMark: hlDram && !hlDram.stale ? hlDram.mark : null,
          } : null,
          overnight,
          interval,
          candles: chart.map((k) => ({ t: k[0], o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5]) })),
          daily: dramDaily.map((k) => ({ t: k[0], c: num(k[4]) })),
          peers: peerStats,
          listedSince: first ? new Date(first[0]).toISOString().slice(0, 10) : null,
          dailyCount: dramDaily.length,
          // 기초자산 정체 — 화면에서 근거와 함께 밝힌다 (하루 한 번이면 충분)
          underlying: await cached('ram:underlying', 86400000, async () => {
            const [ei, cst] = await Promise.all([
              fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: AbortSignal.timeout(12000) })
                .then((r) => r.json())
                .then((j) => (j.symbols || []).find((s) => s.symbol === 'DRAMUSDT') || null).catch(() => null),
              fetch('https://fapi.binance.com/fapi/v1/constituents?symbol=DRAMUSDT', { signal: AbortSignal.timeout(9000) })
                .then((r) => r.json()).catch(() => null),
            ]);
            // 한 번 실패한 빈 결과가 24시간 박히면 안 된다 — 비었으면 캐시에서 빼고 이번 응답만 준다
            if (!ei) cache.delete('ram:underlying');
            return {
              contractType: ei?.contractType ?? null,
              underlyingType: ei?.underlyingType ?? null,
              underlyingSubType: ei?.underlyingSubType ?? null,
              onboardDate: ei?.onboardDate ? new Date(ei.onboardDate).toISOString().slice(0, 10) : null,
              constituents: (cst?.constituents || []).map((x) => ({ exchange: x.exchange, symbol: x.symbol, weight: x.weight })),
            };
          }).catch(() => null),
          note: '바이낸스 토큰화 무기한선물(DRAMUSDT) — 기초자산은 티커 DRAM인 미국 상장 메모리 반도체 ETF. 상관·베타는 일간 수익률 기준.',
        };
      });
      return sendJSON(res, 200, data);
    } },
];
