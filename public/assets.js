/* 내 자산 — 평단 손익계산기 (멀티 계좌)
 *
 * 데이터는 localStorage('assets-v2')에만 저장된다. 서버 전송 없음.
 * 구조: { v:2, taxRate, activeAid, accounts:[{aid,name}],
 *         holdings: [{ aid, id, name, isEtf, lots:[{price,qty}], sells:[{price,qty,date}] }] }
 *
 * ── 계좌 도입에서 가장 조심할 것 ──
 * 같은 종목을 일반과 ISA에 동시 보유할 수 있다. 그래서 종목 id 단독으로는 행을 특정할 수 없고
 * 모든 조회가 복합키(aid|id)여야 한다. id로만 찾으면 ISA 행을 고쳤는데 일반 계좌 값이 바뀐다.
 *
 * ── 계좌별로 나누지 않는 것 ──
 * 거래세율은 전역이다. ISA·연금의 혜택은 양도세·배당세 축이지 증권거래세 면제가 아니다.
 * 계좌별 세율을 만들면 틀린 방향으로 정교해진다.
 * 통화도 계좌별로 섞지 않는다 — 원화와 달러는 끝까지 분리한다(환산하지 않는다).
 *
 * 계산 규칙:
 *  - 가중 평단 = Σ(차수 평단×수량) / Σ수량
 *  - 보유 수량 = Σ매수 − Σ매도 (매도는 가중 평단을 바꾸지 않는다 — 이동평균법)
 *  - 거래세 = 평가금 × 세율 (국내 주식만, ETF·미국 면제) — "지금 다 팔면" 기준으로 손익에서 차감
 *  - 실현손익 = (매도가 − 가중평단) × 수량 − 매도금액×세율
 *  - APR = 수익률 ÷ 보유일수 × 365 (매도일 − 첫 매수 기록일이 없으므로 매도 기록의 date 기준 안내만)
 */

const REFRESH = 5000;

const fmtKR = Pure.fmtKR;
const fmtUS = Pure.fmtUS;

/* ── 저장 · 마이그레이션 ──
 * v1을 절대 덮어쓰지 않는다. v2로만 쓰고 v1은 읽기 전용으로 동결한다.
 * 문제가 생기면 이 파일만 되돌리면 즉시 원상복구된다. */
const tryParse = (raw) => { try { return JSON.parse(raw || 'null'); } catch { return null; } };
const uid = (p) => `${p}${Math.random().toString(36).slice(2, 8)}`;

function migrateV1toV2(v1) {
  const aid = 'a1';
  return {
    v: 2,
    taxRate: v1.taxRate ?? 0.15,
    accounts: [{ aid, name: '일반' }],
    // 기존 필드는 하나도 건드리지 않는다 — aid만 붙인다 (무손실)
    holdings: v1.holdings.map((h) => ({ ...h, aid })),
    activeAid: 'all',
  };
}

/* 매 로드마다 형태를 강제한다. 손으로 편집한 파일을 가져와도 죽지 않아야 한다. */
function normalize(d) {
  const out = { v: 2, taxRate: typeof d.taxRate === 'number' ? d.taxRate : 0.15 };
  // 중복 aid 를 남기면 '전체' 보기에서 같은 보유가 두 번 그려지고,
  // 사용자가 중복인 줄 알고 하나를 지우면 하나뿐인 원본이 사라진다
  const seenAid = new Set();
  out.accounts = (Array.isArray(d.accounts) ? d.accounts : [])
    .filter((a) => a && a.aid && !seenAid.has(String(a.aid)) && seenAid.add(String(a.aid)))
    .map((a) => ({ aid: String(a.aid), name: String(a.name || '계좌') }));
  if (!out.accounts.length) out.accounts = [{ aid: 'a1', name: '일반' }];
  const valid = new Set(out.accounts.map((a) => a.aid));
  const first = out.accounts[0].aid;

  /* 행 식별자는 고유 hid 다.
   * 처음엔 aid|id 복합키를 썼는데, 계좌를 지워 보유를 다른 계좌로 옮길 때
   * 그쪽에 같은 종목이 있으면 키가 겹쳐서 한 행을 고치면 다른 행이 바뀐다.
   * hid 를 쓰면 이 문제가 구조적으로 사라진다. */
  /* lots/sells 는 배열인지만 보면 부족하다. 다른 도구에서 만든 JSON 은 숫자를 문자열로 담는데,
   * "100" + "200" 같은 문자열 연산이 섞이면 평단이 조용히 틀려서 그 값으로 손익·세금이 전부 계산된다.
   * null 원소는 렌더를 죽인다. 여기서 한 번에 정규화한다. */
  const cleanLots = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({ price: Number(l.price) || 0, qty: Number(l.qty) || 0 }));
  const cleanSells = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({ price: Number(x.price) || 0, qty: Number(x.qty) || 0, date: typeof x.date === 'string' ? x.date : '' }));

  const seen = new Set();
  const rawCount = Array.isArray(d.holdings) ? d.holdings.length : 0;
  out.holdings = (Array.isArray(d.holdings) ? d.holdings : []).filter((h) => h && h.id).map((h) => {
    let hid = h.hid;
    if (!hid || seen.has(hid)) { hid = uid('h'); needsSave = true; }
    seen.add(hid);
    return {
      ...h, hid,
      // 고아 방지 — 계좌를 지운 뒤 남은 보유는 첫 계좌로 흡수한다
      aid: valid.has(h.aid) ? h.aid : first,
      lots: cleanLots(h.lots).length ? cleanLots(h.lots) : [{ price: 0, qty: 0 }],
      sells: cleanSells(h.sells),
    };
  });
  out.dropped = rawCount - out.holdings.length;    // 버린 개수 — 가져오기 확인창에서 알려준다
  out.activeAid = d.activeAid === 'all' || valid.has(d.activeAid) ? d.activeAid : 'all';
  return out;
}

/* 로드 중에 형태를 보정했으면(마이그레이션·hid 생성·고아 흡수) 결과를 바로 저장한다.
 * 안 그러면 매 로드마다 hid가 새로 생겨 펼침 상태 같은 것이 세션 간에 유지되지 않는다. */
let needsSave = false;
let brokenV2 = null;      // 깨진 v2 를 백업했으면 그 키 — 화면에 반드시 알린다
let saveFailed = false;   // localStorage 저장이 실패했는가 (용량 초과 등)

function load() {
  const rawV2 = localStorage.getItem('assets-v2');
  const v2 = tryParse(rawV2);
  if (v2 && v2.v === 2) return normalize(v2);

  /* ⚠️ v2 가 있는데 못 읽히는 상황(쓰기 중 강제 종료, 수동 편집, 확장프로그램 간섭).
   * 여기서 그냥 v1 으로 되감으면, 마이그레이션 이후 쌓은 데이터가 전부 사라지고
   * 부팅 직후 save() 가 깨진 원본까지 덮어써서 복구할 길이 없어진다.
   * 한 글자만 고치면 살릴 수 있었던 손상을 영구 소실로 바꾸면 안 된다. */
  if (rawV2) {
    const bk = `assets-v2-broken-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    try { localStorage.setItem(bk, rawV2); } catch { /* 용량 초과면 백업은 포기하되 경고는 남긴다 */ }
    brokenV2 = bk;
  }

  const v1 = tryParse(localStorage.getItem('assets-v1'));
  if (v1 && Array.isArray(v1.holdings)) {
    // 원문 그대로 1회 백업 — 재직렬화하지 않는다
    const bk = `assets-v1-backup-${new Date().toISOString().slice(0, 10)}`;
    const raw = localStorage.getItem('assets-v1');
    // 백업은 최선이지 전제가 아니다 — 용량 초과로 여기서 던지면 페이지가 매 로드마다 죽어 마이그레이션 자체가 막힌다
    if (raw && !localStorage.getItem(bk)) {
      try { localStorage.setItem(bk, raw); } catch (e) { console.warn('v1 백업 실패(용량?) — 마이그레이션은 계속', e.message); }
    }
    needsSave = true;
    return normalize(migrateV1toV2(v1));
  }
  return normalize({});
}

const state = { ...load(), quotes: new Map(), openKey: null };
// 변환 결과를 바로 확정한다. 안 그러면 v1이 계속 원본 노릇을 해서
// "지금 보고 있는 게 어느 쪽 데이터인가"가 모호해진다. (v1은 그대로 둔다 — 되돌릴 길)
if (needsSave) save();

/* 저장 데이터가 깨져 있었다면 반드시 알린다.
 * 조용히 옛 데이터로 되감으면, 사라진 걸 한참 뒤에야 눈치채고 그때는 복구가 불가능하다. */
if (brokenV2) {
  // 이 스크립트는 body 끝에서 로드되므로 DOMContentLoaded 가 이미 지났을 수 있다
  const showBanner = () => {
    const bar = document.createElement('div');
    bar.className = 'broken-banner';
    bar.innerHTML = `⚠️ <b>저장된 자산 데이터를 읽지 못했습니다.</b>
      최근 기록이 아니라 이전 백업 시점으로 되돌아간 상태입니다.
      읽지 못한 원본은 <code>${brokenV2}</code> 키에 그대로 보관해 뒀습니다 —
      덮어쓰기 전에 확인하세요.
      <button class="bb-x" aria-label="닫기">✕</button>`;
    bar.querySelector('.bb-x').onclick = () => bar.remove();
    document.body.prepend(bar);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
  else showBanner();
}
function save() {
  try {
    localStorage.setItem('assets-v2', JSON.stringify({
      v: 2, taxRate: state.taxRate, accounts: state.accounts,
      holdings: state.holdings, activeAid: state.activeAid,
    }));
    saveFailed = false;
  } catch (e) {
    // 저장 실패를 조용히 삼키면 화면은 성공한 척하고 사용자는 입력이 남은 줄 안다
    saveFailed = true;
    console.error('저장 실패', e);
    // 문구는 markUpdated 가 넣는다(saveFailed 분기). 여기서 덮어쓰면 5초 뒤 폴링 때 다른 문구로 바뀐다
    markUpdated(false);
  }
}

/* 같은 종목이 여러 계좌에(심지어 한 계좌에도) 있을 수 있으므로 행 식별은 고유 hid로 */
const keyOf = (h) => h.hid;
const findByKey = (k) => state.holdings.find((h) => keyOf(h) === k);
const accName = (aid) => state.accounts.find((a) => a.aid === aid)?.name || '?';
const inView = (h) => state.activeAid === 'all' || h.aid === state.activeAid;
const viewHoldings = () => state.holdings.filter(inView);

/* ── 시세 ── */

function markUpdated(ok) {
  // 실패했는데 화면은 그대로면 사용자는 낡은 값을 현재값으로 읽는다.
  // 흐림(시선)과 문구(설명)를 함께 준다 — 흐림만으로는 경고가 안 읽힌다.
  document.body.classList.toggle('stale', !ok);
  /* 저장 실패는 시세 성공보다 우선한다. 예전엔 5초 폴링의 '갱신 hh:mm' 이 ⚠️ 경고를 지워서
   * 사용자는 저장된 줄 알고 계속 입력했고, 새로고침 때 그 뒤 입력이 전부 사라졌다. */
  if (saveFailed) {
    $('#statusDot').classList.add('error');
    $('#lastUpdated').textContent = '⚠️ 저장 실패 — 지금 입력은 이 화면에만 남아 있습니다. 내보내기로 백업하세요';
    return;
  }
  $('#statusDot').classList.toggle('error', !ok);
  $('#lastUpdated').textContent = ok
    ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`
    : '갱신 실패 — 아래 값은 이전 것';
}

async function refreshQuotes() {
  if (!state.holdings.length) { render(); return; }
  try {
    // 같은 종목이 여러 계좌에 있으면 id가 중복된다 — 서버 캐시 키가 갈리지 않게 반드시 제거
    const ids = [...new Set(state.holdings.map((h) => h.id))].join(',');
    const { quotes } = await api(`/api/quotes?ids=${encodeURIComponent(ids)}`);
    for (const q of quotes) state.quotes.set(q.id, q);
    markUpdated(true);
  } catch (e) {
    console.warn('quotes', e);
    markUpdated(false);
  }
  render();
}

/* ── 계산 ── */
function calc(h) {
  const q = state.quotes.get(h.id);
  const isKR = h.id.startsWith('KR:');
  const lots = h.lots.filter((l) => l.price > 0 && l.qty > 0);
  const buyQty = lots.reduce((a, l) => a + l.qty, 0);
  const sellQty = (h.sells || []).reduce((a, s) => a + (s.qty > 0 ? s.qty : 0), 0);
  /* 매도 수량이 매수 기록을 넘으면(무상증자분·타 계좌 물량을 헷갈려 넣는 흔한 실수)
   * 보유수량이 음수가 되고, 그 음수 평가금·매입금이 상단 합계에 그대로 더해진다.
   * 0으로 막고 대신 '기록이 안 맞는다'는 신호를 올린다 — 조용히 계산하면 총합이 거짓이 된다. */
  const oversold = sellQty > buyQty;
  const qty = Math.max(0, buyQty - sellQty);
  const avg = buyQty ? lots.reduce((a, l) => a + l.price * l.qty, 0) / buyQty : 0;

  const price = q?.price ?? null;                     // 실시간(장중) 또는 종가
  const cost = avg * qty;
  const evalAmt = price != null ? price * qty : null;
  const taxRate = (isKR && !h.isEtf) ? state.taxRate / 100 : 0;
  const tax = evalAmt != null ? evalAmt * taxRate : 0;
  const pnlGross = evalAmt != null ? evalAmt - cost : null;
  const pnlNet = pnlGross != null ? pnlGross - tax : null;
  const rate = pnlNet != null && cost > 0 ? (pnlNet / cost) * 100 : null;

  // 실현손익
  const realized = (h.sells || []).map((s) => {
    if (!(s.price > 0 && s.qty > 0)) return null;
    const gross = (s.price - avg) * s.qty;
    const sTax = s.price * s.qty * taxRate;
    const net = gross - sTax;
    const r = avg > 0 ? (net / (avg * s.qty)) * 100 : null;
    /* APR 은 보유 기간이 실제로 알려져 있을 때만 낸다.
     * firstBuyDate 는 '처음 수량을 입력한 날'이지 실제 첫 매수일이 아니다.
     * 오늘 입력하고 오늘 매도를 적으면 days=1 로 클램프되어 +1,767% 같은 값이 찍히는데,
     * 이건 정보가 아니라 소음이다. 최소 보유일을 넘길 때만 표시한다. */
    let apr = null;
    if (r != null && s.date && h.firstBuyDate) {
      const days = (new Date(s.date) - new Date(h.firstBuyDate)) / 86400000;
      if (days >= 7) apr = (r / days) * 365;
    }
    return { ...s, net, rate: r, apr, __src: s };
  }).filter(Boolean);
  const realizedNet = realized.reduce((a, r) => a + r.net, 0);

  return { q, isKR, qty, buyQty, sellQty, oversold, avg, cost, evalAmt, tax, pnlGross, pnlNet, rate, realized, realizedNet,
           marketState: q?.marketState ?? null, currency: q?.currency || (isKR ? 'KRW' : 'USD') };
}

/* ── 포맷 ── */
function money(v, cur) {
  if (v == null || isNaN(v)) return '—';
  return cur === 'USD' ? `$${fmtUS.format(v)}` : `${fmtKR.format(Math.round(v))}원`;
}
function moneyShort(v, cur) {
  if (v == null || isNaN(v)) return '—';
  return cur === 'USD' ? `$${fmtUS.format(v)}` : fmtKR.format(Math.round(v));
}
function signMoney(v, cur) {
  if (v == null || isNaN(v)) return '—';
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return s + moneyShort(Math.abs(v), cur);
}
function pct(v) {
  if (v == null || isNaN(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
}
const cls = Pure.cls;
const esc = Pure.esc;

/* ── 렌더 ── */
function render() {
  renderAccounts();
  renderSummary();
  /* 입력 중이면 목록을 재구성하지 않는다.
   * 5초 폴링이 refreshQuotes → render 를 계속 부르기 때문에, 이 가드가 없으면
   * 평단을 5초 넘게 타이핑할 때 innerHTML 교체로 커서가 날아간다(기존 버그).
   * 계좌가 붙어 행 수가 늘면 증상이 더 나빠지므로 여기서 같이 막는다. */
  if ($('#holdingsBody').contains(document.activeElement)) return;
  renderHoldings();
}

/* 합산은 '전체'와 '계좌별'이 같은 코드를 타야 한다 — 순수 함수로 뽑는다 */
function totals(rows) {
  const krw = rows.filter((r) => r.currency !== 'USD' && r.evalAmt != null);
  const usd = rows.filter((r) => r.currency === 'USD' && r.evalAmt != null);
  const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] ?? 0), 0);
  // 시세를 못 받은 종목이 있으면 합계가 그만큼 비어 있다는 뜻 — 화면에서 밝힌다
  const pending = rows.filter((r) => r.evalAmt == null && r.cost > 0).length;
  return {
    krw, usd, pending,
    kEval: sum(krw, 'evalAmt'), kCost: sum(krw, 'cost'), kTax: sum(krw, 'tax'),
    kGross: sum(krw, 'pnlGross'), kNet: sum(krw, 'pnlNet'),
    kRealized: sum(rows.filter((r) => r.currency !== 'USD'), 'realizedNet'),
    uEval: sum(usd, 'evalAmt'), uNet: sum(usd, 'pnlNet'),
  };
}

function renderAccounts() {
  const counts = {};
  for (const h of state.holdings) counts[h.aid] = (counts[h.aid] || 0) + 1;
  const chip = (aid, name, n) => `<button class="acc ${state.activeAid === aid ? 'active' : ''}" data-aid="${esc(aid)}">
    ${esc(name)}<span class="cnt">${n}</span></button>`;

  $('#accountBar').innerHTML =
    chip('all', '전체', state.holdings.length)
    + state.accounts.map((a) => chip(a.aid, a.name, counts[a.aid] || 0)).join('')
    + `<button class="acc-add" id="accAdd">+ 계좌</button>`
    + `<span class="acc-tools">`
    + (state.activeAid !== 'all'
      ? `<button class="acc-add" id="accRename">이름 변경</button><button class="acc-add" id="accDel">계좌 삭제</button>` : '')
    + `</span>`;
}

function renderSummary() {
  // 통화 혼합(원+달러) 문제: 합계는 원화 종목만 합산하고, 달러 종목은 별도 표기
  const rows = viewHoldings().map(calc);
  const t = totals(rows);
  const { krw, usd } = t;
  const kEval = t.kEval, kCost = t.kCost, kTax = t.kTax;
  const kGross = t.kGross, kNet = t.kNet, kRealized = t.kRealized;
  const uEval = t.uEval, uNet = t.uNet;

  /* 주말·야간에 이 화면을 열면 금요일 종가가 '지금 내 자산'으로 읽힌다.
   * 숫자만 크게 보여주고 시점을 안 밝히면 그 오독을 막을 방법이 없다. */
  /* 통화별로 따로 판정한다. 한 뭉치로 묶으면 미국장만 열린 새벽에도
   * 원화 합계(금요일 종가) 옆에 '장중'이 붙어 정반대의 말을 하게 된다. */
  const stateOf = (list) => new Set(list.map((r) => r.marketState).filter(Boolean));
  const kStates = stateOf(krw), uStates = stateOf(usd);
  const word = (st) => (st.size === 0 ? null : st.has('OPEN') ? '장중' : '종가');
  // 히어로 숫자는 원화 합계다(원화가 없을 때만 달러) — 배지도 그 통화를 따라간다
  const heroStates = krw.length || !usd.length ? kStates : uStates;
  const heroOpen = heroStates.has('OPEN');
  const base = state.activeAid === 'all' ? '총 평가금' : `${accName(state.activeAid)} 평가금`;
  $('.sum-label').innerHTML = heroStates.size === 0
    ? base
    : `${base} <span class="as-of ${heroOpen ? 'live' : 'closed'}">${heroOpen ? '장중' : '종가 기준'}</span>`;
  $('#sumEval').textContent = krw.length || !usd.length ? money(kEval, 'KRW') : money(uEval, 'USD');
  const netRate = kCost > 0 ? (kNet / kCost) * 100 : null;
  $('#sumPnl').innerHTML = krw.length
    ? `<span class="${cls(kNet)}">${signMoney(kNet, 'KRW')}원 (${pct(netRate)})</span> <span class="sum-label">순손익 · 거래세 차감</span>`
    : '';

  const items = [
    ['총 매입', moneyShort(kCost, 'KRW')],
    ['세전 손익', `<span class="${cls(kGross)}">${signMoney(kGross, 'KRW')}</span>`],
    ['거래세(매도 시)', moneyShort(kTax, 'KRW')],
    ['실현손익 누계', `<span class="${cls(kRealized)}">${signMoney(kRealized, 'KRW')}</span>`],
  ];
  if (usd.length) {
    const uw = word(uStates);
    items.push(['미국 평가', `${money(uEval, 'USD')} <span class="${cls(uNet)}">(${signMoney(uNet, 'USD')})</span>`
      + (uw ? ` <span class="as-of ${uw === '장중' ? 'live' : 'closed'}">${uw}</span>` : '')]);
  }
  if (t.pending) items.push(['시세 대기', `<span class="sub warn">${t.pending}종목 — 합계에서 빠져 있음</span>`]);
  // 통화가 섞이면 시점도 섞인다 — 한 줄로 뭉뚱그리지 않고 둘 다 적는다
  const asOf = [
    kStates.size ? `국내 ${word(kStates) === '장중' ? '장중 실시간' : '직전 종가'}` : null,
    uStates.size ? `미국 ${word(uStates) === '장중' ? '장중 실시간' : '직전 종가'}` : null,
  ].filter(Boolean).join(' · ');
  if (asOf) items.push(['기준 시점', asOf]);
  $('#sumGrid').innerHTML = items.map(([k, v]) =>
    `<div class="sg-item"><span class="sg-k">${k}</span><span class="sg-v">${v}</span></div>`).join('');
}

function renderHoldings() {
  const body = $('#holdingsBody');
  if (!viewHoldings().length) {
    body.innerHTML = `<div class="empty-assets">위에서 종목을 검색해 보유 수량과 평단을 입력하세요.<br>
      데이터는 이 브라우저(localStorage)에만 저장되고 어디로도 전송되지 않아요.</div>`;
    return;
  }

  const head = `<div class="h-head">
    <span>종목</span><span>현재가</span><span class="hide-sm">보유수량</span>
    <span class="hide-sm">가중평단</span><span>평가금</span><span class="hide-sm">매입금</span><span>순손익</span><span></span>
  </div>`;

  /* '전체' 보기에서는 계좌별로 묶어서 소계를 보여준다.
   * 특정 계좌를 고르면 기존과 같은 평평한 목록. */
  const groups = state.activeAid === 'all'
    ? state.accounts.map((a) => ({ acc: a, rows: state.holdings.filter((h) => h.aid === a.aid) })).filter((g) => g.rows.length)
    : [{ acc: null, rows: viewHoldings() }];

  const rowHtml = (h) => {
    const c = calc(h);
    const isOpen = state.openKey === keyOf(h);
    const badge = `<span class="badge ${c.isKR ? 'kr' : 'us'}">${c.isKR ? (h.isEtf ? 'ETF' : '국내') : '미국'}</span>`;
    const ext = c.q?.extPrice
      ? `<span class="sub ${cls(c.q.extPct)}">NXT ${moneyShort(c.q.extPrice, c.currency)} ${pct(c.q.extPct)}</span>` : '';

    // data-key 는 복합키 — id 단독이면 같은 종목을 두 계좌에 가졌을 때 앞의 것만 잡힌다
    return `<div class="holding${isOpen ? ' open' : ''}" data-key="${esc(keyOf(h))}">
      <div class="h-row" data-toggle>
        <span class="h-name">${badge}<span class="nm">${esc(h.name)}</span>${
          state.activeAid === 'all' ? '' : ''}</span>
        <span class="h-cell">${c.q ? moneyShort(c.q.price, c.currency) : '…'}
          <span class="sub ${cls(c.q?.changePct)}">${pct(c.q?.changePct)}</span>${ext}</span>
        <span class="h-cell hide-sm">${c.qty ? fmtKR.format(c.qty) : '—'}<span class="sub${c.oversold ? ' warn' : ''}">${
          c.oversold ? `매도 ${fmtKR.format(c.sellQty)} > 매수 ${fmtKR.format(c.buyQty)}` : `매수 ${fmtKR.format(c.buyQty)}`
        }</span></span>
        <span class="h-cell hide-sm">${c.avg ? moneyShort(c.avg, c.currency) : '—'}</span>
        <span class="h-cell">${moneyShort(c.evalAmt, c.currency)}</span>
        <span class="h-cell hide-sm">${moneyShort(c.cost, c.currency)}</span>
        <span class="h-cell h-pnl ${cls(c.pnlNet)}">${signMoney(c.pnlNet, c.currency)}<span class="sub ${cls(c.rate)}">${pct(c.rate)}</span></span>
        <span class="h-open">▶</span>
      </div>
      <div class="h-detail">
        <div>
          <div class="hd-title">분할매수 차수 (평단 · 수량)</div>
          ${h.lots.map((l, i) => `
            <div class="lot-row">
              <span class="lot-no">${i + 1}차</span>
              <input type="number" inputmode="decimal" step="any" min="0" placeholder="평단"
                data-lot-price="${i}" value="${l.price || ''}">
              <input type="number" inputmode="numeric" step="any" min="0" placeholder="수량"
                data-lot-qty="${i}" value="${l.qty || ''}">
              <span class="lot-sum">${l.price > 0 && l.qty > 0 ? moneyShort(l.price * l.qty, c.currency) : ''}</span>
              <button class="x-btn" data-del-lot="${i}" title="차수 삭제">✕</button>
            </div>`).join('')}
          <button class="add-line" data-add-lot>+ 매수 차수 추가</button>
          ${c.buyQty ? `<div class="realized-sum"><span>가중 평단</span><b>${moneyShort(c.avg, c.currency)} × ${fmtKR.format(c.qty)}주</b></div>` : ''}
        </div>
        <div>
          <div class="hd-title">매도 기록 (실현손익)</div>
          ${(h.sells || []).map((s, i) => {
            /* c.realized 는 미완성 기록(price·qty 0)이 걸러진 배열이라
             * 원본 인덱스 i 로 꺼내면 뒤 행들의 손익이 한 칸씩 밀린다(기존 버그).
             * 원본 항목과 동일성으로 찾는다. */
            const r = c.realized.find((x) => x.__src === s) || {};
            return `
            <div class="sell-row">
              <input type="number" inputmode="decimal" step="any" min="0" placeholder="매도가"
                data-sell-price="${i}" value="${s.price || ''}">
              <input type="number" inputmode="numeric" step="any" min="0" placeholder="수량"
                data-sell-qty="${i}" value="${s.qty || ''}">
              <input type="date" data-sell-date="${i}" value="${s.date || ''}">
              <span class="sell-result ${cls(r.net)}">${r.net != null ? signMoney(r.net, c.currency) + ' (' + pct(r.rate) + (r.apr != null ? ' · APR ' + pct(r.apr) : '') + ')' : ''}</span>
              <button class="x-btn" data-del-sell="${i}" title="기록 삭제">✕</button>
            </div>`;
          }).join('')}
          <button class="add-line" data-add-sell>+ 매도 기록 추가</button>
          ${c.realized.length ? `<div class="realized-sum"><span>실현손익 합계</span><b class="${cls(c.realizedNet)}">${signMoney(c.realizedNet, c.currency)}</b></div>` : ''}
          <div class="realized-sum"><span>이 종목 삭제</span><button class="x-btn" data-del-holding title="종목 삭제">🗑</button></div>
        </div>
      </div>
    </div>`;
  };

  body.innerHTML = head + groups.map((g) => {
    if (!g.acc) return g.rows.map(rowHtml).join('');
    const t = totals(g.rows.map(calc));
    const sub = [
      t.krw.length ? `평가 ${moneyShort(t.kEval, 'KRW')}원` : null,
      t.krw.length ? `<span class="${cls(t.kNet)}">${signMoney(t.kNet, 'KRW')}</span>` : null,
      t.usd.length ? `미국 ${money(t.uEval, 'USD')}` : null,
    ].filter(Boolean).join(' · ');
    return `<div class="acc-group"><span class="ag-name">${esc(g.acc.name)}</span><span class="ag-sub">${sub}</span></div>`
      + g.rows.map(rowHtml).join('');
  }).join('');
}
