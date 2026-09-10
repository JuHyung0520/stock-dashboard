/* 알림 설정 라우트.
 * 본문은 server.js 에서 그대로 옮겼다 — if 껍데기만 함수로 바뀌었을 뿐이다.
 * 각 항목은 path(정확히 일치) 또는 match(정규식) 중 하나로 자기 주소를 밝힌다. */
const fs = require('node:fs');
const path = require('node:path');
const toss = require('../toss');
const analysis = require('../analysis');
const M = require('../metrics');
const { KR_CODE, PEAK_CODE } = require('../public/pure.js');
const { sanitizeAlerts } = require('../lib/alerts');
const { ROOT, PUBLIC_DIR, UA, cached, getJSON, num, mapMarketStatus, signed, sendJSON } = require('../lib/core');
const D = require('../lib/data');
const {
  krQuotes, krIndices, investorMarket, investorStock, usProfile, stockProfile, search,
  usQuotes, usIndicesAndFx, buildOverview, newsMain, newsForStock,
  ymd, RANGES, rangeFrom, naverDaily, dailyCached, patchToday, downsample, hlXyz, adrHistory,
} = D;

module.exports = [
    /* ── 알림 설정 (/api/alerts) ─────────────────
     * alert.js 데몬이 읽는 alerts.json 을 브라우저에서 편집하기 위한 통로.
     * localStorage는 브라우저 안에만 있어서 Node 데몬이 못 읽는다 — 그래서 파일로 내린다.
     *
     * ⚠️ 이 서버는 그동안 req.method 를 한 번도 보지 않았다(쓰기 라우트가 없었으므로).
     *    쓰기가 생긴 이상 메서드를 명시적으로 갈라야 한다. 안 그러면 GET 으로도 설정이 덮어써진다. */
  { path: '/api/alerts',
    handle: async ({ req, res, url, p }) => {
      const file = path.join(ROOT, 'alerts.json');

      if (req.method === 'GET') {
        try {
          return sendJSON(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
        } catch {
          return sendJSON(res, 200, { version: 1, enabled: true, targets: [], grids: [] });
        }
      }

      if (req.method === 'PUT') {
        /* 127.0.0.1 바인딩만으로는 DNS 리바인딩을 못 막는다 —
         * 외부 페이지가 자기 도메인을 127.0.0.1 로 재해석시키면 브라우저가 이 서버에 쓸 수 있다.
         * Host 와 Origin 을 루프백으로 제한하면 그 경로가 닫힌다. */
        const host = String(req.headers.host || '');
        const origin = req.headers.origin;
        const loopback = /^(localhost|127\.0\.0\.1|\[::1\]):?\d*$/;
        if (!loopback.test(host) || (origin && !loopback.test(origin.replace(/^https?:\/\//, '')))) {
          res.writeHead(403); return res.end('loopback only');
        }
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 262144) { res.writeHead(413); return res.end('too large'); }
          chunks.push(c);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return sendJSON(res, 400, { error: 'JSON 파싱 실패' });
        }
        // `[]`·`123`·`"x"` 도 유효한 JSON 이다 — 객체가 아니면 targets/grids 가 [] 로 읽혀 기존 조건이 전부 지워진다
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJSON(res, 400, { error: '객체 본문이 필요합니다' });
        }
        const { clean, dropped } = sanitizeAlerts(body);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
        fs.renameSync(tmp, file);      // 데몬이 반쯤 쓰인 파일을 읽지 않도록 원자적 교체
        // 검증에서 빠진 항목을 조용히 삼키면 사용자는 저장된 줄 안다
        return sendJSON(res, 200, { ok: true, dropped, ...clean });
      }

      res.writeHead(405, { Allow: 'GET, PUT' });
      return res.end('method not allowed');
    } },
  { path: '/api/alerts/state',
    handle: async ({ req, res, url, p }) => {
      try {
        return sendJSON(res, 200, JSON.parse(fs.readFileSync(path.join(ROOT, 'alerts-state.json'), 'utf8')));
      } catch {
        return sendJSON(res, 200, { never: true });
      }
    } },
];
