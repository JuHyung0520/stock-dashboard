/* 오른쪽 패널 — 시장 수급, 해외 선물 환산가(김프), 뉴스·랭킹, 검색.
 *
 * app.js 가 1,184줄 한 덩어리라 한 기능을 고치려면 전체를 훑어야 했다. 구획 단위로 갈랐다.
 * 모두 클래식 스크립트라 최상위 선언을 서로 그대로 공유한다(같은 전역 렉시컬 환경) —
 * 그래서 **같은 이름을 두 파일에 선언하면 안 된다**(already been declared 로 즉사). */

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
    // 60초 재렌더가 <details> 를 새로 만들며 펼침을 닫아버렸다 — 열림 상태를 읽어 두었다가 복원
    const wasOpen = [...wrap.querySelectorAll('.inv-detail')].map((d) => d.open);
    wrap.innerHTML = verdictHtml + data.markets.map((m, mi) => {
      // 토스를 쓸 때만 기관 세부분류가 들어온다
      const bd = (m.breakdown || []).filter((b) => b.value != null);
      const bdMax = Math.max(1, ...bd.map((b) => Math.abs(b.value)));
      const detail = bd.length ? `
        <details class="inv-detail"${wasOpen[mi] ? ' open' : ''}>
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

const gapGuard = Pure.makeGuard();   // 늦게 온 옛 응답이 새 화면을 덮지 않게
async function refreshGap() {
  const __g = gapGuard.start();
  const body = $('#gapBody');
  try {
    const d = await api('/api/gap');
    if (!gapGuard.current(__g)) return;   // 그새 다른 대상으로 갔다
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
    if (!gapGuard.current(__g)) return;   // 늦게 실패한 옛 요청이 최신 화면을 덮지 않게
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
      if (seq !== newsSeq) return;   // 옛 요청의 실패로 새 탭을 덮지 않는다
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
    if (seq !== newsSeq) return;
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
  if (!q) { ++searchSeq; searchResults.hidden = true; return; }   // 진행 중 응답은 버린다
  searchTimer = setTimeout(() => runSearch(q), 250);
});

// 방향키로 고르고 Enter로 추가 — 타이핑하던 손을 마우스로 옮기지 않아도 된다
let searchIdx = -1;

function highlightSearchItem(items) {
  items.forEach((el, i) => el.classList.toggle('active', i === searchIdx));
  if (searchIdx >= 0) items[searchIdx]?.scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ++searchSeq; searchResults.hidden = true; searchInput.blur(); return; }
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
