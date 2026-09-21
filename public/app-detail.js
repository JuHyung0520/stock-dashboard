/* 종목 상세 — 선택, 상세 탭(호가·수급·공매도·프로그램·신용·대차), 호가 폴링.
 *
 * app.js 가 1,184줄 한 덩어리라 한 기능을 고치려면 전체를 훑어야 했다. 구획 단위로 갈랐다.
 * 모두 클래식 스크립트라 최상위 선언을 서로 그대로 공유한다(같은 전역 렉시컬 환경) —
 * 그래서 **같은 이름을 두 파일에 선언하면 안 된다**(already been declared 로 즉사). */

/* ── selection → detail + stock news ─── */
function clearSelection() {
  state.selectedId = null;
  $('#detailPanel').hidden = true;
  const tab = $('#stockNewsTab');
  tab.disabled = true;
  tab.textContent = '종목 뉴스';
  if (state.newsTab === 'stock') switchNewsTab('main');
}

async function selectStock(id, { scroll = true } = {}) {
  state.selectedId = id;
  renderQuotes();
  if (state.view === 'card') renderCards();   // 카드 뷰의 선택 테두리 — 표만 다시 그려서 다음 폴링까지 옛 카드에 남아 있었다
  const w = state.watchlist.find((x) => x.id === id);
  const q = state.quotes.get(id);
  const name = (q && q.name) || (w && w.name) || id;

  $('#detailPanel').hidden = false;
  // 1열 스택 모드에선 상세 패널이 화면 밖일 수 있다 — 직접 선택했을 때만 스크롤
  // (자동 첫 선택이 페이지를 끌어내리면 안 되고, 폭 0으로 로드되는 환경도 방어)
  if (scroll && window.innerWidth > 0 && window.innerWidth <= 980) {
    $('#detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#detailName').textContent = name;
  $('#detailPrice').innerHTML = q
    ? `<span>${fmtPrice(q)}</span><span class="dp-change ${moveClass(q.change)}">${fmtChange(q)} (${fmtPct(q.changePct)})</span>`
    : '';

  const tab = $('#stockNewsTab');
  tab.disabled = false;
  tab.textContent = `${name} 뉴스`;
  switchNewsTab('stock');

  // 미국 종목은 국내 전용 지표(수급·공매도 등)가 없어 탭을 잠근다. 호가는 미국도 되므로 예외.
  const isKR = id.startsWith('KR:');
  document.querySelectorAll('#detailTabs .tab').forEach((b) => {
    const locked = !isKR && b.dataset.dtab !== 'orderbook';
    b.disabled = locked;
    // 잠긴 이유를 말해준다 — disabled는 클릭이 무시돼 안내 문구에 도달할 수 없다
    b.title = locked ? '미국 종목은 국내 수급·공매도 지표가 제공되지 않아요' : '';
  });
  // 종목을 바꿔도 보던 탭을 유지한다 (미국 종목은 호가만 가능하므로 예외)
  state.detailTab = isKR ? (localStorage.getItem('detailTab-v1') || 'orderbook') : 'orderbook';
  syncDetailTabs();
  renderDetailTab();
}

/* ── detail panel tabs ───────────────── */
function syncDetailTabs() {
  document.querySelectorAll('#detailTabs .tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.dtab === state.detailTab));
}

// 오류 화면의 "다시 시도" — 현재 탭을 다시 그린다
$('#invDailyWrap').addEventListener('click', (e) => {
  if (e.target.closest('.retry-btn')) renderDetailTab();
});

$('#detailTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn || btn.disabled) return;   // 같은 탭 재클릭 허용 — 실패한 탭의 재시도 경로
  state.detailTab = btn.dataset.dtab;
  localStorage.setItem('detailTab-v1', btn.dataset.dtab);
  syncDetailTabs();
  renderDetailTab();
});

async function renderDetailTab() {
  const id = state.selectedId;
  if (!id) return;
  const wrap = $('#invDailyWrap');
  const hint = $('#detailHint');

  // 호가 탭을 떠나면 폴링을 반드시 멈춘다
  if (state.detailTab !== 'orderbook') stopOrderbookPolling();

  // 호가는 미국 종목도 지원하므로 국내 전용 차단보다 먼저 처리
  if (state.detailTab === 'orderbook') {
    wrap.innerHTML = '<div class="inv-empty">불러오는 중…</div>';
    try {
      return await renderOrderbookTab(id, wrap, hint);
    } catch (e) {
      console.warn('orderbook', e);
      wrap.innerHTML = '<div class="inv-empty">호가를 불러오지 못했어요 <button class="retry-btn">다시 시도</button></div>';
      return;
    }
  }

  if (!id.startsWith('KR:')) {
    wrap.innerHTML = '<div class="inv-empty">미국 종목은 국내 수급·공매도 지표가 제공되지 않아요</div>';
    hint.textContent = '';
    return;
  }
  const code = id.slice(3);
  const tab = state.detailTab;
  wrap.innerHTML = '<div class="inv-empty">불러오는 중…</div>';

  try {
    if (tab === 'investor') return await renderInvestorTab(id, code, wrap, hint);
    return await renderMetricTab(id, code, tab, wrap, hint);
  } catch (e) {
    console.warn('detail', tab, e);
    if (state.selectedId === id && state.detailTab === tab) {
      wrap.innerHTML = '<div class="inv-empty">데이터를 불러오지 못했어요 <button class="retry-btn">다시 시도</button></div>';
      hint.textContent = '';
    }
  }
}

async function renderInvestorTab(id, code, wrap, hint) {
  {
    const data = await api(`/api/investor/stock/${encodeURIComponent(code)}`);
    if (state.selectedId !== id || state.detailTab !== 'investor') return; // 그새 바뀜
    if (!data.days.length) {
      wrap.innerHTML = '<div class="inv-empty">수급 데이터 없음</div>';
      return;
    }
    // 토스는 개인·연기금까지 주고, 네이버는 종가·등락률을 주므로 컬럼이 다르다
    const cols = data.source === 'toss'
      ? [
          { th: '개인', get: (d) => d.individual },
          { th: '외국인', get: (d) => d.foreign },
          { th: '기관', get: (d) => d.institution },
          { th: '연기금', get: (d) => d.pensionFund },
        ]
      : [
          { th: '외국인', get: (d) => d.foreign },
          { th: '기관', get: (d) => d.institution },
        ];

    const head = data.source === 'toss'
      ? `<th class="al">날짜</th>${cols.map((c) => `<th class="ar">${c.th}</th>`).join('')}`
      : `<th class="al">날짜</th><th class="ar">종가</th><th class="ar">등락률</th>${cols.map((c) => `<th class="ar">${c.th}</th>`).join('')}`;

    const rows = data.days.slice(0, 10).map((d) => {
      const lead = data.source === 'toss'
        ? `<td class="al">${d.date}</td>`
        : `<td class="al">${d.date}</td><td class="ar num">${fmtKR.format(d.close)}</td><td class="ar num ${moveClass(d.changePct)}">${fmtPct(d.changePct)}</td>`;
      const cells = cols.map((c) => {
        const v = c.get(d);
        return `<td class="ar num ${moveClass(v)}">${fmtShares(v)}</td>`;
      }).join('');
      return `<tr>${lead}${cells}</tr>`;
    }).join('');

    wrap.innerHTML = `<table class="inv-daily"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;

    const holdRate = data.days.find((d) => d.foreignHoldRate != null)?.foreignHoldRate;
    const src = data.source === 'toss' ? '토스증권 Open API' : '네이버 금융';
    hint.textContent = [
      `일별 순매수 수량(주) · 출처 ${src}`,
      holdRate != null ? `외국인 보유율 ${holdRate.toFixed(2)}%` : null,
      data.note,
    ].filter(Boolean).join(' · ');
  }
}

/* ── 호가창 ──
 * 국내 관례대로 매도호가가 위(파랑), 매수호가가 아래(빨강).
 * 막대 길이 = 잔량. 매도벽/매수벽이 어디 쌓였는지 눈으로 보라고 만든 화면이다.
 * 유일하게 초 단위로 바뀌는 데이터라 장중에만 자동 갱신한다. */
let obTimer = null;

/* 세대 번호. 종목을 빠르게 두 번 바꾸면 첫 호출이 `await draw()` 에서 자고 있다가
 * 뒤늦게 깨어나 **이미 지나간 종목의** 인터벌을 obTimer 에 덮어썼다.
 * 그러면 앞 인터벌은 참조를 잃어 영원히 살아남고(좀비), 그 좀비가 2초 뒤
 * "내 종목이 아니네" 하며 stopOrderbookPolling() 을 불러 **현재 종목의 타이머**를 죽였다.
 * 증상은 '호가가 갑자기 안 움직임'인데 오류가 없어서 원인을 알 수 없었다. */
let obSeq = 0;

function stopOrderbookPolling() {
  if (obTimer) { clearInterval(obTimer); obTimer = null; }
}

// 국내 정규장(09:00~15:30 KST)인지 — 장 끝나면 굳이 계속 긁지 않는다
function isKRMarketOpen() {
  const kst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const day = kst.getDay();
  if (day === 0 || day === 6) return false;
  const min = kst.getHours() * 60 + kst.getMinutes();
  return min >= 540 && min <= 930;
}

async function renderOrderbookTab(id, wrap, hint) {
  const seq = ++obSeq;
  stopOrderbookPolling();

  const draw = async () => {
    // 그새 다른 탭/종목으로 옮겨갔으면 중단.
    // 단, 내 세대가 아니면 남의 타이머는 건드리지 않는다 — 그게 좀비가 현재 폴링을 죽이던 경로다.
    if (seq !== obSeq) return;
    if (state.selectedId !== id || state.detailTab !== 'orderbook') { stopOrderbookPolling(); return; }
    let d;
    try {
      d = await api(`/api/orderbook/${encodeURIComponent(id)}`);
    } catch (e) {
      stopOrderbookPolling();
      wrap.innerHTML = '<div class="inv-empty">호가를 불러오지 못했어요 <button class="retry-btn">다시 시도</button></div>';
      return;
    }
    if (state.selectedId !== id || state.detailTab !== 'orderbook') return;
    if (d.unavailable) {
      wrap.innerHTML = '<div class="inv-empty">토스증권 API 키가 필요해요</div>';
      stopOrderbookPolling();
      return;
    }
    if (!d.asks?.length && !d.bids?.length) {
      wrap.innerHTML = '<div class="inv-empty">호가 정보가 없어요 (장 시작 전이거나 거래정지)</div>';
      return;
    }

    const isUSD = d.currency === 'USD';
    const fmtP = (v) => (isUSD ? `$${fmtUS.format(v)}` : fmtKR.format(v));
    const maxVol = Math.max(...[...d.asks, ...d.bids].map((x) => x.volume), 1);
    const askTotal = d.asks.reduce((a, b) => a + b.volume, 0);
    const bidTotal = d.bids.reduce((a, b) => a + b.volume, 0);

    // 매도는 높은 가격이 위로 오게 뒤집는다 (호가창 관례)
    const askRows = [...d.asks].reverse().map((x) => obRow(x, 'ask', maxVol, fmtP));
    const bidRows = d.bids.map((x) => obRow(x, 'bid', maxVol, fmtP));

    const spread = d.asks[0] && d.bids[0] ? d.asks[0].price - d.bids[0].price : null;
    const ratio = bidTotal + askTotal ? (bidTotal / (bidTotal + askTotal)) * 100 : 50;

    wrap.innerHTML = `
      <div class="ob">
        ${askRows.join('')}
        <div class="ob-mid">
          <span class="ob-spread">스프레드 ${spread != null ? fmtP(spread) : '—'}</span>
        </div>
        ${bidRows.join('')}
      </div>
      <div class="ob-totals">
        <div class="ob-tbar">
          <div class="ob-tfill bid" style="width:${ratio.toFixed(1)}%"></div>
        </div>
        <div class="ob-tnums">
          <span class="up">매수 ${fmtVolume(bidTotal)}</span>
          <span class="ob-tratio">${ratio.toFixed(0)} : ${(100 - ratio).toFixed(0)}</span>
          <span class="down">매도 ${fmtVolume(askTotal)}</span>
        </div>
      </div>`;

    const t = d.timestamp ? new Date(d.timestamp).toLocaleTimeString('en-GB', { hour12: false }) : '';
    hint.textContent = `총잔량 비율은 10단계 합계 기준 · ${t} 기준${isKRMarketOpen() ? ' · 2초마다 갱신' : ' · 장 마감 (갱신 중지)'}`;
  };

  await draw();
  // 자는 사이에 다른 종목으로 넘어갔으면 타이머를 아예 걸지 않는다 (좀비 생성 차단)
  if (seq !== obSeq) return;
  // 장중에만 폴링. 장외에는 안 움직이는 숫자를 긁을 이유가 없다.
  if (isKRMarketOpen() && id.startsWith('KR:')) {
    stopOrderbookPolling();          // 덮어쓰기 전에 반드시 회수한다
    obTimer = setInterval(draw, 2000);
  }
}

function obRow(x, side, maxVol, fmtP) {
  const w = (x.volume / maxVol) * 100;
  return `
    <div class="ob-row ${side}">
      <span class="ob-vol">${side === 'bid' ? '' : fmtVolume(x.volume)}</span>
      <span class="ob-price">${fmtP(x.price)}</span>
      <span class="ob-vol">${side === 'bid' ? fmtVolume(x.volume) : ''}</span>
      <div class="ob-bar ${side}" style="width:${w.toFixed(1)}%"></div>
    </div>`;
}

/* 공매도·프로그램·신용·대차 — 4종 모두 한 번에 받아와 서버에서 10분 캐싱된다 */
const METRIC_VIEWS = {
  short: {
    rows: (m) => m.shortSelling,
    cols: [
      { th: '공매도량', get: (r) => fmtQty(r.volume), cls: () => '' },
      { th: '비중', get: (r) => (r.volumeRate != null ? r.volumeRate.toFixed(2) + '%' : '—'), cls: () => '' },
      { th: '금액', get: (r) => fmtWon(r.amount), cls: () => '' },
    ],
    hint: '공매도 비중 = 그날 전체 거래량 대비 공매도 비율. 높을수록 하락 베팅이 많았다는 뜻.',
  },
  program: {
    rows: (m) => m.program,
    cols: [
      { th: '차익', get: (r) => fmtShares(r.arbitrage), cls: (r) => moveClass(r.arbitrage) },
      { th: '비차익', get: (r) => fmtShares(r.nonArbitrage), cls: (r) => moveClass(r.nonArbitrage) },
      { th: '합계', get: (r) => fmtShares(r.total), cls: (r) => moveClass(r.total) },
    ],
    hint: '프로그램 순매수(주). 비차익이 기관 바스켓 매매 흐름에 가깝다.',
  },
  credit: {
    rows: (m) => m.credit,
    cols: [
      { th: '융자잔고', get: (r) => fmtQty(r.loanBalance), cls: () => '' },
      { th: '신규', get: (r) => fmtQty(r.loanNew), cls: () => '' },
      { th: '상환', get: (r) => fmtQty(r.loanReturn), cls: () => '' },
    ],
    hint: '융자잔고 = 빚내서 매수한 채 남아있는 물량(주). 급증 후 하락하면 반대매매 압력이 된다.',
  },
  lending: {
    rows: (m) => m.lending,
    cols: [
      { th: '잔고', get: (r) => fmtQty(r.balance), cls: () => '' },
      { th: '체결', get: (r) => fmtQty(r.execution), cls: () => '' },
      { th: '상환', get: (r) => fmtQty(r.repayment), cls: () => '' },
    ],
    hint: '대차잔고 = 빌려간 채 안 갚은 주식(주). 공매도 대기 물량으로 읽힌다.',
  },
};

async function renderMetricTab(id, code, tab, wrap, hint) {
  const m = await api(`/api/metrics/${encodeURIComponent(code)}`);
  if (state.selectedId !== id || state.detailTab !== tab) return;
  if (m.unavailable) {
    wrap.innerHTML = '<div class="inv-empty">토스증권 API 키가 있어야 볼 수 있어요<br><span style="font-size:var(--fs-2xs)">.env에 TOSS_CLIENT_ID / SECRET 설정</span></div>';
    hint.textContent = '';
    return;
  }
  const view = METRIC_VIEWS[tab];
  const rows = view.rows(m) || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="inv-empty">데이터 없음</div>';
    hint.textContent = '';
    return;
  }
  const head = `<th class="al">날짜</th>${view.cols.map((c) => `<th class="ar">${c.th}</th>`).join('')}`;
  const body = rows.slice(0, 10).map((r) => `
    <tr>
      <td class="al">${r.date ? r.date.slice(5).replace('-', '/') : ''}</td>
      ${view.cols.map((c) => `<td class="ar num ${c.cls(r)}">${c.get(r)}</td>`).join('')}
    </tr>`).join('');

  wrap.innerHTML = `<table class="inv-daily"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  hint.textContent = `${view.hint} · 출처 토스증권 Open API`;
}

// 잔고·거래량처럼 방향성 없는 수량 (부호 없이)
function fmtQty(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e4) return `${(abs / 1e4).toFixed(1)}만`;
  return fmtKR.format(abs);
}

// 억/조 단위 원화
function fmtWon(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + '조';
  if (abs >= 1e8) return Math.round(v / 1e8).toLocaleString('ko-KR') + '억';
  return fmtKR.format(v);
}

function fmtShares(v) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  const abs = Math.abs(v);
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}만`;
  return `${sign}${fmtKR.format(abs)}`;
}
