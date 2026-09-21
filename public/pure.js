/* 순수 로직 — 브라우저와 테스트가 같은 코드를 쓴다.
 *
 * 이 파일이 생긴 이유: 프론트 5,392줄에 직접 테스트가 하나도 없었다.
 * 로직이 전부 모듈 스코프에 묶여 있어 부를 수가 없었기 때문이다.
 * DOM·fetch·전역 상태를 건드리지 않는 것만 여기로 옮긴다 —
 * 그리면(render) 안 되고, 계산해서 **값을 돌려주기만** 한다.
 * 그리는 일은 각 페이지가 그대로 맡는다.
 *
 * 브라우저에서는 전역 Pure, Node 에서는 require 로 같은 객체를 얻는다. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pure = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 종목 코드 형식 ──
   * 클라이언트와 서버가 각자 정규식을 들고 있다가 갈라졌다.
   * 국내 단축코드는 숫자 6자리만이 아니다 — 전환우선주 등은 끝에 영문이 붙는다(00104K).
   * \d{6} 으로 걸렀더니 검색으로는 고를 수 있는데 저장은 거부돼, 하나만 그런 코드여도
   * 다음 새로고침에 **두 종목 다** 기본값으로 초기화됐다. 이제 규칙은 여기 한 곳에만 있다. */
  const KR_CODE = /^[0-9A-Z]{6}$/i;          // 국내 단축코드 (시총비교)
  const PEAK_CODE = /^[A-Z0-9]{3,10}$/i;     // 전고대비 — 지수(KOSPI)와 종목을 함께 받는다
  const isKrCode = (v) => KR_CODE.test(String(v ?? ''));
  const isPeakCode = (v) => PEAK_CODE.test(String(v ?? ''));

  /* ── 프로필 값을 현재가 시점으로 맞추기 ──
   * 프로필은 10분 캐시라 그 안의 price 는 시세(5초)보다 낡다. 시총·PER·PBR 을 그대로 쓰면
   * 한 카드 안에서 현재가만 최신이고 나머지는 10분 전 가격 기준이 된다.
   * 주당값(EPS·BPS·주식수)은 장중에 안 변하므로 가격비만 곱해 같은 시점으로 맞춘다. */
  function liveFacts(p, q) {
    if (!p) return null;
    const k = p.price && q && q.price ? q.price / p.price : 1;
    return {
      marketCap: p.marketCap != null ? p.marketCap * k : null,
      per: p.per != null ? p.per * k : null,
      pbr: p.pbr != null ? p.pbr * k : null,
      upside: p.targetMean && q && q.price ? (p.targetMean / q.price - 1) * 100 : p.targetUpside,
    };
  }

  /* ── 긴 목록을 한 줄에 담기 ──
   * 저장 바는 화면 아래 고정이고 본문은 그만큼(90px)만 비워 둔다 — 한 줄 기준이다.
   * 사유를 전부 이으면 바가 두세 줄이 되어 본문을 덮는다. */
  const brief = (list, n) => {
    const arr = Array.isArray(list) ? list : [];
    const k = n == null ? 2 : n;
    return arr.slice(0, k).join(' · ') + (arr.length > k ? ` 외 ${arr.length - k}개` : '');
  };

  /* ── 데몬 시세 조회 실패율 ──
   * 로그가 실패만 남겨서 "20건 실패"가 3천 번 중인지 200번 중인지 알 수 없었다.
   * 분모 없는 실패 건수로는 나빠지고 있는지 판단할 수 없다.
   * 값만 계산해서 돌려준다 — 문구와 색은 페이지가 정한다. */
  function healthSummary(h, now) {
    if (!h || !Number(h.runs)) return null;
    const recent = String(h.recent || '');
    const recentFails = (recent.match(/0/g) || []).length;
    const t = now == null ? Date.now() : now;
    return {
      runs: Number(h.runs) || 0,
      fails: Number(h.fails) || 0,
      recentTotal: recent.length,
      recentFails,
      ratePct: recent.length ? (recentFails / recent.length) * 100 : 0,
      // 20% 넘으면 빨간불. 한 번이라도 실패했으면 회색, 전부 성공이면 초록
      level: recent.length && recentFails / recent.length >= 0.2 ? 'bad' : recentFails ? 'meh' : 'good',
      lastFailAgoMin: h.lastFailAt ? Math.round((t - h.lastFailAt) / 60000) : null,
      lastFailMsg: h.lastFailMsg || null,
    };
  }



  /* ── 표시 헬퍼 ──
   * 11개 페이지 스크립트가 각자 정의하고 있었다($ 11곳, esc 10곳, cls 8곳, pct 8곳).
   * 같은 것을 여러 번 적으면 갈라진다 — 실제로 pct 는 소수 자릿수가 3종으로 갈라져 있었다.
   * 여기 것은 전부 DOM 을 안 건드리므로 테스트가 직접 부를 수 있다. */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 등락 방향 클래스. null 은 'flat' — 모르는 값을 하락으로 칠하면 안 된다
  const cls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

  // 부호는 −(U+2212). 하이픈은 숫자 옆에서 너무 짧아 마이너스로 안 읽힌다
  const pct = (v, d = 2) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);

  const money = (v) => (v == null ? '—'
    : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M`
    : `$${(v / 1e3).toFixed(0)}K`);

  const fmtKR = new Intl.NumberFormat('ko-KR');
  const fmtUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ── 그리드 매매 — 칸 상태 ──
   * 시작가 이상에서 '사는' 칸(buyPx ≥ start)은 시작가에 진입해 보유 중으로 시작한다.
   * 새 그리드를 만들 때와 망가진 그리드를 복구할 때가 **같은 규칙**이어야 해서 여기 한 곳에 둔다. */
  function initialCellState(lower, upper, cells, start) {
    const step = (upper - lower) / cells;
    return Array.from({ length: cells }, (_, i) =>
      (Number.isFinite(start) && lower + step * i >= start ? { state: 'held', entryPx: start } : { state: 'cash' }));
  }

  // 칸을 계산할 수 있는가 — 범위가 성립하고 칸 수가 정수여야 한다
  function isUsableGrid(g) {
    return !!(g && g.id && Number.isFinite(g.lower) && Number.isFinite(g.upper) && g.upper > g.lower
      && Number.isInteger(g.cells) && g.cells >= 1 && g.cells <= 200 && Array.isArray(g.cellState)
      && g.cellState.length === g.cells);
  }

  /* 저장된(또는 가져온) 그리드를 엔진이 믿고 쓸 수 있는 모양으로.
   * 보유 종목은 불러올 때 normalize 로 꼼꼼히 정리하는데 그리드는 aid 만 고치고
   * "cellState 등 나머지 필드는 손대지 않았다". 그래서 cellState 가 없는 그리드가 하나라도 섞이면
   * 렌더러의 g.cellState.map 에서 터져 **그리드 탭 전체가 빈 화면**이 됐다. 백업 가져오기로 충분히 들어오는 경로다.
   * 원칙: 지우지 않고 고친다. 고칠 수 없는 것(범위 불성립)은 그대로 두고 화면에서만 따로 표시한다. */
  function repairGrid(raw) {
    if (!raw || typeof raw !== 'object') return { grid: raw, repaired: false };
    const num = (v) => (v == null || v === '' ? NaN : Number(v));
    const g = { ...raw,
      lower: num(raw.lower), upper: num(raw.upper), cells: num(raw.cells), qty: num(raw.qty), start: num(raw.start),
      fills: Array.isArray(raw.fills) ? raw.fills.filter((x) => x && typeof x === 'object') : [] };
    let repaired = !Array.isArray(raw.fills) || g.fills.length !== raw.fills.length
      || ['lower', 'upper', 'cells', 'qty', 'start'].some((k) => raw[k] != null && typeof raw[k] !== 'number');
    const rangeOk = g.id && Number.isFinite(g.lower) && Number.isFinite(g.upper) && g.upper > g.lower
      && Number.isInteger(g.cells) && g.cells >= 1 && g.cells <= 200;
    if (!rangeOk) return { grid: g, repaired };          // 범위를 모르면 칸을 만들 수 없다 — 손대지 않는다
    const ok = (c) => c && (c.state === 'cash' || (c.state === 'held' && Number.isFinite(Number(c.entryPx))));
    const src = Array.isArray(raw.cellState) ? raw.cellState : [];
    const rule = initialCellState(g.lower, g.upper, g.cells, g.start);
    g.cellState = rule.map((r, i) => (ok(src[i])
      ? (src[i].state === 'held' ? { state: 'held', entryPx: Number(src[i].entryPx) } : { state: 'cash' })
      : r));
    if (src.length !== g.cells || src.some((c) => !ok(c))) repaired = true;
    return { grid: g, repaired };
  }

  /* ── 세대 가드 ──
   * 탭·기간을 빠르게 바꾸면 느린 옛 응답이 나중에 도착해 새 화면을 덮는다.
   * (탭은 ETH 인데 BTC 캔들이 그려지는 식 — 실제로 idx·ram 에서 났던 버그다.)
   *
   * 곳곳에 `let xSeq = 0` 을 손으로 박다 보니 ram.js 는 통째로 빠져 있었다.
   * 빠뜨릴 수 없게 하나로 만든다: start() 로 번호를 받고, await 뒤에 current() 로 확인한다. */
  function makeGuard() {
    let n = 0;
    return {
      start() { return ++n; },
      current(token) { return token === n; },
    };
  }

  return { KR_CODE, PEAK_CODE, isKrCode, isPeakCode, liveFacts, brief, healthSummary, makeGuard,
    esc, cls, pct, money, fmtKR, fmtUS,
    initialCellState, isUsableGrid, repairGrid };
}));
