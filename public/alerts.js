/* 알림 설정 — alert.js 데몬이 읽는 alerts.json 을 편집한다.
 *
 * localStorage를 쓰지 않는 유일한 페이지다. Node 데몬은 브라우저 저장소를 읽을 수 없어서
 * 설정이 파일로 내려가야 한다. 그래서 여기만 GET/PUT /api/alerts 를 쓴다.
 *
 * 입력 UX 규칙(다른 페이지와 동일): input 이벤트에서 전체 재렌더를 하면 커서가 날아간다.
 * 값은 state 에만 반영하고, 목록 재구성은 종목 추가·삭제처럼 구조가 바뀔 때만 한다.
 */

const $ = (s) => document.querySelector(s);
const fKR = new Intl.NumberFormat('ko-KR');
const fUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = { cfg: null, dirty: false, quotes: {} };

/* 알림은 미국 종목(US:AAPL.O)도 받는다 — 그런데 표시는 '원' 고정이라
 * $209.66 이 '209.66원'으로 찍혔다. 통화는 심볼 접두사로 안다. */
const isKR = (sym) => String(sym || '').startsWith('KR:');
const px = (sym, v) => (v == null || isNaN(v) ? '—' : isKR(sym) ? `${fKR.format(Math.round(v))}원` : `$${fUS.format(v)}`);

const api = async (p, opts) => {
  const r = await fetch(p, opts);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

function markUpdated(ok, msg) {
  document.body.classList.toggle('stale', !ok);
  $('#statusDot').classList.toggle('error', !ok);
  $('#lastUpdated').textContent = msg
    || (ok ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}` : '갱신 실패 — 아래 값은 이전 것');
}
function setDirty(v) {
  state.dirty = v;
  $('#saveBar').hidden = !v;
}

/* ── 데몬 상태 ──
 * 알림이 안 울렸을 때 "조건 미충족"인지 "데몬이 죽음"인지 구분되지 않으면
 * 알림 시스템은 신뢰할 수 없다. 마지막 실행 시각을 반드시 보여준다. */
async function renderDaemon() {
  const box = $('#daemonState');
  try {
    const st = await api('/api/alerts/state');
    if (st.never) {
      box.innerHTML = `<div class="dstate warn">
        <b>아직 한 번도 실행되지 않았습니다.</b>
        <span>launchd 등록이 필요합니다 — 아래 '알아둘 것'을 보세요.</span></div>`;
      return;
    }
    const ago = st.lastRunAt ? Math.round((Date.now() - st.lastRunAt) / 60000) : null;
    const stale = ago == null || ago > 5;
    box.innerHTML = `<div class="dstate ${stale ? 'warn' : 'ok'}">
      <b>${stale ? '데몬이 멈춰 있을 수 있습니다' : '정상 동작 중'}</b>
      <span>
        마지막 실행 ${ago == null ? '기록 없음' : ago === 0 ? '1분 이내' : `${ago}분 전`}
        ${st.lastVia ? ` · 시세 출처 ${st.lastVia === 'server' ? '로컬 서버' : '네이버 직접'}` : ''}
        ${st.date ? ` · 기준일 ${st.date}` : ''}
      </span>
      ${stale ? '<span class="dim">장외 시간에는 데몬이 조용히 종료하므로 정상입니다. 장중에도 5분 넘게 멈춰 있으면 launchd를 확인하세요.</span>' : ''}
    </div>`;
  } catch {
    box.innerHTML = '<div class="dstate warn"><b>상태를 읽을 수 없습니다</b><span>서버가 꺼져 있을 수 있습니다</span></div>';
  }
}

/* ── 목표가 ── */
function renderTargets() {
  const list = state.cfg.targets;
  $('#targetList').innerHTML = list.length ? list.map((t, i) => `
    <div class="cond-row" data-kind="target" data-i="${i}">
      <div class="cr-head">
        <input class="cr-name" data-f="name" value="${esc(t.name || '')}" placeholder="종목명">
        <span class="cr-sym">${esc(t.symbol || '')}</span>
        <span class="cr-live" data-live="${esc(t.symbol || '')}"></span>
        <button class="cr-del" title="삭제">×</button>
      </div>
      <div class="cr-body">
        <select class="cr-in" data-f="mode">
          <option value="price"${t.price != null ? ' selected' : ''}>가격</option>
          <option value="pct"${t.changePct != null ? ' selected' : ''}>등락률</option>
        </select>
        <select class="cr-in" data-f="op">
          <option value=">="${(t.op || '>=') === '>=' ? ' selected' : ''}>이상 ↑</option>
          <option value="<="${t.op === '<=' ? ' selected' : ''}>이하 ↓</option>
        </select>
        <input class="cr-in num" data-f="value" type="number" step="any"
               value="${t.price != null ? t.price : (t.changePct != null ? t.changePct : '')}"
               placeholder="${t.changePct != null ? '-3' : '300000'}">
        <label class="cr-chk"><input type="checkbox" data-f="once"${t.once ? ' checked' : ''}><span>1회만</span></label>
        <span class="cr-cool">쿨다운 <input class="cr-in tiny num" data-f="cooldownMin" type="number" min="1" value="${t.cooldownMin ?? 60}">분</span>
      </div>
    </div>`).join('') : '<div class="inv-empty">목표가가 없습니다. + 추가를 누르세요.</div>';
  refreshLive();
}

/* ── 그리드 ── */
function renderGrids() {
  const list = state.cfg.grids;
  $('#gridList').innerHTML = list.length ? list.map((g, i) => {
    const step = g.cells ? (g.upper - g.lower) / g.cells : 0;
    return `
    <div class="cond-row" data-kind="grid" data-i="${i}">
      <div class="cr-head">
        <input class="cr-name" data-f="name" value="${esc(g.name || '')}" placeholder="종목명">
        <span class="cr-sym">${esc(g.symbol || '')}</span>
        <span class="cr-live" data-live="${esc(g.symbol || '')}"></span>
        <button class="cr-del" title="삭제">×</button>
      </div>
      <div class="cr-body grid-body">
        <span class="cr-lbl">하단</span><input class="cr-in num" data-f="lower" type="number" value="${g.lower ?? ''}">
        <span class="cr-lbl">상단</span><input class="cr-in num" data-f="upper" type="number" value="${g.upper ?? ''}">
        <span class="cr-lbl">칸</span><input class="cr-in tiny num" data-f="cells" type="number" min="1" max="100" value="${g.cells ?? 10}">
        <span class="cr-cool">쿨다운 <input class="cr-in tiny num" data-f="cooldownMin" type="number" min="1" value="${g.cooldownMin ?? 15}">분</span>
      </div>
      <div class="cr-note">칸 간격 ${step ? px(g.symbol, step) : '—'} · 경계 ${(g.cells ?? 0) + 1}개</div>
    </div>`;
  }).join('') : '<div class="inv-empty">그리드가 없습니다. 내 자산에서 쓰던 구간을 그대로 넣으세요.</div>';
  refreshLive();
}

/* 현재가를 옆에 띄워서 목표가가 현실적인지 바로 보이게 한다 */
async function refreshLive() {
  const syms = [...new Set([...state.cfg.targets, ...state.cfg.grids].map((x) => x.symbol).filter(Boolean))];
  if (!syms.length) return;
  try {
    const d = await api(`/api/quotes?ids=${syms.join(',')}`);
    state.quotes = Object.fromEntries((d.quotes || []).map((q) => [q.id, q]));
    document.querySelectorAll('[data-live]').forEach((el) => {
      const q = state.quotes[el.dataset.live];
      el.textContent = q ? `현재 ${px(el.dataset.live, q.price)}` : '';
      el.className = `cr-live ${q ? (q.changePct > 0 ? 'up' : q.changePct < 0 ? 'down' : '') : ''}`;
    });
  } catch { /* 시세 없이도 편집은 가능해야 한다 */ }
}

/* ── 편집 ──
 * input 이벤트에서는 state 만 갱신한다. 여기서 재렌더하면 타이핑 중 커서가 날아간다. */
document.addEventListener('input', (e) => {
  const row = e.target.closest('.cond-row');
  if (!row) return;
  const kind = row.dataset.kind, i = Number(row.dataset.i);
  const item = kind === 'target' ? state.cfg.targets[i] : state.cfg.grids[i];
  if (!item) return;
  const f = e.target.dataset.f;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;

  if (f === 'value') {
    const n = v === '' ? null : Number(v);
    if (item.changePct !== undefined && item.price === undefined) item.changePct = n;
    else if (row.querySelector('[data-f="mode"]')?.value === 'pct') { item.changePct = n; delete item.price; }
    else { item.price = n; delete item.changePct; }
  } else if (['lower', 'upper', 'cells', 'cooldownMin'].includes(f)) {
    item[f] = v === '' ? null : Number(v);
  } else if (f === 'mode') {
    // 모드 전환은 구조가 바뀌므로 재렌더가 필요하다 (input 이 아니라 change 로 처리)
  } else {
    item[f] = v;
  }
  setDirty(true);
});

document.addEventListener('change', (e) => {
  const row = e.target.closest('.cond-row');
  if (!row || e.target.dataset.f !== 'mode') return;
  const i = Number(row.dataset.i);
  const t = state.cfg.targets[i];
  if (!t) return;
  if (e.target.value === 'pct') { t.changePct = t.changePct ?? -3; delete t.price; }
  else { t.price = t.price ?? null; delete t.changePct; }
  setDirty(true);
  renderTargets();
});

document.addEventListener('click', (e) => {
  const del = e.target.closest('.cr-del');
  if (del) {
    const row = del.closest('.cond-row');
    const i = Number(row.dataset.i);
    if (row.dataset.kind === 'target') { state.cfg.targets.splice(i, 1); renderTargets(); }
    else { state.cfg.grids.splice(i, 1); renderGrids(); }
    setDirty(true);
  }
});

/* ── 추가: 관심종목에서 고른다 ── */
function watchlist() {
  try {
    const wl = JSON.parse(localStorage.getItem('watchlist-v1') || '[]');
    return wl.map((x) => (typeof x === 'string' ? { id: x, name: x } : x)).filter((x) => x.id);
  } catch { return []; }
}

function pickSymbol() {
  const wl = watchlist();
  if (!wl.length) {
    alert('대시보드에서 관심종목을 먼저 추가하세요.');
    return null;
  }
  const names = wl.map((x, i) => `${i + 1}. ${x.name || x.id}`).join('\n');
  const pick = prompt(`어느 종목인가요?\n\n${names}\n\n번호를 입력하세요:`);
  const idx = Number(pick) - 1;
  return wl[idx] || null;
}

$('#addTarget').addEventListener('click', () => {
  const s = pickSymbol();
  if (!s) return;
  const q = state.quotes[s.id];
  state.cfg.targets.push({
    id: uid('t'), symbol: s.id, name: s.name || s.id,
    op: '>=', price: q?.price ? Math.round(q.price * 1.1) : null,
    cooldownMin: 60, once: false, sound: 'Glass',
  });
  setDirty(true); renderTargets();
});

$('#addGrid').addEventListener('click', () => {
  const s = pickSymbol();
  if (!s) return;
  const q = state.quotes[s.id];
  const p = q?.price || 100000;
  state.cfg.grids.push({
    id: uid('g'), symbol: s.id, name: s.name || s.id,
    lower: Math.round(p * 0.8), upper: Math.round(p * 1.2), cells: 10,
    cooldownMin: 15, sound: 'Ping',
  });
  setDirty(true); renderGrids();
});

$('#enabledToggle').addEventListener('change', (e) => {
  state.cfg.enabled = e.target.checked;
  setDirty(true);
});

$('#saveBtn').addEventListener('click', async () => {
  try {
    // 값이 안 채워진 조건은 데몬에서 조용히 무시되므로 저장 전에 걸러준다
    const bad = [...state.cfg.targets.filter((t) => t.price == null && t.changePct == null),
      ...state.cfg.grids.filter((g) => !g.lower || !g.upper || !g.cells || g.upper <= g.lower)];
    if (bad.length) {
      $('#saveMsg').textContent = `값이 비었거나 잘못된 조건이 ${bad.length}개 있습니다`;
      return;
    }
    await api('/api/alerts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.cfg),
    });
    setDirty(false);
    markUpdated(true, `저장됨 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`);
  } catch (e) {
    $('#saveMsg').textContent = `저장 실패: ${e.message}`;
  }
});

// 저장 안 하고 나가면 설정이 날아간다
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ── 안내 ── */
$('#caveats').innerHTML = `
  <b>등록</b> — 알림은 launchd가 1분마다 <code>alert.js</code>를 깨워서 동작합니다.
  아직 등록 전이라면 터미널에서 한 번만 실행하세요:
  <br><code class="cmd">launchctl load ~/Library/LaunchAgents/com.jk.stock-alert.plist</code>
  <br><br>
  <b>동작 시간</b> — 평일 08:50~20:00(NXT 장후 포함)에만 돕니다. 그 밖에는 조용히 종료하므로
  데몬 상태가 "멈춤"으로 보여도 정상입니다.
  <br><br>
  <b>알림이 안 뜬다면</b> — macOS가 <code>osascript</code> 알림을 차단하고 있을 수 있습니다.
  시스템 설정 &gt; 알림에서 '스크립트 편집기'가 허용돼 있는지 확인하세요.
  방해금지 모드에서는 알림이 조용히 삼켜지지만, 소리는 별도로 재생하므로 들립니다.
  <br><br>
  <b>맥북을 닫아두면</b> — launchd의 <code>StartInterval</code>은 시스템이 자는 동안의 실행을 건너뜁니다.
  그 구간에 발생한 신호는 놓칩니다. 10분 넘는 공백 뒤에는 기준만 다시 잡고
  "알림 재개" 한 줄만 띄웁니다(밀린 알림을 한꺼번에 쏟지 않기 위해서입니다).
  <br><br>
  <b>테스트</b> — 장외에도 강제로 한 번 돌려보려면:
  <br><code class="cmd">ALERT_FORCE=1 node ~/Desktop/stock-dashboard/alert.js</code>`;

/* ── 로드 ── */
async function load() {
  try {
    state.cfg = await api('/api/alerts');
    state.cfg.targets = state.cfg.targets || [];
    state.cfg.grids = state.cfg.grids || [];
    $('#enabledToggle').checked = state.cfg.enabled !== false;
    renderTargets();
    renderGrids();
    markUpdated(true);
  } catch (e) {
    markUpdated(false);
    // 한쪽 패널만 오류를 말하면 다른 쪽은 '조건이 없는 것'처럼 보인다 — 둘 다 알린다
    const msg = `<div class="inv-empty">설정을 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. `
      + `<button class="retry-btn" onclick="load()">다시 시도</button></div>`;
    $('#targetList').innerHTML = msg;
    $('#gridList').innerHTML = msg;
  }
  renderDaemon();
}

load();
setInterval(() => { if (!document.hidden) renderDaemon(); }, 30000);
setInterval(() => { if (!document.hidden && !state.dirty) refreshLive(); }, 15000);
