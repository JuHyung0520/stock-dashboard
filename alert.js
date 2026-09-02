#!/usr/bin/env node
/* 가격 알림 데몬 — launchd가 60초마다 깨운다.
 *
 * 브라우저와 무관하게 동작하는 게 존재 이유다. 대시보드를 닫아둬도
 * 목표가·그리드 라인에 닿으면 macOS 알림이 뜬다.
 *
 * ── 설계 원칙 1: 상태 갱신과 발화 판정을 분리한다 ──
 * 초판에서 가장 크게 틀렸던 부분이다. 평가 함수가 "발화한다"고 판단하는 순간
 * armed/lastFiredAt/disabled 를 먼저 기록해 버렸는데, 호출부가 그 알림을 버리는 경로
 * (갭 모드)가 있었다. 결과는 최악이었다 — 알림은 안 뜨는데 쿨다운과 재무장은 소모돼서,
 * 신호 하나를 놓치는 게 아니라 그 뒤 최소 60분을 통째로 침묵하게 만들었다.
 * 그래서 지금은 `record` 모드를 명시적으로 둔다: 기준만 기록하고 방아쇠는 건드리지 않는다.
 *
 * ── 설계 원칙 2: 침묵의 원인을 항상 구분할 수 있어야 한다 ──
 * 알림이 안 울렸을 때 "조건 미충족"인지 "데몬이 죽음"인지 모르면 이 시스템은 신뢰할 수 없다.
 * 그래서 lastRunAt 은 어떤 경로로 끝나든 반드시 남긴다(장외 종료·시세 실패 포함).
 *
 * ── 설계 원칙 3: 한 조건의 오류가 나머지를 죽이지 않는다 ──
 * 조건마다 try/catch 로 격리하고, 상태 저장은 알림 발송보다 뒤에 둔다.
 *
 * ── 알림 폭주 방지 3단 ──
 *   1단 교차 판정 — 경계를 넘은 순간에만. 첫 관측은 절대 발화하지 않는다.
 *   2단 히스테리시스 — 발화 후 일정 폭 되돌아와야 재무장.
 *   3단 쿨다운 — 1·2단이 뚫려도 막는 최후 안전망. 그래서 설정값을 여기서 다시 검증한다.
 *
 * ── 한계 (숨기지 않는다) ──
 * - StartInterval 은 시스템이 자는 동안의 발화를 놓친다(man launchd.plist).
 *   깨어난 뒤에는 기준만 다시 잡고 요약 한 줄만 띄운다 — 밀린 알림을 쏟지 않기 위해서다.
 * - osascript 의 exit 0 은 '알림이 화면에 떴다'를 증명하지 않는다. 방해금지 모드면 조용히 삼켜진다.
 *   그래서 소리는 afplay 로 따로 낸다.
 * - 한국 공휴일은 구분하지 않는다. 휴장일엔 시세가 직전 종가로 고정돼 교차가 거의 없다.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'alerts.json');
const STATE = path.join(DIR, 'alerts-state.json');
const SERVER = 'http://127.0.0.1:8787';
const GAP_MIN = 10;                 // 이 이상 공백이면 기준만 다시 잡는다

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/* ── 유틸 ── */
const log = (...a) => console.log(`[${kstStamp()}]`, ...a);

function num(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const v = parseFloat(String(s).replace(/[+,\s]/g, '').replace(/−/g, '-'));
  return isNaN(v) ? null : v;
}

// 네이버는 하락 시 이미 음수를 준다 — 방향으로 또 뒤집으면 부호가 반대가 된다
function signed(value, directionName) {
  const v = num(value);
  if (v == null) return null;
  return directionName === 'FALLING' && v > 0 ? -v : v;
}

/* 시스템 타임존과 무관하게 한국 시각을 얻는다.
 * 한국 장 시간을 판정하면서 로컬 TZ에 기대면, 해외에서 켰을 때 창이 통째로 어긋난다.
 * 그런데 이 오작동의 증상은 '침묵'뿐이라 발견이 거의 불가능하다. */
function kstParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const g = (t) => f.find((x) => x.type === t)?.value;
  const hour = g('hour') === '24' ? 0 : Number(g('hour'));
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    minutes: hour * 60 + Number(g('minute')),
    weekday: g('weekday'),                       // Mon..Sun
    stamp: `${g('year')}-${g('month')}-${g('day')} ${String(hour).padStart(2, '0')}:${g('minute')}`,
  };
}
const kstStamp = () => kstParts().stamp;

const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};

// tmp + rename — 쓰다가 죽어도 상태 파일이 반쯤 쓰인 채로 남지 않는다
function writeJSON(f, obj) {
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

/* ── 장중 판정 (KST 고정) ──
 * 'regular' 정규장 09:00~15:30 (앞뒤 여유 포함) / 'nxt' 장후 ~20:00 */
function marketWindow(k) {
  if (k.weekday === 'Sat' || k.weekday === 'Sun') return null;
  if (k.minutes >= 8 * 60 + 50 && k.minutes <= 15 * 60 + 35) return 'regular';
  if (k.minutes > 15 * 60 + 35 && k.minutes <= 20 * 60) return 'nxt';
  return null;
}

/* ⚠️ 정규장이 끝나면 q.price(네이버 closePrice)는 15:30 종가에 얼어붙는다.
 * NXT 창에서 그 값으로 교차를 보면 prev == price 라 절대 교차가 나지 않는다 —
 * 장후 알림이 구조적으로 0건이 된다. 그 시간대엔 NXT 가격을 봐야 한다. */
function priceOf(q, win) {
  if (win === 'nxt' && q.extPrice != null) return q.extPrice;
  return q.price ?? null;
}

/* ── 시세 ──
 * 1순위 로컬 서버: num()·signed()가 이미 적용된 값이라 부호 실수가 원천 차단된다.
 * 서버가 꺼져 있으면 네이버 직접 호출로 폴백한다 — 알림이 서버 생존에 묶이면 안 된다. */
async function fetchQuotes(ids) {
  if (!ids.length) return { quotes: [], via: 'none' };

  try {
    const r = await fetch(`${SERVER}/api/quotes?ids=${ids.map(encodeURIComponent).join(',')}`,
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      if (d.quotes?.length) {
        // 일부만 돌아온 경우를 성공으로 삼키면, 해석 못 한 심볼이 영구히 무음으로 빠진다
        const got = new Set(d.quotes.map((q) => q.id));
        const missing = ids.filter((i) => !got.has(i));
        if (missing.length) log(`시세를 못 받은 심볼: ${missing.join(', ')} (id 형식을 확인하세요 — 미국 종목은 US:AAPL.O 처럼 접미사가 필요합니다)`);
        return { quotes: d.quotes, via: 'server' };
      }
    }
  } catch { /* 서버가 꺼져 있다 — 폴백 */ }

  const usIds = ids.filter((i) => !i.startsWith('KR:'));
  if (usIds.length) log(`서버가 꺼져 있어 미국 종목 ${usIds.length}건은 이번 실행에서 평가하지 못했습니다: ${usIds.join(', ')}`);

  const krCodes = ids.filter((i) => i.startsWith('KR:')).map((i) => i.slice(3)).filter((c) => /^\d{6}$/.test(c));
  if (!krCodes.length) return { quotes: [], via: 'none' };

  const d = await fetch(
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${krCodes.join(',')}`,
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) },
  ).then((r) => r.json());

  const quotes = (d.datas || []).map((x) => ({
    id: `KR:${x.itemCode}`,
    name: x.stockName,
    price: num(x.closePrice),
    changePct: signed(x.fluctuationsRatio, x.compareToPreviousPrice?.name),
    marketState: x.marketStatus === 'OPEN' ? 'OPEN' : 'CLOSED',
    extPrice: x.overMarketPriceInfo?.overMarketStatus === 'OPEN' ? num(x.overMarketPriceInfo.overPrice) : null,
  }));
  return { quotes, via: 'naver' };
}

/* ── 알림 ──
 * 'on run argv' 로 인자를 넘긴다. 문자열 보간과 달리 따옴표·아포스트로피가 안전하다. */
const SCRIPT = `on run argv
  display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)
end run`;

function notify(title, message, subtitle, sound) {
  try {
    execFileSync('osascript', ['-e', SCRIPT, String(title), String(message), String(subtitle || '')], { timeout: 8000 });
  } catch (e) {
    log('알림 실패:', e.message);
  }
  // 방해금지 모드면 알림은 삼켜져도 소리는 난다 — 이중 보험.
  // sound는 설정 파일에서 오므로 파일 경로에 그대로 넣지 않는다(경로 탈출 차단).
  if (sound === false) return;
  const safe = /^[A-Za-z]{1,20}$/.test(String(sound ?? '')) ? sound : 'Glass';
  const f = `/System/Library/Sounds/${safe}.aiff`;
  try { if (fs.existsSync(f)) execFileSync('afplay', [f], { timeout: 8000 }); } catch { /* 소리는 실패해도 무시 */ }
}

/* 알림 문구의 통화. 대시보드와 같은 규칙으로 심볼 접두사에서 끌어낸다 —
 * 미국 종목에 '원'을 붙이면 $209.66 이 '210원'이 되어 목표가와 비교가 안 된다. */
const isKR = (sym) => String(sym || '').startsWith('KR:');
const px = (sym, v) => (v == null || isNaN(v) ? '—'
  : isKR(sym) ? `${Math.round(v).toLocaleString('ko-KR')}원`
  : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/* 쿨다운은 최후 안전망이라 설정값을 여기서 다시 검증한다.
 * 0·음수·빈문자열이 그대로 통과하면 마지막 방어선이 사라진다. */
function cooldownMs(v, dflt) {
  const n = Number(v);
  return (Number.isFinite(n) && n >= 1 ? n : dflt) * 60000;
}

/* ── 목표가 평가 ──
 * record=true 면 기준만 기록하고 방아쇠(armed·lastFiredAt·disabled)는 절대 건드리지 않는다. */
function evalTarget(t, q, st, now, win, record) {
  const price = priceOf(q, win);
  if (price == null) return null;

  const prevPrice = st.prev;
  st.prev = price;

  const cp = q.changePct ?? null;
  const prevPct = st.prevPct;
  if (cp != null) st.prevPct = cp;

  // 재무장은 '가격이 어디 있느냐'의 문제라 쿨다운과 무관하게 항상 갱신한다.
  // 쿨다운 아래에 두면 그 60분 동안 기준선이 얼어붙어 다음 판정이 무의미해진다.
  const rearm = Number.isFinite(Number(t.rearmPct)) ? Number(t.rearmPct) : 0.005;
  const up = (t.op || '>=') === '>=';
  if (t.price != null) {
    if (up ? price < t.price * (1 - rearm) : price > t.price * (1 + rearm)) st.armed = true;
  } else if (t.changePct != null && cp != null) {
    const down = (t.op || '<=') === '<=';
    if (down ? cp > t.changePct + 0.5 : cp < t.changePct - 0.5) st.armed = true;
  }

  if (record) return null;                       // 기준만 기록하는 회차
  if (st.disabled) return null;                  // once 로 소진됨 (설정이 아니라 상태를 본다)
  if (prevPrice == null) return null;            // 첫 관측
  if (st.armed === false) return null;
  if (st.lastFiredAt && now - st.lastFiredAt < cooldownMs(t.cooldownMin, 60)) return null;

  let hit = false, dir = '';
  if (t.price != null) {
    if (up) { if (prevPrice < t.price && price >= t.price) { hit = true; dir = '도달'; } }
    else if (prevPrice > t.price && price <= t.price) { hit = true; dir = '도달'; }
  } else if (t.changePct != null) {
    if (cp == null || prevPct == null) return null;
    const down = (t.op || '<=') === '<=';
    if (down) { if (prevPct > t.changePct && cp <= t.changePct) { hit = true; dir = '하락'; } }
    else if (prevPct < t.changePct && cp >= t.changePct) { hit = true; dir = '상승'; }
  }
  if (!hit) return null;

  st.armed = false;
  st.lastFiredAt = now;
  if (t.once) st.disabled = true;

  const goal = t.price != null ? px(t.symbol, t.price)
    : `${t.changePct > 0 ? '+' : ''}${t.changePct}%`;
  return {
    title: `${up ? '🔺' : '🔻'} ${q.name || t.name || t.symbol}`,
    message: `${px(t.symbol, price)}${cp != null ? ` (${cp > 0 ? '+' : ''}${cp.toFixed(2)}%)` : ''}${win === 'nxt' ? ' · NXT' : ''}`,
    subtitle: `목표 ${goal} ${dir}`,
    sound: t.sound,
  };
}

/* ── 그리드 평가 ──
 * 칸 간격 자체가 히스테리시스라 rearm 이 필요 없고,
 * '직전에 알린 라인과 다른 라인일 때만'으로 진동을 막는다. */
function evalGrid(g, q, st, now, win, record) {
  const price = priceOf(q, win);
  if (price == null) return null;

  const prevPrice = st.prev;
  st.prev = price;

  if (record) return null;
  if (st.disabled) return null;
  if (prevPrice == null) return null;
  if (st.lastFiredAt && now - st.lastFiredAt < cooldownMs(g.cooldownMin, 15)) return null;

  const cells = Number(g.cells);
  if (!(cells >= 1) || !(g.upper > g.lower)) return null;   // 잘못된 구간은 조용히 건너뛴다
  const step = (g.upper - g.lower) / cells;

  const crossed = [];
  for (let i = 0; i <= cells; i++) {
    const line = g.lower + step * i;
    if (prevPrice < line && price >= line) crossed.push({ i, line, dir: 'up' });
    else if (prevPrice >= line && price < line) crossed.push({ i, line, dir: 'down' });
  }
  const fresh = crossed.filter((c) => c.i !== st.lastLine);
  if (!fresh.length) return null;

  /* 대표 라인은 '가격이 실제로 멈춘 쪽에 가장 가까운' 라인이어야 한다.
   * crossed 는 가격 오름차순이라, 상향이면 마지막(가장 높은) · 하향이면 첫(가장 낮은) 것이다.
   * 이걸 뒤집으면 가장 먼 라인을 알리고, lastLine 도 거기 박혀 되돌림 알림까지 막는다. */
  const goingDown = fresh[0].dir === 'down';
  const lead = goingDown ? fresh[0] : fresh[fresh.length - 1];

  st.lastLine = lead.i;
  st.lastFiredAt = now;

  const more = fresh.length > 1 ? ` 외 ${fresh.length - 1}개 라인` : '';
  return {
    title: `${goingDown ? '🟦 매수' : '🟥 매도'} 라인 · ${g.name || q.name || g.symbol}`,
    message: `${px(g.symbol, price)} — ${px(g.symbol, lead.line)} ${goingDown ? '아래로' : '위로'} 통과${more}`,
    subtitle: `${cells}칸 ${px(g.symbol, g.lower)}~${px(g.symbol, g.upper)}${win === 'nxt' ? ' · NXT' : ''}`,
    sound: g.sound,
  };
}

/* ── 메인 ── */
async function main() {
  const k = kstParts();
  const now = Date.now();
  const state = readJSON(STATE, null) || { version: 1 };
  state.targets = (state.targets && typeof state.targets === 'object') ? state.targets : {};
  state.grids = (state.grids && typeof state.grids === 'object') ? state.grids : {};

  /* 어떤 경로로 끝나든 lastRunAt 을 남긴다.
   * 이게 없으면 화면이 데몬을 '멈춤'으로 오진하고, 다음 정상 회차가 갭 모드로 들어가
   * 진짜 알림 구간을 통째로 삼킨다. */
  const finish = (via) => {
    state.lastRunAt = now;
    state.lastCheckedAt = now;
    if (via) state.lastVia = via;
    state.date = k.date;
    try { writeJSON(STATE, state); } catch (e) { log('상태 저장 실패:', e.message); }
  };

  const cfg = readJSON(CONFIG, null);
  if (!cfg || cfg.enabled === false) { finish(null); return; }

  const win = marketWindow(k);
  if (!win && !process.env.ALERT_FORCE) { finish(null); return; }   // 장외 — 조용히, 그러나 흔적은 남긴다

  // 원소가 객체가 아닐 수 있다(수작업 편집·구버전 파일). 하나라도 null 이면 예전엔 데몬 전체가 죽었다.
  const targets = (Array.isArray(cfg.targets) ? cfg.targets : [])
    .filter((t) => t && typeof t === 'object' && t.symbol && t.id);
  const grids = (Array.isArray(cfg.grids) ? cfg.grids : [])
    .filter((g) => g && typeof g === 'object' && g.symbol && g.id);
  const dropped = (cfg.targets?.length || 0) + (cfg.grids?.length || 0) - targets.length - grids.length;
  if (dropped > 0) log(`형식이 잘못된 조건 ${dropped}건을 건너뜁니다 (symbol·id 필수)`);

  if (!targets.length && !grids.length) { finish(null); return; }

  // 날짜가 바뀌면 재무장. 그리드의 lastLine 도 함께 지운다 —
  // 안 지우면 어제 알린 라인이 오늘까지 살아남아 그 라인만 영영 무음이 된다.
  if (state.date !== k.date) {
    for (const s of Object.values(state.targets)) if (!s.disabled) { s.armed = true; s.lastFiredAt = null; }
    for (const s of Object.values(state.grids)) { s.lastFiredAt = null; s.lastLine = null; }
  }

  /* 공백이 길면(슬립 등) prev 가 낡아 여러 라인을 한꺼번에 통과한 것처럼 보인다.
   * 이럴 땐 평가 자체를 하지 않고 기준만 다시 잡는다 — 평가한 뒤 알림만 버리면
   * 쿨다운과 재무장이 소모돼서 그 뒤 한 시간이 통째로 침묵해 버린다. */
  const gapMin = state.lastRunAt ? (now - state.lastRunAt) / 60000 : null;
  const record = gapMin == null || gapMin > GAP_MIN;

  const ids = [...new Set([...targets, ...grids].map((x) => String(x.symbol)))];
  let quotes = [], via = 'none';
  try {
    ({ quotes, via } = await fetchQuotes(ids));
  } catch (e) {
    log('시세 조회 실패:', e.message);
  }
  if (!quotes.length) { finish(via); return; }
  const qBy = Object.fromEntries(quotes.map((q) => [q.id, q]));

  // 조건 하나가 던져도 나머지는 계속 평가한다
  const fired = [];
  const run = (list, bucket, fn, dflt) => {
    for (const item of list) {
      try {
        const q = qBy[item.symbol];
        if (!q) continue;
        const st = (bucket[item.id] = bucket[item.id] || {});
        const hit = fn(item, q, st, now, win, record);
        if (hit) fired.push(hit);
      } catch (e) {
        log(`조건 ${item.id} 평가 실패: ${e.message}`);
      }
    }
  };
  run(targets, state.targets, evalTarget);
  run(grids, state.grids, evalGrid);

  // 설정에서 지워진 조건의 상태는 정리한다 (안 하면 파일이 계속 자란다)
  const liveT = new Set(targets.map((t) => t.id));
  const liveG = new Set(grids.map((g) => g.id));
  for (const key of Object.keys(state.targets)) if (!liveT.has(key)) delete state.targets[key];
  for (const key of Object.keys(state.grids)) if (!liveG.has(key)) delete state.grids[key];

  if (record) {
    /* 첫 실행이면 조용히 넘어간다. 매일 아침 첫 회차도 여기 걸리는데,
     * 그때마다 '알림 재개'를 띄우면 늑대소년이 되어 진짜 갭 경고의 신뢰가 떨어진다.
     * 장중에 실제로 긴 공백이 났을 때만 알린다. */
    if (gapMin != null && gapMin > GAP_MIN && win === 'regular' && gapMin < 600) {
      notify('📈 알림 재개', `${Math.round(gapMin)}분 공백 후 기준을 다시 잡았습니다`,
        '그 사이 발생한 신호는 놓쳤을 수 있습니다', 'Submarine');
    }
    finish(via);
    return;
  }

  // 알림을 먼저 보내고 상태를 저장한다 — 저장이 실패해도 알림은 이미 나갔다
  const show = fired.slice(0, 3);
  for (const f of show) notify(f.title, f.message, f.subtitle, f.sound);
  if (fired.length > show.length) {
    notify('📈 알림 여러 건', `그 외 ${fired.length - show.length}건이 더 발생했습니다`, '대시보드에서 확인하세요', 'Glass');
  }
  if (fired.length) log(`${fired.length}건 발화 (via ${via}, ${win})`);

  finish(via);
}

/* ── 워치독 ──
 * launchd 의 StartInterval 은 이전 인스턴스가 아직 돌고 있으면 다음 실행을 건너뛴다.
 * 그래서 한 번이라도 멈추면 알림이 영구히·무음으로 죽는다.
 * 실제로 그런 일이 있었다 — 잘못된 설정 하나로 프로세스가 99% CPU 로 1시간 51분 돌면서
 * 그동안 알림이 완전히 정지했고, 증상은 침묵뿐이라 알아채기 어려웠다.
 * 주기(60초)보다 짧은 시한을 걸어, 무슨 일이 있어도 다음 실행 자리를 비워준다. */
const watchdog = setTimeout(() => {
  log('워치독: 45초를 넘겨 스스로 종료합니다 (다음 실행을 막지 않기 위해)');
  process.exit(1);
}, 45000);
watchdog.unref();

main()
  .catch((e) => { log('실패:', e.message); process.exitCode = 1; })
  .finally(() => clearTimeout(watchdog));
