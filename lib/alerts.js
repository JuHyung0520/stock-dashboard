/* 알림 설정 정제 — PUT 본문을 데몬이 믿고 읽을 수 있는 형태로 만든다.
 * 여기서 회귀가 났었다(빈 값이 0원으로 저장). test/alerts-save.test.js 가 지킨다. */

/* 알림 설정 정제 — PUT 본문을 데몬이 믿고 읽을 수 있는 형태로 만든다.
 * 핸들러 안에 있던 것을 밖으로 뺐다: 이 로직에서 회귀가 났었는데(빈 값이 0원으로 저장)
 * 안에 있으면 테스트로 못 부른다. 부를 수 없는 코드는 검증할 수 없다. */
function sanitizeAlerts(body) {
  /* 데몬이 신뢰하고 읽는 파일이라 형태를 여기서 강제한다.
   * 로컬 전용이지만 잘못된 값 하나가 데몬을 매분 죽이면 알림이 조용히 멈춘다 —
   * 값 검증은 편집 UI가 아니라 저장 지점에서 해야 한다. */
  const numIn = (v, lo, hi, dflt) => {
    if (v == null || v === '') return dflt;   // Number(null) 은 0 이라 빈 값이 '0원'으로 조용히 저장됐다
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  /* id 는 alert.js 에서 상태 객체의 키가 된다. "__proto__" 가 통과하면
   * state.targets["__proto__"] 대입이 프로토타입을 오염시켜
   * "첫 실행은 절대 발화하지 않는다"는 방어가 통째로 무력화된다. */
  const seenIds = new Set();
  const idOf = (v, prefix) => {
    let id = String(v ?? '').slice(0, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || id === '__proto__' || id === 'constructor' || id === 'prototype') {
      id = `${prefix}${Math.random().toString(36).slice(2, 9)}`;
    }
    // 중복 id 는 서로 다른 종목이 같은 상태를 공유하게 만들어 첫 실행에 오발화한다
    while (seenIds.has(id)) id = `${prefix}${Math.random().toString(36).slice(2, 9)}`;
    seenIds.add(id);
    return id;
  };
  const dropped = [];
  const sym = (v) => (/^(KR|US):[\w.-]{1,20}$/.test(String(v)) ? String(v) : null);
  // false 는 '무음' 이라는 유효한 선택이다 — 기본값으로 덮으면 그 분기가 도달 불가능해진다
  const sound = (v) => (v === false ? false : (/^[A-Za-z]{1,20}$/.test(String(v || '')) ? String(v) : 'Glass'));
  const text = (v, max) => String(v ?? '').slice(0, max);

  const clean = {
    version: 1,
    // "false"(문자열)·0 을 true 로 받으면 마스터 스위치가 fail-open 이 된다
    enabled: !(body.enabled === false || body.enabled === 'false' || body.enabled === 0),
    targets: (Array.isArray(body.targets) ? body.targets : []).slice(0, 100)
      .map((t) => {
        if (!t || typeof t !== 'object') { dropped.push('목표가: 형식 오류'); return null; }
        const symbol = sym(t.symbol);
        if (!symbol) { dropped.push(`목표가 "${text(t.name, 20) || '이름없음'}": 종목 코드 형식 오류`); return null; }
        const price = t.price == null ? null : numIn(t.price, 0, 1e12, null);
        const changePct = t.changePct == null ? null : numIn(t.changePct, -100, 1000, null);
        if (price == null && changePct == null) {
          dropped.push(`목표가 "${text(t.name, 20) || symbol}": 가격·등락률이 비어 있음`);
          return null;
        }
        return {
          id: idOf(t.id, 't'),
          symbol, name: text(t.name, 40),
          op: t.op === '<=' ? '<=' : '>=',
          ...(price != null ? { price } : { changePct }),
          cooldownMin: numIn(t.cooldownMin, 1, 1440, 60),
          rearmPct: numIn(t.rearmPct, 0, 0.5, 0.005),
          once: !!t.once, sound: sound(t.sound),
        };
      }).filter(Boolean),
    grids: (Array.isArray(body.grids) ? body.grids : []).slice(0, 50)
      .map((g) => {
        if (!g || typeof g !== 'object') { dropped.push('그리드: 형식 오류'); return null; }
        const symbol = sym(g.symbol);
        const lower = numIn(g.lower, 0, 1e12, null);
        const upper = numIn(g.upper, 0, 1e12, null);
        const cellsRaw = numIn(g.cells, 1, 200, null);
        const cells = Number.isInteger(cellsRaw) ? cellsRaw : null;   // 2.5칸이면 경계선이 상단에 안 닿는다
        // 상단이 하단보다 작거나 칸이 없으면 경계 계산이 깨진다 — 아예 저장하지 않는다
        if (!symbol || lower == null || upper == null || cells == null || upper <= lower) {
          dropped.push(`그리드 "${text(g.name, 20) || symbol || '이름없음'}": 구간·칸 수가 올바르지 않음`);
          return null;
        }
        return {
          id: idOf(g.id, 'g'),
          symbol, name: text(g.name, 40),
          lower, upper, cells,
          cooldownMin: numIn(g.cooldownMin, 1, 1440, 15),
          sound: sound(g.sound),
        };
      }).filter(Boolean),
    savedAt: new Date().toISOString(),
  };
  return { clean, dropped };
}

module.exports = { sanitizeAlerts };
