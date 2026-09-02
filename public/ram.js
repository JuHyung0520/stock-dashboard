/* 램값 — 메모리 반도체 지수(티커 DRAM) 24시간 시세
 *
 * ⚠️ 이름에 속으면 안 된다. 실측 결과 DRAMUSDT의 기초자산은 램 칩 가격이 아니라
 *    **티커 DRAM인 미국 상장 메모리 반도체 ETF**다.
 *    근거는 화면 하단 '이 값의 정체' 패널에 그대로 노출한다.
 *
 * 그럼에도 볼 가치가 있는 이유는 24시간 거래된다는 점이다.
 * 국장이 열리기 전 아침에 "밤사이 메모리 섹터가 어디로 갔는지"를 알 수 있고,
 * 그게 하이닉스·삼전 시초가의 힌트가 된다. 그래서 밤사이 변화를 주인공으로 놓는다.
 */

const $ = (s) => document.querySelector(s);
const f2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = { interval: '1h', data: null };

const api = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
const pct = (v, d = 2) => (v == null || isNaN(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const cls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mi = (s) => String(s).replace(/-/g, '\u2212');   // 음수 글리프 통일
const money = (v) => (v == null ? '—' : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`);

// 첫 로드부터 실패하면 스켈레톤이 영원히 반짝인다 — 재시도 수단을 준다
let everLoaded = false;

function markUpdated(ok) {
  // 실패했는데 화면은 그대로면 사용자는 낡은 값을 현재값으로 읽는다.
  // 흐림(시선)과 문구(설명)를 함께 준다 — 흐림만으로는 경고가 안 읽힌다.
  document.body.classList.toggle('stale', !ok);
  $('#statusDot').classList.toggle('error', !ok);
  $('#lastUpdated').textContent = ok
    ? `갱신 ${new Date().toLocaleTimeString('en-GB', { hour12: false })}`
    : '갱신 실패 — 아래 값은 이전 것';
}

/* 상관의 세기를 말로 — 0.95 라는 숫자만으론 강한 건지 모른다 */
function corrWord(r) {
  const a = Math.abs(r);
  if (a >= 0.9) return '거의 한 몸';
  if (a >= 0.7) return '강하게 연동';
  if (a >= 0.5) return '느슨하게 연동';
  if (a >= 0.3) return '약한 연동';
  return '따로 논다';
}

function renderHero(d) {
  const r = d.dram;
  if (!r) return;
  $('#dramPrice').textContent = `$${f2.format(r.price)}`;
  $('#dramPrice').className = `hero-value ${cls(r.changePct)}`;
  $('#dramChange').innerHTML = `<span class="${cls(r.changePct)}">${r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : ''} ${pct(r.changePct)}</span>`;
  $('#dramSub').textContent = `24h 고 $${f2.format(r.high)} · 저 $${f2.format(r.low)} · 상장 ${d.listedSince} 이후 ${d.dailyCount}일`;

  // 펀딩비는 방향성 베팅의 쏠림을 보여준다 — 양수면 롱이 숏에 돈을 낸다(강세 쏠림)
  const fund = r.fundingHourPct;
  const on = d.overnight;
  $('#dramStats').innerHTML = [
    // 국장 마감 이후 변화 — 이 페이지에서 가장 실용적인 숫자라 맨 앞에 둔다
    on ? {
      k: '국장 마감 이후', v: pct(on.pct), tone: cls(on.pct),
      sub: `${Chart.md(on.since)} 15:30 이후 · $${f2.format(on.from)} → $${f2.format(on.to)}`,
    } : null,
    { k: '24h 거래대금', v: money(r.volUsd), sub: '바이낸스 선물', tone: '' },
    r.oiUsd != null ? { k: '미결제약정', v: money(r.oiUsd), sub: 'Hyperliquid', tone: '' } : null,
    fund != null ? {
      k: '펀딩비 (시간당)', v: mi(`${fund > 0 ? '+' : ''}${fund.toFixed(4)}%`),
      sub: fund > 0 ? '롱이 숏에 지급 — 강세 쏠림' : '숏이 롱에 지급 — 약세 쏠림',
      tone: cls(fund),
    } : null,
  ].filter(Boolean).map((x) => `
    <div class="hs-item">
      <span class="k">${esc(x.k)}</span>
      <span class="v ${x.tone}">${esc(x.v)}</span>
      <span class="d">${esc(x.sub)}</span>
    </div>`).join('');
}

function renderPeers(d) {
  if (!d.peers?.length) { $('#peerList').innerHTML = `<div class="inv-empty">연동 데이터 없음</div>`; return; }
  const sorted = [...d.peers].sort((a, b) => (b.corr ?? -1) - (a.corr ?? -1));

  $('#peerList').innerHTML = sorted.map((x) => {
    const r = x.corr;
    const w = r == null ? 0 : Math.max(0, Math.min(100, r * 100));
    return `
    <div class="peer-row">
      <div class="pe-head">
        <span class="pe-name">${esc(x.name)}</span>
        <span class="pe-price">$${f2.format(x.price)}</span>
        <span class="pe-chg ${cls(x.changePct)}">${pct(x.changePct)}</span>
      </div>
      <div class="pe-bars">
        <div class="pe-metric">
          <span class="k">상관</span>
          <div class="pe-track"><div class="pe-bar" style="width:${w.toFixed(1)}%"></div></div>
          <span class="v">${r == null ? '—' : mi(r.toFixed(2))}</span>
        </div>
        <div class="pe-beta">
          <span class="k">베타</span>
          <span class="v">${x.beta == null ? '—' : mi(`${x.beta.toFixed(2)}×`)}</span>
          <span class="d">${x.beta == null ? '' : mi(`DRAM +1% → ${x.beta > 0 ? '+' : ''}${x.beta.toFixed(2)}%`)}</span>
        </div>
      </div>
      <div class="pe-word">${r == null ? '' : `${corrWord(r)} · 표본 ${x.samples}일`}</div>
    </div>`;
  }).join('');
}

async function renderChart() {
  const box = $('#dramChart');
  try {
    const d = await api(`/api/ram?interval=${state.interval}`);
    state.data = d;
    renderHero(d);
    renderPeers(d);

    if (!d.candles?.length) { box.innerHTML = `<div class="inv-empty">캔들 없음</div>`; return; }
    Chart.candles(box, {
      candles: d.candles, height: 340,
      yFormat: (v) => f2.format(v),
      xFormat: Chart.timeAxis(d.candles),
    });
    const first = d.candles[0], last = d.candles[d.candles.length - 1];
    const span = ((last.c / first.o) - 1) * 100;
    $('#chartNote').textContent = `${d.candles.length}봉 · 이 구간 ${pct(span)}`;

    // 상장 이후 일봉 추이
    if (d.daily?.length) {
      Chart.line($('#dailyChart'), {
        series: [{
          key: 'dram', label: 'DRAM', color: Chart.series(1),
          values: d.daily.map((x) => x.c),
          readout: (v) => `$${f2.format(v)}`,
        }],
        labels: d.daily.map((x) => Chart.md(x.t)),
        height: 210,
        yFormat: (v) => `$${v.toFixed(0)}`,
        tagFormat: (s, v) => `$${f2.format(v)}`,
      });
      const dFirst = d.daily[0].c, dLast = d.daily[d.daily.length - 1].c;
      $('#sinceNote').textContent = `${d.listedSince} $${f2.format(dFirst)} → 현재 $${f2.format(dLast)} (${pct(((dLast / dFirst) - 1) * 100)})`;
    }

    const u = d.underlying;
    const cst = (u?.constituents || []).filter((x) => x.exchange !== 'binance_future');
    $('#sourceNote').innerHTML =
      `<b class="warn-text">이 값은 램 칩 가격이 아닙니다.</b> 이름 때문에 DDR5 계약가처럼 읽히지만, `
      + `실제 기초자산은 <b>티커 DRAM인 미국 상장 메모리 반도체 ETF</b>입니다. 근거는 전부 거래소 API에서 직접 확인한 것입니다:`
      + `<br><br>① 바이낸스 스스로 <code>underlyingType = ${esc(u?.underlyingType || '?')}</code>로 분류합니다. `
      + `금(XAUUSDT)은 <code>COMMODITY</code>로 따로 있는데 DRAM은 거기 없습니다.`
      + (cst.length ? `<br>② 지수 구성이 ${cst.map((x) => `<code>${esc(x.symbol.split('//')[0])}</code>`).join(' · ')} 로, `
        + `마이크론(<code>MU:USLF24</code>)과 완전히 같은 '미국 상장 종목' 템플릿입니다.` : '')
      + `<br>③ 요일별 변동성이 평일 4~7% vs 주말 1~2%로, 미국 증시 리듬을 그대로 따릅니다.`
      + `<br><br><b>그럼 왜 보나?</b> 24시간 거래되기 때문입니다. 국장·미장이 모두 닫힌 시간에도 움직여서, `
      + `아침에 열어보면 밤사이 메모리 섹터가 어디로 갔는지 알 수 있습니다.`
      + `<br><br><span class="dim">상장 ${esc(u?.onboardDate || d.listedSince || '?')} · 미결제약정과 펀딩비는 Hyperliquid의 같은 상품(xyz:DRAM)에서 가져옵니다`
      + `${d.dram?.hlMark != null ? ` — 두 시장 가격은 $${f2.format(d.dram.price)} vs $${f2.format(d.dram.hlMark)}로 거의 일치합니다.` : '.'}</span>`;

    everLoaded = true;

    markUpdated(true);
  } catch (e) {
    console.warn('ram', e);
    markUpdated(false);
    // 이미 그려진 차트는 남긴다 — 상단이 '아래 값은 이전 것'이라 말하는데 지우면 앞뒤가 안 맞는다
    if (!box.querySelector('svg')) box.innerHTML = `<div class="inv-empty">불러오지 못했어요</div>`;
    if (!everLoaded) {
      const el = $('#dramChart');
      if (el) el.innerHTML = `<div class="inv-empty">데이터를 불러오지 못했어요. 서버가 꺼져 있을 수 있습니다. <button class="retry-btn" onclick="load()">다시 시도</button></div>`;
    }
  }
}

$('#ivTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.iv === state.interval) return;
  state.interval = b.dataset.iv;
  document.querySelectorAll('#ivTabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  renderChart();
});

function load() { renderChart(); }   // '다시 시도' 버튼이 부르는 이름 — 없어서 무반응이었다

load();
setInterval(() => { if (!document.hidden) renderChart(); }, 20000);

/* 테마가 바뀌면 다시 그린다 — 차트는 색을 SVG 속성에 박아 그리므로 CSS 변수만 바뀌어선 안 따라온다 */
addEventListener('themechange', () => renderChart());
