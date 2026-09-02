/* 내 주식 보드 — 로컬 서버 (의존성 제로, Node 18+)
 * 실행: node server.js  →  http://localhost:8787
 *
 * 역할: 외부 시세 소스를 프록시하면서
 *  - 브라우저 CORS 제한 우회
 *  - 응답을 프론트용 정규화 스키마로 변환
 *  - TTL 캐시로 외부 요청 횟수 최소화 (개인용 예의)
 *
 * 수급 데이터는 .env에 토스 키가 있으면 토스증권 공식 Open API를 쓰고,
 * 없거나 실패하면 네이버(비공식)로 폴백한다.
 * 시세·뉴스·검색은 네이버. 외부 엔드포인트는 2026-08-13 실측 검증 기준.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const toss = require('./toss');
const analysis = require('./analysis');
const M = require('./metrics');

/* 로컬은 8787 고정. 배포 환경(Render 등)은 PORT 를 주입하는데,
 * 그때만 전 인터페이스에 연다 — 로컬에서 실수로 LAN 에 노출되는 일이 없게. */
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/* ── TTL 캐시 ────────────────────────── */
const cache = new Map(); // key -> { at, ttl, promise }
let lastSweep = 0;

/* 키에 사용자 입력(종목 코드 조합·검색어)이 들어가는 경로가 있어 항목이 무한히 쌓인다.
 * 개인용이라 위험은 낮지만 오래 켜두면 메모리가 계속 는다 — 가끔 만료분을 쓸어낸다. */
function sweepCache(now) {
  if (now - lastSweep < 300000) return;
  lastSweep = now;
  for (const [k, v] of cache) if (now - v.at > v.ttl * 4) cache.delete(k);
}

function cached(key, ttlMs, loader) {
  sweepCache(Date.now());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const promise = loader().catch((e) => {
    // 실패 응답은 캐시에서 즉시 제거해 다음 요청이 재시도하게 함
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), ttl: ttlMs, promise });
  return promise;
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/* ── 숫자 파싱 (네이버는 "+5,544,777" 같은 부호+콤마 문자열) ── */
function num(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const cleaned = String(s).replace(/[+,\s]/g, '').replace(/−/g, '-');
  const v = parseFloat(cleaned);
  return isNaN(v) ? null : v;
}

function mapMarketStatus(s) {
  if (s === 'OPEN') return 'OPEN';
  if (s === 'CLOSE' || s === 'CLOSED') return 'CLOSED';
  return s || null;
}

// 네이버는 하락 시 값에 이미 음수 부호가 붙어 옴(실측). 혹시 양수로 오는 변형에도 대비.
function signed(value, directionName) {
  const v = num(value);
  if (v == null) return null;
  if (directionName === 'FALLING' && v > 0) return -v;
  return v;
}

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

/* ═══════════════════ HTTP 서버 ═══════════════════ */

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/overview') {
      const data = await cached('overview', 5000, buildOverview);
      return sendJSON(res, 200, data);
    }

    if (p === '/api/quotes') {
      // 값이 외부 URL 경로에 그대로 들어간다 — 형식과 개수를 여기서 잘라낸다
      const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 60);
      const krCodes = ids.filter((i) => /^KR:\d{6}$/.test(i)).map((i) => i.slice(3));
      const usCodes = ids.filter((i) => /^US:[\w.-]{1,20}$/.test(i)).map((i) => i.slice(3));
      const [kr, us] = await Promise.all([
        krCodes.length ? cached(`kr:${krCodes.join(',')}`, 4000, () => krQuotes(krCodes)) : [],
        usCodes.length ? cached(`us:${usCodes.join(',')}`, 4000, () => usQuotes(usCodes)) : [],
      ]);
      return sendJSON(res, 200, { quotes: [...kr, ...us] });
    }

    if (p === '/api/investor/market') {
      return sendJSON(res, 200, await cached('inv:market', 45000, investorMarket));
    }

    const invStock = p.match(/^\/api\/investor\/stock\/(\w+)$/);
    if (invStock) {
      return sendJSON(res, 200, await cached(`inv:${invStock[1]}`, 60000, () => investorStock(invStock[1])));
    }

    // 공매도·프로그램매매·신용·대차 — 전부 일별 확정 데이터라 10분 캐시로 충분
    const metrics = p.match(/^\/api\/metrics\/(\w+)$/);
    if (metrics) {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      return sendJSON(res, 200, await cached(`metrics:${metrics[1]}`, 600000, () => toss.stockMetrics(metrics[1])));
    }

    if (p === '/api/news/main') {
      return sendJSON(res, 200, await cached('news:main', 60000, newsMain));
    }

    const newsStock = p.match(/^\/api\/news\/stock\/(.+)$/);
    if (newsStock) {
      const id = decodeURIComponent(newsStock[1]);
      return sendJSON(res, 200, await cached(`news:${id}`, 60000, () => newsForStock(id)));
    }

    /* ── 터미널 — 종목 재무카드 + 지수/환율 레일 + 글로벌 반도체(바이낸스 토큰화) ──
     * 바이낸스 토큰화 주식(perp)은 24시간 거래라 미국장 마감 후·주말에도 살아 있다.
     * 램값(DRAMUSDT)은 여기서만 구할 수 있는 지표다. */
    if (p === '/api/terminal') {
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
    }

    /* 바이낸스 캔들 — 토큰화 주식 24시간 차트 */
    const bk = p.match(/^\/api\/binance\/klines$/);
    if (bk) {
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
    }

    /* 상대수익률 차트 — 여러 종목을 같은 기준일=0% 로 정규화 */
    if (p === '/api/relative') {
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
      const cfg = CFG[range] || CFG['1D'];
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
    }

    /* ── ETF NAV·괴리율 ──
     * 네이버 integration의 etfKeyIndicator가 iNAV와 괴리율을 직접 준다.
     * 시세는 5초 폴링과 함께 오지만 NAV는 2분 캐시 — 괴리율은 최신 시세로 직접 재계산한다. */
    if (p === '/api/etf') {
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
    }

    /* ── 김프 트래커 — Hyperliquid 한국주식 무기한선물 × 업비트 환율 ──
     * 삼전(xyz:SMSN)·하이닉스(xyz:SKHX) 달러 선물가를 USDT/KRW로 환산해
     * 한국 시세와의 괴리를 계산한다. 선물은 24시간 거래라 장 마감 후·주말에도 움직인다. */
    if (p === '/api/gap') {
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
    }

    // 종목 프로필 (카드 뷰) — 국내·미국 모두. id 형식(KR:/US:)으로 소스를 가른다.
    if (p === '/api/profiles') {
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
    }

    // 호가창 — 장중엔 초 단위로 바뀌므로 캐시를 아주 짧게
    const ob = p.match(/^\/api\/orderbook\/(.+)$/);
    if (ob) {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const sym = decodeURIComponent(ob[1]).replace(/^(KR|US):/, '');
      return sendJSON(res, 200, await cached(`ob:${sym}`, 2000, () => toss.orderbook(sym)));
    }

    // 랭킹
    const rank = p.match(/^\/api\/rankings\/(\w+)$/);
    if (rank) {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const country = url.searchParams.get('country') === 'US' ? 'US' : 'KR';
      return sendJSON(res, 200,
        await cached(`rank:${rank[1]}:${country}`, 30000, () => toss.rankings(rank[1], { country })));
    }

    /* ── 세력 좌표 (/flow) ── */
    if (p === '/api/flow/market') {
      if (!toss.enabled) return sendJSON(res, 200, { unavailable: true });
      const market = url.searchParams.get('market') === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
      // 과거 99일은 하루가 지나야 바뀌므로 길게 캐싱해도 되지만,
      // 당일 잠정치가 장중 계속 갱신되므로 60초로 맞춘다.
      const data = await cached(`flow:${market}`, 60000, async () =>
        analysis.buildMarket(await toss.marketFlowSeries(market, 100)));
      return sendJSON(res, 200, { market, ...data });
    }

    if (p === '/api/flow/scan') {
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
    }

    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJSON(res, 200, { results: [] });
      return sendJSON(res, 200, { results: await cached(`search:${q}`, 300000, () => search(q)) });
    }

    /* ── 지수 (/idx) ──────────────────────────
     * 낮에는 KRX 현물, 밤에는 Hyperliquid 선물.
     * 코스피200 선물(xyz:KR200)이 24시간 돌기 때문에 국장이 닫힌 뒤에도
     * "지금 코스피가 어디쯤인가"를 추정할 수 있다.
     * 환산식: 코스피 추정 = 코스피 현재값 × (KR200 선물 / 코스피200 현물)
     *   — 선물/현물 비율(베이시스)을 그대로 코스피에 옮긴다. 장중에는 이 값이
     *     실제 코스피와 거의 같아야 하므로 식이 맞는지 화면에서 바로 검산된다. */
    if (p === '/api/idx') {
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
    }

    /* Hyperliquid 캔들 — 야간 선물 차트. dex 접두사(xyz:)를 그대로 coin에 넣는다. */
    if (p === '/api/hl/candles') {
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
    }

    /* ── 시총비교 (/marketcap) ──────────────────
     * 시총 = 일별 종가 × 현재 발행주식수.
     * 발행주식수가 기간 내내 일정하다고 가정하는 근사다(자사주 소각·증자 미반영).
     * 과거 시총의 정확한 값이 아니라 두 회사의 상대 크기 추이를 보는 용도. */
    if (p === '/api/marketcap') {
      const codes = (url.searchParams.get('codes') || '005930,000660')
        .split(',').map((s) => s.trim()).filter((c) => /^\d{6}$/.test(c)).slice(0, 2);
      if (codes.length < 2) return sendJSON(res, 400, { error: '비교할 두 종목이 필요합니다' });
      const withPref = url.searchParams.get('pref') === '1';
      /* ⚠️ 시총 = 수정주가 × 현재 발행주식수 는 주식수가 안 변한 구간에서만 맞다.
       * 액면분할·무상증자는 시총이 안 변하니 괜찮지만, 감자·유상증자·자사주 소각은 틀린다.
       * 실측: SK하이닉스는 2002년 21:1 감자를 겪어 1999년 수정종가가 718,108원으로 잡히고,
       *       여기에 현재 주식수를 곱하면 524조 — 당시 코스피 전체 시총을 넘는 허구가 나온다.
       * 그래서 10년을 상한으로 둔다. 감자·출자전환 같은 대형 이벤트는 대개 그 밖에 있다. */
      const MAX_RANGE = '10Y';
      const asked = url.searchParams.get('range');
      const valid = RANGES[asked] !== undefined ? asked : '1Y';
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
    }

    /* ── 전고대비 (/peak) ───────────────────────
     * 전고점 대비 낙폭과 "원금 회복에 필요한 상승률"을 같이 낸다.
     * −50%는 +100%가 있어야 돌아온다 — 하락률만 보면 이 비대칭이 안 보인다. */
    if (p === '/api/peak') {
      const syms = (url.searchParams.get('codes') || 'KOSPI,KOSDAQ,005930,000660')
        .split(',').map((s) => s.trim()).filter((c) => /^[A-Z0-9]{3,10}$/i.test(c)).slice(0, 24);
      const range = RANGES[url.searchParams.get('range')] !== undefined ? url.searchParams.get('range') : '1Y';
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
    }

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
    if (p === '/api/ram') {
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
        const bk = (sym, iv, limit) =>
          fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${iv}&limit=${limit}`,
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
          const rows = await bk('DRAMUSDT', '15m', 400);
          if (!rows.length) return null;
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
    }

    /* ── 하닉 ADR (/adr) ─────────────────────────
     * SK하이닉스는 미국에 ADR(SKHY.O)로도 거래된다.
     * ⚠️ ADR 비율을 틀리면 괴리율이 통째로 무의미해진다.
     *    실측 검증: 네이버가 주는 ADR 시가총액 ÷ ADR 주가 = 총 ADR 수 = 7,288,655,000
     *    ÷ 발행주식수 730,492,365 = 9.978 → 1주 = 10 ADR.
     *    같은 계산을 매 요청마다 다시 해서 화면에 노출한다 (하드코딩하지 않는다).
     * 지금 ADR은 한국 대비 약 +28% 프리미엄에 거래된다 — 그게 이 페이지의 주제다. */
    if (p === '/api/adr') {
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
    }

    /* ── 알림 설정 (/api/alerts) ─────────────────
     * alert.js 데몬이 읽는 alerts.json 을 브라우저에서 편집하기 위한 통로.
     * localStorage는 브라우저 안에만 있어서 Node 데몬이 못 읽는다 — 그래서 파일로 내린다.
     *
     * ⚠️ 이 서버는 그동안 req.method 를 한 번도 보지 않았다(쓰기 라우트가 없었으므로).
     *    쓰기가 생긴 이상 메서드를 명시적으로 갈라야 한다. 안 그러면 GET 으로도 설정이 덮어써진다. */
    if (p === '/api/alerts') {
      const file = path.join(__dirname, 'alerts.json');

      if (req.method === 'GET') {
        try {
          return sendJSON(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
          return sendJSON(res, 200, { version: 1, enabled: true, targets: [], grids: [] });
        }
      }

      if (req.method === 'PUT') {
        /* 127.0.0.1 바인딩만으로는 DNS 리바인딩을 못 막는다 —
         * 외부 페이지가 자기 도메인을 127.0.0.1 로 재해석시키면 브라우저가 이 서버에 쓸 수 있다.
         * Host 와 Origin 을 루프백으로 제한하면 그 경로가 닫힌다. */
        const host = String(req.headers.host || '');
        const origin = req.headers.origin;
        const loopback = /^(localhost|127\.0\.0\.1|\[::1\]):?\d*$/;
        if (!loopback.test(host) || (origin && !loopback.test(origin.replace(/^https?:\/\//, '')))) {
          res.writeHead(403); return res.end('loopback only');
        }
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 262144) { res.writeHead(413); return res.end('too large'); }
          chunks.push(c);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return sendJSON(res, 400, { error: 'JSON 파싱 실패' });
        }
        /* 데몬이 신뢰하고 읽는 파일이라 형태를 여기서 강제한다.
         * 로컬 전용이지만 잘못된 값 하나가 데몬을 매분 죽이면 알림이 조용히 멈춘다 —
         * 값 검증은 편집 UI가 아니라 저장 지점에서 해야 한다. */
        const numIn = (v, lo, hi, dflt) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
        };
        /* id 는 alert.js 에서 상태 객체의 키가 된다. "__proto__" 가 통과하면
         * state.targets["__proto__"] 대입이 프로토타입을 오염시켜
         * "첫 실행은 절대 발화하지 않는다"는 방어가 통째로 무력화된다. */
        const seenIds = new Set();
        const idOf = (v, prefix) => {
          let id = String(v ?? '').slice(0, 40);
          if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || id === '__proto__' || id === 'constructor' || id === 'prototype') {
            id = `${prefix}${Math.random().toString(36).slice(2, 9)}`;
          }
          // 중복 id 는 서로 다른 종목이 같은 상태를 공유하게 만들어 첫 실행에 오발화한다
          while (seenIds.has(id)) id = `${prefix}${Math.random().toString(36).slice(2, 9)}`;
          seenIds.add(id);
          return id;
        };
        const dropped = [];
        const sym = (v) => (/^(KR|US):[\w.-]{1,20}$/.test(String(v)) ? String(v) : null);
        // false 는 '무음' 이라는 유효한 선택이다 — 기본값으로 덮으면 그 분기가 도달 불가능해진다
        const sound = (v) => (v === false ? false : (/^[A-Za-z]{1,20}$/.test(String(v || '')) ? String(v) : 'Glass'));
        const text = (v, max) => String(v ?? '').slice(0, max);

        const clean = {
          version: 1,
          // "false"(문자열)·0 을 true 로 받으면 마스터 스위치가 fail-open 이 된다
          enabled: !(body.enabled === false || body.enabled === 'false' || body.enabled === 0),
          targets: (Array.isArray(body.targets) ? body.targets : []).slice(0, 100)
            .map((t) => {
              if (!t || typeof t !== 'object') { dropped.push('목표가: 형식 오류'); return null; }
              const symbol = sym(t.symbol);
              if (!symbol) { dropped.push(`목표가 "${text(t.name, 20) || '이름없음'}": 종목 코드 형식 오류`); return null; }
              const price = t.price == null ? null : numIn(t.price, 0, 1e12, null);
              const changePct = t.changePct == null ? null : numIn(t.changePct, -100, 1000, null);
              if (price == null && changePct == null) {
                dropped.push(`목표가 "${text(t.name, 20) || symbol}": 가격·등락률이 비어 있음`);
                return null;
              }
              return {
                id: idOf(t.id, 't'),
                symbol, name: text(t.name, 40),
                op: t.op === '<=' ? '<=' : '>=',
                ...(price != null ? { price } : { changePct }),
                cooldownMin: numIn(t.cooldownMin, 1, 1440, 60),
                rearmPct: numIn(t.rearmPct, 0, 0.5, 0.005),
                once: !!t.once, sound: sound(t.sound),
              };
            }).filter(Boolean),
          grids: (Array.isArray(body.grids) ? body.grids : []).slice(0, 50)
            .map((g) => {
              if (!g || typeof g !== 'object') { dropped.push('그리드: 형식 오류'); return null; }
              const symbol = sym(g.symbol);
              const lower = numIn(g.lower, 0, 1e12, null);
              const upper = numIn(g.upper, 0, 1e12, null);
              const cells = numIn(g.cells, 1, 200, null);
              // 상단이 하단보다 작거나 칸이 없으면 경계 계산이 깨진다 — 아예 저장하지 않는다
              if (!symbol || lower == null || upper == null || cells == null || upper <= lower) {
                dropped.push(`그리드 "${text(g.name, 20) || symbol || '이름없음'}": 구간·칸 수가 올바르지 않음`);
                return null;
              }
              return {
                id: idOf(g.id, 'g'),
                symbol, name: text(g.name, 40),
                lower, upper, cells,
                cooldownMin: numIn(g.cooldownMin, 1, 1440, 15),
                sound: sound(g.sound),
              };
            }).filter(Boolean),
          savedAt: new Date().toISOString(),
        };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
        fs.renameSync(tmp, file);      // 데몬이 반쯤 쓰인 파일을 읽지 않도록 원자적 교체
        // 검증에서 빠진 항목을 조용히 삼키면 사용자는 저장된 줄 안다
        return sendJSON(res, 200, { ok: true, dropped, ...clean });
      }

      res.writeHead(405, { Allow: 'GET, PUT' });
      return res.end('method not allowed');
    }

    // 데몬이 마지막으로 언제 돌았는지 — 화면에서 살아있는지 확인용
    if (p === '/api/alerts/state') {
      try {
        return sendJSON(res, 200, JSON.parse(fs.readFileSync(path.join(__dirname, 'alerts-state.json'), 'utf8')));
      } catch {
        return sendJSON(res, 200, { never: true });
      }
    }

    /* 정적 파일 */
    const PAGES = {
      '/': '/index.html', '/flow': '/flow.html', '/assets': '/assets.html',
      '/etf': '/etf.html', '/terminal': '/terminal.html',
      '/idx': '/idx.html', '/marketcap': '/marketcap.html', '/peak': '/peak.html',
      '/ram': '/ram.html', '/adr': '/adr.html', '/alerts': '/alerts.html',
    };
    let file = PAGES[p] || p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        // 로컬 개발 도구 — 파일을 자주 고치므로 브라우저 캐시가 항상 최신을 확인하게
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${p} 실패:`, e.message);
    sendJSON(res, 502, { error: e.message });
  }
});

/* 개인용 로컬 도구다. 쓰기 API(/api/alerts)가 생긴 이상 전 인터페이스(*:8787)에
 * 열어둘 이유가 없다 — 같은 네트워크의 다른 기기가 설정을 바꿀 수 있게 된다. */
server.listen(PORT, HOST, () => {
  console.log(`📈 내 주식 보드 → http://localhost:${PORT}${HOST !== '127.0.0.1' ? ` (${HOST} 바인딩 — 배포 모드)` : ''}`);
});
