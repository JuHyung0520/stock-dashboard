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

  return { KR_CODE, PEAK_CODE, isKrCode, isPeakCode, liveFacts, brief, healthSummary };
}));
