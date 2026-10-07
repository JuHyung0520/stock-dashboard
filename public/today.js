/* 오늘의 장 정리 — /api/today 한 덩어리를 받아 그린다.
 * 글 요약은 서버(pure.js 템플릿)가 만들어 준다. 여기서는 숫자를 보기 좋게 놓는 일만 한다. */
const { esc, cls, pct, fmtKR, fmtUS } = Pure;
const f2 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

const state = { target: 'KOSPI', rank: 'watch', data: null, watch: null };
const okBy = {};
function markUpdated(ok, src = 'main') {
  okBy[src] = ok;
  const all = Object.values(okBy).every(Boolean);
  $('#statusDot').classList.toggle('error', !all);
  document.body.classList.toggle('stale', !all);
  $('#lastUpdated').textContent = all
    ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}` : '갱신 실패 — 아래 값은 이전 것';
}

const idxOf = () => state.data && state.data.indices.find((i) => i.id === state.target);

/* ── 히어로 ── */
function renderHero() {
  const ix = idxOf(); if (!ix) return;
  const s = ix.stats;
  const open = ix.marketState === 'OPEN';
  $('#heroName').textContent = ix.name;
  const badge = $('#heroBadge');
  badge.textContent = open ? '장중' : '마감';
  badge.classList.toggle('live', open);
  const close = s ? s.close : ix.value;
  const chg = s ? s.closePct : ix.changePct;
  $('#heroValue').innerHTML = close == null ? '—' : `<span class="${cls(chg)}">${f2.format(close)}</span>`;
  $('#heroChange').innerHTML = chg == null ? '' : `<span class="${cls(chg)}">${pct(chg)}</span>`
    + (s ? ` <span class="vs">전일 ${f2.format(s.prevClose)}</span>` : '');
  $('#heroNarr').textContent = ix.narrative || (open ? '장이 끝나면 하루를 문장으로 정리합니다.' : '');
  $('#heroSide').innerHTML = !s ? '' : [
    ['시가', s.open, s.openPct, s.openT], ['고가', s.high, s.highPct, s.highT],
    ['저가', s.low, s.lowPct, s.lowT], ['변동폭', null, s.rangePct, null],
  ].map(([k, v, p, t]) => `<div class="hs-item">
      <span class="k">${k}${t ? ` <span class="t">${t}</span>` : ''}</span>
      <span class="v ${v == null ? '' : cls(p)}">${v == null ? `${p.toFixed(2)}%` : f2.format(v)}</span>
      <span class="d ${v == null ? '' : cls(p)}">${v == null ? '고가−저가' : pct(p)}</span>
    </div>`).join('');
  if (state.data.date) {
    const d = state.data.date;
    $('#brandDate').textContent = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)} 정규장`;
  }
}

/* ── 장중 흐름 차트 ── */
const chartGuard = Pure.makeGuard();
function renderChart() {
  const ix = idxOf(); const box = $('#flowChart');
  if (!ix || !ix.points.length) { Chart.clear(box, '<div class="inv-empty">장중 시세가 아직 없어요 (09:00 이후 쌓입니다)</div>'); return; }
  // 선 색은 등락 방향 — 상승 빨강·하락 파랑. 전일종가 점선 위/아래로 읽힌다
  const up = ix.stats ? ix.stats.closePct >= 0 : (ix.changePct || 0) >= 0;
  Chart.line(box, {
    series: [{ key: ix.id, label: ix.name, color: Chart.token(up ? '--up' : '--down', up ? '#f04452' : '#3182f6'),
      values: ix.points.map((p) => p.p), readout: (v) => f2.format(v) }],
    labels: ix.points.map((p) => p.t),
    height: 300,
    yFormat: (v) => f0.format(Math.round(v)),
    tagFormat: (s, v) => f2.format(v),
    baseline: ix.prevClose,
  });
  const n = ix.points.length;
  $('#flowNote').textContent = `점선은 전일 종가 ${ix.prevClose ? f2.format(ix.prevClose) : '—'}. ${ix.points[0].t}~${ix.points[n - 1].t} 1분 단위 ${n}개.`;
}

/* ── 수급 ── */
function renderFlow() {
  const fl = state.data && state.data.flow;
  const m = fl && fl.markets ? (fl.markets.find((x) => x.market === '코스피') || fl.markets[0]) : null;
  if (!m) { $('#flowNarr').textContent = '수급 데이터가 없어요.'; $('#flowBars').innerHTML = ''; $('#flowBreakdown').innerHTML = ''; return; }
  $('#flowSrc').textContent = `${m.market} · ${fl.unit} · ${fl.source === 'toss' ? '토스' : '네이버'}${fl.provisional ? ' · 잠정' : ''}${m.asOf ? ` · ${m.asOf}` : ''}`;
  $('#flowNarr').textContent = fl.narrative || '';
  const rows = [['외국인', m.foreign, fl.streaks && fl.streaks.foreign], ['기관', m.institution, fl.streaks && fl.streaks.institution],
    ['개인', m.individual, fl.streaks && fl.streaks.individual], ['기타법인', m.otherCorp, 0]].filter(([, v]) => v != null);
  const maxAbs = Math.max(1, ...rows.map(([, v]) => Math.abs(v)));
  $('#flowBars').innerHTML = rows.map(([label, v, n]) => {
    const w = Math.min(50, (Math.abs(v) / maxAbs) * 50);
    return `<div class="inv-row">
      <span class="inv-label">${label}${n >= 2 ? `<small> ${n}일째</small>` : ''}</span>
      <div class="inv-bar-track">${v === 0 ? '' : `<div class="inv-bar ${v > 0 ? 'pos' : 'neg'}" style="width:${w}%"></div>`}</div>
      <span class="inv-amount ${cls(v)}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Pure.fEok(v)}</span>
    </div>`;
  }).join('');
  const bd = (m.breakdown || []).filter((b) => b.value != null).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  $('#flowBreakdown').innerHTML = bd.map((b) =>
    `<span class="chip">${esc(b.label)} <b class="${cls(b.value)}">${b.value > 0 ? '+' : b.value < 0 ? '−' : ''}${Pure.fEok(b.value)}</b></span>`).join('');
}

/* ── 오늘의 종목 ── */
const fmtKrw = (v) => (v == null ? '—' : v >= 1e12 ? `${(v / 1e12).toFixed(1)}조` : v >= 1e8 ? `${f0.format(Math.round(v / 1e8))}억` : f0.format(v));
const priceOf = (q) => (q.currency === 'USD' ? `$${fmtUS.format(q.price)}` : fmtKR.format(q.price));

function renderRank() {
  const body = $('#rankBody');
  if (state.rank === 'watch') {
    const q = state.watch;
    if (!q) { body.innerHTML = '<div class="rank-empty">관심종목 시세를 불러오는 중…</div>'; return; }
    if (!q.length) { body.innerHTML = '<div class="rank-empty">관심종목이 없어요 — 대시보드에서 추가하세요.</div>'; return; }
    const rows = [...q].sort((a, b) => (b.changePct ?? -1e9) - (a.changePct ?? -1e9));
    body.innerHTML = `<table class="rank-table">${rows.map((x, i) => `<tr>
        <td class="rk">${i + 1}</td>
        <td class="nm">${esc(x.name)}<small>${esc(x.id)}</small></td>
        <td class="num">${x.price == null ? '—' : priceOf(x)}</td>
        <td class="pct ${cls(x.changePct)}">${pct(x.changePct)}</td>
      </tr>`).join('')}</table>`;
    return;
  }
  const r = state.data && state.data.rankings && state.data.rankings[state.rank];
  if (!r || !r.rows) { body.innerHTML = '<div class="rank-empty">랭킹을 불러오지 못했어요 (토스 API 필요)</div>'; return; }
  body.innerHTML = `<table class="rank-table">${r.rows.slice(0, 10).map((x) => `<tr>
      <td class="rk">${x.rank}</td>
      <td class="nm">${esc(x.name)}<small>${esc(x.symbol)}</small></td>
      <td class="num">${x.price == null ? '—' : fmtKR.format(x.price)}${state.rank === 'amount' ? `<small> · ${fmtKrw(x.amount)}</small>` : ''}</td>
      <td class="pct ${cls(x.changePct)}">${pct(x.changePct)}</td>
    </tr>`).join('')}</table>`;
}

/* ── 불러오기 ── */
const loadGuard = Pure.makeGuard();
async function load() {
  const g = loadGuard.start();
  try {
    const d = await api('/api/today');
    if (!loadGuard.current(g)) return;
    state.data = d;
    renderHero(); renderChart(); renderFlow(); renderRank();
    markUpdated(true, 'today');
  } catch (e) {
    if (!loadGuard.current(g)) return;
    console.warn('today', e);
    markUpdated(false, 'today');
  }
}

async function loadWatch() {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem('watchlist-v1') || '[]').map((x) => (typeof x === 'string' ? x : x.id)).filter(Boolean); } catch { /* 깨진 저장값 */ }
  if (!ids.length) { state.watch = []; if (state.rank === 'watch') renderRank(); return; }
  try {
    const { quotes } = await api(`/api/quotes?ids=${encodeURIComponent(ids.join(','))}`);
    state.watch = quotes || [];
    markUpdated(true, 'watch');
  } catch (e) { console.warn('watch', e); state.watch = state.watch || []; markUpdated(false, 'watch'); }
  if (state.rank === 'watch') renderRank();
}

$('#idxTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-target]'); if (!b || b.dataset.target === state.target) return;
  state.target = b.dataset.target;
  document.querySelectorAll('#idxTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderHero(); renderChart();
});
$('#rankTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rank]'); if (!b || b.dataset.rank === state.rank) return;
  state.rank = b.dataset.rank;
  document.querySelectorAll('#rankTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderRank();
});
addEventListener('themechange', renderChart);

load(); loadWatch();
// 장중엔 1분마다(1분봉이 1개씩 늘어난다), 그 밖엔 5분마다
setInterval(() => { if (document.hidden) return; const ix = idxOf(); if (!ix || ix.marketState === 'OPEN') load(); }, 60000);
setInterval(() => { if (!document.hidden) { load(); loadWatch(); } }, 300000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(); loadWatch(); } });
