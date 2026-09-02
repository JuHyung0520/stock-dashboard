/* 전고대비 — 전고점에서 얼마나 내려왔고, 돌아가려면 얼마나 올라야 하나.
 *
 * 이 화면의 핵심은 낙폭이 아니라 **비대칭**이다.
 * −50%는 +100%가 있어야 본전이다. 하락률만 보면 이 사실이 안 보인다.
 * 그래서 두 숫자를 항상 나란히 놓는다.
 */

const $ = (s) => document.querySelector(s);
const f2 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f0 = new Intl.NumberFormat('ko-KR');

const DEFAULT_CODES = ['KOSPI', 'KOSDAQ', '005930', '000660'];

// 대시보드 관심종목을 그대로 가져온다 (국내 종목만 — 장기 일봉이 국내 소스라서)
function watchlistCodes() {
  try {
    const wl = JSON.parse(localStorage.getItem('watchlist-v1') || '[]');
    const kr = wl.map((x) => (typeof x === 'string' ? x : x.id)).filter((id) => id?.startsWith('KR:')).map((id) => id.slice(3));
    return kr;
  } catch { return []; }
}

/* 저장값은 믿지 않는다. 같은 파일의 watchlist 읽기는 try 로 감싸놓고 정작 이 키는 맨몸이라,
 * 깨진 JSON 하나에 모듈 최상위에서 던져 페이지 전체가 즉사했다.
 * 배열이 아니거나 항목 형식이 틀리면 버리고, 빈 배열은 '다 지운 상태'로 존중한다. */
function readCodes() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem('peak-codes-v1') || 'null'); } catch { /* 깨진 JSON */ }
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((c) => typeof c === 'string' && /^[A-Z0-9]{1,12}$/.test(c)))];
}

const state = {
  codes: readCodes() ?? [...new Set([...DEFAULT_CODES, ...watchlistCodes()])],
  range: localStorage.getItem('peak-range-v1') || '3Y',
  selected: null,
  rows: [],
};

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const pct = (v, d = 1) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
/* 상장 이후 구간에선 저점 대비가 +71,904% 같은 값이 나온다 (감자 반영 수정주가).
 * 자릿수만 늘어나고 읽히지 않으므로 열 배 이상은 배수로 바꾼다. */
const gain = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (v < 900) return pct(v);
  const x = v / 100 + 1;                       // 상승률 → 배수
  return `×${x < 100 ? x.toFixed(1) : Math.round(x).toLocaleString('ko-KR')}`;
};
const cls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (s) => `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
const price = (v, isIndex) => (v == null ? '—' : isIndex ? f2.format(v) : f0.format(Math.round(v)));

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
function save() {
  localStorage.setItem('peak-codes-v1', JSON.stringify(state.codes));
  localStorage.setItem('peak-range-v1', state.range);
}

/* 경과일을 사람이 읽는 단위로 */
function elapsed(days) {
  if (days <= 0) return '오늘';
  if (days < 31) return `${days}일 전`;
  if (days < 365) return `${Math.round(days / 30.4)}개월 전`;
  const y = days / 365.25;
  return `${y.toFixed(1)}년 전`;
}

function renderList(rows, missing = []) {
  if (!rows.length) {
    $('#peakList').innerHTML = `<div class="inv-empty">표시할 종목이 없습니다. 위에서 검색해 추가하세요.</div>`;
    // 목록이 비었는데 요약이 마지막 집계를 계속 말하면 거짓말이 된다
    const note = $('#summaryNote'); if (note) note.textContent = '전고점은 장중 고가 기준';
    return;
  }

  // 막대 길이는 가장 많이 빠진 종목을 기준으로 잡되, 최소 20%는 확보해 작은 낙폭도 보이게
  const worst = Math.max(20, ...rows.map((r) => Math.abs(r.drawdownPct || 0)));

  const missingNote = missing.length
    ? `<div class="inv-empty">불러오지 못한 종목: ${missing.map(esc).join(', ')} `
      + `<button class="retry-btn" onclick="load()">다시 시도</button></div>`
    : '';
  $('#peakList').innerHTML = rows.map((r) => {
    const dd = r.drawdownPct ?? 0;
    const w = Math.min(100, (Math.abs(dd) / worst) * 100);
    return `
    <div class="peak-row ${state.selected === r.code ? 'selected' : ''} ${r.isNewHigh ? 'newhigh' : ''}" data-code="${esc(r.code)}" role="button" tabindex="0">
      <div class="pr-main">
        <div class="pr-head">
          <span class="pr-name">${esc(r.name)}</span>
          ${r.isIndex ? '<span class="pr-tag">지수</span>' : `<span class="pr-code">${esc(r.code)}</span>`}
          ${r.isNewHigh ? '<span class="pr-badge">신고가</span>' : ''}
          ${r.marketState === 'OPEN' ? '<span class="pr-live">장중</span>' : ''}
          ${!r.isIndex ? `<button class="pr-del" data-del="${esc(r.code)}" title="목록에서 제거" aria-label="${esc(r.name)} 제거">×</button>` : ''}
        </div>
        <div class="pr-prices">
          <span class="pr-cur ${cls(r.changePct)}">${price(r.current, r.isIndex)}</span>
          <span class="pr-chg ${cls(r.changePct)}">${pct(r.changePct, 2)}</span>
          <span class="pr-peak">전고 ${price(r.peak, r.isIndex)} · ${fmtDate(r.peakDate)} (${elapsed(r.daysSincePeak)})</span>
        </div>
      </div>
      <div class="pr-bar-wrap">
        <div class="pr-track"><div class="pr-bar" style="width:${w.toFixed(1)}%"></div></div>
        <span class="pr-dd ${r.isNewHigh ? 'flat' : 'down'}">${r.isNewHigh ? '전고 경신' : pct(dd)}</span>
      </div>
      <div class="pr-recover">
        <span class="k">회복까지</span>
        <span class="v ${r.isNewHigh ? 'flat' : 'up'}">${r.isNewHigh ? '—' : pct(r.recoveryPct)}</span>
      </div>
      <div class="pr-low">
        <span class="k">저점 대비</span>
        <span class="v up" title="기간 저점 ${price(r.low, r.isIndex)} (${fmtDate(r.lowDate)})">${gain(r.fromLowPct)}</span>
      </div>
    </div>`;
  }).join('') + missingNote;

  const worstRow = rows[0];
  const highs = rows.filter((r) => r.isNewHigh).length;
  $('#summaryNote').textContent =
    `전고점은 장중 고가 기준 · ${rows.length}개 중 신고가 ${highs}개`
    + (worstRow && !worstRow.isNewHigh ? ` · 최대 낙폭 ${worstRow.name} ${pct(worstRow.drawdownPct)}` : '');
}

/* ── 선택 종목 상세 차트 ── */
function renderDetail(row) {
  $('#detailPanel').hidden = false;
  $('#detailTitle').textContent = `${row.name} — 전고점 대비`;
  $('#detailNote').textContent = `${fmtDate(row.firstDate)} 이후 ${row.tradingDays.toLocaleString('ko-KR')}거래일`;

  const labels = row.points.map((p) => `${p.d.slice(2, 4)}.${p.d.slice(4, 6)}`);
  Chart.line($('#detailChart'), {
    series: [{
      key: row.code, label: row.name, color: Chart.series(1),
      values: row.points.map((p) => p.c),
      readout: (v) => price(v, row.isIndex),
    }],
    labels, height: 300,
    baseline: row.peak,                       // 전고점을 가로선으로 — 얼마나 아래인지 눈으로 보인다
    yFormat: (v) => (row.isIndex ? f0.format(Math.round(v)) : f0.format(Math.round(v))),
    tagFormat: (s, v) => price(v, row.isIndex),
  });

  $('#detailFoot').innerHTML = row.isNewHigh
    ? `현재가가 이 기간 최고가입니다. 종가 기준 최고는 ${price(row.peakClose, row.isIndex)} (${fmtDate(row.peakCloseDate)}).`
    : `노란 점선이 전고점 <b>${price(row.peak, row.isIndex)}</b> (${fmtDate(row.peakDate)}, ${elapsed(row.daysSincePeak)}). `
      + `현재 <b>${pct(row.drawdownPct)}</b> 아래이고, 전고를 되찾으려면 <b class="up">${pct(row.recoveryPct)}</b> 올라야 합니다. `
      + `기간 저점은 ${price(row.low, row.isIndex)} (${fmtDate(row.lowDate)})이고 거기서 ${gain(row.fromLowPct)} 올라온 상태입니다.`;
}

/* ── 상호작용 ── */
$('#peakList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    state.codes = state.codes.filter((c) => c !== del.dataset.del);
    if (state.selected === del.dataset.del) { state.selected = null; $('#detailPanel').hidden = true; }
    save(); load();
    return;
  }
  const row = e.target.closest('.peak-row');
  if (!row) return;
  state.selected = state.selected === row.dataset.code ? null : row.dataset.code;
  const found = state.rows.find((r) => r.code === state.selected);
  if (found) renderDetail(found); else $('#detailPanel').hidden = true;
  renderList(state.rows);
});

$('#peakList').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.peak-row');
  if (!row) return;
  e.preventDefault();
  row.click();
});

$('#rangeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.range === state.range) return;
  state.range = b.dataset.range;
  document.querySelectorAll('#rangeTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  save(); load();
});

$('#resetBtn').addEventListener('click', () => {
  state.codes = [...new Set([...DEFAULT_CODES, ...watchlistCodes()])];
  state.selected = null;
  $('#detailPanel').hidden = true;
  save(); load();
});

let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $('#searchResults').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const kr = results.filter((r) => r.id.startsWith('KR:') && !state.codes.includes(r.code));
      const box = $('#searchResults');
      box.innerHTML = kr.length
        ? kr.slice(0, 8).map((r) => `<button class="sr-item" data-code="${esc(r.code)}">
            <span>${esc(r.name)}</span><span class="sr-code">${esc(r.code)}</span></button>`).join('')
        : '<div class="sr-empty">국내 종목만 지원합니다 (장기 일봉 소스가 국내 전용)</div>';
      box.hidden = false;
    } catch { $('#searchResults').hidden = true; }
  }, 220);
});

$('#searchResults').addEventListener('click', (e) => {
  const it = e.target.closest('.sr-item');
  if (!it) return;
  state.codes.push(it.dataset.code);
  $('#searchInput').value = '';
  $('#searchResults').hidden = true;
  save(); load();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) $('#searchResults').hidden = true;
});

/* ── 로드 ── */
async function load() {
  try {
    const d = await api(`/api/peak?codes=${state.codes.join(',')}&range=${state.range}`);
    state.rows = d.rows || [];

    /* 서버가 못 찾은 종목을 조용히 빼면 "내가 넣은 종목이 왜 없지"가 된다.
     * 무엇이 빠졌는지 이름을 대고 재시도 수단을 준다. */
    const got = new Set(state.rows.map((r) => r.code));
    const missing = state.codes.filter((c) => !got.has(c));

    renderList(state.rows, missing);

    /* 선택한 종목이 이번 응답에서 사라졌는데 상세 차트를 그대로 두면
     * 다른 종목 데이터를 그 종목 것으로 읽게 된다 — 반드시 닫는다. */
    const sel = state.selected ? state.rows.find((r) => r.code === state.selected) : null;
    if (sel) renderDetail(sel);
    else if (state.selected) { $('#detailPanel').hidden = true; state.selected = null; }
    everLoaded = true;
    markUpdated(true);
  } catch (e) {
    console.warn('peak', e);
    markUpdated(false);
    if (!everLoaded) {
      const el = $('#peakList');
      if (el) el.innerHTML = `<div class="inv-empty">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. <button class="retry-btn" onclick="load()">다시 시도</button></div>`;
    }
  }
}

document.querySelectorAll('#rangeTabs .tab').forEach((x) => x.classList.toggle('active', x.dataset.range === state.range));
load();
setInterval(() => { if (!document.hidden) load(); }, 15000);

/* 테마가 바뀌면 다시 그린다 — 차트는 색을 SVG 속성에 박아 그리므로 CSS 변수만 바뀌어선 안 따라온다 */
addEventListener('themechange', () => load());
