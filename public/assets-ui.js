/* 보유 자산 조작 — 행 이벤트, 계좌 관리, 거래세 탭, 종목 검색·추가, 백업(내보내기·가져오기).
 *
 * assets.js 가 1,025줄 한 덩어리라 구획 단위로 갈랐다. 모두 클래식 스크립트라
 * 최상위 선언을 서로 공유한다(같은 전역 렉시컬 환경) — 같은 이름을 두 파일에 선언하면 즉사한다. */

/* ── 이벤트 (위임) ── */
$('#holdingsBody').addEventListener('click', (e) => {
  const holdingEl = e.target.closest('.holding');
  if (!holdingEl) return;
  const key = holdingEl.dataset.key;
  const h = findByKey(key);
  if (!h) return;

  if (e.target.closest('[data-add-lot]')) {
    h.lots.push({ price: 0, qty: 0 });
    save(); reopen(key); return;
  }
  if (e.target.closest('[data-add-sell]')) {
    h.sells = h.sells || [];
    h.sells.push({ price: 0, qty: 0, date: new Date().toISOString().slice(0, 10) });
    save(); reopen(key); return;
  }
  const delLot = e.target.closest('[data-del-lot]');
  if (delLot) { h.lots.splice(+delLot.dataset.delLot, 1); save(); reopen(key); return; }
  const delSell = e.target.closest('[data-del-sell]');
  if (delSell) { h.sells.splice(+delSell.dataset.delSell, 1); save(); reopen(key); return; }
  if (e.target.closest('[data-del-holding]')) {
    if (!confirm(`${h.name}${state.activeAid === 'all' ? ` (${accName(h.aid)})` : ''} 을(를) 삭제할까요? 입력한 차수·매도 기록이 함께 지워져요.`)) return;
    state.holdings = state.holdings.filter((x) => keyOf(x) !== key);
    save(); forceRender(); return;
  }
  if (e.target.closest('[data-toggle]')) {
    state.openKey = state.openKey === key ? null : key;
    forceRender();
  }
});

// 구조가 바뀐 뒤엔 커서 가드를 무시하고 반드시 다시 그린다.
// 그리드 탭이 열려 있으면 그쪽도 계좌 필터가 바뀌므로 같이 갱신한다.
function forceRender() {
  renderAccounts(); renderSummary(); renderHoldings();
  if (!$('#gridPanel').hidden) renderGrids();
}
function reopen(key) { state.openKey = key; forceRender(); }

// 입력 반영 — input 이벤트로 즉시 재계산 (렌더는 blur에서, 커서 유지)
$('#holdingsBody').addEventListener('input', (e) => {
  const holdingEl = e.target.closest('.holding');
  if (!holdingEl) return;
  const h = findByKey(holdingEl.dataset.key);
  if (!h) return;
  const t = e.target;
  const v = t.type === 'date' ? t.value : parseFloat(t.value) || 0;
  if (t.dataset.lotPrice != null) h.lots[+t.dataset.lotPrice].price = v;
  else if (t.dataset.lotQty != null) h.lots[+t.dataset.lotQty].qty = v;
  else if (t.dataset.sellPrice != null) h.sells[+t.dataset.sellPrice].price = v;
  else if (t.dataset.sellQty != null) h.sells[+t.dataset.sellQty].qty = v;
  else if (t.dataset.sellDate != null) h.sells[+t.dataset.sellDate].date = t.value;
  if (!h.firstBuyDate && h.lots.some((l) => l.qty > 0)) h.firstBuyDate = new Date().toISOString().slice(0, 10);
  save();
  renderSummary();   // 합계만 갱신 — 입력 중 전체 재렌더하면 커서가 날아간다
});
$('#holdingsBody').addEventListener('focusout', (e) => {
  // blur 직후엔 activeElement가 body로 빠지므로 render()의 커서 가드에 걸리지 않는다.
  // 다만 같은 패널 안 다른 입력으로 옮겨가는 중이면 가드가 걸려 재렌더를 건너뛴다 — 의도된 동작.
  if (e.target.matches('input')) setTimeout(render, 0);
});

/* ── 계좌 관리 ── */
$('#accountBar').addEventListener('click', (e) => {
  const chip = e.target.closest('.acc');
  if (chip) {
    state.activeAid = chip.dataset.aid;
    state.openKey = null;
    save(); forceRender(); return;
  }
  if (e.target.id === 'accAdd') {
    const name = prompt('계좌 이름 (예: ISA, 연금저축)');
    if (!name?.trim()) return;
    const aid = uid('a');
    state.accounts.push({ aid, name: name.trim() });
    state.activeAid = aid;
    save(); forceRender(); return;
  }
  if (e.target.id === 'accRename') {
    const a = state.accounts.find((x) => x.aid === state.activeAid);
    if (!a) return;
    const name = prompt('새 이름', a.name);
    if (!name?.trim()) return;
    a.name = name.trim();
    save(); forceRender(); return;
  }
  if (e.target.id === 'accDel') {
    if (state.accounts.length <= 1) { alert('계좌가 하나뿐이라 삭제할 수 없어요.'); return; }
    const a = state.accounts.find((x) => x.aid === state.activeAid);
    const n = state.holdings.filter((h) => h.aid === a.aid).length;
    const other = state.accounts.find((x) => x.aid !== a.aid);
    const dupCount = state.holdings.filter((h) => h.aid === a.aid
      && state.holdings.some((x) => x.aid === other.aid && x.id === h.id)).length;
    if (!confirm(n
      ? `${a.name} 계좌를 삭제하면 보유 ${n}종목이 '${other.name}'으로 옮겨집니다.`
        + (dupCount ? `\n그중 ${dupCount}종목은 '${other.name}'에 이미 있어 차수·매도 기록이 합쳐집니다(평단이 다시 계산됩니다).` : '')
        + `\n계속할까요?`
      : `${a.name} 계좌를 삭제할까요?`)) return;
    /* 보유 데이터는 지우지 않고 다른 계좌로 옮긴다 — 계좌 삭제로 기록이 사라지면 안 된다.
     * 옮겨갈 계좌에 같은 종목이 이미 있으면 차수·매도 기록을 합친다.
     * (한 계좌에 같은 종목이 두 줄로 남으면 평단이 둘로 갈려 읽을 수 없다) */
    for (const h of state.holdings.filter((x) => x.aid === a.aid)) {
      const dup = state.holdings.find((x) => x.aid === other.aid && x.id === h.id);
      if (dup) {
        // 값이 0인 줄은 '아직 입력 중'일 수 있다 — 병합 과정에서 말없이 지우지 않는다
        const merged = [...dup.lots, ...h.lots];
        const real = merged.filter((l) => l.price > 0 || l.qty > 0);   // 완전히 빈 줄만 버린다 — 평단만 적어둔 '입력 중' 줄은 남긴다
        dup.lots = real.length ? real : [{ price: 0, qty: 0 }];
        dup.sells = [...(dup.sells || []), ...(h.sells || [])];
        // 보유 기간(APR 계산 기준)은 더 이른 쪽을 남긴다
        if (h.firstBuyDate && (!dup.firstBuyDate || h.firstBuyDate < dup.firstBuyDate)) dup.firstBuyDate = h.firstBuyDate;
        h.__merged = true;
      } else {
        h.aid = other.aid;
      }
    }
    state.holdings = state.holdings.filter((h) => !h.__merged);

    // 그리드도 같이 옮긴다. 안 옮기면 삭제된 계좌 소속으로 남아
    // 어느 계좌 탭에서도 안 보이고, 사용자는 사라진 줄 알고 같은 걸 새로 만든다.
    let moved = 0;
    for (const g of grids) if (g.aid === a.aid) { g.aid = other.aid; moved++; }
    if (moved) saveGrids();

    state.accounts = state.accounts.filter((x) => x.aid !== a.aid);
    state.activeAid = 'all';
    save(); forceRender();
  }
});

/* ── 거래세 탭 ── */
document.querySelectorAll('#taxTabs .tab').forEach((b) => {
  if (parseFloat(b.dataset.tax) === state.taxRate) {
    document.querySelectorAll('#taxTabs .tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  }
});
$('#taxTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  state.taxRate = parseFloat(b.dataset.tax);
  document.querySelectorAll('#taxTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  save(); render();
});

/* ── 검색 → 종목 추가 (대시보드와 같은 UX + 키보드) ── */
const searchInput = $('#searchInput');
const searchResults = $('#searchResults');
let searchTimer = null, searchSeq = 0, searchIdx = -1;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { ++searchSeq; searchResults.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      searchIdx = -1;
      searchResults.innerHTML = results.length ? results.slice(0, 8).map((r) => {
        // '추가됨' 판정은 현재 계좌 기준 — 다른 계좌에 있다고 못 넣을 이유가 없다
        const targetAid = state.activeAid === 'all' ? state.accounts[0].aid : state.activeAid;
        const added = state.holdings.some((h) => h.aid === targetAid && h.id === r.id);
        return `<button class="search-item" data-add='${esc(JSON.stringify(r))}' ${added ? 'disabled' : ''}>
          <span class="badge ${r.id.startsWith('KR') ? 'kr' : 'us'}">${r.isEtf ? 'ETF' : r.id.startsWith('KR') ? '국내' : '미국'}</span>
          <span>${esc(r.name)}</span><span class="si-code">${esc(r.code)}</span>
          ${added ? '<span class="si-added">추가됨</span>' : ''}</button>`;
      }).join('') : '<div class="search-empty">검색 결과 없음</div>';
      searchResults.hidden = false;
    } catch {}
  }, 250);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ++searchSeq; searchResults.hidden = true; searchInput.blur(); return; }
  if (searchResults.hidden) return;
  const items = [...searchResults.querySelectorAll('.search-item:not([disabled])')];
  if (!items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchIdx = e.key === 'ArrowDown' ? (searchIdx + 1) % items.length : (searchIdx - 1 + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === searchIdx));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (items[searchIdx] || items[0]).click();
  }
});

searchResults.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-add]');
  if (!btn || btn.disabled) return;
  const r = JSON.parse(btn.dataset.add);
  // '전체' 보기에서 추가하면 첫 계좌로 들어간다
  const aid = state.activeAid === 'all' ? state.accounts[0].aid : state.activeAid;
  const h = { hid: uid('h'), aid, id: r.id, name: r.name, isEtf: !!r.isEtf, lots: [{ price: 0, qty: 0 }], sells: [] };
  state.holdings.push(h);
  save();
  searchResults.hidden = true;
  searchInput.value = '';
  state.openKey = keyOf(h);   // 추가하면 바로 입력할 수 있게 펼친다
  refreshQuotes();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.searchbox')) { searchResults.hidden = true; gridSearchResults.hidden = true; }
});

/* ── 백업 ── */
$('#exportBtn').addEventListener('click', () => {
  /* 그리드를 반드시 포함한다 — 전에는 빠져 있어서 "백업했다"고 믿고
   * 그리드 체결 기록을 잃을 수 있었다. */
  const payload = {
    v: 2, taxRate: state.taxRate, accounts: state.accounts,
    holdings: state.holdings, grids: tryParse(localStorage.getItem('grids-v1')) || [],
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `assets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.holdings)) throw new Error('형식이 다름');
    // v1 파일(계좌 없음)도 그대로 받아서 마이그레이션한다
    const norm = normalize(d.v === 2 ? d : migrateV1toV2(d));

    /* ⚠️ 그리드 처리가 가장 위험한 지점이다.
     * 내보내기는 그리드가 하나도 없던 시점에도 `grids: []` 를 넣는다. 그 파일을 몇 달 뒤
     * 가져오면 빈 배열이 '유효한 값'으로 통과해 그동안 쌓은 체결 기록을 전멸시킨다.
     * 게다가 확인창이 그리드를 언급조차 하지 않아 사용자는 종목만 덮어쓰는 줄 안다.
     * → 그리드 증감을 확인창에 명시하고, 덮어쓰기 전에 현재 그리드를 따로 백업한다. */
    const curGrids = tryParse(localStorage.getItem('grids-v1')) || [];
    const fileGrids = Array.isArray(d.grids) ? d.grids : null;
    const gridLine = fileGrids === null
      ? `\n· 그리드: 파일에 없음 → 현재 ${curGrids.length}개 그대로 둡니다`
      : `\n· 그리드: 현재 ${curGrids.length}개 → 파일의 ${fileGrids.length}개로 교체`
        + (curGrids.length && !fileGrids.length ? '  ⚠️ 지금 있는 그리드가 전부 사라집니다' : '');

    const dropLine = norm.dropped > 0 ? `\n· 형식이 잘못된 ${norm.dropped}건은 제외됩니다` : '';
    if (!confirm(`불러올 내용\n· 종목 ${norm.holdings.length}개 · 계좌 ${norm.accounts.length}개${gridLine}${dropLine}\n\n현재 데이터를 덮어씁니다. 계속할까요?`)) return;

    // 되돌릴 길을 남긴다 — 그리드는 지금까지 백업 대상이 아니었다
    if (fileGrids !== null && curGrids.length) {
      const bk = `grids-v1-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
      try { localStorage.setItem(bk, JSON.stringify(curGrids)); } catch { /* 용량 초과 시 백업 생략 */ }
    }

    state.holdings = norm.holdings;
    state.accounts = norm.accounts;
    state.activeAid = norm.activeAid;
    state.taxRate = norm.taxRate;
    if (fileGrids !== null) {
      localStorage.setItem('grids-v1', JSON.stringify(fileGrids));
      // 메모리 배열도 반드시 다시 읽는다. 안 그러면 다음 그리드 조작 한 번에
      // saveGrids() 가 옛 배열을 통째로 다시 써서 방금 복구한 것이 날아간다.
      grids = loadGrids();
      renderGrids();
    }
    save(); refreshQuotes();
  } catch (err) {
    alert('가져오기 실패: ' + err.message);
  }
  e.target.value = '';
});
