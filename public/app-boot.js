/* 부팅 — 폴링을 시작하고 첫 종목을 고른다.
 * ⚠️ 반드시 app-*.js 중 **마지막**에 로드돼야 한다. 여기서 로드 즉시 다른 파일의 함수를
 * 부르는데(refreshGap·refreshNews·autoSelectFirst …), 클래식 스크립트는 파일을 넘어
 * 호이스팅되지 않아서 아직 안 읽힌 파일의 함수를 부르면 그 자리에서 ReferenceError 다.
 *
 * app.js 가 1,184줄 한 덩어리라 한 기능을 고치려면 전체를 훑어야 했다. 구획 단위로 갈랐다.
 * 모두 클래식 스크립트라 최상위 선언을 서로 그대로 공유한다(같은 전역 렉시컬 환경) —
 * 그래서 **같은 이름을 두 파일에 선언하면 안 된다**(already been declared 로 즉사). */

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
