/* 그리드 매매 트래커 — 엔진, 렌더, 체결 기록, 새 그리드 폼, 탭 전환과 시세.
 *
 * assets.js 가 1,025줄 한 덩어리라 구획 단위로 갈랐다. 모두 클래식 스크립트라
 * 최상위 선언을 서로 공유한다(같은 전역 렉시컬 환경) — 같은 이름을 두 파일에 선언하면 즉사한다. */

/* ═══════════════ 그리드 매매 트래커 ═══════════════
 * 수동 그리드 매매의 기록 장부. 자동매매 아님.
 *
 * 모델: 하단가~상단가를 N칸 등분. 경계 P_0(하단)..P_N(상단).
 *  칸 i = [P_{i-1} → P_i] : P_{i-1}에서 사서 P_i에서 판다.
 *  시작 시 시작가 '위'에 있는 칸(매수가 ≥ 시작가)은 시작가로 진입한 보유 상태 —
 *  올라갈 때 팔 물량을 처음부터 들고 시작하는 그리드 관례.
 * 저장: localStorage('grids-v1') — 서버 전송 없음.
 */

function loadGrids() {
  const g = tryParse(localStorage.getItem('grids-v1'));
  if (!Array.isArray(g)) return [];
  // 계좌 도입 전에 만든 그리드에는 aid가 없다 — 첫 계좌로 귀속시킨다.
  // cellState 등 나머지 필드는 손대지 않는다.
  const first = state.accounts[0].aid;
  const valid = new Set(state.accounts.map((a) => a.aid));
  return g.map((x) => ({ ...x, aid: valid.has(x.aid) ? x.aid : first }));
}
let grids = loadGrids();
const saveGrids = () => {
  // 던지면 뒤의 renderGrids 가 안 돌아 버튼이 옛 상태로 남고, 다시 누르면 체결이 두 번 기록됐다
  try { localStorage.setItem('grids-v1', JSON.stringify(grids)); return true; }
  catch (e) { console.error('그리드 저장 실패', e); saveFailed = true; markUpdated(false); return false; }
};

/* ── 엔진 ── */
/* 그리드도 미국 종목을 담을 수 있다(검색이 US를 돌려주고 gridCalc 이 이미 isKR 로 세금을 가른다).
 * 그런데 표시는 전부 '원' 고정이라 $209.66 이 '210원'으로 찍혔다 — 통화를 id 에서 끌어낸다. */
const gridCur = (g) => (g.id.startsWith('KR:') ? 'KRW' : 'USD');
const gPx = (g, v) => (v == null || isNaN(v) ? '…' : moneyShort(v, gridCur(g)));

function gridBoundaries(g) {
  const step = (g.upper - g.lower) / g.cells;
  return Array.from({ length: g.cells + 1 }, (_, i) => g.lower + step * i);
}

function gridCalc(g) {
  const q = state.quotes.get(g.id);
  const price = q?.price ?? null;
  const P = gridBoundaries(g);
  const isKR = g.id.startsWith('KR:');
  const taxRate = (isKR && !g.isEtf) ? state.taxRate / 100 : 0;

  let held = 0, invested = 0, unrealized = 0;
  const cells = g.cellState.map((c, i) => {
    const buyPx = P[i], sellPx = P[i + 1];
    let pnl = null;
    if (c.state === 'held') {
      held++;
      invested += c.entryPx * g.qty;
      if (price != null) { pnl = (price - c.entryPx) * g.qty; unrealized += pnl; }
    }
    return { i, buyPx, sellPx, ...c, pnl };
  });

  const realizedNet = (g.fills || []).reduce((a, f) => a + f.net, 0);
  const turns = (g.fills || []).filter((f) => f.type === 'sell').length;
  const days = Math.max(1, (Date.now() - new Date(g.startDate)) / 86400000);
  // 그리드 총 예산(모든 칸을 산다고 가정한 최대 투입) 기준 수익률 — 회전율 성격
  const budget = P.slice(0, -1).reduce((a, p) => a + p * g.qty, 0);
  const rate = budget ? ((realizedNet + unrealized) / budget) * 100 : null;
  const apr = rate != null ? (rate / days) * 365 : null;

  return { q, price, P, cells, held, invested, unrealized, realizedNet, turns, rate, apr, taxRate, budget, days };
}

/* ── 렌더 ── */
function renderGrids() {
  const list = $('#gridList');
  const shown = grids.filter((g) => state.activeAid === 'all' || g.aid === state.activeAid);
  if (!shown.length) {
    list.innerHTML = grids.length
      ? `<div class="empty-assets">${esc(accName(state.activeAid))} 계좌에는 그리드가 없어요.<br>다른 계좌를 보거나 아래에서 새로 만드세요.</div>`
      : '<div class="empty-assets">아직 그리드가 없어요. 아래에서 종목·범위·칸 수를 정해 시작하세요.</div>';
    return;
  }
  list.innerHTML = shown.map((g) => {
    const c = gridCalc(g);
    const cur = c.price;
    const ccy = gridCur(g);
    const step = (g.upper - g.lower) / g.cells;
    const stepPct = (step / g.lower) * 100;

    // 사다리: 위 칸부터. 현재가가 속한 칸 다음에 현재가 라인 삽입
    const rows = [];
    for (let i = g.cells - 1; i >= 0; i--) {
      const cell = c.cells[i];
      const atPrice = cur != null && cur >= cell.buyPx && cur < cell.sellPx;
      if (cur != null && cur >= cell.sellPx && i === g.cells - 1) {
        rows.push(`<div class="price-line">현재가 ${gPx(g, cur)} (범위 위)</div>`);
      }
      rows.push(`
        <div class="lad-row ${cell.state} ${atPrice ? 'at-price' : ''}">
          <span class="lad-range"><b>${gPx(g, cell.buyPx)}</b> → ${gPx(g, cell.sellPx)}</span>
          <span class="lad-bar">${cell.state === 'held' ? '<span class="fill"></span>' : ''}</span>
          <span class="lad-state">${cell.state === 'held'
            ? `<span class="entry">@${gPx(g, cell.entryPx)}</span> <span class="${cls(cell.pnl)}">${signMoney(cell.pnl, ccy)}</span>`
            : '현금 대기'}</span>
          ${cell.state === 'held'
            ? `<button class="lad-act sell" data-grid="${g.uid}" data-sell-cell="${cell.i}">매도</button>`
            : `<button class="lad-act buy" data-grid="${g.uid}" data-buy-cell="${cell.i}">매수</button>`}
        </div>`);
      if (atPrice) rows.push(`<div class="price-line">현재가 ${gPx(g, cur)}</div>`);
      if (cur != null && cur < c.P[0] && i === 0) {
        rows.push(`<div class="price-line">현재가 ${gPx(g, cur)} (범위 아래)</div>`);
      }
    }

    const lastFills = (g.fills || []).slice(-3).reverse()
      .map((f) => `${f.date.slice(5)} ${f.type === 'sell' ? '매도' : '매수'} ${gPx(g, f.px)}${f.type === 'sell' ? ` (<b class="${cls(f.net)}">${signMoney(f.net, ccy)}</b>)` : ''}`)
      .join(' · ');

    return `
    <div class="grid-card" data-uid="${g.uid}">
      <div class="gc-head">
        <span class="gc-name">${esc(g.name)}</span>
        <span class="gc-price ${cls(c.q?.changePct)}">${gPx(g, cur)} ${pct(c.q?.changePct)}</span>
        <span class="gc-meta">${gPx(g, g.lower)}~${gPx(g, g.upper)} · ${g.cells}칸 · 칸당 ${money(step, ccy)}(${stepPct.toFixed(1)}%) × ${g.qty}주 · ${g.startDate} 시작</span>
        <button class="x-btn" data-del-grid="${g.uid}" title="그리드 삭제">🗑</button>
      </div>
      <div class="gc-stats">
        <div class="gc-stat"><span class="k">실현수익</span><span class="v ${cls(c.realizedNet)}">${signMoney(c.realizedNet, ccy)}</span></div>
        <div class="gc-stat"><span class="k">회전</span><span class="v">${c.turns}회</span></div>
        <div class="gc-stat"><span class="k">보유 칸</span><span class="v">${c.held}/${g.cells}${c.held === 0 ? ' (전량 현금)' : ''}</span></div>
        <div class="gc-stat"><span class="k">미청산 평가</span><span class="v ${cls(c.unrealized)}">${signMoney(c.unrealized, ccy)}</span></div>
        <div class="gc-stat"><span class="k">수익률(예산 대비)</span><span class="v ${cls(c.rate)}">${pct(c.rate)}</span></div>
        <div class="gc-stat"><span class="k">APR</span><span class="v ${cls(c.apr)}">${pct(c.apr)}</span></div>
      </div>
      <div class="ladder">${rows.join('')}</div>
      ${lastFills ? `<div class="gc-log">최근 체결: ${lastFills}</div>` : ''}
    </div>`;
  }).join('');
}

/* ── 체결 기록 (위임) ── */
$('#gridList').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del-grid]');
  if (del) {
    const g = grids.find((x) => x.uid === del.dataset.delGrid);
    if (g && confirm(`${g.name} 그리드를 삭제할까요? 체결 기록도 지워져요.`)) {
      grids = grids.filter((x) => x.uid !== g.uid);
      saveGrids(); renderGrids();
    }
    return;
  }
  const btn = e.target.closest('[data-buy-cell],[data-sell-cell]');
  if (!btn) return;
  const g = grids.find((x) => x.uid === btn.dataset.grid);
  if (!g) return;
  const P = gridBoundaries(g);
  const isKR = g.id.startsWith('KR:');
  const taxRate = (isKR && !g.isEtf) ? state.taxRate / 100 : 0;
  const today = new Date().toISOString().slice(0, 10);
  g.fills = g.fills || [];

  if (btn.dataset.buyCell != null) {
    const i = +btn.dataset.buyCell;
    g.cellState[i] = { state: 'held', entryPx: P[i] };
    g.fills.push({ type: 'buy', cell: i, px: P[i], date: today, net: 0 });
  } else {
    const i = +btn.dataset.sellCell;
    const entry = g.cellState[i].entryPx;
    const sellPx = P[i + 1];
    const net = (sellPx - entry) * g.qty - sellPx * g.qty * taxRate;
    g.cellState[i] = { state: 'cash' };
    g.fills.push({ type: 'sell', cell: i, px: sellPx, entryPx: entry, date: today, net });
  }
  saveGrids(); renderGrids();
});

/* ── 새 그리드 폼 ── */
let gnStock = null;   // { id, name, isEtf }

const gridSearch = $('#gridSearch');
const gridSearchResults = $('#gridSearchResults');
let gnTimer = null, gnSeq = 0;
gridSearch.addEventListener('keydown', (e) => {   // 보유 탭 검색과 같은 ESC 동작
  if (e.key === 'Escape') { ++gnSeq; gridSearchResults.hidden = true; gridSearch.blur(); }
});

gridSearch.addEventListener('input', () => {
  clearTimeout(gnTimer);
  const q = gridSearch.value.trim();
  if (!q) { ++gnSeq; gridSearchResults.hidden = true; return; }   // 진행 중 응답은 버린다
  gnTimer = setTimeout(async () => {
    const seq = ++gnSeq;
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== gnSeq) return;
      gridSearchResults.innerHTML = results.slice(0, 6).map((r) =>
        `<button class="search-item" data-pick='${esc(JSON.stringify(r))}'>
          <span class="badge ${r.id.startsWith('KR') ? 'kr' : 'us'}">${r.isEtf ? 'ETF' : r.id.startsWith('KR') ? '국내' : '미국'}</span>
          <span>${esc(r.name)}</span><span class="si-code">${esc(r.code)}</span></button>`).join('')
        || '<div class="search-empty">검색 결과 없음</div>';
      gridSearchResults.hidden = false;
    } catch {}
  }, 250);
});

gridSearchResults.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pick]');
  if (!btn) return;
  gnStock = JSON.parse(btn.dataset.pick);
  gridSearch.value = gnStock.name;
  gridSearchResults.hidden = true;
  // 현재가 받아서 시작가 안내 + 범위 기본값 제안 (±8%)
  try {
    const { quotes } = await api(`/api/quotes?ids=${encodeURIComponent(gnStock.id)}`);
    const p = quotes[0]?.price;
    if (p) {
      gnStock.startPrice = p;
      // 달러 종목을 정수로 반올림하면 센트가 통째로 사라진다
      const usd = !gnStock.id.startsWith('KR:');
      const r = (v) => (usd ? +v.toFixed(2) : Math.round(v));
      if (!$('#gnLower').value) $('#gnLower').value = r(p * 0.92);
      if (!$('#gnUpper').value) $('#gnUpper').value = r(p * 1.08);
      $('#gnInfo').textContent = `현재가 ${money(p, usd ? 'USD' : 'KRW')}이 시작가가 돼요. 시작가 위 칸은 '보유'로 시작합니다. (기본 범위 ±8% 채워둠)`;
    }
  } catch {}
  validateGn();
});

function validateGn() {
  const lower = +$('#gnLower').value, upper = +$('#gnUpper').value;
  const cells = +$('#gnCells').value, qty = +$('#gnQty').value;
  $('#gnCreate').disabled = !(gnStock?.startPrice && lower > 0 && upper > lower && cells >= 2 && qty > 0);
}
['gnLower', 'gnUpper', 'gnCells', 'gnQty'].forEach((id) => $('#' + id).addEventListener('input', validateGn));

$('#gnCreate').addEventListener('click', () => {
  const lower = +$('#gnLower').value, upper = +$('#gnUpper').value;
  const cells = +$('#gnCells').value, qty = +$('#gnQty').value;
  const start = gnStock.startPrice;
  const step = (upper - lower) / cells;
  const g = {
    uid: 'g' + Date.now(),
    // '전체' 보기에서 만들면 첫 계좌로 들어간다
    aid: state.activeAid === 'all' ? state.accounts[0].aid : state.activeAid,
    id: gnStock.id, name: gnStock.name, isEtf: !!gnStock.isEtf,
    lower, upper, cells, qty,
    start, startDate: new Date().toISOString().slice(0, 10),
    // 시작가 이상에서 '사는' 칸(buyPx ≥ start)은 시작가 진입 보유로 초기화
    cellState: Array.from({ length: cells }, (_, i) =>
      (lower + step * i) >= start ? { state: 'held', entryPx: start } : { state: 'cash' }),
    fills: [],
  };
  grids.push(g);
  saveGrids();
  gnStock = null;
  gridSearch.value = '';
  ['gnLower', 'gnUpper', 'gnQty'].forEach((id) => { $('#' + id).value = ''; });
  $('#gridNew').open = false;
  refreshGridQuotes();
});

/* ── 탭 전환 + 시세 ── */
let assetTab = 'holdings';
$('#assetTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.vt');
  if (!b || b.dataset.atab === assetTab) return;
  assetTab = b.dataset.atab;
  document.querySelectorAll('#assetTabs .vt').forEach((x) => x.classList.toggle('active', x === b));
  $('#holdingsPanel').hidden = assetTab !== 'holdings';
  $('#gridPanel').hidden = assetTab !== 'grid';
  if (assetTab === 'grid') refreshGridQuotes();
});

async function refreshGridQuotes() {
  if (!grids.length) { renderGrids(); return; }
  try {
    const ids = [...new Set(grids.map((g) => g.id))].join(',');
    const { quotes } = await api(`/api/quotes?ids=${encodeURIComponent(ids)}`);
    for (const q of quotes) state.quotes.set(q.id, q);
  } catch {}
  renderGrids();
}
setInterval(() => { if (!document.hidden && assetTab === 'grid') refreshGridQuotes(); }, REFRESH);
