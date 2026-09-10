/* 업스트림 데이터 계층 — 네이버·토스·Hyperliquid 에서 값을 가져와 우리 모양으로 바꾼다.
 * 라우트(routes/)는 여기서 받은 값을 조립해 응답만 만든다.
 * "어디서 가져오는가"와 "어떤 주소로 내주는가"를 갈라 둔다. */
const toss = require('../toss');
const { UA, cached, getJSON, num, mapMarketStatus, signed } = require('./core');

/* ═══════════════════ 국내 (네이버) ═══════════════════ */

// 국내 종목 배치 시세: datas[] — 콤마 문자열 가격
async function krQuotes(codes) {
  if (!codes.length) return [];
  const data = await getJSON(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`);
  return (data.datas || []).map((d) => ({
    id: `KR:${d.itemCode}`,
    code: d.itemCode,
    name: d.stockName,
    price: num(d.closePrice),
    change: signed(d.compareToPreviousClosePrice, d.compareToPreviousPrice?.name),
    changePct: signed(d.fluctuationsRatio, d.compareToPreviousPrice?.name),
    volume: num(d.accumulatedTradingVolume),
    currency: 'KRW',
    marketState: mapMarketStatus(d.marketStatus),
    // NXT 장전·장후 가격 — 정규장 밖에서도 평가손익을 최신으로
    extPrice: d.overMarketPriceInfo?.overMarketStatus === 'OPEN' ? num(d.overMarketPriceInfo.overPrice) : null,
    extPct: d.overMarketPriceInfo?.overMarketStatus === 'OPEN'
      ? signed(d.overMarketPriceInfo.fluctuationsRatio, d.overMarketPriceInfo.compareToPreviousPrice?.name)
      : null,
  }));
}

// 코스피/코스닥 지수 (Raw 필드 있음)
async function krIndices() {
  const data = await getJSON('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ');
  return (data.datas || []).map((d) => ({
    id: d.itemCode,
    name: d.itemCode === 'KOSPI' ? '코스피' : '코스닥',
    value: num(d.closePriceRaw ?? d.closePrice),
    change: signed(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, d.compareToPreviousPrice?.name),
    changePct: signed(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, d.compareToPreviousPrice?.name),
    kind: 'index',
    marketState: mapMarketStatus(d.marketStatus),
  }));
}

// 시장 전체 투자자별 순매수 (억원, 장중 잠정)
async function investorMarketNaver() {
  const [kospi, kosdaq] = await Promise.all([
    getJSON('https://m.stock.naver.com/api/index/KOSPI/trend'),
    getJSON('https://m.stock.naver.com/api/index/KOSDAQ/trend'),
  ]);
  const one = (market, d) => ({
    market,
    individual: num(d.personalValue),
    foreign: num(d.foreignValue),
    institution: num(d.institutionalValue),
    asOf: d.bizdate ? `${d.bizdate.slice(4, 6)}/${d.bizdate.slice(6, 8)}` : '',
  });
  return { markets: [one('코스피', kospi), one('코스닥', kosdaq)], provisional: true, unit: '억원', source: 'naver' };
}

// 종목별 일별 수급 (단위: 주)
async function investorStockNaver(code) {
  const rows = await getJSON(`https://m.stock.naver.com/api/stock/${code}/trend?pageSize=12&page=1`);
  const days = (Array.isArray(rows) ? rows : []).map((r) => ({
    date: r.bizdate ? `${r.bizdate.slice(4, 6)}/${r.bizdate.slice(6, 8)}` : '',
    close: num(r.closePrice),
    changePct: (() => {
      const close = num(r.closePrice);
      const chg = signed(r.compareToPreviousClosePrice, r.compareToPreviousPrice?.name);
      if (!close || chg == null) return null;
      const prev = close - chg;
      return prev ? (chg / prev) * 100 : null;
    })(),
    foreign: num(r.foreignerPureBuyQuant),
    institution: num(r.organPureBuyQuant),
    individual: num(r.individualPureBuyQuant),
  }));
  return { days, unit: '주', note: '최신일은 잠정치(T+1 확정)', source: 'naver' };
}

/* 토스 키가 있으면 토스 우선, 실패하면 네이버로 폴백.
 * 토스가 죽었다고 대시보드가 빈 화면이 되면 안 되므로 항상 폴백을 남겨둔다. */
async function withFallback(label, tossFn, naverFn) {
  if (toss.enabled) {
    try {
      return await tossFn();
    } catch (e) {
      console.warn(`[토스] ${label} 실패 → 네이버로 폴백: ${e.message}`);
    }
  }
  return naverFn();
}

const investorMarket = () =>
  withFallback('시장 수급', () => toss.marketInvestor(), investorMarketNaver);

const investorStock = (code) =>
  withFallback(`종목 수급 ${code}`, () => toss.stockInvestor(code), () => investorStockNaver(code));

/* 미국 종목 프로필.
 * 국내와 소스가 다르다 — 시총은 네이버 worldstock이 완성된 문자열로 주고,
 * 컨센서스는 오히려 국내보다 풍부해서 최고/최저 목표가까지 나온다.
 * 다만 52주 최저/최고와 PER/BPS는 어디에도 없어서 200일 캔들 범위로 대체한다. */
async function usProfile(reutersCode) {
  const [basic, integration, polling] = await Promise.all([
    getJSON(`https://api.stock.naver.com/stock/${encodeURIComponent(reutersCode)}/basic`).catch(() => ({})),
    getJSON(`https://api.stock.naver.com/stock/${encodeURIComponent(reutersCode)}/integration`).catch(() => ({})),
    getJSON(`https://polling.finance.naver.com/api/realtime/worldstock/stock/${encodeURIComponent(reutersCode)}`)
      .then((r) => r?.datas?.[0] || {}).catch(() => ({})),
  ]);

  const c = integration?.consensusInfo || {};
  const price = num(polling.closePriceRaw ?? polling.closePrice);
  const targetMean = num(c.priceTargetMean);

  // 52주 데이터가 없어서 토스 캔들 200일(약 9.5개월)로 대체한다 — 라벨도 다르게 표기
  let rangeLow = null, rangeHigh = null;
  if (toss.enabled) {
    try {
      const cd = await toss.candles(reutersCode, { count: 200 });
      if (cd.length) {
        rangeLow = Math.min(...cd.map((x) => x.low));
        rangeHigh = Math.max(...cd.map((x) => x.high));
      }
    } catch { /* 없으면 범위 막대 생략 */ }
  }

  if (price == null && !(basic.stockName || polling.stockName)) throw new Error(`profile empty: ${reutersCode}`);

  return {
    code: reutersCode,
    market: 'US',
    name: basic.stockName || polling.stockName || null,
    logo: basic.itemLogoUrl || null,
    price,
    marketCapText: polling.marketValueHangeul || null,      // "2,592억 USD"
    marketCapKrwText: polling.marketValueKrwHangeul || null, // "366조 9,791억원"
    rangeLow, rangeHigh, rangeLabel: '200일',
    targetMean,
    targetHigh: num(c.priceTargetHigh),
    targetLow: num(c.priceTargetLow),
    targetUpside: targetMean && price ? (targetMean / price - 1) * 100 : null,
    recommMean: num(c.recommMean),
    per: null, pbr: null,     // 미국 종목은 네이버가 제공하지 않는다
  };
}

/* 종목 프로필 — 카드 뷰용 부가 정보 (로고·시총·52주·목표가·PER)
 * 하루 단위로만 바뀌는 값들이라 길게 캐싱한다. */
async function stockProfile(code) {
  const [legacy, integration, tossInfo] = await Promise.all([
    // 52주 최저/최고·EPS·BPS는 레거시 realtime에만 있다 (EUC-KR이지만 숫자 필드는 무관)
    fetch(`https://polling.finance.naver.com/api/realtime?query=SERVICE_ITEM:${code}`, {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
    }).then(async (r) => {
      const buf = await r.arrayBuffer();
      const text = new TextDecoder('euc-kr').decode(buf);
      return JSON.parse(text)?.result?.areas?.[0]?.datas?.[0] || {};
    }).catch(() => ({})),
    getJSON(`https://m.stock.naver.com/api/stock/${code}/integration`).catch(() => ({})),
    getJSON(`https://m.stock.naver.com/api/stock/${code}/basic`).catch(() => ({})),
  ]);

  let shares = null;
  if (toss.enabled) {
    try {
      const s = await toss.call('/api/v1/stocks', { symbols: code });
      shares = num(Array.isArray(s) ? s[0]?.sharesOutstanding : null);
    } catch { /* 없으면 시총 생략 */ }
  }

  const price = num(legacy.nv);
  const eps = num(legacy.eps), bps = num(legacy.bps);
  const targetMean = num(integration?.consensusInfo?.priceTargetMean);

  // 네이버가 잠깐 죽으면 전부 null 인 프로필이 30분 캐시에 박혔다 — 비었으면 던져서 cached() 가 버리게 한다
  if (price == null && !tossInfo.stockName) throw new Error(`profile empty: ${code}`);

  return {
    code,
    market: 'KR',
    name: tossInfo.stockName || null,
    logo: tossInfo.itemLogoUrl || null,
    price,
    marketCap: shares && price ? shares * price : null,
    rangeLow: num(legacy.lowPriceOf52Weeks),
    rangeHigh: num(legacy.highPriceOf52Weeks),
    rangeLabel: '52주',
    targetMean,
    targetHigh: null, targetLow: null,   // 국내는 평균만 제공된다
    targetUpside: targetMean && price ? ((targetMean / price - 1) * 100) : null,
    recommMean: num(integration?.consensusInfo?.recommMean),
    per: eps && price ? price / eps : null,
    pbr: bps && price ? price / bps : null,
  };
}

// 종목 검색 (국내+미국 통합)
async function search(q) {
  const data = await getJSON(`https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(q)}&target=stock%2Cindex%2Cmarketindicator`);
  const items = data?.result?.items || [];
  return items
    .filter((it) => it.category === 'stock')
    .map((it) => {
      const isKR = it.nationCode === 'KOR';
      const isUS = it.nationCode === 'USA';
      if (!isKR && !isUS) return null;
      return {
        id: isKR ? `KR:${it.code}` : `US:${it.reutersCode}`,
        code: it.code,
        name: it.name,
        market: it.typeCode || '',
        isEtf: !!it.isEtf,   // 손익계산기에서 거래세 자동 면제 판정용
      };
    })
    .filter(Boolean);
}

/* ═══════════════════ 미국/환율 ═══════════════════ */
/* 심볼 규칙(로이터 RIC): 나스닥 = TICKER.O, 뉴욕 = 접미사 없는 티커, 클래스주 = BRKb.
 * 검색 API가 reutersCode를 그대로 주므로 관심종목 id에 그 값을 담는다. */

async function usQuotes(codes) {
  if (!codes.length) return [];
  const data = await getJSON(`https://polling.finance.naver.com/api/realtime/worldstock/stock/${codes.join(',')}`);
  return (data.datas || []).map((d) => {
    const over = d.overMarketPriceInfo;
    const dir = d.compareToPreviousPrice?.name;
    return {
      id: `US:${d.reutersCode}`,
      code: d.symbolCode || d.reutersCode,
      name: d.stockName,
      price: num(d.closePriceRaw ?? d.closePrice),
      change: signed(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, dir),
      changePct: signed(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, dir),
      volume: num(d.accumulatedTradingVolume),
      currency: 'USD',
      // 정규장이 닫혀도 프리/애프터마켓이 열려 있으면 그 상태를 보여준다
      marketState: over?.overMarketStatus === 'OPEN'
        ? (over.tradingSessionType === 'PRE_MARKET' ? 'PRE' : 'POST')
        : mapMarketStatus(d.marketStatus),
      extPrice: over?.overMarketStatus === 'OPEN' ? num(over.overPrice) : null,
      extPct: over?.overMarketStatus === 'OPEN'
        ? signed(over.fluctuationsRatio, over.compareToPreviousPrice?.name)
        : null,
    };
  });
}

async function usIndicesAndFx() {
  const [idx, fx] = await Promise.all([
    getJSON('https://polling.finance.naver.com/api/realtime/worldstock/index/.INX,.IXIC'),
    getJSON('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW'),
  ]);
  const out = (idx.datas || []).map((d) => ({
    id: d.reutersCode,
    name: d.reutersCode === '.INX' ? 'S&P 500' : '나스닥',
    value: num(d.closePriceRaw ?? d.closePrice),
    change: signed(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice, d.compareToPreviousPrice?.name),
    changePct: signed(d.fluctuationsRatioRaw ?? d.fluctuationsRatio, d.compareToPreviousPrice?.name),
    kind: 'index',
    marketState: mapMarketStatus(d.marketStatus),
  }));

  const f = fx?.result;
  if (f) {
    out.push({
      id: 'FX_USDKRW',
      name: '원/달러',
      value: num(f.calcPrice ?? f.closePrice),
      change: signed(f.fluctuations, f.fluctuationsType?.name),
      changePct: signed(f.fluctuationsRatio, f.fluctuationsType?.name),
      kind: 'fx',
      currency: 'KRW',
      marketState: null, // 하나은행 고시환율이라 장 상태 개념이 없음
    });
  }
  return out;
}

async function buildOverview() {
  const [kr, us] = await Promise.all([
    krIndices().catch((e) => { console.error('krIndices:', e.message); return []; }),
    usIndicesAndFx().catch((e) => { console.error('usIndices:', e.message); return []; }),
  ]);
  return { indices: [...kr, ...us] };
}

/* ═══════════════════ 뉴스 ═══════════════════ */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// datetime이 피드마다 14자리(yyyyMMddHHmmss) 또는 12자리(yyyyMMddHHmm)로 옴
function fmtNewsTime(dt) {
  const s = String(dt || '');
  if (s.length < 12) return '';
  return `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

// 시장 주요 뉴스
async function newsMain() {
  const data = await getJSON('https://m.stock.naver.com/front-api/news/category?category=mainnews&page=1&pageSize=20');
  const items = (data?.result || []).map((n) => ({
    title: decodeEntities(n.title),
    press: n.officeName || '',
    datetime: fmtNewsTime(n.datetime),
    url: `https://n.news.naver.com/article/${n.officeId}/${n.articleId}`,
  }));
  return { items };
}

// 종목 뉴스 — 국내 6자리 코드, 미국 로이터코드(AAPL.O) 둘 다 이 엔드포인트가 처리
async function newsForStock(id) {
  const code = id.replace(/^(KR|US):/, '');
  const clusters = await getJSON(`https://api.stock.naver.com/news/stock/${encodeURIComponent(code)}?pageSize=15&page=1`);
  const items = (Array.isArray(clusters) ? clusters : [])
    .flatMap((c) => c.items || [])
    .map((n) => ({
      title: decodeEntities(n.title),
      press: n.officeName || '',
      datetime: fmtNewsTime(n.datetime),
      url: n.mobileNewsUrl || `https://n.news.naver.com/article/${n.officeId}/${n.articleId}`,
    }));
  return { items };
}

/* ═══════════════════ 장기 일봉 (네이버 siseJson) ═══════════════════
 * 토스 캔들은 200개가 상한이라 3년·10년 비교가 불가능하다.
 * 이 엔드포인트는 1990년치까지 한 번에 주고(코스피 9,453행 실측) 수정주가라
 * 액면분할을 넘어 연속적으로 이어진다 — 장기 비교의 유일한 소스.
 * Referer 헤더가 없으면 거부당한다. 지수(KOSPI/KOSDAQ/KPI200)도 같은 경로다. */

function ymd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// 기간 → 소급 일수. null = 상장 이후 전체
const RANGES = { '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '3Y': 1096, '5Y': 1827, '10Y': 3653, 'ALL': null };

function rangeFrom(range) {
  const days = RANGES[range];
  if (days == null) return '19900101';
  const d = new Date();
  d.setDate(d.getDate() - days);
  return ymd(d);
}

async function naverDaily(symbol, from) {
  const res = await fetch(
    `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(symbol)}&requestType=1&startTime=${from}&endTime=${ymd(new Date())}&timeframe=day`,
    { headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`siseJson ${symbol} → ${res.status}`);
  const text = await res.text();

  // 응답이 JS 배열 리터럴이라(헤더 행은 홑따옴표) JSON.parse가 안 된다 → 행 단위로 훑는다
  const rows = [];
  const re = /\["(\d{8})",\s*([\d.-]+),\s*([\d.-]+),\s*([\d.-]+),\s*([\d.-]+),\s*([\d.-]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const close = +m[5];
    if (!close) continue;                    // 결측 행 방어
    /* 시/고/저가만 0으로 비어 있는 행이 드물게 있다 (실측: 코스피 2007-03-02).
     * 그대로 두면 기간 최저가가 0이 되어 "저점 대비"가 통째로 깨진다 → 종가로 메운다. */
    const open = +m[2] || close, high = +m[3] || close, low = +m[4] || close;
    rows.push({ date: m[1], open, high, low, close, volume: +m[6] });
  }
  if (!rows.length) throw new Error(`siseJson ${symbol}: 행 없음`);
  return rows;                               // 날짜 오름차순
}

/* 히스토리는 무겁다(코스피 전체 176KB) — 30분 캐시.
 * 대신 마지막 점(오늘)은 실시간 시세로 덮어써서 장중에도 끝이 살아 있게 한다. */
const dailyCached = (symbol, from) => cached(`daily:${symbol}:${from}`, 1800000, () => naverDaily(symbol, from));

function patchToday(rows, livePrice) {
  if (!livePrice || !rows.length) return rows;
  const today = ymd(new Date());
  const last = rows[rows.length - 1];
  if (last.date === today) {
    return [...rows.slice(0, -1), { ...last, close: livePrice, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice) }];
  }
  return rows;   // 장 시작 전이면 오늘 행이 아직 없다 — 억지로 만들지 않는다
}

// 차트 점이 수천 개면 SVG가 무거워진다. 마지막(오늘)은 반드시 남긴다.
function downsample(rows, target = 500) {
  if (rows.length <= target) return rows;
  const stride = Math.ceil(rows.length / target);
  const out = rows.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

/* ═══════════════════ Hyperliquid xyz DEX ═══════════════════
 * 주식·지수·환율·원자재 무기한선물 115종. 24시간 거래라 국장이 닫힌 밤에도 움직인다.
 * ⚠️ 미결제약정·거래대금이 0인 심볼(VIX·DXY·NIFTY 등)은 상장만 되고 거래가 없어
 *    마크가 고정된 껍데기다 — stale로 표시해서 절대 값으로 읽지 않게 한다. */
async function hlXyz() {
  return cached('hl:xyz', 5000, async () => {
    const [meta, ctxs] = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());

    const out = {};
    meta.universe.forEach((a, i) => {
      const c = ctxs[i] || {};
      const mark = num(c.markPx), prev = num(c.prevDayPx);
      const volUsd = num(c.dayNtlVlm), oi = num(c.openInterest);
      out[a.name] = {
        symbol: a.name, mark, prev,
        changePct: mark && prev ? (mark / prev - 1) * 100 : null,
        volUsd, oiUsd: oi != null && mark ? oi * mark : null,
        oracle: num(c.oraclePx),
        fundingHourPct: c.funding != null ? num(c.funding) * 100 : null,
        stale: !(volUsd > 0) || !(oi > 0),
      };
    });
    return out;
  });
}

/* ── ADR 프리미엄 이력 ───────────────────────
 * 세 계열을 날짜로 맞춰 과거 프리미엄을 복원한다:
 *   ADR 종가(달러) × 비율 × 그날 환율  vs  한국 종가(원)
 * ADR 이력은 토스가 31거래일치만 준다(실측) — 차트 길이는 여기에 묶인다.
 * 미국장은 한국 마감 뒤에 열리므로 같은 날짜끼리 맞추는 게 맞다. */
async function adrHistory(ratio = 10) {
  if (!toss.enabled) return [];
  return cached(`adr:hist:${ratio}`, 900000, async () => {
    const [adrC, krRows, fxRows] = await Promise.all([
      toss.candles('SKHY.O', { interval: '1d', count: 200 }),
      /* ⚠️ 한국 종가는 반드시 네이버 일봉(KRX 정규장 종가)을 쓴다.
       * 토스 일봉은 NXT 연장세션까지 포함한 종가라(거래량 실측으로 확인) 라이브 프리미엄이
       * 쓰는 기준(네이버)과 달라, 같은 화면의 헤드라인과 차트가 서로 다른 값을 말하게 된다. */
      dailyCached('000660', rangeFrom('6M')),
      // 환율 이력은 siseJson이 안 되고 전용 API를 쓴다. pageSize 상한 60 (실측).
      getJSON('https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW&page=1&pageSize=60')
        .then((r) => (Array.isArray(r.result) ? r.result : []))
        .catch(() => []),
    ]);
    // 환율·한국 일봉이 비면 15분 동안 빈 이력이 박힌다 — 이번 응답만 주고 캐시는 비운다
    if (!krRows?.length || !fxRows.length) cache.delete(`adr:hist:${ratio}`);

    // 네이버 일봉은 YYYYMMDD, 토스 캔들은 YYYY-MM-DD — 키를 맞춘다
    const krBy = Object.fromEntries(krRows.map((r) => [
      `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`, r.close]));
    const fxBy = Object.fromEntries(fxRows.map((x) => [x.localTradedAt, num(x.closePrice)]));

    const out = [];
    // 최신이 index 0 이므로 뒤집어서 오름차순으로
    for (const a of [...adrC].reverse()) {
      const kr = krBy[a.date], fx = fxBy[a.date];
      if (!kr || !fx) continue;                    // 세 계열이 다 있는 날만
      const adrKrw = a.close * ratio * fx;         // 비율은 라이브에서 역산한 값을 그대로 받는다
      out.push({
        date: a.date,
        adr: a.close, kr, fx,
        adrKrw,
        premiumPct: (adrKrw / kr - 1) * 100,
      });
    }
    return out;
  });
}

module.exports = { krQuotes, krIndices, investorMarketNaver, investorStockNaver, withFallback, investorMarket, investorStock, usProfile, stockProfile, search, usQuotes, usIndicesAndFx, buildOverview, decodeEntities, fmtNewsTime, newsMain, newsForStock, ymd, RANGES, rangeFrom, naverDaily, dailyCached, patchToday, downsample, hlXyz, adrHistory };
