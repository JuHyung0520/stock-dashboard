/* 관심종목 목록 조작 — 삭제·실행취소, 드래그로 순서 바꾸기, 카드 뷰.
 * 로드 순서: app.js 다음. 여기서 로드 즉시 enableDragReorder 를 부르므로 그 정의도 이 파일에 둔다.
 *
 * app.js 가 1,184줄 한 덩어리라 한 기능을 고치려면 전체를 훑어야 했다. 구획 단위로 갈랐다.
 * 모두 클래식 스크립트라 최상위 선언을 서로 그대로 공유한다(같은 전역 렉시컬 환경) —
 * 그래서 **같은 이름을 두 파일에 선언하면 안 된다**(already been declared 로 즉사). */

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
      // 그새 검색·랭킹으로 같은 종목을 다시 넣었으면 되돌릴 게 없다 — 안 막으면 두 줄로 저장된다
      if (state.watchlist.some((w) => w.id === lastRemoved.item.id)) { lastRemoved = null; t.classList.remove('on'); return; }
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
    /* 정리는 여기서 끝낸다. 아래 재렌더가 드래그 원본을 DOM 에서 떼어내면 dragend 가 그 노드에서 나서
     * 컨테이너까지 버블링되지 않는다 — 그러면 justDragged 가 영영 true 로 남아 이후 모든 클릭이 무시됐다. */
    dragId = null;
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);   // 드롭 직후의 click 한 번만 무시
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

/* 첫 로드와 뷰 전환이 겹치면 두 경로가 동시에 들어와 같은 id 를 두 번 요청하고 카드를 두 번 그렸다.
 * 둘 다 캐시가 채워지기 **전에** missing 을 계산하기 때문이다.
 * 진행 중인 요청을 id 조합별로 나눠 쓴다 (toss.js 의 토큰 발급과 같은 방식).
 * 조합이 다르면(관심종목이 그새 늘었다면) 따로 나가야 하므로 키를 ids 로 잡는다. */
const profileInFlight = new Map();

async function loadProfiles() {
  const now = Date.now();
  const missing = state.watchlist.map((w) => w.id)
    .filter((id) => !profileCache.has(id) || now - profileCache.get(id).__at > PROFILE_TTL);
  if (!missing.length) return false;

  const key = missing.join(',');
  if (profileInFlight.has(key)) return profileInFlight.get(key);

  const job = (async () => {
    try {
      const { profiles } = await api(`/api/profiles?ids=${encodeURIComponent(key)}`);
      for (const p of profiles) profileCache.set(p.id, { ...p, __at: Date.now() });
      // 안 돌아온 id 는 '없음'으로 기억한다 — 안 그러면 5초 폴링마다 다시 요청해 업스트림을 계속 때린다
      for (const id of missing) if (!profiles.some((p) => p.id === id)) profileCache.set(id, { id, __at: Date.now(), __missing: true });
      return true;
    } catch (e) {
      console.warn('profiles', e);
      return false;
    } finally {
      profileInFlight.delete(key);
    }
  })();
  profileInFlight.set(key, job);
  return job;
}

const liveFacts = Pure.liveFacts;   // 계산은 pure.js 로 옮겼다 (테스트 가능하게)

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
    const p0 = profileCache.get(w.id);
    const p = p0 && !p0.__missing ? p0 : null;
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
