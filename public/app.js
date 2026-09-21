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
  // 저장이 실패해도 메모리는 이미 바뀌어 화면엔 반영된다 — 그 불일치를 상태점으로 드러낸다
  try { localStorage.setItem('watchlist-v1', JSON.stringify(state.watchlist)); markUpdated(true, 'save'); return true; }
  catch (e) { console.error('관심종목 저장 실패', e); markUpdated(false, 'save'); return false; }
}

/* ── fetch helper ────────────────────── */

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
const fmtKR = Pure.fmtKR;
const fmtUS = Pure.fmtUS;

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
  // 조기 return 이 okBy.quotes 를 안 건드려서, 한 번 실패한 뒤 목록을 비우면 상태점이 영영 빨간불이었다.
  // 가져올 것이 없다는 건 실패가 아니다.
  if (!state.watchlist.length) { renderQuotes(); markUpdated(true, 'quotes'); return; }
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
