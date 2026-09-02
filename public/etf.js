/* ETF 괴리율 + 세션 타임라인
 * 괴리율 = (현재가 − iNAV) / iNAV. 시세 5초, NAV는 서버에서 2분 캐시.
 * 목록은 localStorage('etf-v1') — 기본값은 단일종목 레버리지 6종 + KODEX 레버리지/인버스.
 */

const $ = (s) => document.querySelector(s);
const fmtKR = new Intl.NumberFormat('ko-KR');

const DEFAULT_ETFS = [
  { code: '0193W0', name: 'KODEX 삼성전자단일종목레버리지' },
  { code: '0195R0', name: 'TIGER 삼성전자단일종목레버리지' },
  { code: '0194M0', name: 'ACE 삼성전자단일종목레버리지' },
  { code: '0193T0', name: 'KODEX SK하이닉스단일종목레버리지' },
  { code: '0195S0', name: 'TIGER SK하이닉스단일종목레버리지' },
  { code: '122630', name: 'KODEX 레버리지' },
  { code: '114800', name: 'KODEX 인버스' },
];

function loadList() {
  /* '비어 있음'과 '아직 설정한 적 없음'은 다른 상태다.
   * 빈 배열을 저장했는데 기본값으로 되살리면, 사용자가 지운 것이 계속 돌아온다. */
  try {
    const raw = localStorage.getItem('etf-v1');
    if (raw !== null) {
      const d = JSON.parse(raw);
      if (Array.isArray(d)) return d;      // 빈 배열도 그대로 존중한다
    }
  } catch { /* 깨졌으면 기본값으로 */ }
  return [...DEFAULT_ETFS];
}
let list = loadList();
const saveList = () => localStorage.setItem('etf-v1', JSON.stringify(list));

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

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

/* ── 표 ── */
async function refresh() {
  if (!list.length) {
    $('#etfBody').innerHTML = `<tr><td colspan="7" class="ac" style="padding:24px;color:var(--text-faint)">위에서 ETF를 검색해 추가하세요</td></tr>`;
    return;
  }
  try {
    const { rows } = await api(`/api/etf?codes=${list.map((e) => e.code).join(',')}`);

    /* 서버가 준 거래소 기준 장 상태를 세션 타임라인의 진실로 삼는다.
     * 한 종목이라도 OPEN 이면 장중, 전부 CLOSED 면 휴장, 아무도 안 주면 모름. */
    const states = rows.map((r) => r.marketState).filter(Boolean);
    krOpen = states.length ? states.includes('OPEN') : null;
    renderSessions();

    // 괴리 절대값 큰 순 — 벌어진 놈이 위로
    rows.sort((a, b) => Math.abs(b.gapPct ?? 0) - Math.abs(a.gapPct ?? 0));
    $('#etfBody').innerHTML = rows.map((r) => {
      const g = r.gapPct;                       // 네이버 제공 실시간 괴리 — 신뢰할 값
      const big = g != null && Math.abs(g) >= 1;
      return `<tr>
        <td class="al"><b>${esc(r.name)}</b> <span style="color:var(--text-faint);font-size:var(--fs-2xs)">${esc(r.code)}</span></td>
        <td class="ar num">${r.price != null ? fmtKR.format(r.price) : '—'}${
          r.extPrice ? `<span class="q-ext ${cls(r.extPct)}">NXT ${fmtKR.format(r.extPrice)} ${pct(r.extPct)}</span>` : ''}</td>
        <td class="ar num ${cls(r.changePct)}">${pct(r.changePct)}${
          r.marketState && r.marketState !== 'OPEN'
            ? '<span class="q-ext" style="color:var(--text-faint)">종가</span>' : ''}</td>
        <td class="ar num">${r.inav != null ? fmtKR.format(Math.round(r.inav)) : '—'}</td>
        <td class="ar"><span class="gap-cell ${cls(g)}${big ? ' big' : ''}">${pct(g)}</span></td>
        <td class="ar num" style="color:var(--text-faint)">${r.navPrevClose != null ? fmtKR.format(Math.round(r.navPrevClose)) : '—'}</td>
        <td class="ac"><button class="remove-btn" data-del="${r.code}" title="삭제" style="opacity:1">✕</button></td>
      </tr>`;
    }).join('');
    everLoaded = true;
    markUpdated(true);
  } catch (e) {
    console.warn('etf', e);
    markUpdated(false);
    if (!everLoaded) {
      const el = $('#etfBody');
      if (el) el.innerHTML = `<tr><td colspan="7" class="ac" style="padding:24px">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. <button class="retry-btn" onclick="refresh()">다시 시도</button></td></tr>`;
    }
  }
}

$('#etfBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  list = list.filter((x) => x.code !== btn.dataset.del);
  saveList(); refresh();
});

/* ── 검색 추가 (ETF만) ── */
const searchInput = $('#searchInput');
const searchResults = $('#searchResults');
let timer = null, seq = 0;

searchInput.addEventListener('input', () => {
  clearTimeout(timer);
  const q = searchInput.value.trim();
  if (!q) { searchResults.hidden = true; return; }
  timer = setTimeout(async () => {
    const s = ++seq;
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (s !== seq) return;
      const etfs = results.filter((r) => r.isEtf && r.id.startsWith('KR:'));
      searchResults.innerHTML = etfs.length ? etfs.slice(0, 8).map((r) => {
        const added = list.some((x) => x.code === r.code);
        return `<button class="search-item" data-add-code="${r.code}" data-add-name="${esc(r.name)}" ${added ? 'disabled' : ''}>
          <span class="badge kr">ETF</span><span>${esc(r.name)}</span><span class="si-code">${esc(r.code)}</span>
          ${added ? '<span class="si-added">추가됨</span>' : ''}</button>`;
      }).join('') : '<div class="search-empty">국내 ETF만 추가할 수 있어요</div>';
      searchResults.hidden = false;
    } catch {}
  }, 250);
});

searchResults.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add-code]');
  if (!btn || btn.disabled) return;
  list.push({ code: btn.dataset.addCode, name: btn.dataset.addName });
  saveList();
  searchResults.hidden = true;
  searchInput.value = '';
  refresh();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) searchResults.hidden = true;
});

/* ── 세션 타임라인 ──
 * 24시간(KST) 띠에 각 장의 운영 시간을 깔고 현재 시각 마커를 움직인다.
 * 미국 정규장은 서머타임에 따라 22:30~05:00 또는 23:30~06:00 — ET 오프셋으로 동적 계산. */
function usSessionKst() {
  // 오늘 09:30 ET가 KST로 몇 시인지 역산
  const now = new Date();
  const etHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now), 10);
  const kstHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false }).format(now), 10);
  let diff = (kstHour - etHour + 24) % 24;      // ET → KST 시차 (13 서머타임 / 14 표준시)
  const open = (9.5 + diff) % 24;                // 09:30 ET
  const close = (16 + diff) % 24;                // 16:00 ET
  return { open, close, dst: diff === 13 };
}

const SESSIONS = () => {
  const us = usSessionKst();
  return [
    { key: 'nxt', label: 'NXT', cls: 'nxt', ranges: [[8, 9], [15.5, 20]] },
    { key: 'kr', label: 'KR 정규', cls: 'kr', ranges: [[9, 15.5]] },
    { key: 'us', label: `US 정규${us.dst ? '' : '(표준시)'}`, cls: 'us',
      ranges: us.open < us.close ? [[us.open, us.close]] : [[us.open, 24], [0, us.close]] },
  ];
};

function kstNowHours() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const h = +p.find((x) => x.type === 'hour').value, m = +p.find((x) => x.type === 'minute').value;
  return h + m / 60;
}

/* ⚠️ 요일만 보고 '진행 중'을 판정하면 공휴일에 거짓말을 한다.
 * 광복절·설·추석 평일 10시에 열면 "KR 정규 ● 진행 중"이 뜬다 —
 * 이 패널의 존재 이유가 "지금 어느 장이 열려 있나"인데 1년에 10일 넘게 정반대를 말하는 셈이다.
 * 거래소 기준을 아는 건 서버뿐이라, /api/etf 가 함께 내려주는 marketState 를 진실로 삼는다.
 * null 은 '모름'이며, 모를 때는 시간대 추정으로 물러난다(거짓 단정보다 낫다). */
let krOpen = null;   // true=장중, false=휴장, null=모름

function renderSessions() {
  const bar = $('#sessBar');
  const nowH = kstNowHours();
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' }).format(new Date());
  const weekend = day === 'Sat' || day === 'Sun';
  const segs = [];
  const legend = [];

  for (const s of SESSIONS()) {
    let live = false;
    for (const [a, b] of s.ranges) {
      const inWindow = !weekend && nowH >= a && nowH < b;
      /* KR·NXT 는 한국 거래소 상태를 그대로 따른다.
       * 미국 세션은 우리가 상태를 모르므로 시간대 추정을 유지하되,
       * 한국이 휴장인 날에도 미국은 열릴 수 있으니 krOpen 을 적용하지 않는다. */
      const korean = s.key === 'kr' || s.key === 'nxt';
      const on = korean && krOpen === false ? false : inWindow;
      if (on) live = true;
      segs.push(`<div class="sess-seg ${s.cls}${on ? ' live' : ''}"
        style="left:${(a / 24 * 100).toFixed(2)}%;width:${((b - a) / 24 * 100).toFixed(2)}%">${
        (b - a) >= 2 ? s.label : ''}</div>`);
    }
    const t = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`;
    legend.push(`<span class="${live ? 'on' : ''}">${s.label} ${s.ranges.map(([a, b]) => `${t(a)}–${t(b)}`).join(' · ')}${live ? ' ● 진행 중' : ''}</span>`);
  }

  const hhmm = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  bar.innerHTML = segs.join('') + `<div class="sess-now" style="left:${(nowH / 24 * 100).toFixed(2)}%" data-time="${hhmm}"></div>`;

  // 왜 꺼져 있는지 말해준다 — 주말인지, 휴장일인지, 그냥 장 시간이 아닌지
  let note = '';
  if (weekend) note = ' <span>· 주말 휴장</span>';
  else if (krOpen === false && nowH >= 9 && nowH < 15.5) note = ' <span>· 오늘은 휴장일</span>';
  $('#sessLegend').innerHTML = legend.join('') + note;
}

/* ── 부팅 ── */
refresh();
renderSessions();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
setInterval(renderSessions, 30000);
