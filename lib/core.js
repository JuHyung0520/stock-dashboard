/* 서버 공통 바닥 — 설정·TTL 캐시·작은 변환기.
 * server.js 가 1,739줄 한 덩어리라 한 곳을 고치려면 전체를 타고 내려가야 했다.
 * 여기엔 '무엇을 가져오는가'가 아니라 '어떻게 가져오고 보내는가'만 둔다. */
const path = require('node:path');

/* 로컬은 8787 고정. 배포 환경(Render 등)은 PORT 를 주입하는데,
 * 그때만 전 인터페이스에 연다 — 로컬에서 실수로 LAN 에 노출되는 일이 없게. */
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
/* ⚠️ 파일을 lib/ 로 옮기면서 __dirname 이 프로젝트 루트가 아니게 됐다.
 * 루트를 한 번만 계산해 두고 모두 여기서 가져다 쓴다 — 옮길 때마다 경로가 어긋나지 않게. */
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/* ── TTL 캐시 ────────────────────────── */
const cache = new Map(); // key -> { at, ttl, promise }
let lastSweep = 0;

/* 키에 사용자 입력(종목 코드 조합·검색어)이 들어가는 경로가 있어 항목이 무한히 쌓인다.
 * 개인용이라 위험은 낮지만 오래 켜두면 메모리가 계속 는다 — 가끔 만료분을 쓸어낸다. */
function sweepCache(now) {
  if (now - lastSweep < 300000) return;
  lastSweep = now;
  for (const [k, v] of cache) if (now - v.at > v.ttl * 4) cache.delete(k);
}

function cached(key, ttlMs, loader) {
  sweepCache(Date.now());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const promise = loader().catch((e) => {
    // 실패 응답은 캐시에서 즉시 제거해 다음 요청이 재시도하게 함
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), ttl: ttlMs, promise });
  return promise;
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

/* ── 숫자 파싱 (네이버는 "+5,544,777" 같은 부호+콤마 문자열) ── */
function num(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const cleaned = String(s).replace(/[+,\s]/g, '').replace(/−/g, '-');
  const v = parseFloat(cleaned);
  return isNaN(v) ? null : v;
}

function mapMarketStatus(s) {
  if (s === 'OPEN') return 'OPEN';
  if (s === 'CLOSE' || s === 'CLOSED') return 'CLOSED';
  return s || null;
}

// 네이버는 하락 시 값에 이미 음수 부호가 붙어 옴(실측). 혹시 양수로 오는 변형에도 대비.
function signed(value, directionName) {
  const v = num(value);
  if (v == null) return null;
  if (directionName === 'FALLING' && v > 0) return -v;
  return v;
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

module.exports = { ROOT, PORT, HOST, PUBLIC_DIR, UA, sweepCache, cached, getJSON, num, mapMarketStatus, signed, MIME, sendJSON };
