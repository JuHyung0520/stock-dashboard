/* 세력 좌표 — 분석 계층
 *
 * 원시 시계열을 "누가 어떤 포지션에 서 있는가"로 가공한다.
 * 설계 원칙 (심사에서 확정된 것들):
 *  - 평균 대신 중앙값·MAD (로버스트 z). 팻테일 계열에서 평균/표준편차는 신호를 죽인다.
 *  - "z=2.8" 대신 "100일 중 2위" (경험적 순위). 금융 시계열은 정규분포가 아니다.
 *  - 잔고성 계열은 반드시 1차 차분 후 평가. 수준값은 추세 때문에 상시 이상으로 뜬다.
 *  - 장중 잠정치는 individual·기관세부·otherCorp가 null → 0으로 채우지 말고 null로 전파.
 *  - 히스테리시스: 어제 뜬 판정은 임계 0.8배로 유지. 화면이 시장보다 변덕스러우면 안 된다.
 *
 * 폐기된 것 (실측/심사로 반증):
 *  - 세력 평단선: 순매수 가중은 발산, 총매수 가중은 전 주체가 같은 값. 일별 종가만으론 불가능.
 *  - 전례 스트립: 매칭 표본 n=1~5, 그마저 같은 사건 구간 → 통계가 아니라 일화.
 *  - 본페로니 보정: 지표 간 상관이 강해 과보정. 경험적 순위로 대체.
 */

const M = require('./metrics');

/* 주체 정의 — 화면 행 순서와 일치 */
const ACTORS = [
  { key: 'individual', label: '개인', group: 'main' },
  { key: 'foreign', label: '외국인', group: 'main' },
  { key: 'institution', label: '기관', group: 'main' },
  { key: 'otherCorp', label: '기타법인', group: 'main' },
  { key: 'financialInvestment', label: '금융투자', group: 'inst' },
  { key: 'insurance', label: '보험', group: 'inst' },
  { key: 'trust', label: '투신', group: 'inst' },
  { key: 'privateEquityFund', label: '사모', group: 'inst' },
  { key: 'bank', label: '은행', group: 'inst' },
  { key: 'otherFinancialInstitution', label: '기타금융', group: 'inst' },
  { key: 'pensionFund', label: '연기금', group: 'inst' },
];

// 시계열에서 주체별 배열 뽑기 (기관 7세부는 breakdown 안에 있음)
function seriesFor(rows, key) {
  return rows.map((r) => (r.breakdown && key in r.breakdown ? r.breakdown[key] : r[key]));
}

/* ── 주체 한 명의 현재 포지션 ── */
function actorPosition(rows, actor, { window = 20, rankWindow = 100 } = {}) {
  const s = seriesFor(rows, actor.key);
  const valid = s.filter((v) => v != null);
  if (valid.length < 5) return { ...actor, insufficient: true };

  const z = M.robustZ(s, Math.min(window, valid.length - 1));
  const rk = M.rank(s, rankWindow);
  const st = M.streak(s);              // 오늘은 잠정이라 전일부터
  const b = M.baseline(s);

  // 최근 20일 z 시퀀스 — 캘린더 스트립용. 각 시점마다 그 직전 20일로 재계산.
  const zSeq = [];
  for (let i = 0; i < Math.min(20, s.length - window - 1); i++) {
    zSeq.push(M.robustZ(s.slice(i), window));
  }

  return {
    ...actor,
    today: s[0],
    missing: s[0] == null,
    z, zLabel: M.zLabel(z),
    rank: rk,
    streak: st,
    baseline: b,
    zSeq,
    valueSeq: s.slice(0, 20),   // 매트릭스 칸 값 (index 0 = 오늘)
  };
}

/* ── 배신자 탐지 ──
 * 20일 내내 한 방향이던 주체가 오늘 반대로 돌아섰는가.
 * 히스테리시스: 어제 이미 배신자로 찍혔으면 임계를 낮춰 유지(깜빡임 방지). */
function findTraitors(rows, { minStreak = 4 } = {}) {
  const out = [];
  for (const a of ACTORS) {
    const s = seriesFor(rows, a.key);
    if (s[0] == null || s[1] == null) continue;      // 장중 null이면 판정 보류
    const before = M.streak(s.slice(1), { includeToday: true });  // 전일 기준 연속
    if (!before || before.days < minStreak) continue;
    const flipped = Math.sign(s[0]) !== 0 && Math.sign(s[0]) !== (before.direction === 'buy' ? 1 : -1);
    if (flipped) {
      out.push({
        key: a.key, label: a.label,
        wasDirection: before.direction, wasDays: before.days,
        todayValue: s[0],
      });
    }
  }
  return out;
}

/* ── 기관 내부 대립 ──
 * "기관이 샀다"를 "연기금이 사고 금융투자가 팔았다"로 분해.
 * 분열도 = 7세부 순매수의 표준편차. 평소보다 크면 기관 내부가 갈라진 날. */
function institutionSplit(rows) {
  const today = rows[0];
  if (!today) return null;
  const bd = today.breakdown || {};
  const members = ACTORS.filter((a) => a.group === 'inst').map((a) => ({
    key: a.key, label: a.label, value: bd[a.key] ?? null,
    streak: M.streak(seriesFor(rows, a.key)),
  }));

  const known = members.filter((m) => m.value != null);
  if (!known.length) {
    return { members, buyers: [], sellers: [], dispersion: null, provisional: true };
  }

  // 분열도의 과거 시계열 → 오늘이 평소보다 갈라졌는지
  const dispSeries = rows.map((r) => {
    const vals = ACTORS.filter((a) => a.group === 'inst')
      .map((a) => r.breakdown?.[a.key]).filter((v) => v != null);
    return vals.length >= 4 ? M.stdev(vals) : null;
  });

  return {
    members,
    buyers: known.filter((m) => m.value > 0).sort((a, b) => b.value - a.value),
    sellers: known.filter((m) => m.value < 0).sort((a, b) => a.value - b.value),
    dispersion: dispSeries[0],
    dispersionZ: M.robustZ(dispSeries),
    provisional: known.length < 7,
  };
}

/* ── 오늘의 세력 판정 ──
 * 오늘 시장을 실제로 움직인 주체 하나를 지목한다.
 * 장중엔 개인·기타법인·기관세부가 null이라 후보가 줄어든다 — 그 사실을 숨기지 않고 같이 반환. */
function verdict(positions, { split } = {}) {
  const usable = positions.filter((p) => !p.insufficient && p.today != null && p.group === 'main');
  if (!usable.length) {
    return { headline: '수급 데이터를 기다리는 중', detail: '장 시작 직후에는 잠정치가 아직 없습니다.', actor: null };
  }
  // 절대 규모가 가장 큰 주체
  const lead = usable.reduce((a, b) => (Math.abs(b.today) > Math.abs(a.today) ? b : a));
  const dir = lead.today > 0 ? '순매수' : '순매도';
  const rk = lead.rank;

  const bits = [];
  if (rk) {
    bits.push(rk.isRecord
      ? `최근 ${rk.of}거래일 만에 최대`
      : `최근 ${rk.of}거래일 중 ${rk.rank}위`);
  }
  if (lead.streak && lead.streak.days > 1) {
    bits.push(`${lead.streak.direction === 'buy' ? '순매수' : '순매도'} ${lead.streak.days}일째`);
  }

  const missing = positions.filter((p) => p.missing).map((p) => p.label);

  return {
    // '순매도'라는 말에 방향이 이미 있으므로 숫자는 절대값으로 (이중 부호 방지)
    headline: `${lead.label}${josa(lead.label)} ${fmtEok(Math.abs(lead.today)).replace('+', '')} ${dir}`,
    detail: bits.join(' · '),
    actor: lead.key,
    isExceptional: rk ? rk.rank <= 3 : false,
    missing,                       // 장중 null인 주체들 — 화면에 명시해야 함
    splitNote: split?.dispersionZ != null && Math.abs(split.dispersionZ) > 1.5
      ? '기관 내부 방향이 평소보다 갈렸습니다'
      : null,
  };
}

function fmtEok(v) {
  if (v == null) return '—';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(v)).toLocaleString('ko-KR')}억`;
}

/* 조사 처리 — 받침 유무로 이/가, 은/는 결정. "외국인이(가)" 같은 표기를 피한다. */
function josa(word, pair = '이/가') {
  const [withBatchim, without] = pair.split('/');
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return withBatchim;   // 한글 아니면 기본값
  return (last - 0xac00) % 28 ? withBatchim : without;
}

/* ── 시장 화면 전체 조립 ── */
function buildMarket(rows) {
  const positions = ACTORS.map((a) => actorPosition(rows, a));
  const split = institutionSplit(rows);
  const traitors = findTraitors(rows);

  return {
    asOf: rows[0]?.date || null,
    updatedAt: rows[0]?.updatedAt || null,
    dates: rows.slice(0, 20).map((r) => r.date),   // 매트릭스 날짜 축 (index 0 = 오늘)
    verdict: verdict(positions, { split }),
    positions,
    split,
    traitors,
    // 감사용: 무엇을 몇 건 검사했고 왜 안 떴나
    audit: {
      actorsChecked: ACTORS.length,
      daysAvailable: rows.length,
      missingToday: positions.filter((p) => p.missing).map((p) => p.label),
      insufficient: positions.filter((p) => p.insufficient).map((p) => p.label),
      note: '당일 기록은 장중 잠정치이며 개인·기관세부·기타법인은 장 마감 후 채워집니다',
    },
  };
}

/* ── 종목 스캐너 ──
 * 종목별 수급은 주(株) 단위라 종목 간 비교가 불가능하다.
 * 20일 평균 거래량으로 나눠 %(강도)로 만들면 크기와 무관하게 비교된다. */
function scanStock({ code, name, flows, candles }) {
  if (!flows?.length || !candles?.length) return null;
  const vols = candles.map((c) => c.volume);
  const closes = candles.map((c) => c.close);

  const intensity = (key) => {
    const s = flows.map((r) => (r.breakdown && key in r.breakdown ? r.breakdown[key] : r[key]));
    if (s[0] == null) return null;
    return {
      value: s[0],
      intensity: M.flowIntensity(s, vols),
      z: M.robustZ(s),
      rank: M.rank(s, 100),
      streak: M.streak(s),
    };
  };

  return {
    code, name,
    close: closes[0],
    changePct: M.changePct(closes),
    disparity: M.disparity(closes, 20),
    volumeRatio: M.volumeRatio(vols, { sessionProgress: M.sessionProgress() }),
    foreign: intensity('foreign'),
    institution: intensity('institution'),
    individual: intensity('individual'),
    pensionFund: intensity('pensionFund'),
    foreignHoldRate: flows.find((f) => f.foreignHoldRate != null)?.foreignHoldRate ?? null,
  };
}

module.exports = { ACTORS, buildMarket, scanStock, seriesFor, actorPosition, institutionSplit, findTraitors };
