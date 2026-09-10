/* 내 주식 보드 — 로컬 서버 (의존성 제로, Node 18+)
 * 실행: node server.js  →  http://localhost:8787
 *
 * 역할: 외부 시세 소스를 프록시하면서
 *  - 브라우저 CORS 제한 우회
 *  - 응답을 프론트용 정규화 스키마로 변환
 *  - TTL 캐시로 외부 요청 횟수 최소화 (개인용 예의)
 *
 * 수급 데이터는 .env에 토스 키가 있으면 토스증권 공식 Open API를 쓰고,
 * 없거나 실패하면 네이버(비공식)로 폴백한다.
 * 시세·뉴스·검색은 네이버. 외부 엔드포인트는 2026-08-13 실측 검증 기준.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const toss = require('./toss');
// 종목 코드 형식은 화면과 서버가 같은 규칙을 써야 한다 — 갈라져서 종목이 사라진 적이 있다
const { KR_CODE, PEAK_CODE } = require('./public/pure.js');
const analysis = require('./analysis');
const M = require('./metrics');

/* ── 갈라 둔 곳 ──
 * 한 파일 1,739줄이라 한 곳을 고치려면 전체를 타고 내려가야 했다.
 *   lib/core.js   설정·TTL 캐시·응답 헬퍼   ("어떻게 가져오고 보내는가")
 *   lib/data.js   업스트림 조회·변환        ("어디서 가져오는가")
 *   lib/alerts.js 알림 설정 정제
 * 이름을 그대로 끌어와서 아래 라우트 코드는 한 줄도 바뀌지 않았다. */
const {
  PORT, HOST, PUBLIC_DIR, UA, sweepCache, cached,
  getJSON, num, mapMarketStatus, signed, MIME, sendJSON
} = require('./lib/core');
const {
  krQuotes, krIndices, investorMarketNaver, investorStockNaver, withFallback, investorMarket,
  investorStock, usProfile, stockProfile, search, usQuotes, usIndicesAndFx,
  buildOverview, decodeEntities, fmtNewsTime, newsMain, newsForStock, ymd,
  RANGES, rangeFrom, naverDaily, dailyCached, patchToday, downsample,
  hlXyz, adrHistory
} = require('./lib/data');
const { sanitizeAlerts } = require('./lib/alerts');

/* 라우트는 페이지 단위로 갈라 두고 여기서 한 줄로 잇는다. 순서가 곧 우선순위다. */
const ROUTES = [
  ...require('./routes/market'),
  ...require('./routes/terminal'),
  ...require('./routes/etf'),
  ...require('./routes/crypto'),
  ...require('./routes/flow'),
  ...require('./routes/charts'),
  ...require('./routes/alerts'),
];

/* 한 요청이 프로세스를 죽이면 안 된다. 실측: request-target 이 `//300.300.300.300/` 이면 llhttp 는 통과시키고
 * WHATWG 파서는 던진다 — 그 throw 가 try 밖에 있어서 unhandledRejection 으로 프로세스가 종료됐다.
 * 서버가 죽으면 알림 데몬도 네이버 폴백으로만 돌아 미국 종목 알림이 조용히 빠진다. */
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://localhost:${PORT}`); }
  catch { res.writeHead(400); return res.end('bad url'); }
  const p = url.pathname;
  // 읽기 전용 서버다. /api/alerts 만 PUT 을 받고 나머지는 GET/HEAD 뿐 — 그 외 메서드는 실행 없이 거절
  if (p !== '/api/alerts' && req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end();
  }

  try {
    /* ── 라우트 표 ──
     * 주소마다 if 문을 줄줄이 늘어놓던 것을 routes/ 아래 파일로 갈랐다.
     * 표를 위에서부터 훑어 첫 번째로 맞는 것에 넘긴다 — 원래 if 사슬과 같은 순서다. */
    for (const r of ROUTES) {
      const m = r.path ? (p === r.path ? [] : null) : p.match(r.match);
      if (!m) continue;
      await r.handle({ req, res, url, p }, m);
      /* 원래 코드에는 '조건은 맞지만 응답은 안 하고 아래로 흘려보내는' 자리가 있었다.
       * 응답 여부로 판단해야 그 동작이 그대로 보존된다 — 맞았다고 무조건 끊으면 안 된다. */
      if (res.headersSent || res.writableEnded) return;
    }


    /* 정적 파일 */
    const PAGES = {
      '/': '/index.html', '/flow': '/flow.html', '/assets': '/assets.html',
      '/etf': '/etf.html', '/terminal': '/terminal.html',
      '/idx': '/idx.html', '/marketcap': '/marketcap.html', '/peak': '/peak.html',
      '/ram': '/ram.html', '/adr': '/adr.html', '/alerts': '/alerts.html',
    };
    let file = PAGES[p] || p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        // 로컬 개발 도구 — 파일을 자주 고치므로 브라우저 캐시가 항상 최신을 확인하게
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${p} 실패:`, e.message);
    sendJSON(res, 502, { error: e.message });
  }
});

/* 개인용 로컬 도구다. 쓰기 API(/api/alerts)가 생긴 이상 전 인터페이스(*:8787)에
 * 열어둘 이유가 없다 — 같은 네트워크의 다른 기기가 설정을 바꿀 수 있게 된다. */
/* require 로 불러올 때는 포트를 잡지 않는다 — 테스트가 서버를 띄우면
 * 이미 8787 에서 돌고 있는 개발 서버와 충돌한다(EADDRINUSE). */
if (require.main === module) {
server.listen(PORT, HOST, () => {
  // 배포 환경(Render)은 실제 공개 주소를 환경변수로 준다 — localhost 라고 찍으면 헷갈린다
  const addr = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`📈 내 주식 보드 → ${addr}${HOST !== '127.0.0.1' ? ' (배포 모드)' : ''}`);
});
}

module.exports = { sanitizeAlerts };
