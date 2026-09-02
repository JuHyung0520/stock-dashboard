/* 파생 지표 계산 엔진
 *
 * 원시 숫자를 "평소 대비 어떤가"로 바꾸는 계산들.
 * 전부 순수 함수 — 외부 호출 없음. 계산식은 실측 검증됨(2026-08-14):
 *   삼성전자 이격도 우리 계산 11.03% vs 상용 리포트 11.09% (3시간 시차) → 일치
 *
 * 배열 규약: 토스 응답은 전부 **최신이 index 0**. 기준선 계산 시 오늘(0)은 제외하고
 * slice(1, N+1)로 과거만 쓴다 — 오늘을 평균에 넣으면 자기 자신과 비교하는 꼴이 된다.
 */

const num = (s) => (s == null ? null : Number(s));

/* ── 기초 통계 ── */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
}

/* ── 기준선: 오늘 / 전일 / 5일평 / 20일평 ──
 * 레퍼런스 카드의 핵심. 숫자 하나로는 의미를 알 수 없고, 자기 과거와 비교해야 뜻이 생긴다. */
function baseline(series) {
  const s = series.filter((v) => v != null);
  if (!s.length) return null;
  return {
    today: s[0] ?? null,
    prev: s[1] ?? null,
    avg5: s.length > 5 ? mean(s.slice(1, 6)) : null,
    avg20: s.length > 20 ? mean(s.slice(1, 21)) : null,
  };
}

/* ── z-score ──
 * ⚠️ 실측 교훈(2026-08-14): 수급 계열에 일반 z를 쓰면 신호가 죽는다.
 *    코스피 외국인이 20일 평균 -34억인데 오늘 +25,010억인 날조차 z = 0.78이 나왔다.
 *    표준편차 자체가 과거의 극단값들로 부풀려지기 때문. 팻테일 계열엔 robustZ + rank를 써라.
 */
function zScore(series, window = 20) {
  const s = series.filter((v) => v != null);
  if (s.length < window + 1) return null;
  const base = s.slice(1, window + 1);
  const sd = stdev(base);
  if (!sd) return null;
  return (s[0] - mean(base)) / sd;
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* 로버스트 z — 중앙값·MAD 기반이라 과거 극단값에 표준편차가 오염되지 않는다.
 * σ̂ = 1.4826 × MAD (정규분포에서 표준편차와 일치하도록 하는 상수) */
function robustZ(series, window = 20) {
  const s = series.filter((v) => v != null);
  if (s.length < window + 1) return null;
  const base = s.slice(1, window + 1);
  const med = median(base);
  let sigma = 1.4826 * median(base.map((v) => Math.abs(v - med)));
  // MAD가 0이면(값이 몰려 있으면) 평균절대편차로 대체, 그것도 0이면 포기
  if (!sigma) sigma = 1.2533 * mean(base.map((v) => Math.abs(v - med)));
  if (!sigma) return null;
  return (s[0] - med) / sigma;
}

/* 경험적 순위 — "z=2.8"보다 "최근 100거래일 중 2번째"가 정직하다.
 * 금융 시계열은 정규분포가 아니라서 시그마의 확률 해석이 실제와 안 맞는다. */
function rank(series, window = 100) {
  const s = series.filter((v) => v != null);
  if (s.length < 10) return null;
  const base = s.slice(1, window + 1);
  const today = Math.abs(s[0]);
  const r = 1 + base.filter((v) => Math.abs(v) > today).length;
  return {
    rank: r,
    of: base.length,
    // "평소라면 며칠에 한 번" — 1위면 "N일 만에 처음"
    everyNDays: r === 1 ? null : Math.round(base.length / r),
    isRecord: r === 1,
  };
}

// 이상 정도를 사람 말로 (로버스트 z 기준)
function zLabel(z) {
  if (z == null) return null;
  const a = Math.abs(z);
  if (a >= 3.5) return z > 0 ? '매우 이례적 매수' : '매우 이례적 매도';
  if (a >= 2) return z > 0 ? '이례적 매수' : '이례적 매도';
  if (a >= 1) return z > 0 ? '평소보다 매수' : '평소보다 매도';
  return '평범한 범위';
}

/* ── 수급 강도 ──
 * 종목별 수급은 주(株) 단위라 종목 간 비교가 불가능하다(삼전 100만주 ≠ 코스닥주 100만주).
 * 20일 평균 거래량으로 나눠 %로 만들면 종목 크기와 무관하게 비교된다. */
function flowIntensity(netVolumes, volumes, window = 20) {
  const avgVol = mean(volumes.slice(1, window + 1).filter((v) => v != null));
  if (!avgVol) return null;
  return (netVolumes[0] / avgVol) * 100;
}

/* ── 1차 차분 ──
 * 융자잔고·대차잔고·외국인보유율 같은 '잔고성' 계열은 수준값에 z를 씌우면
 * 추세 때문에 상시 이상으로 뜬다. 반드시 전일 대비 변화량으로 바꿔서 봐야 한다. */
function diff(series) {
  const out = [];
  for (let i = 0; i < series.length - 1; i++) {
    out.push(series[i] != null && series[i + 1] != null ? series[i] - series[i + 1] : null);
  }
  return out;
}

/* ── 매매 타이밍 우열 ──
 * 주체별 '평단'은 계산해봐야 모두 같은 값으로 수렴해 정보가 없다(실측 확인:
 * 외국인 242,482 / 기관 241,873 / 개인 240,757 — 차이 0.7%). 일별 종가만 있어서 생기는 한계.
 * 대신 같은 주체의 매수평단 vs 매도평단을 비교하면 타이밍 우열이 드러난다.
 * 반환 > 0 이면 판 가격이 산 가격보다 높다 = 잘 굴렸다. */
function tradingEdge(records, closeByDate, pick) {
  let bq = 0, bc = 0, sq = 0, sc = 0;
  for (const r of records) {
    const o = pick(r);
    const px = closeByDate[r.date];
    if (!o || px == null) continue;
    const b = num(o.buyVolume), s = num(o.sellVolume);
    if (b) { bq += b; bc += b * px; }
    if (s) { sq += s; sc += s * px; }
  }
  if (!bq || !sq) return null;
  const buyAvg = bc / bq, sellAvg = sc / sq;
  return { buyAvg, sellAvg, edgePct: (sellAvg / buyAvg - 1) * 100 };
}

/* ── 연속 일수: "연기금 5일 연속 순매수" ──
 * 오늘은 장중 잠정치라 뒤집힐 수 있으므로 기본은 전일(index 1)부터 센다. */
function streak(series, { includeToday = false } = {}) {
  const s = series.filter((v) => v != null);
  const start = includeToday ? 0 : 1;
  if (s.length <= start || !s[start]) return null;
  const sign = Math.sign(s[start]);
  let i = start;
  while (i < s.length && Math.sign(s[i]) === sign) i++;
  return { direction: sign > 0 ? 'buy' : 'sell', days: i - start };
}

/* ── 이동평균 · 이격도 ──
 * 이격도 = (현재가 / N일 이평 - 1) × 100. 양수면 이평선 위. */
function movingAverage(closes, n = 20) {
  if (closes.length < n) return null;
  return mean(closes.slice(0, n));
}

function disparity(closes, n = 20) {
  const ma = movingAverage(closes, n);
  if (!ma) return null;
  return (closes[0] / ma - 1) * 100;
}

/* ── 거래량 배수: 오늘 거래량 / 과거 N일 평균 ──
 * ⚠️ 장중에는 누적 거래량이라 시간이 갈수록 커진다. 시간대 보정 없이 쓰면
 *    오전엔 낮게, 오후엔 높게 나온다. sessionProgress(0~1)를 주면 보정한다. */
function volumeRatio(volumes, { window = 20, sessionProgress = null } = {}) {
  if (volumes.length < window + 1) return null;
  const avg = mean(volumes.slice(1, window + 1));
  if (!avg) return null;
  const raw = volumes[0] / avg;
  return sessionProgress && sessionProgress > 0 ? raw / sessionProgress : raw;
}

/* 국내 정규장(09:00~15:30) 경과 비율. 장외면 null. */
function sessionProgress(now = new Date()) {
  const kst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const min = kst.getHours() * 60 + kst.getMinutes();
  const open = 9 * 60, close = 15 * 60 + 30;
  if (min < open || min > close) return null;
  return (min - open) / (close - open);
}

/* ── 상대강도: 종목 등락률 − 지수 등락률 (%p) ──
 * 양수면 시장보다 강하다. 오른 날에도 시장보다 덜 올랐으면 음수가 된다. */
function relativeStrength(stockPct, indexPct) {
  if (stockPct == null || indexPct == null) return null;
  return stockPct - indexPct;
}

/* ── 순매수 계산 (토스는 buy/sell 금액만 주는 경우가 있음) ── */
const netAmount = (o) => (o ? num(o.buyAmount) - num(o.sellAmount) : null);
const netVolume = (o) => (o ? num(o.netBuyVolume) : null);

/* ── 등락률 (캔들 2개로) ── */
function changePct(closes) {
  if (closes.length < 2 || !closes[1]) return null;
  return (closes[0] / closes[1] - 1) * 100;
}

/* ── 일간 수익률 시계열 ──
 * 가격 수준끼리 상관을 내면 둘 다 우상향이라는 이유만으로 0.9가 나온다(허위상관).
 * 반드시 수익률로 바꾼 뒤 비교한다. */
function returns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1], cur = closes[i];
    out.push(prev && cur ? cur / prev - 1 : null);
  }
  return out;
}

/* ── 피어슨 상관계수 ── null 쌍은 버린다 */
function correlation(a, b) {
  const pairs = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] != null && b[i] != null && !isNaN(a[i]) && !isNaN(b[i])) pairs.push([a[i], b[i]]);
  }
  if (pairs.length < 5) return null;                 // 표본이 너무 적으면 숫자가 우연이다
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, da = 0, db = 0;
  for (const [x, y] of pairs) {
    const u = x - ma, v = y - mb;
    num += u * v; da += u * u; db += v * v;
  }
  const den = Math.sqrt(da * db);
  return den ? { r: num / den, n } : null;
}

/* ── 베타 ── x가 1% 움직일 때 y가 몇 % 움직이는가 (회귀 기울기) */
function beta(y, x) {
  const pairs = [];
  for (let i = 0; i < Math.min(y.length, x.length); i++) {
    if (y[i] != null && x[i] != null && !isNaN(y[i]) && !isNaN(x[i])) pairs.push([y[i], x[i]]);
  }
  if (pairs.length < 5) return null;
  const n = pairs.length;
  const my = pairs.reduce((s, p) => s + p[0], 0) / n;
  const mx = pairs.reduce((s, p) => s + p[1], 0) / n;
  let cov = 0, varx = 0;
  for (const [yy, xx] of pairs) { cov += (yy - my) * (xx - mx); varx += (xx - mx) ** 2; }
  return varx ? cov / varx : null;
}

module.exports = {
  num, mean, stdev, median,
  baseline, zScore, robustZ, rank, zLabel, streak,
  flowIntensity, diff, tradingEdge,
  movingAverage, disparity, volumeRatio, sessionProgress,
  relativeStrength, netAmount, netVolume, changePct,
  returns, correlation, beta,
};
