/* 장 마감 국장 요약 생성기
 * 실행: node wrap.js  →  wraps/YYYY-MM-DD.md 저장 + macOS 알림
 * launchd(com.jk.stock-wrap)가 평일 15:40에 자동 실행한다.
 *
 * 규칙 기반 요약 — LLM 없이 데이터 계층(toss/analysis/metrics)만으로 문장을 만든다.
 * 휴장일이면 (KOSPI 체결일 ≠ 오늘) 조용히 종료.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const toss = require('./toss');
const A = require('./analysis');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const OUT_DIR = path.join(__dirname, 'wraps');

// 요약에 넣을 관심종목 (국내만) — 필요하면 여기를 고치면 된다
const WATCH = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '009150', name: '삼성전기' },
  { code: '402340', name: 'SK스퀘어' },
];

const getJSON = (url) => fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }).then((r) => r.json());
const num = (s) => (s == null ? null : Number(String(s).replace(/[+,]/g, '')));
const eok = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.round(Math.abs(v)).toLocaleString('ko-KR')}억`);
const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);

function kstToday() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD
}

async function main() {
  const today = kstToday();

  /* ── 지수 (휴장 판정 포함) ── */
  const idx = await getJSON('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ');
  const kospi = idx.datas.find((d) => d.itemCode === 'KOSPI');
  const kosdaq = idx.datas.find((d) => d.itemCode === 'KOSDAQ');
  if (!kospi?.localTradedAt?.startsWith(today)) {
    console.log(`휴장일(${today}) — 요약 생략`);
    return;
  }
  const provisional = kospi.marketStatus === 'OPEN';

  const idxLine = (d, name) =>
    `${name.padEnd(4)} ${Number(d.closePriceRaw).toLocaleString('en-US', { minimumFractionDigits: 2 })}  ` +
    `${num(d.compareToPreviousClosePriceRaw) > 0 ? '+' : ''}${d.compareToPreviousClosePriceRaw} (${d.fluctuationsRatioRaw}%)`;

  /* ── 해외·환율 ── */
  let usLine = '', fxLine = '';
  try {
    const us = await getJSON('https://polling.finance.naver.com/api/realtime/worldstock/index/.INX,.IXIC');
    usLine = us.datas.map((d) => `${d.indexName || d.reutersCode} ${d.fluctuationsRatioRaw}%`).join(' · ');
  } catch {}
  try {
    const fx = await getJSON('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW');
    const f = fx.result;
    const sign = f.fluctuationsType?.name === 'FALLING' ? '−' : '+';
    fxLine = `원/달러 ${f.calcPrice}원 (${sign}${Math.abs(num(f.fluctuations))})`;
  } catch {}

  /* ── 시장 수급 (토스, 실패 시 그 시장만 생략) ── */
  const flows = {};
  for (const mkt of ['KOSPI', 'KOSDAQ']) {
    try {
      flows[mkt] = A.buildMarket(await toss.marketFlowSeries(mkt, 100));
    } catch (e) {
      console.error(`${mkt} 수급 실패: ${e.message}`);
    }
  }

  const flowBlock = (m, label) => {
    if (!m) return `### ${label}\n수급 데이터를 가져오지 못했다.\n`;
    const lines = [`### ${label} — ${m.verdict.headline}`, ''];
    if (m.verdict.detail) lines.push(`${m.verdict.detail}`, '');
    lines.push('| 주체 | 순매수 | 99일 순위 | 연속 |', '|---|---|---|---|');
    for (const p of m.positions.filter((x) => x.group === 'main')) {
      const st = p.streak ? `${p.streak.direction === 'buy' ? '매수' : '매도'} ${p.streak.days}일` : '—';
      lines.push(`| ${p.label} | ${eok(p.today)} | ${p.rank ? p.rank.rank + '위' : '—'} | ${st} |`);
    }
    const s = m.split;
    if (s && (s.buyers.length || s.sellers.length)) {
      lines.push('', `기관 내부 — 사는 쪽: ${s.buyers.map((x) => `${x.label} ${eok(x.value)}`).join(', ') || '없음'}`);
      lines.push(`기관 내부 — 파는 쪽: ${s.sellers.map((x) => `${x.label} ${eok(x.value)}`).join(', ') || '없음'}`);
    }
    if (m.traitors.length) {
      lines.push('', `**방향 반전**: ${m.traitors.map((t) =>
        `${t.label}(${t.wasDays}일 ${t.wasDirection === 'buy' ? '매수' : '매도'} → 오늘 ${eok(t.todayValue)})`).join(', ')}`);
    }
    return lines.join('\n') + '\n';
  };

  /* ── 시장 성격 한 줄 (규칙 기반) ── */
  const kp = num(kospi.fluctuationsRatioRaw), kd = num(kosdaq.fluctuationsRatioRaw);
  let character = '';
  if (kp != null && kd != null) {
    const gap = Math.abs(kp - kd);
    if (Math.sign(kp) !== Math.sign(kd) && Math.max(Math.abs(kp), Math.abs(kd)) > 0.5) character = '코스피와 코스닥이 반대로 움직인 날.';
    else if (gap > 2) character = `낙폭/상승폭이 ${Math.abs(kp) > Math.abs(kd) ? '코스피(대형주)' : '코스닥(중소형주)'}에 집중된 날.`;
    else if (Math.abs(kp) < 0.3 && Math.abs(kd) < 0.3) character = '방향 없이 좁게 움직인 날.';
    else character = `양 시장이 같은 방향으로 ${kp > 0 ? '오른' : '내린'} 날.`;
  }

  /* ── 랭킹 ── */
  let rankBlock = '';
  try {
    const parts = [];
    for (const [k, label] of [['amount', '거래대금 상위'], ['gainers', '급상승'], ['losers', '급하락']]) {
      const r = await toss.rankings(k, { count: 5 });
      parts.push(`- **${label}**: ` + r.rows.map((x) => `${x.name} ${pct(x.changePct)}`).join(' · '));
    }
    rankBlock = parts.join('\n');
  } catch (e) { rankBlock = '(랭킹 조회 실패)'; }

  /* ── 관심종목 ── */
  let watchBlock = '';
  try {
    const q = await getJSON(`https://polling.finance.naver.com/api/realtime/domestic/stock/${WATCH.map((w) => w.code).join(',')}`);
    watchBlock = q.datas.map((d) => `- ${d.stockName} ${d.closePrice} (${d.fluctuationsRatio}%)`).join('\n');
  } catch {}

  /* ── 뉴스 헤드라인 ── */
  let newsBlock = '';
  try {
    const n = await getJSON('https://m.stock.naver.com/front-api/news/category?category=mainnews&page=1&pageSize=10');
    newsBlock = n.result.slice(0, 8).map((x) => {
      const t = String(x.title).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
      return `- ${x.datetime.slice(8, 10)}:${x.datetime.slice(10, 12)} [${x.officeName}] ${t}`;
    }).join('\n');
  } catch {}

  /* ── 조립 ── */
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Seoul' }).slice(0, 5); // HH:MM
  const md = `# 국장 마감 요약 — ${today} (${['일','월','화','수','목','금','토'][new Date(today).getDay()]})

> ${now} 생성${provisional ? ' · **장중 잠정치** (마감 전 실행됨)' : ' · 마감 기준 잠정치'} · 수급 확정은 다음 거래일

**${character}**

## 지수·환율

\`\`\`
${idxLine(kospi, '코스피')}
${idxLine(kosdaq, '코스닥')}
${fxLine}
간밤 미국  ${usLine}
\`\`\`

## 수급

${flowBlock(flows.KOSPI, '코스피')}
${flowBlock(flows.KOSDAQ, '코스닥')}
## 랭킹

${rankBlock}

## 관심종목

${watchBlock}

## 주요 뉴스

${newsBlock}

---
*자동 생성 (wrap.js) · 데이터: 토스증권 Open API + 네이버 금융 · 투자 판단 아님*
`;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${today}.md`);
  fs.writeFileSync(file, md);
  console.log(`저장: ${file}`);

  // macOS 알림
  try {
    const kospiMsg = `코스피 ${kospi.closePriceRaw} (${kospi.fluctuationsRatioRaw}%)`;
    execFileSync('osascript', ['-e',
      `display notification "${kospiMsg} — 요약 저장됨" with title "📈 국장 마감 요약" sound name "Glass"`]);
  } catch {}
}

main().catch((e) => { console.error('요약 생성 실패:', e.message); process.exit(1); });
