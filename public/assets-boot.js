/* 부팅 — 첫 렌더와 시세 폴링 시작.
 * ⚠️ 반드시 assets-*.js 중 **마지막**에 로드돼야 한다. 로드 즉시 render() 를 부르는데,
 * render 가 안에서 부르는 함수가 아직 안 읽힌 파일에 있으면 그 자리에서 ReferenceError 다.
 * (원래 한 파일일 땐 함수 선언이 파일 전체로 호이스팅돼서 순서가 안 드러났다.)
 *
 * assets.js 가 1,025줄 한 덩어리라 구획 단위로 갈랐다. 모두 클래식 스크립트라
 * 최상위 선언을 서로 공유한다(같은 전역 렉시컬 환경) — 같은 이름을 두 파일에 선언하면 즉사한다. */

/* ── 부팅 ── */
render();
refreshQuotes();
setInterval(() => { if (!document.hidden) refreshQuotes(); }, REFRESH);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotes(); });
