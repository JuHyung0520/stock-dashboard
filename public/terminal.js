/* 터미널 — 재무카드 · 상대수익률 · 글로벌 반도체 · 바이낸스 24h
 * 차트는 전부 인라인 SVG (의존성 제로 원칙 유지)
 */

const $ = (s) => document.querySelector(s);
const fmtKR = new Intl.NumberFormat('ko-KR');
const fmtUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* 색은 렌더 시점에 읽는다. 모듈 최상위에서 한 번 스냅샷하면 테마를 바꿔도
 * 차트 계열색만 옛 테마에 남아, 범례와 선이 서로 다른 색이 된다. */
const COLORS = (code) => (code === '005930' ? Chart.series(1) : code === '000660' ? Chart.series(2) : null);  // 삼전 민트 / 하닉 앰버
const NAMES = { '005930': '삼성전자', '000660': 'SK하이닉스' };

const state = { range: '1D', binSymbol: 'SKHYNIXUSDT', binInterval: '15m', binMeta: null };

async function api(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
}
const money = (v) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`);
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

/* ── 종목 카드 ── */
function renderCards(stocks) {
  $('#termCards').innerHTML = stocks.map((s) => {
    const color = COLORS(s.code);
    return `
    <div class="panel tcard ${s.code === '000660' ? 'hynix' : ''}">
      <div class="tc-name"><b style="color:${color}">${esc(s.name)}</b><span class="code">${s.code}</span>${
        Chart.asOfBadge(s.marketState)}</div>
      <div class="tc-price ${cls(s.changePct)}">
        ${s.price != null ? fmtKR.format(s.price) : '…'}
        <span class="chg">${s.change != null ? (s.change > 0 ? '▲' : s.change < 0 ? '▼' : '') + ' ' + fmtKR.format(Math.abs(s.change)) : ''} (${pct(s.changePct)})</span>
      </div>
      ${s.extPrice ? `<div class="tc-ext ${cls(s.extPct)}">NXT ${fmtKR.format(s.extPrice)} ${pct(s.extPct)}</div>` : ''}
      <div class="tc-facts">
        <div class="tc-fact"><span class="k">PER</span><span class="v">${s.per || '—'}</span></div>
        <div class="tc-fact"><span class="k">추정PER</span><span class="v">${s.perFwd || '—'}</span></div>
        <div class="tc-fact"><span class="k">PBR</span><span class="v">${s.pbr || '—'}</span></div>
        <div class="tc-fact"><span class="k">외인</span><span class="v">${s.foreignRate || '—'}</span></div>
        <div class="tc-fact"><span class="k">배당</span><span class="v">${s.dividendYield || '—'}</span></div>
        <div class="tc-fact"><span class="k">시총</span><span class="v">${s.marketCap || '—'}</span></div>
      </div>
      <div class="tc-target">
        <span class="k">목표주가</span>
        <span class="v">${s.target ? fmtKR.format(Math.round(s.target)) : '—'}</span>
        <span class="up-pct ${cls(s.targetUpside)}">${pct(s.targetUpside)}</span>
      </div>
      <div class="tc-spark" data-spark="${s.code}"></div>
    </div>`;
  }).join('');
  drawSparklines();
}

/* 카드 하단 30일 주가 스파크라인 (목표주가 이력은 API가 없어 주가로 대체) */
async function drawSparklines() {
  try {
    const d = await api('/api/relative?range=1M');
    for (const s of d.series || []) {
      const box = document.querySelector(`[data-spark="${s.code}"]`);
      if (!box || !s.points.length) continue;
      const vals = s.points.map((p) => p.close);
      const chg = ((vals[vals.length - 1] / vals[0]) - 1) * 100;
      box.innerHTML = Chart.spark(vals, {
        color: chg >= 0 ? 'var(--up)' : 'var(--down)',
        label: `30일 ${pct(chg)}`,
      });
    }
  } catch {}
}

/* ── 상대수익률 차트 ── */
async function renderRelative() {
  const box = $('#relChart');
  try {
    const d = await api(`/api/relative?range=${state.range}&codes=005930,000660`);
    if (d.unavailable || !d.series?.length) { box.innerHTML = `<div class="inv-empty">차트 데이터 없음</div>`; return; }

    // 계열마다 종가를 함께 실어 끝점 태그에 "가격 +등락%"을 찍는다
    Chart.line(box, {
      series: d.series.map((sr) => ({
        key: sr.code,
        label: NAMES[sr.code] || sr.code,
        color: COLORS(sr.code) || 'var(--text)',
        values: sr.points.map((p) => p.v),
        closes: sr.points.map((p) => p.close),
        readout: (v, i) => `${fmtKR.format(sr.points[i].close)} ${pct(v)}`,
      })),
      labels: d.series[0].points.map((p) => p.t),
      height: 300,
      includeZero: true,
      zeroLine: true,
      yFormat: (v) => `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`,
      tagFormat: (sr, v, i) => `${fmtKR.format(sr.closes[i])} ${pct(v)}`,
    });

    const maxN = Math.max(...d.series.map((sr) => sr.points.length));

    $('#chartLegend').innerHTML = d.series.map((s) => {
      const last = s.points[s.points.length - 1];
      const c = COLORS(s.code);
      return `<span class="lg-item" style="color:${c}">
        <span class="lg-swatch" style="background:${c}"></span>${NAMES[s.code] || s.code} ${pct(last.v)}</span>`;
    }).join('');

    const first = d.series[0]?.points[0];
    /* 1D 는 '기준일'이 아니라 '가장 오래된 분봉'이 0% 다 — 토스가 200봉만 주기 때문에
     * 장 후반엔 그 시작점이 09:00 이 아니라 두어 시간 전이 된다. 그걸 기준일이라 부르면 거짓말이 된다. */
    $('#chartNote').textContent = state.range === '1D'
      ? `${first?.t || '첫 분봉'}=0% 기준 · 분봉 ${maxN}개 (토스 캔들 상한 200 — 장 후반엔 최근 200분만 표시되어 시가 기준이 아닙니다)`
      : `${first?.t || '기준일'}=0% 기준 · ~ 오늘 (${maxN}거래일)`;
    everLoaded = true;
    markUpdated(true);
  } catch (e) {
    console.warn('relative', e);
    box.innerHTML = `<div class="inv-empty">차트를 불러오지 못했어요</div>`;
    markUpdated(false);
    if (!everLoaded) {
      const el = $('#termCards');
      if (el) el.innerHTML = `<div class="inv-empty">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. <button class="retry-btn" onclick="refresh()">다시 시도</button></div>`;
    }
  }
}

$('#rangeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.range === state.range) return;
  state.range = b.dataset.range;
  document.querySelectorAll('#rangeTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderRelative();
});

/* ── 우측 레일 ── */
function renderRail(d) {
  $('#railGrid').innerHTML = d.rails.map((r) => `
    <div class="rail-card">
      <div class="k">${esc(r.name)}</div>
      <div class="v">${r.value != null ? fmtUS.format(r.value) : '—'}</div>
      <div class="d ${cls(r.changePct)}">${r.changePct != null ? pct(r.changePct) : (r.note || '')}</div>
    </div>`).join('');

  $('#semiGrid').innerHTML = d.semis.map((s) => `
    <div class="rail-card">
      <div class="k">${esc(s.name)}</div>
      <div class="v">${fmtUS.format(s.price)}</div>
      <div class="d ${cls(s.changePct)}">${pct(s.changePct)}</div>
    </div>`).join('');
}

/* ── 바이낸스 24h 캔들 ── */
function renderBinTabs(list) {
  $('#binSymbols').innerHTML = list.map((b) => `
    <button class="tab ${b.symbol === state.binSymbol ? 'active' : ''}" data-sym="${b.symbol}">${esc(b.name)}</button>`).join('');
  state.binMeta = Object.fromEntries(list.map((b) => [b.symbol, b]));
}

$('#binSymbols').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.sym === state.binSymbol) return;
  state.binSymbol = b.dataset.sym;
  document.querySelectorAll('#binSymbols .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderBinChart();
});
$('#binIntervals').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.iv === state.binInterval) return;
  state.binInterval = b.dataset.iv;
  document.querySelectorAll('#binIntervals .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderBinChart();
});

async function renderBinChart() {
  const box = $('#binChart');
  const m = state.binMeta?.[state.binSymbol];
  if (m) {
    $('#binHead').innerHTML = `
      <span style="font-weight:700">${esc(m.name)}</span>
      <span class="price ${cls(m.changePct)}">$${fmtUS.format(m.price)}</span>
      <span class="${cls(m.changePct)}" style="font-weight:700">${pct(m.changePct)}</span>
      <span class="meta">24h고 $${fmtUS.format(m.high)} · 24h저 $${fmtUS.format(m.low)} · 24h대금 ${money(m.volUsd)}</span>`;
  }
  try {
    const d = await api(`/api/binance/klines?symbol=${state.binSymbol}&interval=${state.binInterval}`);
    const c = d.candles;
    if (!c?.length) { box.innerHTML = `<div class="inv-empty">캔들 없음</div>`; return; }

    Chart.candles(box, {
      candles: c, height: 340,
      yFormat: (v) => fmtUS.format(v),
      xFormat: Chart.timeAxis(c),
    });
  } catch (e) {
    console.warn('binance', e);
    box.innerHTML = `<div class="inv-empty">캔들을 불러오지 못했어요</div>`;
  }
}

/* ── 로드 ── */
async function refresh() {
  try {
    const d = await api('/api/terminal');
    renderCards(d.stocks);
    renderRail(d);
    if (!state.binMeta) { renderBinTabs(d.binance); renderBinChart(); }
    else { state.binMeta = Object.fromEntries(d.binance.map((b) => [b.symbol, b])); }
    markUpdated(true);
  } catch (e) {
    console.warn('terminal', e);
    markUpdated(false);
  }
}

refresh();
renderRelative();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(() => { if (!document.hidden) renderRelative(); }, 30000);
setInterval(() => { if (!document.hidden) renderBinChart(); }, 30000);

/* 테마가 바뀌면 다시 그린다 — 차트는 색을 SVG 속성에 박아 그리므로 CSS 변수만 바뀌어선 안 따라온다 */
addEventListener('themechange', () => { renderRelative(); refresh(); });
