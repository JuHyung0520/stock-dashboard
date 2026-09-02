/* 시총비교 — 두 회사의 크기를 시간축 위에 나란히 놓는다.
 *
 * 시총 = 일별 종가 × 현재 발행주식수.
 * 과거 시점의 정확한 시총이 아니라(주식수 변동 미반영) 두 회사의 상대 크기 추이를 본다.
 * 이 근사를 화면에 명시하는 게 중요하다 — 숫자가 정밀해 보일수록 오해가 커진다.
 */

const $ = (s) => document.querySelector(s);
/* 색은 렌더 시점에 읽는다 — 최상위 상수로 잡아두면 테마 전환 후 선 색만 옛 테마로 남는다 */
const COLORS = (i) => Chart.series(i + 1);

const DEFAULT = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
];

const state = {
  picks: JSON.parse(localStorage.getItem('mcap-picks-v1') || 'null') || DEFAULT,
  range: localStorage.getItem('mcap-range-v1') || '1Y',
  pref: localStorage.getItem('mcap-pref-v1') === '1',
  data: null,
};

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const pct = (v) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const cls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 시총은 조 단위가 읽기 좋다. 1조 미만이면 억으로 내려간다. */
const JO = 1e12;
const cap = (v, digits = 1) => {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= JO) return `${(v / JO).toFixed(digits)}조`;
  return `${Math.round(v / 1e8).toLocaleString('ko-KR')}억`;
};
const fmtDate = (s) => `${s.slice(2, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
const fmtAxis = (s) => `${s.slice(2, 4)}.${s.slice(4, 6)}`;

function markUpdated(ok) {
  // 실패했는데 화면은 그대로면 사용자는 낡은 값을 현재값으로 읽는다.
  // 흐림(시선)과 문구(설명)를 함께 준다 — 흐림만으로는 경고가 안 읽힌다.
  document.body.classList.toggle('stale', !ok);
  $('#statusDot').classList.toggle('error', !ok);
  $('#lastUpdated').textContent = ok
    ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`
    : '갱신 실패 — 아래 값은 이전 것';
}

function save() {
  localStorage.setItem('mcap-picks-v1', JSON.stringify(state.picks));
  localStorage.setItem('mcap-range-v1', state.range);
  localStorage.setItem('mcap-pref-v1', state.pref ? '1' : '0');
}

/* ── 대결 카드: 누가 더 큰가, 얼마나 벌어졌나 ── */
function renderVersus(d) {
  const [a, b] = d.entities;
  const st = d.stats;
  const leader = st.gap >= 0 ? 0 : 1;
  const ratioText = st.ratio >= 1 ? `${st.ratio.toFixed(2)}배` : `${(1 / st.ratio).toFixed(2)}배`;

  $('#versus').innerHTML = `
    <div class="vs-side">
      ${d.entities.map((e, i) => `
        <div class="vs-card ${i === leader ? 'leader' : ''}" style="--c:${COLORS(i)}">
          <div class="vs-name">
            ${i === leader ? '<span class="crown">👑</span>' : ''}${esc(e.label)}
            ${e.prefIncluded ? `<span class="vs-pref">+ 우선주</span>` : ''}
          </div>
          <div class="vs-cap">${cap(e.cap)}${Chart.asOfBadge(e.marketState)}</div>
          <div class="vs-chg ${cls(e.changePct)}">${pct(e.changePct)}</div>
          <div class="vs-parts">${e.parts.map((p) => `${esc(p.name)} ${p.shares.toLocaleString('ko-KR')}주`).join(' · ')}</div>
        </div>`).join('<div class="vs-mid">vs</div>')}
    </div>
    <div class="vs-stats">
      <div class="vst">
        <span class="k">격차</span>
        <span class="v">${cap(Math.abs(st.gap))}</span>
        <span class="d">${esc(d.entities[leader].label)}가 ${ratioText}</span>
      </div>
      <div class="vst">
        <span class="k">${st.maxGap.value >= 0 ? `${esc(a.label)} 최대 우위` : `${esc(b.label)} 최소 우위`}</span>
        <span class="v">${cap(Math.abs(st.maxGap.value))}</span>
        <span class="d">${fmtDate(st.maxGap.date)}</span>
      </div>
      <div class="vst">
        <span class="k">${st.everFlipped ? `${esc(b.label)} 최대 우위` : `${esc(a.label)} 최소 우위`}</span>
        <span class="v">${cap(Math.abs(st.minGap.value))}</span>
        <span class="d">${fmtDate(st.minGap.date)}</span>
      </div>
    </div>`;
}

/* ── 차트 ── */
function renderCharts(d) {
  const labels = d.points.map((p) => fmtAxis(p.date));
  const [a, b] = d.entities;

  Chart.line($('#capChart'), {
    series: d.entities.map((e, i) => ({
      key: e.code, label: e.label, color: COLORS(i),
      values: d.points.map((p) => p.caps[i] / JO),
      readout: (v) => `${v.toFixed(1)}조`,
    })),
    labels, height: 300,
    yFormat: (v) => `${Math.round(v)}조`,
    tagFormat: (s, v) => `${v.toFixed(0)}조`,
  });

  $('#capLegend').innerHTML = d.entities.map((e, i) => `
    <span class="lg-item" style="color:${COLORS(i)}">
      <span class="lg-swatch" style="background:${COLORS(i)}"></span>${esc(e.label)} ${cap(e.cap)}
    </span>`).join('');

  Chart.line($('#ratioChart'), {
    series: [{
      key: 'ratio', label: `${a.label} ÷ ${b.label}`, color: Chart.token('--series-3', '#8b9dff'),
      values: d.points.map((p) => p.ratio),
      readout: (v) => `${v.toFixed(3)}배`,
    }],
    labels, height: 210,
    baseline: 1,
    yFormat: (v) => v.toFixed(2),
    tagFormat: (s, v) => `${v.toFixed(2)}배`,
  });

  $('#ratioNote').textContent = `1.00 = 동률 · 1.00 미만 = ${b.label}가 더 큼`;

  // 오래된 구간일수록 주식수 변동 오차가 쌓인다 — 조용히 넘어가면 정밀해 보이는 허수가 된다
  const longRange = ['3Y', '5Y', '10Y'].includes(state.range);
  $('#mcapNote').innerHTML =
    `${fmtDate(d.points[0].date)} ~ ${fmtDate(d.points[d.points.length - 1].date)} · ${d.tradingDays.toLocaleString('ko-KR')}거래일`
    + `<br>${esc(d.note)}`
    + (longRange ? '<br><span class="warn-note">⚠️ 감자·출자전환을 겪은 종목(예: SK하이닉스 2002년 21:1 감자)은 그 이전 구간이 크게 왜곡되어 최대 10년까지만 제공합니다.</span>' : '');
}

/* ── 종목 선택 ── */
function renderPicks() {
  state.picks.forEach((p, i) => {
    const el = i === 0 ? $('#slotA') : $('#slotB');
    el.innerHTML = `<button class="pick-btn ${state.slot === i ? 'active' : ''}" data-slot="${i}" style="--c:${COLORS(i)}">
      <span class="pick-dot"></span>${esc(p.name)}<span class="pick-code">${esc(p.code)}</span></button>`;
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.pick-btn');
  if (btn) {
    state.slot = Number(btn.dataset.slot);
    renderPicks();
    $('#searchInput').focus();
    $('#searchInput').placeholder = `${state.picks[state.slot].name} 자리를 교체할 종목 검색`;
  }
});

let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#searchResults').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      // 시총 계산에 발행주식수가 필요해서 국내 종목만 지원한다
      const kr = results.filter((r) => r.id.startsWith('KR:'));
      const box = $('#searchResults');
      box.innerHTML = kr.length
        ? kr.slice(0, 8).map((r) => `<button class="sr-item" data-code="${esc(r.code)}" data-name="${esc(r.name)}">
            <span>${esc(r.name)}</span><span class="sr-code">${esc(r.code)}</span></button>`).join('')
        : '<div class="sr-empty">국내 종목만 비교할 수 있어요 (발행주식수 필요)</div>';
      box.hidden = false;
    } catch { $('#searchResults').hidden = true; }
  }, 220);
});

$('#searchResults').addEventListener('click', (e) => {
  const it = e.target.closest('.sr-item');
  if (!it) return;
  const slot = state.slot ?? 1;
  state.picks[slot] = { code: it.dataset.code, name: it.dataset.name };
  state.slot = null;
  $('#searchInput').value = '';
  $('#searchInput').placeholder = '종목 검색해서 교체 (예: 현대차)';
  $('#searchResults').hidden = true;
  save(); renderPicks(); load();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) $('#searchResults').hidden = true;
});

$('#rangeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.range === state.range) return;
  state.range = b.dataset.range;
  document.querySelectorAll('#rangeTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  save(); load();
});

$('#prefToggle').addEventListener('change', (e) => {
  state.pref = e.target.checked;
  save(); load();
});

/* 실패했을 때 화면을 비운다.
 * 예전에는 #versus 한 줄만 오류로 바꾸고 조기 return 했는데, 그러면 차트·범례가
 * 직전 종목 것으로 그대로 남는다. 칩은 이미 새 종목 이름으로 바뀐 뒤라
 * "현대차를 골랐는데 삼성전자 곡선을 보며 현대차라고 믿는" 상황이 된다.
 * 화면 대부분을 차지하는 게 차트라서, 작은 오류 문구는 그걸 이기지 못한다. */
function clearCharts(msg) {
  for (const id of ['#capChart', '#ratioChart']) {
    const el = $(id); if (el) el.innerHTML = `<div class="inv-empty">${esc(msg)}</div>`;
  }
  for (const id of ['#capLegend', '#mcapNote', '#ratioNote']) {
    const el = $(id); if (el) el.innerHTML = '';
  }
}

let everLoaded = false;

/* ── 로드 ── */
async function load() {
  try {
    const codes = state.picks.map((p) => p.code).join(',');
    const d = await api(`/api/marketcap?codes=${codes}&range=${state.range}&pref=${state.pref ? 1 : 0}`);
    if (d.unavailable) {
      $('#versus').innerHTML = `<div class="inv-empty">${esc(d.reason || '데이터를 가져올 수 없습니다')} `
        + `<button class="retry-btn" onclick="load()">다시 시도</button></div>`;
      clearCharts('표시할 데이터가 없습니다');
      markUpdated(false);
      return;
    }
    state.data = d;
    // 서버가 돌려준 정식 종목명으로 맞춰둔다 (검색 결과 이름과 다를 수 있음)
    d.entities.forEach((e, i) => { state.picks[i].name = e.label; });
    save(); renderPicks();
    renderVersus(d);
    renderCharts(d);

    if (state.pref) {
      const none = d.entities.filter((e) => !e.prefIncluded).map((e) => e.label);
      $('#prefToggle').parentElement.title = none.length ? `${none.join(', ')}는 우선주가 없습니다` : '';
    }
    everLoaded = true;
    markUpdated(true);
  } catch (e) {
    console.warn('marketcap', e);
    markUpdated(false);
    // 첫 로드부터 실패하면 스켈레톤이 영원히 반짝인다 — 재시도 수단을 준다
    if (!everLoaded) {
      $('#versus').innerHTML = '<div class="inv-empty">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. '
        + '<button class="retry-btn" onclick="load()">다시 시도</button></div>';
      clearCharts('표시할 데이터가 없습니다');
    }
  }
}

// 초기 상태 복원
document.querySelectorAll('#rangeTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.range === state.range));
$('#prefToggle').checked = state.pref;
renderPicks();
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);

/* 테마가 바뀌면 다시 그린다 — 차트는 색을 SVG 속성에 박아 그리므로 CSS 변수만 바뀌어선 안 따라온다 */
addEventListener('themechange', () => load());
