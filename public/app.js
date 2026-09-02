/* 내 주식 보드 — 프론트엔드
 * 서버(/api/*)가 외부 데이터를 정규화해서 내려주고, 여기서는 렌더링 + 폴링만 한다.
 * 관심종목 id 형식: "KR:005930" | "US:AAPL.O"
 */

const REFRESH = { quotes: 5000, indices: 5000, investor: 60000, news: 90000 };

const DEFAULT_WATCHLIST = [
  { id: 'KR:005930', name: '삼성전자' },
  { id: 'KR:000660', name: 'SK하이닉스' },
  { id: 'KR:035420', name: 'NAVER' },
  { id: 'US:AAPL.O', name: '애플' },
  { id: 'US:TSLA.O', name: '테슬라' },
  { id: 'US:NVDA.O', name: '엔비디아' },
];

const $ = (sel) => document.querySelector(sel);

const state = {
  watchlist: loadWatchlist(),
  quotes: new Map(),        // id -> quote
  selectedId: null,
  newsTab: 'main',
  detailTab: 'orderbook',
  view: localStorage.getItem('view-v1') || 'table',
  lastOk: true,
};

/* ── storage ─────────────────────────── */
function loadWatchlist() {
  try {
    const raw = localStorage.getItem('watchlist-v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 구버전은 'KR:005930' 문자열만 저장했다. 항목 형태를 하나로 맞추고 못 쓰는 건 버린다.
        const norm = parsed.map((x) => (typeof x === 'string' ? { id: x, name: x.replace(/^[A-Z]+:/, '') } : x))
          .filter((x) => x && typeof x.id === 'string' && /^(KR|US):/.test(x.id))
          .map((x) => ({ ...x, name: typeof x.name === 'string' && x.name ? x.name : x.id.slice(3) }));
        return norm; // 빈 배열은 '전부 지운 상태' 존중
      }
    }
  } catch {}
  // 첫 방문이면 기본 목록을 즉시 저장한다 — /flow 등 다른 화면도 같은 목록을 읽기 때문
  const defaults = [...DEFAULT_WATCHLIST];
  try { localStorage.setItem('watchlist-v1', JSON.stringify(defaults)); } catch {}
  return defaults;
}
function saveWatchlist() {
  localStorage.setItem('watchlist-v1', JSON.stringify(state.watchlist));
}

/* ── fetch helper ────────────────────── */
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

/* 출처별 성패를 따로 기억한다. 한 함수를 지수·시세가 번갈아 부르면 마지막 호출이 이겨서,
 * 시세가 계속 실패해도 5초마다 지수 성공이 덮어써 장애가 보이지 않았다(상태점 플래핑). */
const okBy = {};
function markUpdated(ok, src = 'main') {
  okBy[src] = ok;
  ok = Object.values(okBy).every(Boolean);   // 하나라도 실패면 실패
  state.lastOk = ok;
  const dot = $('#statusDot');
  dot.classList.toggle('error', !ok);
  if (ok) {
    dot.classList.remove('pulse');
    void dot.offsetWidth; // 애니메이션 재시작
    dot.classList.add('pulse');
    document.body.classList.remove('stale');
    $('#lastUpdated').textContent = `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
  } else {
    document.body.classList.add('stale');
    $('#lastUpdated').textContent = '연결 오류 — 재시도 중';
  }
}

/* ── formatters ──────────────────────── */
const fmtKR = new Intl.NumberFormat('ko-KR');
const fmtUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtPrice(q) {
  if (q.currency === 'USD') return `$${fmtUS.format(q.price)}`;
  return fmtKR.format(q.price);
}
function fmtChange(q) {
  const sign = q.change > 0 ? '+' : q.change < 0 ? '−' : '';
  const abs = Math.abs(q.change);
  const body = q.currency === 'USD' ? fmtUS.format(abs) : fmtKR.format(abs);
  return sign + body;
}
function fmtPct(pct) {
  if (pct == null || isNaN(pct)) return '—';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}
function moveClass(v) { return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'; }
function fmtVolume(v) {
  if (v == null) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '만';
  return fmtKR.format(v);
}
function fmtEok(v) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${fmtKR.format(Math.round(Math.abs(v)))}억`;
}
function marketStateLabel(s) {
  return { OPEN: '장중', CLOSED: '장마감', PRE: '장전', POST: '장후' }[s] || '';
}

/* ── indices ─────────────────────────── */
async function refreshIndices() {
  try {
    const data = await api('/api/overview');
    const strip = $('#indexStrip');
    strip.innerHTML = data.indices.map((ix) => {
      const cls = moveClass(ix.change);
      const value = ix.currency === 'KRW' && ix.kind === 'fx'
        ? fmtKR.format(ix.value) + '원'
        : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(ix.value);
      const st = marketStateLabel(ix.marketState);
      return `
        <div class="index-card">
          <div class="idx-name">${ix.name}${st ? ` <span class="idx-state">${st}</span>` : ''}</div>
          <div class="idx-value num">${value}</div>
          <div class="idx-change ${cls}">${fmtChange({ change: ix.change, currency: 'IDX' })} (${fmtPct(ix.changePct)})</div>
        </div>`;
    }).join('');
    markUpdated(true, 'indices');
  } catch (e) {
    console.warn('indices', e);
    markUpdated(false, 'indices');
  }
}

/* ── watchlist quotes ────────────────── */
async function refreshQuotes() {
  if (!state.watchlist.length) { renderQuotes(); return; }
  const ids = state.watchlist.map((w) => w.id).join(',');
  try {
    const data = await api(`/api/quotes?ids=${encodeURIComponent(ids)}`);
    for (const q of data.quotes) state.quotes.set(q.id, q);
    renderQuotes();
    if (state.view === 'card') {
      renderCards();
      // 10분 TTL 은 여기서만 발동한다 — 만료된 프로필이 없으면 즉시 false
      loadProfiles().then((fetched) => { if (fetched && state.view === 'card') renderCards(); });
    }
    markUpdated(true, 'quotes');
  } catch (e) {
    console.warn('quotes', e);
    markUpdated(false, 'quotes');
  }
}

function renderQuotes() {
  const body = $('#quotesBody');
  if (!state.watchlist.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">관심종목이 없어요. 위에서 검색해서 추가해 보세요.</td></tr>';
    return;
  }
  body.innerHTML = state.watchlist.map((w) => {
    const q = state.quotes.get(w.id);
    const type = w.id.startsWith('KR') ? 'kr' : 'us';
    const badge = `<span class="badge ${type}">${type === 'kr' ? '국내' : '미국'}</span>`;
    const sel = state.selectedId === w.id ? ' class="selected"' : '';
    if (!q) {
      return `<tr data-id="${w.id}"${sel} draggable="true">
        <td class="al"><span class="q-name">${badge}${w.name}</span></td>
        <td class="ar flat" colspan="4">…</td>
        <td class="ac"><button class="remove-btn" data-remove="${w.id}" title="삭제">✕</button></td>
      </tr>`;
    }
    const cls = moveClass(q.change);
    const st = q.marketState && q.marketState !== 'OPEN' ? ` <span class="q-sub">${marketStateLabel(q.marketState)}</span>` : '';
    // 정규장 밖 가격 — 미국은 프리/애프터마켓, 국내는 NXT. 통화에 맞게 표기한다
    const ext = q.extPrice
      ? `<span class="q-ext ${moveClass(q.extPct)}">${
          q.currency === 'USD' ? '$' + fmtUS.format(q.extPrice) : 'NXT ' + fmtKR.format(q.extPrice)
        } ${fmtPct(q.extPct)}</span>`
      : '';
    return `<tr data-id="${w.id}"${sel} draggable="true">
      <td class="al"><span class="q-name">${badge}${q.name || w.name}${st}</span></td>
      <td class="ar num"><strong>${fmtPrice(q)}</strong>${ext}</td>
      <td class="ar num ${cls}">${fmtChange(q)}</td>
      <td class="ar num ${cls}">${fmtPct(q.changePct)}</td>
      <td class="ar num">${fmtVolume(q.volume)}</td>
      <td class="ac"><button class="remove-btn" data-remove="${w.id}" title="삭제">✕</button></td>
    </tr>`;
  }).join('');
}

/* ── 삭제 + 실행취소 ──
 * 22×19px 버튼을 빗나가게 눌러도 되돌릴 수 있어야 한다.
 * 잃는 게 종목 하나가 아니라 드래그로 맞춘 '순서 위치'까지라 undo가 필요하다. */
let lastRemoved = null;   // { item, index }
let undoTimer = null;

function removeStock(id) {
  const index = state.watchlist.findIndex((w) => w.id === id);
  if (index < 0) return;
  lastRemoved = { item: state.watchlist[index], index };
  state.watchlist.splice(index, 1);
  state.quotes.delete(id);
  if (state.selectedId === id) clearSelection();
  saveWatchlist();
  renderQuotes();
  if (state.view === 'card') renderCards();
  showUndoToast(lastRemoved.item.name);
}

function showUndoToast(name) {
  clearTimeout(undoTimer);
  let t = $('#undoToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'undoToast';
    document.body.appendChild(t);
    t.addEventListener('click', (e) => {
      if (!e.target.closest('.undo-btn') || !lastRemoved) return;
      state.watchlist.splice(Math.min(lastRemoved.index, state.watchlist.length), 0, lastRemoved.item);
      lastRemoved = null;
      saveWatchlist();
      renderQuotes();
      if (state.view === 'card') renderCards();
      refreshQuotes();
      t.classList.remove('on');
    });
  }
  t.innerHTML = `<span>${escapeHtml(name)} 삭제됨</span><button class="undo-btn">되돌리기</button>`;
  t.classList.add('on');
  undoTimer = setTimeout(() => { t.classList.remove('on'); lastRemoved = null; }, 6000);
}

/* ── 드래그로 순서 바꾸기 ──
 * 표·카드 양쪽에 같은 로직을 붙인다. 순서는 관심종목 배열 자체를 바꿔 localStorage에 저장된다.
 * 드래그 직후 click이 이어져 종목이 선택되는 걸 막으려고 플래그를 하나 둔다. */
let dragId = null;
let justDragged = false;

function enableDragReorder(container, itemSelector) {
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item) return;
    dragId = item.dataset.id;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);   // 파이어폭스는 데이터가 있어야 드래그가 시작된다
  });

  container.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest(itemSelector);
    container.querySelectorAll('.drop-before, .drop-after').forEach((x) =>
      x.classList.remove('drop-before', 'drop-after'));
    if (!over || over.dataset.id === dragId) return;

    // 카드 뷰는 그리드라 좌우, 표는 위아래로 판정한다
    const r = over.getBoundingClientRect();
    const isGrid = container.classList.contains('card-grid');
    const before = isGrid ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    over.classList.add(before ? 'drop-before' : 'drop-after');
  });

  container.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const over = e.target.closest(itemSelector);
    container.querySelectorAll('.drop-before, .drop-after').forEach((x) =>
      x.classList.remove('drop-before', 'drop-after'));
    if (!over || over.dataset.id === dragId) return;

    const from = state.watchlist.findIndex((w) => w.id === dragId);
    let to = state.watchlist.findIndex((w) => w.id === over.dataset.id);
    if (from < 0 || to < 0) return;

    const r = over.getBoundingClientRect();
    const isGrid = container.classList.contains('card-grid');
    const before = isGrid ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    if (!before) to += 1;
    if (from < to) to -= 1;             // 자기 자신을 빼낸 만큼 보정

    const [moved] = state.watchlist.splice(from, 1);
    state.watchlist.splice(to, 0, moved);
    saveWatchlist();
    justDragged = true;
    renderQuotes();
    if (state.view === 'card') renderCards();
  });

  container.addEventListener('dragend', () => {
    container.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((x) =>
      x.classList.remove('dragging', 'drop-before', 'drop-after'));
    dragId = null;
    // 드롭 직후의 click 한 번만 무시
    setTimeout(() => { justDragged = false; }, 0);
  });
}

/* ── 카드 뷰 ──
 * 시세(토스/네이버 폴링)에 프로필(시총·52주·목표가·PER·로고)을 얹어 큰 카드로 보여준다.
 * 프로필은 하루 단위로만 바뀌므로 서버에서 30분 캐싱된다. */
const profileCache = new Map();
const PROFILE_TTL = 10 * 60000;   // 페이지를 종일 켜두면 52주 범위·목표가가 어제 값으로 굳는다

async function loadProfiles() {
  const now = Date.now();
  const missing = state.watchlist.map((w) => w.id)
    .filter((id) => !profileCache.has(id) || now - profileCache.get(id).__at > PROFILE_TTL);
  if (!missing.length) return false;
  try {
    const { profiles } = await api(`/api/profiles?ids=${encodeURIComponent(missing.join(','))}`);
    for (const p of profiles) profileCache.set(p.id, { ...p, __at: Date.now() });
    return true;
  } catch (e) {
    console.warn('profiles', e);
    return false;
  }
}

/* 프로필은 30분 캐시라 그 안의 price 는 시세(5초 갱신)보다 낡다.
 * 시총·PER·PBR·상승여력을 그대로 쓰면 한 카드 안에서 현재가만 최신이고
 * 나머지는 30분 전 가격 기준이 된다 — 주당값(EPS·BPS·주식수)은 장중에 안 변하므로
 * 가격비만 곱해 같은 시점으로 맞춘다. */
function liveFacts(p, q) {
  if (!p) return null;
  const k = p.price && q?.price ? q.price / p.price : 1;
  return {
    marketCap: p.marketCap != null ? p.marketCap * k : null,
    per: p.per != null ? p.per * k : null,
    pbr: p.pbr != null ? p.pbr * k : null,
    upside: p.targetMean && q?.price ? (p.targetMean / q.price - 1) * 100 : p.targetUpside,
  };
}

function fmtCap(v) {
  if (!v) return '—';
  const jo = v / 1e12;
  if (jo >= 1) {
    const eok = Math.round((v % 1e12) / 1e8);
    return `${Math.floor(jo).toLocaleString('ko-KR')}조 ${eok.toLocaleString('ko-KR')}억`;
  }
  return `${Math.round(v / 1e8).toLocaleString('ko-KR')}억`;
}

function renderCards() {
  const grid = $('#cardGrid');
  if (!state.watchlist.length) {
    grid.innerHTML = '<div class="empty-card">관심종목이 없어요. 위에서 검색해서 추가해 보세요.</div>';
    return;
  }
  grid.innerHTML = state.watchlist.map((w) => {
    const q = state.quotes.get(w.id);
    const isKR = w.id.startsWith('KR:');
    const p = profileCache.get(w.id);
    const cls = q ? moveClass(q.change) : 'flat';
    const sel = state.selectedId === w.id ? ' selected' : '';
    const money = (v) => (isKR ? fmtKR.format(Math.round(v)) : `$${fmtUS.format(v)}`);

    // 범위 안에서 현재가 위치 — 국내는 52주(정확), 미국은 200일 캔들(대체). 라벨로 구분한다.
    const lf = liveFacts(p, q);   // 아래 목표가·PER·시총이 모두 이 값을 쓴다

    let rangeBar = '';
    if (p?.rangeLow && p?.rangeHigh && q && p.rangeHigh > p.rangeLow) {
      const t = Math.max(0, Math.min(100, ((q.price - p.rangeLow) / (p.rangeHigh - p.rangeLow)) * 100));
      rangeBar = `
        <div class="c-range">
          <div class="cr-label">${p.rangeLabel} 범위</div>
          <div class="cr-track"><div class="cr-dot" style="left:${t.toFixed(1)}%"></div></div>
          <div class="cr-ends">
            <span>${money(p.rangeLow)}</span>
            <span>${money(p.rangeHigh)}</span>
          </div>
        </div>`;
    }

    // 목표가 비교 — 미국은 최고 목표가까지 오므로 3단으로 그린다
    let target = '';
    if (p?.targetMean && q) {
      const rows = [
        { k: '현재가', v: q.price, cls: 'now' },
        { k: '평균 목표가', v: p.targetMean, cls: 'goal' },
        ...(p.targetHigh ? [{ k: '최고 목표가', v: p.targetHigh, cls: 'goal-high' }] : []),
      ];
      const max = Math.max(...rows.map((r) => r.v));
      target = `
        <div class="c-target">
          ${rows.map((r) => `
            <div class="ct-row">
              <span class="ct-k">${r.k}</span>
              <div class="ct-track"><div class="ct-bar ${r.cls}" style="width:${((r.v / max) * 100).toFixed(1)}%"></div></div>
              <span class="ct-v">${money(r.v)}</span>
            </div>`).join('')}
          <p class="ct-say">평균 목표가는 현재가보다 <b class="${lf.upside >= 0 ? 'up' : 'down'}">${fmtPct(lf.upside)}</b> ${lf.upside >= 0 ? '높아요' : '낮아요'}</p>
        </div>`;
    }

    // 시가총액 — 국내는 원 단위 숫자, 미국은 네이버가 완성된 문자열로 준다
    const capText = isKR ? fmtCap(lf?.marketCap)
      : (p?.marketCapKrwText ? `${p.marketCapKrwText}` : p?.marketCapText || '—');

    return `
      <div class="scard${sel}" data-id="${w.id}" draggable="true">
        <div class="c-head">
          ${p?.logo ? `<img class="c-logo" src="${p.logo}" alt="" loading="lazy">` : `<span class="c-logo ph">${isKR ? '국내' : '미국'}</span>`}
          <div class="c-title">
            <span class="c-name">${escapeHtml(q?.name || w.name)}</span>
            <span class="c-code">${escapeHtml(w.id.slice(3))}</span>
          </div>
          <button class="remove-btn card-rm" data-remove="${w.id}" title="삭제">✕</button>
        </div>

        ${q ? `
        <div class="c-state ${q.marketState === 'OPEN' ? 'live' : ''}">${marketStateLabel(q.marketState) || '시세'}</div>
        <div class="c-price ${cls}">${fmtPrice(q)}<span class="c-unit">${q.currency === 'USD' ? '' : '원'}</span></div>
        <div class="c-change ${cls}">
          ${q.change > 0 ? '▲' : q.change < 0 ? '▼' : '−'} ${fmtChange(q).replace(/^[+−]/, '')} <span class="c-sep">|</span> ${fmtPct(q.changePct)}
        </div>` : '<div class="c-price flat">…</div>'}

        ${p ? `
        <div class="c-facts">
          <div class="cf-row"><span>시가총액</span><b>${capText}</b></div>
          ${lf?.per ? `<div class="cf-row"><span>PER · PBR</span><b>${lf.per.toFixed(1)} · ${lf.pbr ? lf.pbr.toFixed(2) : '—'}</b></div>` : ''}
        </div>
        ${rangeBar}
        ${target}` : ''}
      </div>`;
  }).join('');
}

$('#viewToggle').addEventListener('click', async (e) => {
  const b = e.target.closest('.vt');
  if (!b || b.dataset.view === state.view) return;
  state.view = b.dataset.view;
  document.querySelectorAll('.vt').forEach((x) => x.classList.toggle('active', x === b));
  $('#cardGrid').hidden = state.view !== 'card';
  $('#tableWrap').hidden = state.view === 'card';
  localStorage.setItem('view-v1', state.view);
  if (state.view === 'card') { renderCards(); await loadProfiles(); renderCards(); }
});

$('#cardGrid').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { removeStock(rm.dataset.remove); return; }
  if (justDragged) return;              // 순서만 바꾼 것이지 선택한 게 아니다
  const card = e.target.closest('.scard');
  if (card) selectStock(card.dataset.id);
});

enableDragReorder($('#cardGrid'), '.scard');

$('#quotesBody').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { removeStock(rm.dataset.remove); return; }
  if (justDragged) return;              // 순서만 바꾼 것이지 선택한 게 아니다
  const row = e.target.closest('tr[data-id]');
  if (row) selectStock(row.dataset.id);
});

enableDragReorder($('#quotesBody'), 'tr[data-id]');

/* ── selection → detail + stock news ─── */
function clearSelection() {
  state.selectedId = null;
  $('#detailPanel').hidden = true;
  const tab = $('#stockNewsTab');
  tab.disabled = true;
  tab.textContent = '종목 뉴스';
  if (state.newsTab === 'stock') switchNewsTab('main');
}

async function selectStock(id, { scroll = true } = {}) {
  state.selectedId = id;
  renderQuotes();
  const w = state.watchlist.find((x) => x.id === id);
  const q = state.quotes.get(id);
  const name = (q && q.name) || (w && w.name) || id;

  $('#detailPanel').hidden = false;
  // 1열 스택 모드에선 상세 패널이 화면 밖일 수 있다 — 직접 선택했을 때만 스크롤
  // (자동 첫 선택이 페이지를 끌어내리면 안 되고, 폭 0으로 로드되는 환경도 방어)
  if (scroll && window.innerWidth > 0 && window.innerWidth <= 980) {
    $('#detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#detailName').textContent = name;
  $('#detailPrice').innerHTML = q
    ? `<span>${fmtPrice(q)}</span><span class="dp-change ${moveClass(q.change)}">${fmtChange(q)} (${fmtPct(q.changePct)})</span>`
    : '';

  const tab = $('#stockNewsTab');
  tab.disabled = false;
  tab.textContent = `${name} 뉴스`;
  switchNewsTab('stock');

  // 미국 종목은 국내 전용 지표(수급·공매도 등)가 없어 탭을 잠근다. 호가는 미국도 되므로 예외.
  const isKR = id.startsWith('KR:');
  document.querySelectorAll('#detailTabs .tab').forEach((b) => {
    const locked = !isKR && b.dataset.dtab !== 'orderbook';
    b.disabled = locked;
    // 잠긴 이유를 말해준다 — disabled는 클릭이 무시돼 안내 문구에 도달할 수 없다
    b.title = locked ? '미국 종목은 국내 수급·공매도 지표가 제공되지 않아요' : '';
  });
  // 종목을 바꿔도 보던 탭을 유지한다 (미국 종목은 호가만 가능하므로 예외)
  state.detailTab = isKR ? (localStorage.getItem('detailTab-v1') || 'orderbook') : 'orderbook';
  syncDetailTabs();
  renderDetailTab();
}

/* ── detail panel tabs ───────────────── */
function syncDetailTabs() {
  document.querySelectorAll('#detailTabs .tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.dtab === state.detailTab));
}

// 오류 화면의 "다시 시도" — 현재 탭을 다시 그린다
$('#invDailyWrap').addEventListener('click', (e) => {
  if (e.target.closest('.retry-btn')) renderDetailTab();
});

$('#detailTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn || btn.disabled) return;   // 같은 탭 재클릭 허용 — 실패한 탭의 재시도 경로
  state.detailTab = btn.dataset.dtab;
  localStorage.setItem('detailTab-v1', btn.dataset.dtab);
  syncDetailTabs();
  renderDetailTab();
});

async function renderDetailTab() {
  const id = state.selectedId;
  if (!id) return;
  const wrap = $('#invDailyWrap');
  const hint = $('#detailHint');

  // 호가 탭을 떠나면 폴링을 반드시 멈춘다
  if (state.detailTab !== 'orderbook') stopOrderbookPolling();

  // 호가는 미국 종목도 지원하므로 국내 전용 차단보다 먼저 처리
  if (state.detailTab === 'orderbook') {
    wrap.innerHTML = '<div class="inv-empty">불러오는 중…</div>';
    try {
      return await renderOrderbookTab(id, wrap, hint);
    } catch (e) {
      console.warn('orderbook', e);
      wrap.innerHTML = '<div class="inv-empty">호가를 불러오지 못했어요 <button class="retry-btn">다시 시도</button></div>';
      return;
    }
  }

  if (!id.startsWith('KR:')) {
    wrap.innerHTML = '<div class="inv-empty">미국 종목은 국내 수급·공매도 지표가 제공되지 않아요</div>';
    hint.textContent = '';
    return;
  }
  const code = id.slice(3);
  const tab = state.detailTab;
  wrap.innerHTML = '<div class="inv-empty">불러오는 중…</div>';

  try {
    if (tab === 'investor') return await renderInvestorTab(id, code, wrap, hint);
    return await renderMetricTab(id, code, tab, wrap, hint);
  } catch (e) {
    console.warn('detail', tab, e);
    if (state.selectedId === id && state.detailTab === tab) {
      wrap.innerHTML = '<div class="inv-empty">데이터를 불러오지 못했어요 <button class="retry-btn">다시 시도</button></div>';
      hint.textContent = '';
    }
  }
}

async function renderInvestorTab(id, code, wrap, hint) {
  {
    const data = await api(`/api/investor/stock/${encodeURIComponent(code)}`);
    if (state.selectedId !== id || state.detailTab !== 'investor') return; // 그새 바뀜
    if (!data.days.length) {
      wrap.innerHTML = '<div class="inv-empty">수급 데이터 없음</div>';
      return;
    }
    // 토스는 개인·연기금까지 주고, 네이버는 종가·등락률을 주므로 컬럼이 다르다
    const cols = data.source === 'toss'
      ? [
          { th: '개인', get: (d) => d.individual },
          { th: '외국인', get: (d) => d.foreign },
          { th: '기관', get: (d) => d.institution },
          { th: '연기금', get: (d) => d.pensionFund },
        ]
      : [
          { th: '외국인', get: (d) => d.foreign },
          { th: '기관', get: (d) => d.institution },
        ];

    const head = data.source === 'toss'
      ? `<th class="al">날짜</th>${cols.map((c) => `<th class="ar">${c.th}</th>`).join('')}`
      : `<th class="al">날짜</th><th class="ar">종가</th><th class="ar">등락률</th>${cols.map((c) => `<th class="ar">${c.th}</th>`).join('')}`;

    const rows = data.days.slice(0, 10).map((d) => {
      const lead = data.source === 'toss'
        ? `<td class="al">${d.date}</td>`
        : `<td class="al">${d.date}</td><td class="ar num">${fmtKR.format(d.close)}</td><td class="ar num ${moveClass(d.changePct)}">${fmtPct(d.changePct)}</td>`;
      const cells = cols.map((c) => {
        const v = c.get(d);
        return `<td class="ar num ${moveClass(v)}">${fmtShares(v)}</td>`;
      }).join('');
      return `<tr>${lead}${cells}</tr>`;
    }).join('');

    wrap.innerHTML = `<table class="inv-daily"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;

    const holdRate = data.days.find((d) => d.foreignHoldRate != null)?.foreignHoldRate;
    const src = data.source === 'toss' ? '토스증권 Open API' : '네이버 금융';
    hint.textContent = [
      `일별 순매수 수량(주) · 출처 ${src}`,
      holdRate != null ? `외국인 보유율 ${holdRate.toFixed(2)}%` : null,
      data.note,
    ].filter(Boolean).join(' · ');
  }
}

/* ── 호가창 ──
 * 국내 관례대로 매도호가가 위(파랑), 매수호가가 아래(빨강).
 * 막대 길이 = 잔량. 매도벽/매수벽이 어디 쌓였는지 눈으로 보라고 만든 화면이다.
 * 유일하게 초 단위로 바뀌는 데이터라 장중에만 자동 갱신한다. */
let obTimer = null;

/* 세대 번호. 종목을 빠르게 두 번 바꾸면 첫 호출이 `await draw()` 에서 자고 있다가
 * 뒤늦게 깨어나 **이미 지나간 종목의** 인터벌을 obTimer 에 덮어썼다.
 * 그러면 앞 인터벌은 참조를 잃어 영원히 살아남고(좀비), 그 좀비가 2초 뒤
 * "내 종목이 아니네" 하며 stopOrderbookPolling() 을 불러 **현재 종목의 타이머**를 죽였다.
 * 증상은 '호가가 갑자기 안 움직임'인데 오류가 없어서 원인을 알 수 없었다. */
let obSeq = 0;

function stopOrderbookPolling() {
  if (obTimer) { clearInterval(obTimer); obTimer = null; }
}

// 국내 정규장(09:00~15:30 KST)인지 — 장 끝나면 굳이 계속 긁지 않는다
function isKRMarketOpen() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();
  if (day === 0 || day === 6) return false;
  const min = kst.getHours() * 60 + kst.getMinutes();
  return min >= 540 && min <= 930;
}

async function renderOrderbookTab(id, wrap, hint) {
  const seq = ++obSeq;
  stopOrderbookPolling();

  const draw = async () => {
    // 그새 다른 탭/종목으로 옮겨갔으면 중단.
    // 단, 내 세대가 아니면 남의 타이머는 건드리지 않는다 — 그게 좀비가 현재 폴링을 죽이던 경로다.
    if (seq !== obSeq) return;
    if (state.selectedId !== id || state.detailTab !== 'orderbook') { stopOrderbookPolling(); return; }
    let d;
    try {
      d = await api(`/api/orderbook/${encodeURIComponent(id)}`);
    } catch (e) {
      stopOrderbookPolling();
      wrap.innerHTML = '<div class="inv-empty">호가를 불러오지 못했어요 <button class="retry-btn">다시 시도</button></div>';
      return;
    }
    if (state.selectedId !== id || state.detailTab !== 'orderbook') return;
    if (d.unavailable) {
      wrap.innerHTML = '<div class="inv-empty">토스증권 API 키가 필요해요</div>';
      stopOrderbookPolling();
      return;
    }
    if (!d.asks?.length && !d.bids?.length) {
      wrap.innerHTML = '<div class="inv-empty">호가 정보가 없어요 (장 시작 전이거나 거래정지)</div>';
      return;
    }

    const isUSD = d.currency === 'USD';
    const fmtP = (v) => (isUSD ? `$${fmtUS.format(v)}` : fmtKR.format(v));
    const maxVol = Math.max(...[...d.asks, ...d.bids].map((x) => x.volume), 1);
    const askTotal = d.asks.reduce((a, b) => a + b.volume, 0);
    const bidTotal = d.bids.reduce((a, b) => a + b.volume, 0);

    // 매도는 높은 가격이 위로 오게 뒤집는다 (호가창 관례)
    const askRows = [...d.asks].reverse().map((x) => obRow(x, 'ask', maxVol, fmtP));
    const bidRows = d.bids.map((x) => obRow(x, 'bid', maxVol, fmtP));

    const spread = d.asks[0] && d.bids[0] ? d.asks[0].price - d.bids[0].price : null;
    const ratio = bidTotal + askTotal ? (bidTotal / (bidTotal + askTotal)) * 100 : 50;

    wrap.innerHTML = `
      <div class="ob">
        ${askRows.join('')}
        <div class="ob-mid">
          <span class="ob-spread">스프레드 ${spread != null ? fmtP(spread) : '—'}</span>
        </div>
        ${bidRows.join('')}
      </div>
      <div class="ob-totals">
        <div class="ob-tbar">
          <div class="ob-tfill bid" style="width:${ratio.toFixed(1)}%"></div>
        </div>
        <div class="ob-tnums">
          <span class="up">매수 ${fmtVolume(bidTotal)}</span>
          <span class="ob-tratio">${ratio.toFixed(0)} : ${(100 - ratio).toFixed(0)}</span>
          <span class="down">매도 ${fmtVolume(askTotal)}</span>
        </div>
      </div>`;

    const t = d.timestamp ? new Date(d.timestamp).toLocaleTimeString('en-GB', { hour12: false }) : '';
    hint.textContent = `총잔량 비율은 10단계 합계 기준 · ${t} 기준${isKRMarketOpen() ? ' · 2초마다 갱신' : ' · 장 마감 (갱신 중지)'}`;
  };

  await draw();
  // 자는 사이에 다른 종목으로 넘어갔으면 타이머를 아예 걸지 않는다 (좀비 생성 차단)
  if (seq !== obSeq) return;
  // 장중에만 폴링. 장외에는 안 움직이는 숫자를 긁을 이유가 없다.
  if (isKRMarketOpen() && id.startsWith('KR:')) {
    stopOrderbookPolling();          // 덮어쓰기 전에 반드시 회수한다
    obTimer = setInterval(draw, 2000);
  }
}

function obRow(x, side, maxVol, fmtP) {
  const w = (x.volume / maxVol) * 100;
  return `
    <div class="ob-row ${side}">
      <span class="ob-vol">${side === 'bid' ? '' : fmtVolume(x.volume)}</span>
      <span class="ob-price">${fmtP(x.price)}</span>
      <span class="ob-vol">${side === 'bid' ? fmtVolume(x.volume) : ''}</span>
      <div class="ob-bar ${side}" style="width:${w.toFixed(1)}%"></div>
    </div>`;
}

/* 공매도·프로그램·신용·대차 — 4종 모두 한 번에 받아와 서버에서 10분 캐싱된다 */
const METRIC_VIEWS = {
  short: {
    rows: (m) => m.shortSelling,
    cols: [
      { th: '공매도량', get: (r) => fmtQty(r.volume), cls: () => '' },
      { th: '비중', get: (r) => (r.volumeRate != null ? r.volumeRate.toFixed(2) + '%' : '—'), cls: () => '' },
      { th: '금액', get: (r) => fmtWon(r.amount), cls: () => '' },
    ],
    hint: '공매도 비중 = 그날 전체 거래량 대비 공매도 비율. 높을수록 하락 베팅이 많았다는 뜻.',
  },
  program: {
    rows: (m) => m.program,
    cols: [
      { th: '차익', get: (r) => fmtShares(r.arbitrage), cls: (r) => moveClass(r.arbitrage) },
      { th: '비차익', get: (r) => fmtShares(r.nonArbitrage), cls: (r) => moveClass(r.nonArbitrage) },
      { th: '합계', get: (r) => fmtShares(r.total), cls: (r) => moveClass(r.total) },
    ],
    hint: '프로그램 순매수(주). 비차익이 기관 바스켓 매매 흐름에 가깝다.',
  },
  credit: {
    rows: (m) => m.credit,
    cols: [
      { th: '융자잔고', get: (r) => fmtQty(r.loanBalance), cls: () => '' },
      { th: '신규', get: (r) => fmtQty(r.loanNew), cls: () => '' },
      { th: '상환', get: (r) => fmtQty(r.loanReturn), cls: () => '' },
    ],
    hint: '융자잔고 = 빚내서 매수한 채 남아있는 물량(주). 급증 후 하락하면 반대매매 압력이 된다.',
  },
  lending: {
    rows: (m) => m.lending,
    cols: [
      { th: '잔고', get: (r) => fmtQty(r.balance), cls: () => '' },
      { th: '체결', get: (r) => fmtQty(r.execution), cls: () => '' },
      { th: '상환', get: (r) => fmtQty(r.repayment), cls: () => '' },
    ],
    hint: '대차잔고 = 빌려간 채 안 갚은 주식(주). 공매도 대기 물량으로 읽힌다.',
  },
};

async function renderMetricTab(id, code, tab, wrap, hint) {
  const m = await api(`/api/metrics/${encodeURIComponent(code)}`);
  if (state.selectedId !== id || state.detailTab !== tab) return;
  if (m.unavailable) {
    wrap.innerHTML = '<div class="inv-empty">토스증권 API 키가 있어야 볼 수 있어요<br><span style="font-size:var(--fs-2xs)">.env에 TOSS_CLIENT_ID / SECRET 설정</span></div>';
    hint.textContent = '';
    return;
  }
  const view = METRIC_VIEWS[tab];
  const rows = view.rows(m) || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="inv-empty">데이터 없음</div>';
    hint.textContent = '';
    return;
  }
  const head = `<th class="al">날짜</th>${view.cols.map((c) => `<th class="ar">${c.th}</th>`).join('')}`;
  const body = rows.slice(0, 10).map((r) => `
    <tr>
      <td class="al">${r.date ? r.date.slice(5).replace('-', '/') : ''}</td>
      ${view.cols.map((c) => `<td class="ar num ${c.cls(r)}">${c.get(r)}</td>`).join('')}
    </tr>`).join('');

  wrap.innerHTML = `<table class="inv-daily"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  hint.textContent = `${view.hint} · 출처 토스증권 Open API`;
}

// 잔고·거래량처럼 방향성 없는 수량 (부호 없이)
function fmtQty(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(1)}만`;
  return fmtKR.format(abs);
}

// 억/조 단위 원화
function fmtWon(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + '조';
  if (abs >= 1e8) return Math.round(v / 1e8).toLocaleString('ko-KR') + '억';
  return fmtKR.format(v);
}

function fmtShares(v) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const abs = Math.abs(v);
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}만`;
  return `${sign}${fmtKR.format(abs)}`;
}

/* ── market investor flows ───────────── */
async function refreshInvestor() {
  try {
    const data = await api('/api/investor/market');
    const wrap = $('#investorMarket');

    // 세력 좌표의 판정 한 줄을 여기 얹는다 — 결론(여기) → 근거(/flow)로 잇는 다리
    let verdictHtml = '';
    try {
      const fv = await api('/api/flow/market?market=KOSPI');
      if (fv?.verdict?.headline) {
        verdictHtml = `<a class="inv-verdict" href="/flow">${escapeHtml(fv.verdict.headline)}<span class="iv-more">근거 보기 →</span></a>`;
      }
    } catch {}
    if (!data.markets.length) {
      wrap.innerHTML = '<div class="inv-empty">수급 데이터 없음</div>';
      return;
    }
    const maxAbs = Math.max(1, ...data.markets.flatMap((m) => [m.individual, m.foreign, m.institution].map((v) => Math.abs(v || 0))));
    wrap.innerHTML = verdictHtml + data.markets.map((m) => {
      // 토스를 쓸 때만 기관 세부분류가 들어온다
      const bd = (m.breakdown || []).filter((b) => b.value != null);
      const bdMax = Math.max(1, ...bd.map((b) => Math.abs(b.value)));
      const detail = bd.length ? `
        <details class="inv-detail">
          <summary>기관 세부 ${bd.length}종</summary>
          ${bd.map((b) => invRow(b.label, b.value, bdMax, true)).join('')}
        </details>` : '';
      return `
      <div class="inv-market">
        <h3>${m.market}<span class="inv-asof">${m.asOf || ''}</span></h3>
        ${invRow('개인', m.individual, maxAbs)}
        ${invRow('외국인', m.foreign, maxAbs)}
        ${invRow('기관', m.institution, maxAbs)}
        ${m.otherCorp != null ? invRow('기타법인', m.otherCorp, maxAbs) : ''}
        ${detail}
      </div>`;
    }).join('');
    const src = data.source === 'toss' ? '토스증권' : '네이버';
    $('#investorNote').textContent = `${data.provisional ? '장중 잠정치' : '확정치'} · ${data.unit || '억원'} · ${src}`;
  } catch (e) {
    console.warn('investor/market', e);
    $('#investorMarket').innerHTML = '<div class="inv-empty">수급 데이터를 불러오지 못했어요</div>';
  }
}

function invRow(label, value, maxAbs, small = false) {
  const v = value || 0;
  const widthPct = Math.min(50, (Math.abs(v) / maxAbs) * 50);
  const bar = v === 0 ? '' : `<div class="inv-bar ${v > 0 ? 'pos' : 'neg'}" style="width:${widthPct}%"></div>`;
  return `
    <div class="inv-row${small ? ' inv-row-sm' : ''}">
      <span class="inv-label">${label}</span>
      <div class="inv-bar-track">${bar}</div>
      <span class="inv-amount ${moveClass(v)}">${fmtEok(v)}</span>
    </div>`;
}

/* ── 해외 선물 환산가 (김프) ──
 * Hyperliquid 한국주식 무기한선물($) × 업비트 USDT/KRW = 원화 환산가.
 * 선물은 24시간 거래라 장 마감 후·주말에 국내 시세의 유일한 실시간 힌트가 된다.
 *
 * 비교 기준을 사용자가 고를 수 있게 한다 — 같은 선물 가격이라도 장중가와 비교하느냐
 * 전일 종가와 비교하느냐에 따라 프리미엄이 2~3%p씩 달라진다. 주말엔 특히 그렇다.
 *
 * 펀딩비는 시간당 값이라 소수 2자리로 찍으면 전부 "−0.00%"가 된다(실제로 그랬다).
 * 연율로 환산해야 "숏이 롱에 연 76%를 지급 중"이라는 정보가 보인다. */

// 달러 금액을 M/B 단위로 — 미결제약정은 자릿수가 커서 그대로 쓰면 안 읽힌다
function fmtUsdM(v) {
  if (v == null || isNaN(v)) return '—';
  return v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${(v / 1e3).toFixed(0)}K`;
}

async function refreshGap() {
  const body = $('#gapBody');
  try {
    const d = await api('/api/gap');
    if (!d.rows?.length) { body.innerHTML = '<div class="inv-empty">데이터 없음</div>'; return; }

    // 어떤 기준이 실제로 존재하는지는 시간대마다 다르다 (NXT는 08~20시만 열린다)
    const available = ['auto', ...new Set(d.rows.flatMap((r) => r.bases.map((b) => b.key)))];
    // 저장된 기준이 지금 시간대에 없으면(밤에 저장한 NXT 를 낮에 읽는 등) 버튼이 하나도 켜지지 않았다 → 자동으로 취급
    const saved = localStorage.getItem('gap-basis-v1') || 'auto';
    const pref = available.includes(saved) ? saved : 'auto';
    const LABELS = { auto: '자동', live: '현재가', nxt: 'NXT', prev: '전일종가' };

    const picker = `<div class="gap-basis" id="gapBasis">`
      + available.map((k) => `<button class="gb ${k === pref ? 'active' : ''}" data-basis="${k}">${LABELS[k] || k}</button>`).join('')
      + `</div>`;

    const rows = d.rows.map((r) => {
      const b = pref === 'auto'
        ? r.bases.find((x) => x.key === r.defaultBasis) || r.bases[0]
        : r.bases.find((x) => x.key === pref) || r.bases.find((x) => x.key === r.defaultBasis) || r.bases[0];
      const g = b?.gapPct;
      const fa = r.fundingAnnualPct;
      return `
      <div class="gap-row">
        <span class="gap-name">${escapeHtml(r.name)}
          <span class="gap-sub">$${fmtUS.format(r.usd)} · 선물 24h <span class="${moveClass(r.hlChangePct)}">${fmtPct(r.hlChangePct)}</span></span>
        </span>
        <span class="gap-krw num">${fmtKR.format(r.krw)}<span class="gap-sub">원 환산</span></span>
        <span class="gap-sub">국내(${escapeHtml(b ? b.label : '?')}) ${b ? fmtKR.format(Math.round(b.price)) : '—'}</span>
        <span class="gap-badge prem" title="환산가가 국내 시세보다 ${g >= 0 ? '높음(프리미엄)' : '낮음(디스카운트)'}">${fmtPct(g)}</span>
        <span class="gap-meta">미결제 ${fmtUsdM(r.openInterestUsd)} · 24h거래 ${fmtUsdM(r.volUsd)}`
        + (fa != null ? ` · 펀딩 연 <span class="${moveClass(fa)}">${fa > 0 ? '+' : '−'}${Math.abs(fa).toFixed(0)}%</span>` : '')
        + `</span>
      </div>`;
    }).join('');

    const age = d.asOf ? Math.round((Date.now() - d.asOf) / 1000) : null;
    body.innerHTML = picker + rows
      + `<div class="gap-foot">USDT ${fmtKR.format(d.usdtKrw)}원 기준 환산 · 해외 선물이라 국내 시세와 다를 수 있음 · 참고용`
      + (age != null ? ` · ${age}초 전` : '') + `</div>`;

    const bx = $('#gapBasis');
    if (bx) bx.addEventListener('click', (e) => {
      const btn = e.target.closest('.gb');
      if (!btn) return;
      localStorage.setItem('gap-basis-v1', btn.dataset.basis);
      refreshGap();
    });
  } catch (e) {
    console.warn('gap', e);
    body.innerHTML = '<div class="inv-empty">환산가를 불러오지 못했어요 <button class="retry-btn" onclick="refreshGap()">다시 시도</button></div>';
  }
}

/* ── news ────────────────────────────── */
function switchNewsTab(tab) {
  state.newsTab = tab;
  // 탭 5개 중 3개는 뉴스가 아니라 랭킹 — 제목이 거짓말하지 않게
  const h2 = document.querySelector('#newsPanel .panel-head h2');
  if (h2) h2.textContent = RANKING_TABS[tab] ? '오늘의 랭킹' : '뉴스';
  document.querySelectorAll('#newsTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  refreshNews();
}

$('#newsTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn && !btn.disabled) switchNewsTab(btn.dataset.tab);
});

const RANKING_TABS = { gainers: '급상승', losers: '급하락', amount: '거래대금' };

/* 탭·종목을 빠르게 바꾸면 느린 옛 응답이 나중에 도착해 새 탭 내용을 덮어썼다.
 * 요청마다 번호를 매기고, 돌아왔을 때 최신이 아니면 버린다. */
let newsSeq = 0;

async function refreshNews() {
  const list = $('#newsList');
  const seq = ++newsSeq;

  // 랭킹 탭 — 뉴스 목록 자리를 그대로 쓰되 표로 그린다
  if (RANKING_TABS[state.newsTab]) {
    try {
      const d = await api(`/api/rankings/${state.newsTab}`);
      if (seq !== newsSeq) return;   // 그새 다른 탭으로 갔다
      if (d.unavailable) { list.innerHTML = '<li class="news-empty">토스증권 API 키가 필요해요</li>'; return; }
      if (!d.rows?.length) { list.innerHTML = '<li class="news-empty">랭킹 데이터 없음</li>'; return; }
      list.innerHTML = d.rows.map((r) => {
        const added = state.watchlist.some((w) => w.id === `KR:${r.symbol}`);
        return `
        <li class="rank-row">
          <span class="rk-no">${r.rank}</span>
          <span class="rk-name">${escapeHtml(r.name)}</span>
          <span class="rk-price num">${fmtKR.format(r.price)}</span>
          <span class="rk-chg num ${moveClass(r.changePct)}">${fmtPct(r.changePct)}</span>
          <span class="rk-amt num">${fmtWon(r.amount)}</span>
          <button class="rk-add" data-add-code="${r.symbol}" data-add-name="${escapeHtml(r.name)}"
            ${added ? 'disabled' : ''}>${added ? '추가됨' : '+ 관심'}</button>
        </li>`;
      }).join('');
    } catch (e) {
      console.warn('rankings', e);
      list.innerHTML = '<li class="news-empty">랭킹을 불러오지 못했어요</li>';
    }
    return;
  }

  try {
    let data;
    if (state.newsTab === 'stock' && state.selectedId) {
      data = await api(`/api/news/stock/${encodeURIComponent(state.selectedId)}`);
    } else {
      data = await api('/api/news/main');
    }
    if (seq !== newsSeq) return;     // 그새 다른 탭/종목으로 갔다
    if (!data.items.length) {
      list.innerHTML = '<li class="news-empty">뉴스가 없어요</li>';
      return;
    }
    list.innerHTML = data.items.slice(0, 12).map((n) => `
      <li>
        <a class="news-link" href="${n.url}" target="_blank" rel="noopener noreferrer">
          <span class="news-title">${escapeHtml(n.title)}</span>
          <span class="news-meta">${escapeHtml(n.press || '')}${n.datetime ? ' · ' + n.datetime : ''}</span>
        </a>
      </li>`).join('');
  } catch (e) {
    console.warn('news', e);
    list.innerHTML = '<li class="news-empty">뉴스를 불러오지 못했어요</li>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 랭킹에서 바로 관심종목에 담기
$('#newsList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add-code]');
  if (!btn || btn.disabled) return;
  const id = `KR:${btn.dataset.addCode}`;
  if (state.watchlist.some((w) => w.id === id)) return;
  state.watchlist.push({ id, name: btn.dataset.addName });
  saveWatchlist();
  btn.disabled = true;
  btn.textContent = '추가됨';
  renderQuotes();
  refreshQuotes();
});

/* ── search ──────────────────────────── */
const searchInput = $('#searchInput');
const searchResults = $('#searchResults');
let searchTimer = null;
let searchSeq = 0;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { searchResults.hidden = true; return; }
  searchTimer = setTimeout(() => runSearch(q), 250);
});

// 방향키로 고르고 Enter로 추가 — 타이핑하던 손을 마우스로 옮기지 않아도 된다
let searchIdx = -1;

function highlightSearchItem(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === searchIdx));
  if (searchIdx >= 0) items[searchIdx]?.scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchResults.hidden = true; searchInput.blur(); return; }
  if (searchResults.hidden) return;
  const items = [...searchResults.querySelectorAll('.search-item:not([disabled])')];
  if (!items.length) return;

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchIdx = e.key === 'ArrowDown'
      ? (searchIdx + 1) % items.length
      : (searchIdx - 1 + items.length) % items.length;
    highlightSearchItem(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (items[searchIdx] || items[0]).click();   // 선택 없이 Enter면 첫 항목
    searchIdx = -1;
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) searchResults.hidden = true;
});

async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return; // 오래된 응답 무시
    if (!data.results.length) {
      searchResults.innerHTML = '<div class="search-empty">검색 결과 없음</div>';
    } else {
      searchResults.innerHTML = data.results.slice(0, 8).map((r) => {
        const added = state.watchlist.some((w) => w.id === r.id);
        const type = r.id.startsWith('KR') ? 'kr' : 'us';
        return `<button class="search-item" data-add="${r.id}" data-name="${escapeHtml(r.name)}" ${added ? 'disabled' : ''}>
          <span class="badge ${type}">${type === 'kr' ? '국내' : '미국'}</span>
          <span>${escapeHtml(r.name)}</span>
          <span class="si-code">${escapeHtml(r.code)}${r.market ? ' · ' + escapeHtml(r.market) : ''}</span>
          ${added ? '<span class="si-added">추가됨</span>' : ''}
        </button>`;
      }).join('');
    }
    searchResults.hidden = false;
    searchIdx = -1;                           // 새 결과 — 키보드 선택 초기화
  } catch (e) {
    console.warn('search', e);
  }
}

searchResults.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn || btn.disabled) return;
  state.watchlist.push({ id: btn.dataset.add, name: btn.dataset.name });
  saveWatchlist();
  searchResults.hidden = true;
  searchInput.value = '';
  renderQuotes();
  refreshQuotes();
});

/* ── boot ────────────────────────────── */
function startPolling(fn, ms) {
  fn();
  setInterval(() => { if (!document.hidden) fn(); }, ms);
}

// 저장된 뷰 복원
if (state.view === 'card') {
  document.querySelectorAll('.vt').forEach((x) => x.classList.toggle('active', x.dataset.view === 'card'));
  $('#cardGrid').hidden = false;
  $('#tableWrap').hidden = true;
  loadProfiles().then(renderCards);
}

/* 상세 패널이 비어 있으면 우측이 휑해 보인다 — 첫 종목을 자동으로 열어둔다 */
async function autoSelectFirst() {
  if (state.selectedId || !state.watchlist.length) return;
  // 시세가 들어온 뒤에 열어야 가격까지 채워진다
  for (let i = 0; i < 20 && !state.quotes.size; i++) await new Promise((r) => setTimeout(r, 150));
  if (!state.selectedId && state.watchlist.length) selectStock(state.watchlist[0].id, { scroll: false });
}

startPolling(refreshIndices, REFRESH.indices);
startPolling(refreshGap, 10000);
startPolling(refreshQuotes, REFRESH.quotes);
startPolling(refreshInvestor, REFRESH.investor);
startPolling(refreshNews, REFRESH.news);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { refreshIndices(); refreshQuotes(); }
});

autoSelectFirst();
