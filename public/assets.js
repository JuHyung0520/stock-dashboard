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

const $ = (s) => document.querySelector(s);
const REFRESH = 5000;

const fmtKR = new Intl.NumberFormat('ko-KR');
const fmtUS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    markUpdated(false);
    $('#lastUpdated').textContent = '⚠️ 저장 실패 — 저장 공간이 가득 찼을 수 있습니다';
  }
}

/* 같은 종목이 여러 계좌에(심지어 한 계좌에도) 있을 수 있으므로 행 식별은 고유 hid로 */
const keyOf = (h) => h.hid;
const findByKey = (k) => state.holdings.find((h) => keyOf(h) === k);
const accName = (aid) => state.accounts.find((a) => a.aid === aid)?.name || '?';
const inView = (h) => state.activeAid === 'all' || h.aid === state.activeAid;
const viewHoldings = () => state.holdings.filter(inView);

/* ── 시세 ── */
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

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
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  if (!e.target.closest('.searchbox')) searchResults.hidden = true;
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

/* ── 부팅 ── */
render();
refreshQuotes();
setInterval(() => { if (!document.hidden) refreshQuotes(); }, REFRESH);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotes(); });

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

gridSearch.addEventListener('input', () => {
  clearTimeout(gnTimer);
  const q = gridSearch.value.trim();
  if (!q) { gridSearchResults.hidden = true; return; }
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
