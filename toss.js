/* 토스증권 Open API 클라이언트 (의존성 제로)
 *
 * 인증: OAuth2 client credentials. 토큰 수명 24h, refresh token 없음.
 * ⚠️ 클라이언트당 유효 토큰이 1개라 재발급하면 이전 토큰이 즉시 죽는다.
 *    → 토큰은 이 모듈 안에서 하나만 들고 돌려쓰고, 만료 임박 시에만 재발급한다.
 *
 * 키가 없으면 enabled=false 로 두고 server.js 가 네이버로 폴백한다.
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://openapi.tossinvest.com';

/* ── .env 로더 (dotenv 대신 최소 구현) ── */
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[m[1]]) process.env[m[1]] = value;
  }
}
loadEnv();

const CLIENT_ID = process.env.TOSS_CLIENT_ID;
const CLIENT_SECRET = process.env.TOSS_CLIENT_SECRET;
const enabled = Boolean(CLIENT_ID && CLIENT_SECRET);

/* ── 토큰 관리 ── */
let token = null;        // { value, expiresAt }
let issuing = null;      // 동시 요청이 토큰을 중복 발급하지 않도록 promise 공유

async function issueToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 비밀값이 로그로 새지 않도록 응답 본문만 짧게 남긴다
    throw new Error(`토스 토큰 발급 실패 (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return {
    value: json.access_token,
    // 만료 5분 전에 미리 갱신
    expiresAt: Date.now() + (json.expires_in ?? 86400) * 1000 - 300000,
  };
}

async function getToken() {
  if (token && Date.now() < token.expiresAt) return token.value;
  if (!issuing) {
    issuing = issueToken()
      .then((t) => { token = t; return t.value; })
      .finally(() => { issuing = null; });
  }
  return issuing;
}

/* ── 공통 호출 ── */
async function call(pathname, params = {}, retried = false) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await getToken()}` },
    signal: AbortSignal.timeout(10000),
  });

  // 토큰이 죽었으면(다른 곳에서 재발급했거나 만료) 한 번만 재발급 후 재시도
  if (res.status === 401 && !retried) {
    token = null;
    return call(pathname, params, true);
  }
  if (res.status === 403) {
    throw new Error('토스 403 — 허용 IP에 현재 공인 IP가 등록되어 있는지 확인하세요 (설정 > Open API > 허용 IP 관리)');
  }
  if (res.status === 429) {
    throw new Error(`토스 429 rate limit — ${res.headers.get('Retry-After') || '?'}초 후 재시도`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`토스 ${pathname} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.result;
}

/* ── 파싱 헬퍼: 토스는 금액/수량을 문자열 정수로 준다 ── */
const int = (s) => (s == null ? null : Number(s));
const EOK = 1e8; // 1억

// 매수/매도 금액 → 순매수 억원
function netEok(o) {
  if (!o) return null;
  const buy = int(o.buyAmount), sell = int(o.sellAmount);
  if (buy == null || sell == null) return null;
  return (buy - sell) / EOK;
}

/* ── 시장 전체 투자자별 매매대금 (코스피/코스닥) ──
 * 네이버와 달리 '금액'이고, 기관이 7개 세부분류로 쪼개진다. */
async function marketInvestor() {
  const [kospi, kosdaq] = await Promise.all([
    call('/api/v1/market-indicators/KOSPI/investor-trading', { interval: '1d', count: 1 }),
    call('/api/v1/market-indicators/KOSDAQ/investor-trading', { interval: '1d', count: 1 }),
  ]);

  const one = (name, result) => {
    const r = result?.records?.[0];
    if (!r) return null;
    const bd = r.institution?.breakdown || {};
    return {
      market: name,
      individual: netEok(r.individual),
      foreign: netEok(r.foreigner),
      institution: netEok(r.institution),
      otherCorp: netEok(r.otherCorporation),
      // 기관 세부 — 네이버엔 없는 데이터
      breakdown: [
        ['금융투자', netEok(bd.financialInvestment)],
        ['보험', netEok(bd.insurance)],
        ['투신', netEok(bd.trust)],
        ['사모', netEok(bd.privateEquityFund)],
        ['은행', netEok(bd.bank)],
        ['기타금융', netEok(bd.otherFinancialInstitution)],
        ['연기금', netEok(bd.pensionFund)],
      ].filter(([, v]) => v != null).map(([label, value]) => ({ label, value })),
      asOf: r.date ? r.date.slice(5).replace('-', '/') : '',
      updatedAt: r.updatedAt || null,
    };
  };

  return {
    markets: [one('코스피', kospi), one('코스닥', kosdaq)].filter(Boolean),
    provisional: true,
    unit: '억원',
    source: 'toss',
  };
}

/* ── 종목별 투자자 수급 (단위: 주) ── */
async function stockInvestor(symbol, count = 12) {
  const result = await call(`/api/v1/stocks/${encodeURIComponent(symbol)}/investor-trading`, { count });
  const days = (result?.records || []).map((r) => {
    const bd = r.institution?.breakdown || {};
    return {
      date: r.date ? r.date.slice(5).replace('-', '/') : '',
      individual: int(r.individual?.netBuyVolume),
      foreign: int(r.foreigner?.netBuyVolume),
      institution: int(r.institution?.netBuyVolume),
      otherCorp: int(r.otherCorporation?.netBuyVolume),
      pensionFund: int(bd.pensionFund?.netBuyVolume),
      financialInvestment: int(bd.financialInvestment?.netBuyVolume),
      // 외국인 보유율 (0.5089 → 50.89%)
      foreignHoldRate: r.foreignerHolding?.holdingRate != null
        ? Number(r.foreignerHolding.holdingRate) * 100
        : null,
    };
  });
  return { days, unit: '주', source: 'toss', note: '당일은 장중 잠정치 (개인·기관세부는 확정 후 표시)' };
}

/* ── 종목 지표 4종 (네이버에 없는 데이터) ──
 * 전부 일별 확정 데이터라 하루 한 번만 바뀐다 → server.js에서 길게 캐싱.
 * 비율 필드는 0.07992 같은 소수로 오므로 ×100 해서 %로 넘긴다. */
const pct = (s) => (s == null ? null : Number(s) * 100);

async function stockMetrics(symbol, count = 10) {
  const get = (p) =>
    call(`/api/v1/stocks/${encodeURIComponent(symbol)}/${p}`, { count })
      .then((r) => r?.records || [])
      .catch((e) => { console.warn(`[토스] ${p} 실패: ${e.message}`); return []; });

  const [short, program, credit, lending] = await Promise.all([
    get('short-selling'), get('program-trades'), get('credit-trades'), get('securities-lending'),
  ]);

  return {
    // 공매도: 거래량 + 전체 거래 대비 비중
    shortSelling: short.map((r) => ({
      date: r.date,
      volume: int(r.shortSellingVolume),
      amount: int(r.shortSellingAmount),
      volumeRate: pct(r.shortSellingVolumeRate),
    })),
    // 프로그램매매: 차익 / 비차익 순매수 (단위 주)
    program: program.map((r) => ({
      date: r.date,
      arbitrage: int(r.arbitrage?.netBuyVolume),
      nonArbitrage: int(r.nonArbitrage?.netBuyVolume),
      total: (int(r.arbitrage?.netBuyVolume) ?? 0) + (int(r.nonArbitrage?.netBuyVolume) ?? 0),
    })),
    // 신용거래: 융자 잔고가 핵심 (빚내서 산 물량)
    credit: credit.map((r) => ({
      date: r.date,
      loanBalance: int(r.marginLoan?.balanceQuantity),
      loanNew: int(r.marginLoan?.newQuantity),
      loanReturn: int(r.marginLoan?.returnQuantity),
      loanTradingRate: pct(r.marginLoan?.tradingRate),
      shortLoanBalance: int(r.stockLoan?.balanceQuantity),
    })),
    // 대차거래: 잔고 = 공매도 대기 물량으로 읽힌다
    lending: lending.map((r) => ({
      date: r.date,
      execution: int(r.executionQuantity),
      repayment: int(r.repaymentQuantity),
      balance: int(r.balanceQuantity),
      balanceAmount: int(r.balanceAmount),
    })),
  };
}

/* ── 캔들 (일봉/분봉) ──
 * 지수(KOSPI/KOSDAQ)는 경로가 다르다: /market-indicators/{symbol}/candles
 * 실측: 일봉 60개, KOSPI 지수 캔들 모두 정상 조회됨. */
async function candles(symbol, { interval = '1d', count = 100 } = {}) {
  const isIndex = /^(KOSPI|KOSDAQ|KR_BOND_)/.test(symbol);
  // 미국 종목은 토스가 접미사 없는 티커를 쓴다 (AAPL.O → AAPL)
  const sym = isIndex ? symbol : symbol.replace(/\.[A-Za-z]+$/, '');
  const path = isIndex
    ? `/api/v1/market-indicators/${encodeURIComponent(symbol)}/candles`
    : '/api/v1/candles';
  const params = isIndex ? { interval, count } : { symbol: sym, interval, count };
  const r = await call(path, params);
  const rows = r?.candles || r?.records || [];
  // 최신이 index 0 (다른 엔드포인트와 규약 통일)
  return rows.map((c) => ({
    date: c.timestamp?.slice(0, 10),
    open: int(c.openPrice), high: int(c.highPrice),
    low: int(c.lowPrice), close: int(c.closePrice),
    volume: int(c.volume),
  }));
}

/* ── 시장 수급 시계열 (기준선·순위 계산용 원본) ──
 * marketInvestor()가 오늘 1건만 주는 것과 달리, 이건 N일 배열을 준다. */
async function marketFlowSeries(market = 'KOSPI', count = 100) {
  const r = await call(`/api/v1/market-indicators/${market}/investor-trading`, { interval: '1d', count });
  return (r?.records || []).map((rec) => {
    const bd = rec.institution?.breakdown || {};
    const net = (o) => (o ? (int(o.buyAmount) - int(o.sellAmount)) / EOK : null);
    return {
      date: rec.date,
      updatedAt: rec.updatedAt,
      individual: net(rec.individual),
      foreign: net(rec.foreigner),
      institution: net(rec.institution),
      otherCorp: net(rec.otherCorporation),
      breakdown: {
        financialInvestment: net(bd.financialInvestment),
        insurance: net(bd.insurance),
        trust: net(bd.trust),
        privateEquityFund: net(bd.privateEquityFund),
        bank: net(bd.bank),
        otherFinancialInstitution: net(bd.otherFinancialInstitution),
        pensionFund: net(bd.pensionFund),
      },
    };
  });
}

/* ── 종목 수급 시계열 (수량, 주) ── */
async function stockFlowSeries(symbol, count = 100) {
  const r = await call(`/api/v1/stocks/${encodeURIComponent(symbol)}/investor-trading`, { count });
  return (r?.records || []).map((rec) => {
    const bd = rec.institution?.breakdown || {};
    const nv = (o) => (o ? int(o.netBuyVolume) : null);
    return {
      date: rec.date,
      updatedAt: rec.updatedAt,
      individual: nv(rec.individual),
      foreign: nv(rec.foreigner),
      institution: nv(rec.institution),
      otherCorp: nv(rec.otherCorporation),
      // 매수/매도 총량 — 타이밍 우열 계산에 필요
      foreignBuy: int(rec.foreigner?.buyVolume),
      foreignSell: int(rec.foreigner?.sellVolume),
      breakdown: {
        financialInvestment: nv(bd.financialInvestment),
        insurance: nv(bd.insurance),
        trust: nv(bd.trust),
        privateEquityFund: nv(bd.privateEquityFund),
        bank: nv(bd.bank),
        otherFinancialInstitution: nv(bd.otherFinancialInstitution),
        pensionFund: nv(bd.pensionFund),
      },
      foreignHoldRate: rec.foreignerHolding?.holdingRate != null
        ? Number(rec.foreignerHolding.holdingRate) * 100 : null,
    };
  });
}

/* ── 호가창 ──
 * 매도(asks) 10단계 + 매수(bids) 10단계. 장중에만 의미 있는 유일한 실시간성 데이터.
 * 심볼 규약: 국내는 6자리 코드, 미국은 접미사 없는 티커(AAPL). 관심종목 id의 AAPL.O에서 .O를 떼야 한다. */
async function orderbook(symbol) {
  const sym = symbol.replace(/\.[A-Za-z]+$/, '');
  const r = await call('/api/v1/orderbook', { symbol: sym });
  const level = (o) => ({ price: int(o.price), volume: int(o.volume) });
  return {
    timestamp: r?.timestamp || null,
    currency: r?.currency || 'KRW',
    asks: (r?.asks || []).map(level),   // 낮은 가격이 앞 (매도 1호가부터)
    bids: (r?.bids || []).map(level),   // 높은 가격이 앞 (매수 1호가부터)
  };
}

/* ── 랭킹 ──
 * type/marketCountry/duration 모두 필수 파라미터. 응답은 symbol만 주고 종목명이 없어서
 * /api/v1/stocks 로 이름을 따로 붙인다. */
const RANKING_TYPES = {
  gainers: 'TOP_GAINERS',
  losers: 'TOP_LOSERS',
  amount: 'MARKET_TRADING_AMOUNT',
  volume: 'MARKET_TRADING_VOLUME',
};

async function rankings(kind = 'gainers', { country = 'KR', count = 15 } = {}) {
  const type = RANKING_TYPES[kind];
  if (!type) throw new Error(`알 수 없는 랭킹 종류: ${kind}`);
  // TOP_GAINERS/LOSERS는 realtime을 지원하지 않는다 (스펙 명시)
  const duration = kind === 'gainers' || kind === 'losers' ? '1d' : 'realtime';

  const r = await call('/api/v1/rankings', {
    type, marketCountry: country, duration, count,
    excludeInvestmentCaution: true,
  });
  const rows = (r?.rankings || []).map((x) => ({
    rank: x.rank,
    symbol: x.symbol,
    price: int(x.price?.lastPrice),
    basePrice: int(x.price?.basePrice),
    changePct: x.price?.changeRate != null ? Number(x.price.changeRate) * 100 : null,
    volume: int(x.tradingVolume),
    amount: int(x.tradingAmount),
    currency: x.currency,
  }));

  // 종목명 붙이기 (최대 200개 배치 지원)
  if (rows.length) {
    try {
      const info = await call('/api/v1/stocks', { symbols: rows.map((x) => x.symbol).join(',') });
      const nameBy = Object.fromEntries((Array.isArray(info) ? info : []).map((s) => [s.symbol, s.name]));
      for (const row of rows) row.name = nameBy[row.symbol] || row.symbol;
    } catch (e) {
      console.warn(`[랭킹] 종목명 조회 실패: ${e.message}`);
      for (const row of rows) row.name = row.symbol;
    }
  }
  return { rankedAt: r?.rankedAt || null, rows };
}

module.exports = {
  enabled, call,
  marketInvestor, stockInvestor, stockMetrics,
  candles, marketFlowSeries, stockFlowSeries,
  orderbook, rankings,
};
