/* 세력 좌표 — 프론트
 * 서버(/api/flow/*)가 분석까지 끝낸 결과를 내려주고, 여기서는 그리기만 한다.
 */

const $ = (s) => document.querySelector(s);
const DAYS = 20;              // 매트릭스 가로 칸 수
const REFRESH = 60000;

const state = { market: 'KOSPI', data: null, hoverDay: null };

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/* ── 포맷 ── */
const nf = new Intl.NumberFormat('ko-KR');
function eok(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf.format(Math.round(Math.abs(v)))}`;
}
function dirClass(v) { return v == null ? 'flat-t' : v > 0 ? 'buy-t' : v < 0 ? 'sell-t' : 'flat-t'; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* 값 → 셀 색.
 *
 * 연속 농도로 칠해봤더니 수급은 거의 매일 유의미한 값이 있어서 모든 칸이 칠해지고,
 * 결국 격자가 색의 벽이 되어 아무 패턴도 안 보였다.
 *
 * 이 격자의 목적은 '크기'가 아니라 **연속과 전환점**이다 (크기는 호버·요약열·대립 패널에 있다).
 * 그래서 농도를 3단계로 양자화한다 — 연속 매수는 한 덩어리로, 방향 전환은 경계선으로 읽힌다. */
const LEVELS = [
  { min: 0.00, a: 0.18 },   // 약 — 방향은 있으나 미미
  { min: 0.35, a: 0.48 },   // 중
  { min: 0.85, a: 0.92 },   // 강 — 그 주체 기준 큰 날
];

function cellColor(v, scale, { muted = false } = {}) {
  if (v == null || !scale) return null;
  const t = Math.abs(v) / scale;
  let a = LEVELS[0].a;
  for (const L of LEVELS) if (t >= L.min) a = L.a;
  if (muted) a = 0.1;                       // 연속에 속하지 않는 날은 눌러둔다
  return v >= 0 ? `rgba(240,68,82,${a})` : `rgba(49,130,246,${a})`;
}

/* 각 칸이 '3일 이상 같은 방향 연속'에 속하는지 표시.
 * 켜면 고립된 하루가 눌리고 진짜 흐름만 남는다. */
function streakMask(seq, minRun = 3) {
  const mask = new Array(seq.length).fill(false);
  let i = 0;
  while (i < seq.length) {
    if (seq[i] == null) { i++; continue; }
    const sign = Math.sign(seq[i]);
    let j = i;
    while (j < seq.length && seq[j] != null && Math.sign(seq[j]) === sign) j++;
    if (sign !== 0 && j - i >= minRun) for (let k = i; k < j; k++) mask[k] = true;
    i = j > i ? j : i + 1;
  }
  return mask;
}

/* 막대 정규화 기준 — 상위 10% 지점.
 * 중앙값을 쓰면 절반이 최대치를 넘어 막대가 셀을 넘치고, 최대값을 쓰면
 * 폭탄 하루 하나 때문에 나머지가 전부 납작해진다. 그 사이를 택한다.
 * 기준을 넘는 날은 막대가 꽉 찬 상태로 잘리고, 그건 '아주 큰 날'이라는 뜻으로 읽힌다. */
function barScale(seq) {
  const abs = seq.filter((v) => v != null).map(Math.abs).sort((a, b) => b - a);
  if (!abs.length) return 1;
  return abs[Math.floor(abs.length * 0.1)] || abs[0] || 1;
}

/* ── ① 판정 ── */
function renderVerdict(d) {
  const v = d.verdict;
  const el = $('#verdict');
  el.classList.toggle('exceptional', !!v.isExceptional);

  const flags = [];
  if (v.isExceptional) flags.push('<span class="v-flag warn">이례적</span>');
  if (v.splitNote) flags.push(`<span class="v-flag warn">${esc(v.splitNote)}</span>`);
  if (v.missing?.length) flags.push(`<span class="v-flag">장중 결측: ${esc(v.missing.join(', '))}</span>`);
  if (d.asOf) flags.push(`<span class="v-flag">${esc(d.asOf)} 기준</span>`);

  el.innerHTML = `
    <div class="v-head">${esc(v.headline)}</div>
    ${v.detail ? `<div class="v-detail">${esc(v.detail)}</div>` : ''}
    ${flags.length ? `<div class="v-flags">${flags.join('')}</div>` : ''}`;
}

/* ── ①-b 기준선 카드 ──
 * 레퍼런스의 가장 강한 요소. 숫자 하나로는 뜻이 안 생기고, 자기 과거와 나란히 놓아야 의미가 된다. */
function renderStats(d) {
  const row = $('#statRow');
  const mains = d.positions.filter((p) => p.group === 'main' && p.baseline);
  if (!mains.length) { row.innerHTML = ''; return; }

  row.innerHTML = mains.map((p) => {
    const b = p.baseline;
    const rk = p.rank;
    // 전일/5일평/20일평 3줄은 매트릭스 스크러버가 이미 담고 있어 중복 —
    // "20일평 대비 몇 배"라는 한 줄 요약이 카드에는 더 맞는 밀도다
    const vs20 = b.avg20 && Math.abs(b.avg20) > 1 && b.today != null
      ? `20일평 대비 ${(b.today / b.avg20) < 0 ? '반대 방향' : '×' + Math.abs(b.today / b.avg20).toFixed(1)}`
      : null;
    // 연속일수는 오늘(잠정)을 빼고 센 값이다. 오늘 부호가 그 방향과 다르면
    // "매수 5일"을 그대로 붙이면 음수 값 옆에 붙어 헷갈리므로 반전으로 표기한다.
    const st = p.streak;
    const flipped = st && b.today != null && Math.sign(b.today) !== (st.direction === 'buy' ? 1 : -1);
    const badge = !st ? ''
      : flipped
        ? `<span class="sc-streak flip">직전 ${st.direction === 'buy' ? '매수' : '매도'} ${st.days}일 → 반전</span>`
        : `<span class="sc-streak ${st.direction === 'buy' ? 'buy-t' : 'sell-t'}">${st.direction === 'buy' ? '매수' : '매도'} ${st.days}일째</span>`;

    return `
      <div class="stat-card${p.missing ? ' muted' : ''}">
        <div class="sc-top">
          <span class="sc-name">${esc(p.label)}</span>
          ${badge}
        </div>
        <div class="sc-big ${dirClass(b.today)}">${eok(b.today)}<span class="sc-unit">억</span></div>
        ${rk ? `<div class="sc-rank">최근 ${rk.of}일 중 <b>${rk.rank}위</b>${rk.isRecord ? ' · 신기록' : ''}${vs20 ? ` · ${vs20}` : ''}</div>` : ''}
      </div>`;
  }).join('');
}

/* ── ② 매트릭스 ── */
function renderMatrix(d) {
  const wrap = $('#matrixWrap');
  const showInst = $('#showInst')?.checked ?? true;
  const streakMode = $('#streakOnly')?.checked ?? false;
  const rows = d.positions.filter((p) => !p.insufficient && (showInst || p.group === 'main'));
  if (!rows.length) { wrap.innerHTML = '<div class="fempty">데이터 부족</div>'; return; }

  // 날짜 축 — zSeq가 아니라 실제 값 시계열이 필요하므로 서버가 준 baseline 대신
  // positions[].zSeq 길이에 맞춰 최근 N일을 쓴다. 값은 valueSeq로 별도 전달됨.
  const nDays = Math.min(DAYS, Math.max(...rows.map((r) => (r.valueSeq || []).length)) || 0);
  if (!nDays) { wrap.innerHTML = '<div class="fempty">시계열 없음</div>'; return; }

  const grid = document.createElement('div');
  grid.className = 'matrix';
  // 트랙에 바닥(24px)을 줘야 좁은 화면에서 칸이 뭉개지는 대신 가로 스크롤이 생긴다
  grid.style.gridTemplateColumns = `110px repeat(${nDays}, minmax(24px, 1fr)) 150px`;

  // 헤더 행 (날짜) — 세로쓰기는 읽기 어려워서 가로로 눕히고 격주로만 표기
  grid.appendChild(cell('', 'm-label'));
  for (let i = nDays - 1; i >= 0; i--) {
    const dt = d.dates?.[i];
    const isToday = i === 0;
    const show = isToday || i % 4 === 0;      // 4칸마다 + 오늘
    // 칸 폭이 좁아 'MM/DD' 5글자가 안 들어간다 — 일만 쓰고, 월이 바뀌는 칸에만 월을 붙인다
    let txt = '';
    if (show && dt) {
      const [, mm, dd] = dt.split('-');
      const prevMm = d.dates?.[i + 1]?.split('-')[1];
      txt = isToday ? '오늘' : (mm !== prevMm ? `${+mm}/${+dd}` : `${+dd}`);
    }
    const e = cell(txt, `m-date${isToday ? ' today' : ''}`);
    e.dataset.day = i;
    grid.appendChild(e);
  }
  grid.appendChild(cell('', 'm-label'));

  let prevGroup = null;
  for (const r of rows) {
    // 주요 4주체와 기관 7세부 사이에 구분선 한 줄
    if (prevGroup === 'main' && r.group === 'inst') {
      const sep = cell('기관 내부', 'm-sep-label');
      grid.appendChild(sep);
      for (let i = 0; i < nDays; i++) grid.appendChild(cell('', 'm-sep'));
      grid.appendChild(cell('', 'm-sep'));
    }
    prevGroup = r.group;

    const lbl = cell('', `m-label${r.group === 'inst' ? ' inst' : ' main'}`);
    lbl.textContent = r.label;
    grid.appendChild(lbl);

    const seq = r.valueSeq || [];
    const scale = barScale(seq);
    const mask = streakMode ? streakMask(seq) : null;
    for (let i = nDays - 1; i >= 0; i--) {
      const v = seq[i];
      // 5칸(약 1주)마다 왼쪽에 여백을 줘서 눈이 끊어 읽을 수 있게
      const weekEdge = i % 5 === 4 ? ' week-edge' : '';
      const c = cell('', `m-cell${v == null ? ' missing' : ''}${i === 0 ? ' today' : ''}${r.group === 'inst' ? ' inst-row' : ''}${weekEdge}`);

      // 색 농도 대신 막대 길이로 크기를 표현한다.
      // 어두운 배경에선 연한 빨강/파랑이 둘 다 탁한 무채색으로 보여 구분이 안 됐다.
      if (v != null) {
        // 셀 높이의 절반(=0선에서 위 또는 아래)이 막대의 최대치. 넘치면 잘라서 행이 겹치지 않게.
        const h = Math.min(46, (Math.abs(v) / scale) * 46);
        const dim = mask && !mask[i];
        const bar = document.createElement('div');
        bar.className = `m-bar ${v >= 0 ? 'up' : 'down'}${dim ? ' dim' : ''}`;
        bar.style.height = `${Math.max(h, 2).toFixed(1)}%`;
        c.appendChild(bar);
      }
      c.dataset.day = i;
      c.title = `${r.label} ${d.dates?.[i] || ''} ${eok(v)}억`;
      grid.appendChild(c);
    }

    // 요약: 연속일수 + 순위
    const sum = cell('', 'm-summary');
    const st = r.streak;
    const flip = st && seq[0] != null && Math.sign(seq[0]) !== (st.direction === 'buy' ? 1 : -1);
    sum.innerHTML = `
      <span class="m-streak ${flip ? 'flip' : st ? (st.direction === 'buy' ? 'buy-t' : 'sell-t') : 'flat-t'}">${
        st ? `${st.direction === 'buy' ? '매수' : '매도'} ${st.days}일${flip ? '↺' : ''}` : '—'}</span>
      <span class="m-rank">${r.rank ? `${r.rank.rank}/${r.rank.of}` : ''}</span>`;
    grid.appendChild(sum);
  }

  wrap.innerHTML = '';
  wrap.appendChild(grid);

  // 스크러버 읽기 패널 — 재렌더링 때 중복 생성되지 않게 한 번만 만든다
  if (!$('#scrubRead')) {
    const read = document.createElement('div');
    read.className = 'scrub-read';
    read.id = 'scrubRead';
    wrap.parentElement.insertBefore(read, $('.scrub-hint'));
  }

  attachScrubber(grid, d, rows);
}

function cell(text, cls) {
  const e = document.createElement('div');
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/* 타임 스크러버 — 격자 위 이동 시 그날 전체를 한 줄로 정렬해 보여준다.
 * (원안의 분 단위 되감기는 서버 상시가동이 필요해 '일 단위'로 격하시킨 버전) */
function attachScrubber(grid, d, rows) {
  const read = $('#scrubRead');

  function show(day) {
    if (day == null) { grid.classList.remove('m-col-hover'); read.classList.remove('on'); state.hoverDay = null; return; }
    state.hoverDay = day;
    grid.classList.add('m-col-hover');
    grid.querySelectorAll('.m-cell.hl, .m-date.hl').forEach((e) => e.classList.remove('hl'));
    grid.querySelectorAll(`[data-day="${day}"]`).forEach((e) => e.classList.add('hl'));

    read.classList.add('on');
    read.innerHTML = `
      <div class="scrub-date">${esc(d.dates?.[day] || '')}${day === 0 ? ' (오늘 · 잠정)' : ''}</div>
      <div class="scrub-rows">${rows.map((r) => {
        const v = (r.valueSeq || [])[day];
        return `<div class="scrub-row"><span class="sr-label">${esc(r.label)}</span><span class="sr-val ${dirClass(v)}">${eok(v)}억</span></div>`;
      }).join('')}</div>`;
  }

  grid.addEventListener('pointermove', (e) => {
    if (scrubPinned) return;                 // 고정 중엔 hover가 못 덮어쓴다
    const t = e.target.closest('[data-day]');
    if (t) show(Number(t.dataset.day));
  });
  // 값을 읽으러 마우스를 패널로 내리는 동작이 패널을 지우던 버그:
  // 클릭하면 고정되고, 고정 중엔 격자를 벗어나도 남는다.
  grid.addEventListener('click', (e) => {
    const t = e.target.closest('[data-day]');
    if (!t) return;
    scrubPinned = true;
    show(Number(t.dataset.day));
  });
  grid.addEventListener('pointerleave', () => { if (!scrubPinned) show(null); });

  // 키보드 핸들러는 문서에 한 번만 붙인다 (매트릭스는 여러 번 다시 그려진다)
  scrubShow = show;
  scrubMax = Math.min(DAYS, (rows[0]?.valueSeq || []).length) - 1;
}

let scrubShow = null;
let scrubMax = 0;
let scrubPinned = false;

// 고정 해제 — Esc 또는 격자/패널 바깥 클릭
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && scrubPinned) {
    scrubPinned = false;
    if (scrubShow) scrubShow(null);
    return;
  }
  if (!scrubShow) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  let day = state.hoverDay ?? 0;
  day += e.key === 'ArrowLeft' ? 1 : -1;     // 왼쪽 = 과거
  scrubPinned = true;                        // 키보드로 고른 날짜도 고정
  scrubShow(Math.max(0, Math.min(scrubMax, day)));
  e.preventDefault();
});

document.addEventListener('click', (e) => {
  if (!scrubPinned) return;
  if (e.target.closest('.matrix') || e.target.closest('#scrubRead')) return;
  scrubPinned = false;
  if (scrubShow) scrubShow(null);
});

/* ── ③ 기관 대립 ── */
function renderSplit(d) {
  const s = d.split;
  const body = $('#splitBody');
  if (!s || (!s.buyers.length && !s.sellers.length)) {
    body.innerHTML = '<div class="fempty">장중에는 기관 세부가 아직 안 나와요</div>';
    $('#splitNote').textContent = '';
    return;
  }
  // 양쪽을 같은 척도로 재야 "금융투자가 압도적"이라는 게 눈에 보인다
  const maxAbs = Math.max(...[...s.buyers, ...s.sellers].map((m) => Math.abs(m.value)), 1);
  const item = (m) => {
    const w = (Math.abs(m.value) / maxAbs) * 100;
    return `
    <div class="split-item">
      <div class="si-top">
        <span class="si-name">${esc(m.label)}${m.streak ? `<span class="si-streak">${m.streak.direction === 'buy' ? '매수' : '매도'}${m.streak.days}일</span>` : ''}</span>
        <span class="si-val ${dirClass(m.value)}">${eok(m.value)}억</span>
      </div>
      <div class="si-track"><div class="si-bar ${m.value >= 0 ? 'buy' : 'sell'}" style="width:${w.toFixed(1)}%"></div></div>
    </div>`;
  };

  body.innerHTML = `
    <div class="split-cols">
      <div class="split-side buy"><h3>사는 쪽 ${s.buyers.length}</h3>${s.buyers.map(item).join('') || '<div class="fempty">없음</div>'}</div>
      <div class="split-side sell"><h3>파는 쪽 ${s.sellers.length}</h3>${s.sellers.map(item).join('') || '<div class="fempty">없음</div>'}</div>
    </div>
    ${s.dispersionZ != null ? `<div class="disp-bar">내부 분열도 ${s.dispersionZ.toFixed(2)}σ — ${
      Math.abs(s.dispersionZ) > 1.5 ? '평소보다 방향이 갈렸습니다' : '평소 수준'}</div>` : ''}`;
  $('#splitNote').textContent = s.provisional ? '일부 잠정' : '확정치';
}

/* ── ④ 배신자 ── */
function renderTraitors(d) {
  const body = $('#traitorBody');
  if (!d.traitors?.length) {
    body.innerHTML = '<div class="fempty">오늘 방향을 튼 주체는 없습니다</div>';
    return;
  }
  body.innerHTML = d.traitors.map((t) => `
    <div class="traitor">
      <span class="tr-name">${esc(t.label)}</span>
      <span class="tr-story">
        <span class="${t.wasDirection === 'buy' ? 'buy-t' : 'sell-t'}">${t.wasDays}일 연속 ${t.wasDirection === 'buy' ? '순매수' : '순매도'}</span>
        <span class="tr-arrow"> → </span>
        <span class="${dirClass(t.todayValue)}">오늘 ${eok(t.todayValue)}억</span>
      </span>
    </div>`).join('');
}

/* ── ⑤ 스캐너 ── */
async function renderScan() {
  const wrap = $('#scanWrap');
  // 대시보드와 같은 목록을 읽는다. 아직 한 번도 안 열었으면 비어 있으므로 기본값으로 대체.
  let watchlist = [];
  try {
    watchlist = JSON.parse(localStorage.getItem('watchlist-v1') || '[]');
    // 구버전 문자열 항목 정규화 — 안 하면 아래 w.id.slice 에서 던진다
    if (!Array.isArray(watchlist)) watchlist = [];
    watchlist = watchlist.map((x) => (typeof x === 'string' ? { id: x, name: x.replace(/^[A-Z]+:/, '') } : x))
      .filter((x) => x && typeof x.id === 'string');
  } catch {}
  if (!watchlist.length) {
    watchlist = [
      { id: 'KR:005930', name: '삼성전자' },
      { id: 'KR:000660', name: 'SK하이닉스' },
      { id: 'KR:035420', name: 'NAVER' },
    ];
  }
  const codes = watchlist.filter((w) => w.id?.startsWith('KR:')).map((w) => w.id.slice(3));
  if (!codes.length) {
    wrap.innerHTML = '<div class="fempty">대시보드에서 국내 관심종목을 추가하면 여기 나타나요</div>';
    return;
  }
  const nameBy = Object.fromEntries(watchlist.map((w) => [w.id.slice(3), w.name]));

  try {
    const { stocks, unavailable } = await api(`/api/flow/scan?codes=${codes.join(',')}`);
    if (unavailable) { wrap.innerHTML = '<div class="fempty">토스 API 키가 필요해요</div>'; return; }
    if (!stocks?.length) { wrap.innerHTML = '<div class="fempty">데이터 없음</div>'; return; }

    // 세력이 세게 들어온 종목이 위로 — 등록 순서는 여기선 의미가 없다
    const heat = (s) => Math.abs(s.foreign?.intensity || 0) + Math.abs(s.institution?.intensity || 0);
    stocks.sort((a, b) => heat(b) - heat(a));

    const maxInt = Math.max(...stocks.flatMap((s) => [s.foreign, s.institution].map((x) => Math.abs(x?.intensity || 0))), 1);
    const bar = (v) => {
      if (v == null) return '';
      const w = Math.min(46, (Math.abs(v) / maxInt) * 46);
      return `<span class="intensity-bar" style="width:${w}px;background:${v >= 0 ? 'var(--buy)' : 'var(--sell)'}"></span>`;
    };
    const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`);

    wrap.innerHTML = `
      <table>
        <thead><tr>
          <th class="al">종목</th><th class="ar">현재가</th><th class="ar" title="토스 일봉의 전일 종가 기준 — KRX 공식 등락률과 소수점이 다를 수 있어요">등락<span class="th-src">토스</span></th>
          <th class="ar">외국인 강도</th><th class="ar">기관 강도</th>
          <th class="ar">연기금</th><th class="ar">이격도</th><th class="ar">거래량</th>
        </tr></thead>
        <tbody>${stocks.map((s) => `
          <tr>
            <td class="al">${esc(nameBy[s.code] || s.code)}</td>
            <td class="ar num">${s.close != null ? nf.format(s.close) : '—'}</td>
            <td class="ar num ${dirClass(s.changePct)}">${pct(s.changePct)}</td>
            <td class="ar num ${dirClass(s.foreign?.intensity)}">${pct(s.foreign?.intensity)}${bar(s.foreign?.intensity)}</td>
            <td class="ar num ${dirClass(s.institution?.intensity)}">${pct(s.institution?.intensity)}${bar(s.institution?.intensity)}</td>
            <td class="ar num ${dirClass(s.pensionFund?.intensity)}">${pct(s.pensionFund?.intensity)}</td>
            <td class="ar num ${dirClass(s.disparity)}">${pct(s.disparity)}</td>
            <td class="ar num">${s.volumeRatio != null ? s.volumeRatio.toFixed(2) + '배' : '—'}</td>
          </tr>`).join('')}</tbody>
      </table>
      ${stocks.every((s) => s.pensionFund == null)
        ? '<p class="scan-foot">연기금 열이 비어 있는 건 오류가 아니에요 — 종목별 기관 세부는 장 마감 후 확정치에서 채워집니다.</p>'
        : ''}
      <p class="scan-foot">거래량 배수는 장중 경과율로 보정한 값이라 장 초반에는 흔들릴 수 있어요.
        현재가·등락은 토스 일봉 기준(NXT 포함 종가)이라 KRX 공식 등락률과 소수점이 다를 수 있어요.
        <span class="scan-at">${new Date().toLocaleTimeString('en-GB', { hour12: false })} 기준</span></p>`;
  } catch (e) {
    console.warn('scan', e);
    wrap.innerHTML = '<div class="fempty">스캔에 실패했어요</div>';
  }
}

/* ── ⑥ 감사 로그 ── */
function renderAudit(d) {
  const a = d.audit;
  $('#auditSummary').textContent =
    `검사 로그 — 주체 ${a.actorsChecked}개 · ${a.daysAvailable}일 · 결측 ${a.missingToday.length}건`;
  $('#auditBody').textContent = [
    `기준일        ${d.asOf || '-'}`,
    `갱신          ${d.updatedAt || '-'}`,
    `검사 주체     ${a.actorsChecked}개 (개인·외국인·기관·기타법인 + 기관 7세부)`,
    `보유 일수     ${a.daysAvailable}일`,
    `당일 결측     ${a.missingToday.length ? a.missingToday.join(', ') : '없음'}`,
    `표본 부족     ${a.insufficient.length ? a.insufficient.join(', ') : '없음'}`,
    `통계          로버스트 z(중앙값·MAD 기준) · 순위는 최근 100거래일 경험적 순위`,
    `주의          ${a.note}`,
    `출처          토스증권 Open API`,
  ].join('\n');
}

/* ── 로드 ── */
async function load() {
  try {
    const d = await api(`/api/flow/market?market=${state.market}`);
    if (d.unavailable) {
      $('#verdict').innerHTML = '<div class="v-loading">토스증권 API 키가 필요해요 (.env 설정)</div>';
      return;
    }
    state.data = d;
    renderVerdict(d);
    renderStats(d);
    renderMatrix(d);
    renderSplit(d);
    renderTraitors(d);
    renderAudit(d);
    // 갱신 상태 — 성공
    document.body.classList.remove('stale');
    $('#fDot')?.classList.remove('error');
    const u = $('#fUpdated');
    if (u) u.textContent = `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`;
  } catch (e) {
    console.warn('flow', e);
    // 실패 — 5개 섹션이 낡은 값을 그대로 보여주므로 화면 전체에 '오래됨' 표시
    document.body.classList.add('stale');
    $('#fDot')?.classList.add('error');
    const u = $('#fUpdated');
    if (u) u.textContent = '갱신 실패 — 표시된 값은 이전 것';
    if (!state.data) $('#verdict').innerHTML = '<div class="v-loading">데이터를 불러오지 못했어요</div>';
  }
}

// 매트릭스 옵션 — 데이터는 그대로 두고 다시 그리기만 한다
for (const id of ['#showInst', '#streakOnly']) {
  $(id).addEventListener('change', () => { if (state.data) renderMatrix(state.data); });
}

$('#marketToggle').addEventListener('click', (e) => {
  const b = e.target.closest('.mkt');
  if (!b || b.dataset.market === state.market) return;
  state.market = b.dataset.market;
  document.querySelectorAll('.mkt').forEach((x) => x.classList.toggle('active', x === b));
  load();
});

load();
renderScan();
setInterval(() => { if (!document.hidden) load(); }, REFRESH);
// 스캔은 서버 TTL 이 120초라 따로 돌린다 — 안 돌리면 표만 로드 시점에 얼어붙는다
setInterval(() => { if (!document.hidden) renderScan(); }, 120000);
