/* 지수 — KRX 현물 + Hyperliquid 야간 선물
 *
 * 이 화면의 존재 이유: 국장은 15:30에 닫히지만 코스피200 선물(xyz:KR200)은
 * 24시간 돈다. 마감 후 미국장이 폭락하면 다음 날 시초가가 어디일지를
 * 선물이 먼저 말해준다. 낮에는 현물이, 밤에는 선물이 주인공이 된다.
 */

const $ = (s) => document.querySelector(s);
const nf = (d = 2) => new Intl.NumberFormat('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const f2 = nf(2), f0 = nf(0);

const state = { target: 'KOSPI', range: '3Y', interval: '1h', data: null };

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const cls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`);

// 첫 로드부터 실패하면 스켈레톤이 영원히 반짝인다 — 재시도 수단을 준다
let everLoaded = false;

const okBy = {};   // 출처별 성패 — 차트 성공이 본체 실패를 덮어쓰지 못하게
function markUpdated(ok, src = 'main') {
  okBy[src] = ok;
  ok = Object.values(okBy).every(Boolean);
  // 실패했는데 화면은 그대로면 사용자는 낡은 값을 현재값으로 읽는다.
  // 흐림(시선)과 문구(설명)를 함께 준다 — 흐림만으로는 경고가 안 읽힌다.
  document.body.classList.toggle('stale', !ok);
  $('#statusDot').classList.toggle('error', !ok);
  $('#lastUpdated').textContent = ok
    ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`
    : '갱신 실패 — 아래 값은 이전 것';
}

/* ── 주인공 카드 ──
 * 장중이면 실제 코스피가 주인공이고 선물 환산값은 검산용 보조로 내려간다.
 * 마감 후면 환산값이 주인공이 되고 마감 종가가 보조로 내려간다. */
function renderHero(d) {
  const kospi = d.spot.find((x) => x.id === 'KOSPI');
  const imp = d.implied;
  const open = kospi?.marketState === 'OPEN';

  if (!kospi) return;

  if (open || !imp) {
    $('#heroTitle').textContent = '코스피';
    $('#heroBadge').textContent = open ? '장중' : '마감';
    $('#heroBadge').className = `hero-badge ${open ? 'live' : ''}`;
    $('#heroValue').textContent = f2.format(kospi.value);
    $('#heroValue').className = `hero-value ${cls(kospi.changePct)}`;
    $('#heroChange').innerHTML = `<span class="${cls(kospi.changePct)}">${kospi.change > 0 ? '▲' : kospi.change < 0 ? '▼' : ''} ${f2.format(Math.abs(kospi.change))} (${pct(kospi.changePct)})</span>`;
    // 장중 베이시스는 오차가 아니라 정보다 — 선물이 현물보다 싸면 야간 하락 압력.
    $('#heroSub').textContent = imp
      ? `선물 환산 ${f2.format(imp.kospi)} · 베이시스 ${pct(imp.basisPct)} — 선물이 현물보다 ${imp.basisPct < 0 ? '싸다 (하락 쪽에 베팅)' : '비싸다 (상승 쪽에 베팅)'}`
      : '야간 선물 데이터 없음';
  } else {
    $('#heroTitle').textContent = '코스피 (야간 선물 환산)';
    $('#heroBadge').textContent = '마감 후 추정';
    $('#heroBadge').className = 'hero-badge est';
    const chg = imp.kospi - kospi.value;
    $('#heroValue').textContent = f2.format(imp.kospi);
    $('#heroValue').className = `hero-value ${cls(chg)}`;
    $('#heroChange').innerHTML = `<span class="${cls(chg)}">${chg > 0 ? '▲' : chg < 0 ? '▼' : ''} ${f2.format(Math.abs(chg))} (${pct((chg / kospi.value) * 100)})</span> <span class="vs">종가 대비</span>`;
    $('#heroSub').textContent = `코스피 종가 ${f2.format(kospi.value)} × (KR200 선물 ${f2.format(imp.kpi200)} ÷ 코스피200 종가 ${f2.format(imp.spotBasis)})`;
  }

  const kr200 = d.futures.find((x) => x.symbol === 'xyz:KR200');
  $('#heroSide').innerHTML = [
    kr200 ? { k: '코스피200 선물', v: f2.format(kr200.mark), sub: `24h ${pct(kr200.changePct)}`, tone: cls(kr200.changePct) } : null,
    imp ? { k: '베이시스 (선물−현물)', v: pct(imp.basisPct), sub: imp.basisPct > 0 ? '콘탱고' : '백워데이션', tone: cls(imp.basisPct) } : null,
    kr200 ? { k: '미결제약정', v: money(kr200.oiUsd), sub: `24h 거래 ${money(kr200.volUsd)}`, tone: '' } : null,
  ].filter(Boolean).map((r) => `
    <div class="hs-item">
      <span class="k">${esc(r.k)}</span>
      <span class="v ${r.tone}">${esc(r.v)}</span>
      <span class="d">${esc(r.sub)}</span>
    </div>`).join('');
}

/* ── KRX 현물 ── */
function renderSpot(d) {
  $('#spotGrid').innerHTML = d.spot.map((s) => `
    <div class="spot-card">
      <div class="sc-head">
        <span class="sc-name">${esc(s.name)}</span>
        <span class="idx-state">${s.marketState === 'OPEN' ? '장중' : '마감'}</span>
      </div>
      <div class="sc-value ${cls(s.changePct)}">${f2.format(s.value)}</div>
      <div class="sc-change ${cls(s.changePct)}">${s.change > 0 ? '▲' : s.change < 0 ? '▼' : ''} ${f2.format(Math.abs(s.change))} (${pct(s.changePct)})</div>
      <div class="sc-ohl">
        <span>시 ${f2.format(s.open)}</span>
        <span>고 ${f2.format(s.high)}</span>
        <span>저 ${f2.format(s.low)}</span>
      </div>
      ${s.tradingValue ? `<div class="sc-vol">거래대금 ${f0.format(Math.round(s.tradingValue / 1e8))}억</div>` : ''}
    </div>`).join('');
}

/* ── 야간 선물 ──
 * 거래가 없는(stale) 심볼은 마크가 고정된 껍데기라 값으로 읽으면 안 된다. */
function renderFutures(d) {
  $('#futList').innerHTML = `<div class="fut-legend"><span>심볼</span><span>마크</span><span>24h</span><span>24h 거래대금</span></div>`
    + d.futures.map((f) => `
    <div class="fut-row ${f.stale ? 'stale' : ''}">
      <div class="fr-name">
        ${esc(f.label)}
        <span class="fr-sym">${esc(f.symbol.replace('xyz:', ''))}</span>
        ${f.stale ? '<span class="fr-warn" title="미결제약정·거래대금이 0 — 거래가 없어 가격이 고정된 상태">거래없음</span>' : ''}
      </div>
      <div class="fr-price">${f.mark != null ? f2.format(f.mark) : '—'}</div>
      <div class="fr-chg ${f.stale ? 'flat' : cls(f.changePct)}">${f.stale ? '—' : pct(f.changePct)}</div>
      <div class="fr-vol">${f.stale ? '—' : money(f.volUsd)}</div>
    </div>`).join('');
}

function renderGlobal(d) {
  $('#globList').innerHTML = d.global.map((g) => `
    <div class="glob-row">
      <div class="gr-name">${esc(g.name)}<span class="gr-src">${esc(g.source)}</span>${g.marketState ? Chart.asOfBadge(g.marketState) : ''}</div>
      <div class="gr-value">${f2.format(g.value)}</div>
      <div class="gr-chg ${cls(g.changePct)}">${pct(g.changePct)}</div>
    </div>`).join('');
}

/* ── 장기 지수 차트 (네이버 장기 일봉) ── */
// 렌더 시점에 읽는다 — 최상위 상수면 테마 전환 뒤에도 옛 색이 남는다
const IDX_COLOR = (k) => (k === 'KOSPI' ? Chart.series(1) : k === 'KOSDAQ' ? Chart.series(2) : Chart.token('--series-3', '#8b9dff'));
const IDX_LABEL = { KOSPI: '코스피', KOSDAQ: '코스닥', KPI200: '코스피200' };

/* 탭을 빠르게 바꾸면 느린 옛 응답이 나중에 도착해 새 탭 차트를 덮어썼다 — 요청 번호로 최신만 남긴다 */
let idxChartSeq = 0, hlChartSeq = 0;

async function renderIdxChart() {
  const box = $('#idxChart');
  const seq = ++idxChartSeq;
  try {
    const d = await api(`/api/peak?codes=${state.target}&range=${state.range}`);
    if (seq !== idxChartSeq) return;   // 그새 다른 지수/기간으로 갔다
    const row = d.rows?.[0];
    if (!row?.points?.length) { box.innerHTML = `<div class="inv-empty">차트 데이터 없음</div>`; return; }

    const fmtDate = (s) => `${s.slice(2, 4)}.${s.slice(4, 6)}`;
    Chart.line(box, {
      series: [{
        key: state.target, label: IDX_LABEL[state.target], color: IDX_COLOR(state.target),
        values: row.points.map((p) => p.c),
        readout: (v) => f2.format(v),
      }],
      labels: row.points.map((p) => fmtDate(p.d)),
      height: 300,
      yFormat: (v) => f0.format(Math.round(v)),
      tagFormat: (s, v) => f2.format(v),
    });

    const dd = row.drawdownPct;
    $('#idxChartNote').textContent = row.isNewHigh
      ? `${row.firstDate.slice(0, 4)}년 이후 ${row.tradingDays.toLocaleString('ko-KR')}거래일 · 지금이 이 기간 최고점`
      : `${row.firstDate.slice(0, 4)}년 이후 ${row.tradingDays.toLocaleString('ko-KR')}거래일 · 전고점 ${f2.format(row.peak)} (${row.peakDate.slice(0, 4)}.${row.peakDate.slice(4, 6)}.${row.peakDate.slice(6, 8)}) 대비 ${pct(dd)}`;
    markUpdated(true, 'chart');
  } catch (e) {
    console.warn('idxChart', e);
    markUpdated(false, 'chart');
    // 이미 그려진 차트는 남긴다 — 상단 문구가 '아래 값은 이전 것'이라고 말하는데 지우면 앞뒤가 안 맞는다
    if (!box.querySelector('svg')) box.innerHTML = `<div class="inv-empty">차트를 불러오지 못했어요</div>`;
  }
}

/* ── HL 선물 캔들 ── */
async function renderHlChart() {
  const box = $('#hlChart');
  const seq = ++hlChartSeq;
  try {
    const d = await api(`/api/hl/candles?coin=xyz:KR200&interval=${state.interval}`);
    if (seq !== hlChartSeq) return;    // 그새 다른 간격으로 갔다
    if (!d.candles?.length) { box.innerHTML = `<div class="inv-empty">캔들 없음</div>`; return; }
    Chart.candles(box, {
      candles: d.candles, height: 210,
      yFormat: (v) => f2.format(v),
      xFormat: Chart.timeAxis(d.candles),
    });
  } catch (e) {
    console.warn('hlChart', e);
    box.innerHTML = `<div class="inv-empty">캔들을 불러오지 못했어요</div>`;
  }
}

/* ── 탭 ── */
function tabs(sel, key, onChange) {
  $(sel).addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b || b.dataset[key] === state[key === 'target' ? 'target' : key === 'range' ? 'range' : 'interval']) return;
    if (key === 'target') state.target = b.dataset.target;
    else if (key === 'range') state.range = b.dataset.range;
    else state.interval = b.dataset.iv;
    document.querySelectorAll(`${sel} .tab`).forEach((x) => x.classList.toggle('active', x === b));
    onChange();
  });
}
tabs('#chartTargetTabs', 'target', renderIdxChart);
tabs('#chartRangeTabs', 'range', renderIdxChart);
tabs('#hlIntervalTabs', 'iv', renderHlChart);

/* ── 로드 ── */
async function refresh() {
  try {
    const d = await api('/api/idx');
    state.data = d;
    renderHero(d);
    renderSpot(d);
    renderFutures(d);
    renderGlobal(d);
    everLoaded = true;
    markUpdated(true, 'main');
  } catch (e) {
    console.warn('idx', e);
    markUpdated(false, 'main');
    if (!everLoaded) {
      const el = $('#spotGrid');
      if (el) el.innerHTML = `<div class="inv-empty">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. <button class="retry-btn" onclick="load()">다시 시도</button></div>`;
    }
  }
}

/* '다시 시도' 버튼과 다른 페이지가 같은 이름으로 부를 수 있게 — 이 이름이 없어서 버튼이 무반응이었다 */
function load() { refresh(); renderIdxChart(); renderHlChart(); }

load();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(() => { if (!document.hidden) renderHlChart(); }, 30000);
/* 지수 추이는 일봉이라 자주 안 바뀌지만, 차트 노트의 '전고점 대비'는 오늘 종가에 딸려 움직인다.
 * 최초 1회만 그리면 히어로(5초 갱신)와 노트가 서로 다른 시점을 말하게 된다. */
setInterval(() => { if (!document.hidden) renderIdxChart(); }, 60000);

/* 테마가 바뀌면 다시 그린다 — 차트는 색을 SVG 속성에 박아 그리므로 CSS 변수만 바뀌어선 안 따라온다 */
addEventListener('themechange', () => { renderIdxChart(); renderHlChart(); });
