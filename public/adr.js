/* 하닉 ADR — SK하이닉스의 한국 주가와 미국 ADR 사이의 괴리.
 *
 * 김프의 주식 버전이다. 같은 회사 지분인데 서울에서 사는 값과 뉴욕에서 사는 값이 다르다.
 *
 * ⚠️ 이 페이지에서 가장 중요한 숫자는 프리미엄이 아니라 **ADR 비율**이다.
 *    1 ADR이 보통주 몇 주분인지 틀리면 프리미엄이 통째로 헛것이 된다.
 *    그래서 비율을 하드코딩하지 않고 매번 역산해서, 근거와 함께 화면에 드러낸다.
 */

const $ = (s) => document.querySelector(s);
const fKR = new Intl.NumberFormat('ko-KR');
const fUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const pct = (v, d = 2) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const cls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`);

// 첫 로드부터 실패하면 스켈레톤이 영원히 반짝인다 — 재시도 수단을 준다
let everLoaded = false;

function markUpdated(ok) {
  // 실패했는데 화면은 그대로면 사용자는 낡은 값을 현재값으로 읽는다.
  // 흐림(시선)과 문구(설명)를 함께 준다 — 흐림만으로는 경고가 안 읽힌다.
  document.body.classList.toggle('stale', !ok);
  $('#statusDot').classList.toggle('error', !ok);
  $('#lastUpdated').textContent = ok
    ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`
    : '갱신 실패 — 아래 값은 이전 것';
}

function renderHero(d) {
  const p = d.premium.headline;
  const over = p > 0;
  $('#premValue').textContent = pct(p);
  // 프리미엄은 '미국이 비싸다'는 뜻 — 한국 관례색(상승=빨강)을 그대로 쓰면 오독된다.
  // 프리미엄/디스카운트는 방향이 다른 개념이라 중립 강조색을 쓴다.
  $('#premValue').className = 'hero-value accent';
  $('#premWords').innerHTML = over
    ? `뉴욕이 서울보다 <b>${Math.abs(p).toFixed(1)}% 비싸게</b> 사고 있습니다`
    : `뉴욕이 서울보다 <b>${Math.abs(p).toFixed(1)}% 싸게</b> 사고 있습니다`;

  $('#heroBadge').textContent = d.best.source;
  $('#heroBadge').className = `hero-badge ${d.best.naverIsStale ? 'est' : ''}`;

  const gapKrw = d.best.krwPerShare - d.kr.price;
  $('#premSub').innerHTML =
    `ADR 1주 $${fUS.format(d.best.price)} × ${d.ratio.value}주분 × ${fKR.format(Math.round(d.fx.usdkrw))}원 `
    + `= <b>${fKR.format(Math.round(d.best.krwPerShare))}원</b>  vs  한국 <b>${fKR.format(d.kr.price)}원</b> `
    + `(차이 ${gapKrw > 0 ? '+' : '−'}${fKR.format(Math.abs(Math.round(gapKrw)))}원)`;

  $('#heroSide').innerHTML = [
    { k: 'ADR 기준 시총', v: `${(d.adr.marketCapKrw / 1e12).toFixed(0)}조`,
      sub: `뉴욕 값으로 환산 · ${(d.adr.tradedAt || '').slice(0, 10)} 종가`, tone: '' },
    { k: '한국 기준 시총', v: `${((d.kr.price * 730492365) / 1e12).toFixed(0)}조`,
      sub: `서울 값으로 환산 · ${d.kr.marketState === 'OPEN' ? '장중' : '직전 종가'}`, tone: '' },
    d.premium.hl != null
      ? { k: '24시간 선물 기준', v: pct(d.premium.hl, 1), sub: 'Hyperliquid xyz:SKHY', tone: '' }
      : null,
  ].filter(Boolean).map((x) => `
    <div class="hs-item"><span class="k">${esc(x.k)}</span><span class="v ${x.tone}">${esc(x.v)}</span><span class="d">${esc(x.sub)}</span></div>`).join('');
}

function renderRatio(d) {
  const r = d.ratio;
  $('#ratioBody').innerHTML = `
    <div class="ratio-row">
      <div class="ratio-big">1주 = <b>${r.value} ADR</b></div>
      <div class="ratio-check ${r.trusted ? 'ok' : 'warn'}">
        ${r.trusted ? '✓ 검증됨' : '⚠ 편차 큼'} · 역산값 ${r.derived == null ? '—' : r.derived.toFixed(4)}
      </div>
    </div>
    <p class="lead-note">
      ADR 비율은 어느 API도 직접 알려주지 않아서 <b>역산</b>합니다.<br>
      ${esc(r.basis)} = <b>${r.derived == null ? '—' : r.derived.toFixed(4)}</b> → 가장 가까운 정수 <b>${r.value}</b>.
      <br>매 요청마다 다시 계산하므로, 발행주식수나 소스가 바뀌면 여기서 바로 드러납니다.
      ${r.trusted ? '' : '<br><span class="warn-text">역산값이 정수에서 3% 이상 벗어났습니다 — 프리미엄 숫자를 신뢰하지 마세요.</span>'}
    </p>`;
}

function renderMarkets(d) {
  // NXT는 정규장 중엔 본 시세와 같은 값이 오는 일이 많다 — 같으면 표시하지 않는다(중복 노이즈)
  const nxtDiffers = d.kr.extPrice != null && d.kr.extPrice !== d.kr.price;

  const cards = [
    {
      flag: '🇰🇷', name: '서울 (000660)', sub: 'KRX 보통주',
      px: `${fKR.format(d.kr.price)}원`,
      chg: d.kr.changePct, state: d.kr.marketState === 'OPEN' ? '장중' : '마감',
      krw: d.kr.price, base: true,
      extra: nxtDiffers ? `NXT ${fKR.format(d.kr.extPrice)} ${pct(d.kr.extPct)}` : `달러 환산 $${fUS.format(d.kr.usd)} (ADR 아님)`,
    },
    {
      flag: '🇺🇸', name: '뉴욕 ADR 정규장', sub: '네이버 SKHY.O',
      px: `$${fUS.format(d.adr.price)}`,
      chg: d.adr.changePct, state: d.adr.marketState === 'OPEN' ? '장중' : '마감',
      krw: d.adr.krwPerShare,
      extra: `${(d.adr.tradedAt || '').slice(0, 10)} 종가${d.adr.volume ? ` · ${(d.adr.volume / 1e6).toFixed(1)}M주` : ''}`,
    },
    d.live ? {
      flag: '🌙', name: '24시간 ADR', sub: d.live.sources.join(' · '),
      px: `$${fUS.format(d.live.price)}`,
      chg: d.hl?.changePct ?? null, state: '24h',
      krw: d.live.krwPerShare,
      // 두 소스가 같은 값이면 서로 독립이 아니라는 뜻 — 그 사실을 감추지 않는다
      extra: d.live.oracleTracking
        ? `HL은 오라클 추종(독립 가격발견 아님)${d.live.spreadPct != null ? ` · 소스간 ${d.live.spreadPct.toFixed(2)}%` : ''}`
        : `${d.hl ? `거래 ${money(d.hl.volUsd)} · 미결제 ${money(d.hl.oiUsd)}` : ''}`,
    } : null,
  ].filter(Boolean);

  $('#marketGrid').innerHTML = cards.map((c) => {
    const gap = c.base ? null : (c.krw / d.kr.price - 1) * 100;
    return `
    <div class="mkt-card ${c.base ? 'base' : ''}">
      <div class="mk-head">
        <span class="mk-flag">${c.flag}</span>
        <span class="mk-name">${esc(c.name)}</span>
        <span class="mk-state">${esc(c.state)}</span>
      </div>
      <div class="mk-px ${cls(c.chg)}">${esc(c.px)}</div>
      <div class="mk-chg ${cls(c.chg)}">${pct(c.chg)}</div>
      <div class="mk-krw">
        <span class="k">1주 환산</span>
        <span class="v">${fKR.format(Math.round(c.krw))}원</span>
      </div>
      <div class="mk-gap ${c.base ? 'base-tag' : ''}">
        ${c.base ? '← 비교 기준' : `서울 대비 <b class="accent">${pct(gap, 1)}</b>`}
      </div>
      <div class="mk-extra">${esc(c.extra)}</div>
    </div>`;
  }).join('');
}

function renderHistory(d) {
  const h = d.history || [];
  if (h.length < 2) {
    $('#premChart').innerHTML = `<div class="inv-empty">이력 데이터가 부족합니다</div>`;
    $('#histNote').textContent = '';
    return;
  }
  Chart.line($('#premChart'), {
    series: [{
      key: 'prem', label: 'ADR 프리미엄', color: Chart.token('--accent', '#ffd166'),
      values: h.map((x) => x.premiumPct),
      readout: (v, i) => `${pct(v, 1)} (ADR $${fUS.format(h[i].adr)} · 한국 ${fKR.format(h[i].kr)}원)`,
    }],
    labels: h.map((x) => `${x.date.slice(5, 7)}.${x.date.slice(8, 10)}`),
    height: 300,
    baseline: 0,
    zeroLine: true,
    includeZero: true,
    yFormat: (v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`,
    tagFormat: (s, v) => pct(v, 1),
  });

  const vals = h.map((x) => x.premiumPct);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const max = Math.max(...vals), min = Math.min(...vals);
  const maxD = h[vals.indexOf(max)].date, minD = h[vals.indexOf(min)].date;
  const cur = vals[vals.length - 1];

  $('#histNote').textContent = `${h[0].date} ~ ${h[h.length - 1].date} · ${h.length}거래일`;
  $('#premFoot').innerHTML =
    `이 기간 평균 <b>${pct(avg, 1)}</b> · 최고 <b>${pct(max, 1)}</b> (${maxD}) · 최저 <b>${pct(min, 1)}</b> (${minD}). `
    + `차트 마지막 점(${h[h.length - 1].date} 종가 기준) <b>${pct(cur, 1)}</b>은 평균보다 `
    + `<b>${Math.abs(cur - avg).toFixed(1)}%p ${cur > avg ? '높습니다' : '낮습니다'}</b>. `
    + `<span class="dim">위 큰 숫자(${pct(d.premium.headline, 1)})는 실시간 값이라 이 점과 다릅니다 — 종가끼리 비교한 값과 지금 시세를 비교한 값입니다.</span>`
    + `<br><span class="dim">ADR 이력은 토스가 ${h.length}거래일치만 제공해 차트 길이가 여기에 묶입니다. `
    + `한국은 장중·ADR은 미국장 종가라 같은 날짜라도 시점이 어긋납니다 (미국장이 한국 마감 뒤에 열립니다).</span>`;
}

async function load() {
  try {
    const d = await api('/api/adr');
    if (d.unavailable) {
      $('#premValue').textContent = '—';
      $('#premWords').textContent = d.reason || '데이터를 가져올 수 없습니다';
      markUpdated(false);
    if (!everLoaded) {
      const el = $('#marketGrid');
      if (el) el.innerHTML = `<div class="inv-empty">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. <button class="retry-btn" onclick="load()">다시 시도</button></div>`;
    }
      return;
    }
    renderHero(d);
    renderRatio(d);
    renderMarkets(d);
    renderHistory(d);
    everLoaded = true;
    markUpdated(true);
  } catch (e) {
    console.warn('adr', e);
    markUpdated(false);
  }
}

load();
setInterval(() => { if (!document.hidden) load(); }, 10000);

/* 테마가 바뀌면 다시 그린다 — 차트는 색을 SVG 속성에 박아 그리므로 CSS 변수만 바뀌어선 안 따라온다 */
addEventListener('themechange', () => load());
