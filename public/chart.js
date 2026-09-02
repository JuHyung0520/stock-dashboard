/* 공통 SVG 차트 — 라이브러리 없이 직접 그린다 (의존성 제로 원칙).
 *
 * 좌표계는 viewBox 를 컨테이너의 실제 픽셀 폭으로 잡는다(1:1).
 * 예전엔 1000 고정 + preserveAspectRatio="none" 으로 가로만 늘렸는데,
 * 그러면 <text>까지 같이 늘어난다 — /idx 는 0.37배로 눌리고 넓은 화면에선 1.37배로 퍼져서
 * 같은 .axis-label 이 페이지마다 다른 글자로 보였다. 끝점 태그의 알약 배경도 글자와 어긋났다.
 * 대신 폭이 바뀌면 다시 그려야 한다 — 아래 ResizeObserver 가 맡는다.
 * 오른쪽 여백(PAD.r)은 y축 라벨 자리다 — 값 라벨을 차트 안에 겹치면 읽기 어렵다.
 *
 * 십자선(crosshair): 장기 차트에서 "2024년 3월엔 얼마였지"를 눈대중하게 두면
 * 차트가 장식이 된다. 마우스 위치의 실제 값을 항상 숫자로 읽어준다.
 */

const Chart = (() => {
  const W0 = 1000;                                   // 폭을 못 재는 경우(숨은 탭 등)의 대비값
  const PAD = { t: 14, r: 66, b: 24, l: 8 };
  const measure = (el) => Math.max(120, Math.round(el.clientWidth || W0));   // 하한은 PAD 합(74px)이 음수 폭을 만들지 않을 만큼만

  /* 폭이 달라지면 다시 그린다. viewBox 가 픽셀 폭이라 리사이즈를 무시하면
   * SVG 가 통째로 확대·축소되어 글자 크기가 또 어긋난다.
   * 다시 그려도 컨테이너 폭은 안 변하므로 무한 루프는 나지 않는다. */
  const RO = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target, w = Math.round(e.contentRect.width);
      const t = el.__chart;
      if (!t || !w || Math.abs(w - t.w) < 8) continue;
      t.w = w;
      t.draw();
    }
  }) : null;

  function track(el, draw) {
    el.__chart = { w: Math.round(el.clientWidth || 0), draw };
    if (RO) { RO.unobserve(el); RO.observe(el); }
  }

  /* 음수 부호를 하나로 — toFixed 는 ASCII '-'(U+002D)를 주는데 프로젝트 나머지는 전부
   * '−'(U+2212)를 쓴다. 같은 차트 안에서 Y축은 '-3%', 끝점 태그는 '−3%' 로 갈리던 문제.
   * 숫자 서식에만 적용한다(x축 라벨엔 '2024-03' 같은 날짜가 들어온다). */
  const minus = (s) => String(s).replace(/-/g, '\u2212');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 눈금 간격을 1·2·2.5·5·10 배수로 떨어뜨린다 — 3.7% 같은 눈금은 읽히지 않는다 */
  function niceStep(span, count) {
    if (!(span > 0)) return 1;
    const raw = span / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  function extent(series) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (v == null || isNaN(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return [lo, hi];
  }

  /* ── 꺾은선 (여러 계열) ──
   * cfg = { series:[{key,label,color,values:[]}], labels:[], height, yFormat,
   *         tagFormat, zeroLine, baseline, includeZero } */
  function line(el, cfg) {
    track(el, () => line(el, cfg));
    const W = measure(el);
    const {
      series = [], labels = [], height: cfgHeight = 300,
      yFormat = (v) => v.toFixed(2),
      tagFormat = null,
      zeroLine = false, baseline = null, includeZero = false,
    } = cfg;
    /* 세로도 실제 픽셀로 맞춘다. CSS 는 .chart-box 높이를 강제하는데(chart.css:4)
     * viewBox 높이가 그와 다르면 SVG 전체가 통째로 확대·축소되어 글자가 또 어긋난다. */
    const height = Math.round(el.clientHeight || cfgHeight);

    const live = series.filter((s) => s.values?.some((v) => v != null && !isNaN(v)));
    if (!live.length || !labels.length) {
      el.innerHTML = '<div class="inv-empty">표시할 데이터가 없습니다</div>';
      return;
    }

    let [lo, hi] = extent(live);
    if (includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (baseline != null) { lo = Math.min(lo, baseline); hi = Math.max(hi, baseline); }
    if (lo === hi) { lo -= 1; hi += 1; }              // 완전 평평한 계열 방어
    const pad = (hi - lo) * 0.1;
    lo -= pad; hi += pad;

    const n = labels.length;
    const y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * (height - PAD.t - PAD.b);
    const x = (i) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);

    // y 눈금
    const step = niceStep(hi - lo, 4);
    let ticks = '';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      if (Math.abs(v) < step * 1e-6) v = 0;   // 부동소수 오차로 −1e-17 이 되면 '−0.0%' 라는 음수 0 이 찍힌다
      const isZero = zeroLine && v === 0;
      ticks += `<line class="${isZero ? 'zero-line' : 'grid-line'}" x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${y(v).toFixed(1)}"/>`
        + `<text class="axis-label" x="${W - PAD.r + 6}" y="${(y(v) + 3.5).toFixed(1)}">${esc(minus(yFormat(v)))}</text>`;
    }
    if (baseline != null) {
      ticks += `<line class="base-line" x1="${PAD.l}" y1="${y(baseline).toFixed(1)}" x2="${W - PAD.r}" y2="${y(baseline).toFixed(1)}"/>`;
    }

    // 계열 선 + 끝점 태그(위치는 아래에서 충돌 정리 후 그린다)
    let paths = '';
    const tags = [];
    for (const s of live) {
      const pts = [];
      let lastI = -1;
      s.values.forEach((v, i) => {
        if (v == null || isNaN(v)) return;
        pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        lastI = i;
      });
      paths += `<polyline class="series-line" points="${pts.join(' ')}" stroke="${s.color}"/>`;
      if (lastI >= 0 && tagFormat) {
        const text = minus(tagFormat(s, s.values[lastI], lastI));   // 인덱스도 넘긴다 — 값으로 역추적하면 부정확하다
        tags.push({
          color: s.color, text,
          lx: x(lastI), ly: y(s.values[lastI]),
          ty: y(s.values[lastI]),                            // 태그 세로 위치 (아래에서 조정될 수 있다)
          w: Math.max(46, text.length * 6.6 + 12),
        });
      }
    }

    /* 끝점 태그 충돌 정리.
     * 비교 차트는 두 선이 만나는 게 핵심이라 끝값이 붙는 일이 잦은데,
     * 그대로 두면 라벨이 겹쳐 둘 다 못 읽게 된다. 겹치면 위아래로 벌린다. */
    const TAG_H = 18, GAP = 3;
    tags.sort((a, b) => a.ty - b.ty);
    for (let i = 1; i < tags.length; i++) {
      const need = tags[i - 1].ty + TAG_H + GAP;
      if (tags[i].ty < need) tags[i].ty = need;
    }
    // 아래로 밀다가 차트를 벗어나면 반대로 되민다
    const floor = height - PAD.b - TAG_H / 2;
    for (let i = tags.length - 1; i >= 0; i--) {
      if (tags[i].ty > floor) tags[i].ty = floor - (tags.length - 1 - i) * (TAG_H + GAP);
    }

    for (const t of tags) {
      // 점은 실제 값 위치에, 라벨은 조정된 위치에. 어긋나면 가느다란 선으로 잇는다.
      if (Math.abs(t.ty - t.ly) > 2) {
        paths += `<line class="tag-leader" x1="${(t.lx - 5).toFixed(1)}" y1="${t.ly.toFixed(1)}" x2="${(t.lx - 9).toFixed(1)}" y2="${t.ty.toFixed(1)}" stroke="${t.color}"/>`;
      }
      paths += `<rect x="${(t.lx - t.w - 4).toFixed(1)}" y="${(t.ty - 10).toFixed(1)}" width="${t.w.toFixed(1)}" height="${TAG_H}" rx="5" fill="${t.color}" opacity="0.16"/>`
        + `<text class="end-tag" x="${(t.lx - 9).toFixed(1)}" y="${(t.ty + 3.5).toFixed(1)}" text-anchor="end" fill="${t.color}">${esc(t.text)}</text>`
        + `<circle class="end-dot" cx="${t.lx.toFixed(1)}" cy="${t.ly.toFixed(1)}" r="3.5" fill="${t.color}"/>`;
    }

    // x축 — 양끝 + 중간 3개
    const idxs = n <= 2 ? [0, n - 1] : [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((n * 3) / 4), n - 1];
    const axis = [...new Set(idxs)].map((i) => {
      const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return `<text class="axis-label" x="${x(i).toFixed(1)}" y="${height - 7}" text-anchor="${anchor}">${esc(labels[i])}</text>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${height}" role="img">
      ${ticks}${paths}${axis}
      <g class="cross" hidden><line class="cross-line" y1="${PAD.t}" y2="${height - PAD.b}"/></g>
    </svg><div class="chart-readout" hidden></div>`;

    bindCrosshair(el, { n, x, y, labels, series: live, height, W });
  }

  /* ── 십자선 + 값 읽기 ── */
  function bindCrosshair(el, { n, x, y, labels, series, W }) {
    const svg = el.querySelector('svg');
    const cross = el.querySelector('.cross');
    const line = cross.querySelector('.cross-line');
    const out = el.querySelector('.chart-readout');
    if (!svg || !out) return;

    const hide = () => { cross.setAttribute('hidden', ''); out.setAttribute('hidden', ''); };

    const move = (ev) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const vx = ((clientX - box.left) / box.width) * W;                 // 뷰박스 좌표
      const frac = (vx - PAD.l) / (W - PAD.l - PAD.r);
      const i = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));

      line.setAttribute('x1', x(i).toFixed(1));
      line.setAttribute('x2', x(i).toFixed(1));
      cross.removeAttribute('hidden');

      out.innerHTML = `<b>${esc(labels[i])}</b>` + series.map((s) => {
        const v = s.values[i];
        if (v == null || isNaN(v)) return '';
        const txt = s.readout ? s.readout(v, i) : v.toFixed(2);
        return `<span style="color:${s.color}">${esc(s.label)} ${esc(txt)}</span>`;
      }).join('');
      out.removeAttribute('hidden');

      // 읽기창이 커서를 따라가되 컨테이너를 벗어나지 않게
      const relX = ((clientX - box.left) / box.width) * 100;
      out.style.left = `${Math.max(2, Math.min(98, relX))}%`;
      out.style.transform = relX > 55 ? 'translateX(-100%)' : 'none';
    };

    svg.addEventListener('mousemove', move);
    svg.addEventListener('touchmove', move, { passive: true });
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchend', hide);
  }

  /* ── 캔들 ── */
  function candles(el, cfg) {
    track(el, () => candles(el, cfg));
    const W = measure(el);
    const { candles: c = [], height: cfgHeight = 340, yFormat = (v) => v.toFixed(2), xFormat = (t) => t } = cfg;
    const height = Math.round(el.clientHeight || cfgHeight);
    if (!c.length) { el.innerHTML = '<div class="inv-empty">캔들이 없습니다</div>'; return; }

    const lo = Math.min(...c.map((k) => k.l)), hi = Math.max(...c.map((k) => k.h));
    const span = (hi - lo) || 1;
    const y = (v) => PAD.t + (1 - (v - lo) / span) * (height - PAD.t - PAD.b);
    const bw = (W - PAD.l - PAD.r) / c.length;
    const bodyW = Math.max(1.5, bw * 0.62);

    const step = niceStep(span, 4);
    let ticks = '';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ticks += `<line class="grid-line" x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${y(v).toFixed(1)}"/>`
        + `<text class="axis-label" x="${W - PAD.r + 6}" y="${(y(v) + 3.5).toFixed(1)}">${esc(minus(yFormat(v)))}</text>`;
    }

    const bars = c.map((k, i) => {
      const cx = PAD.l + bw * (i + 0.5);
      const kls = k.c >= k.o ? 'candle-up' : 'candle-down';
      const yO = y(k.o), yC = y(k.c);
      return `<line class="${kls}" x1="${cx.toFixed(1)}" y1="${y(k.h).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(k.l).toFixed(1)}" stroke-width="1"/>`
        + `<rect class="${kls}" x="${(cx - bodyW / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, Math.abs(yC - yO)).toFixed(1)}"/>`;
    }).join('');

    const idxs = [...new Set([0, Math.floor(c.length / 3), Math.floor((c.length * 2) / 3), c.length - 1])];
    const axis = idxs.map((i) => {
      const anchor = i === 0 ? 'start' : i === c.length - 1 ? 'end' : 'middle';
      return `<text class="axis-label" x="${(PAD.l + bw * (i + 0.5)).toFixed(1)}" y="${height - 7}" text-anchor="${anchor}">${esc(xFormat(c[i].t))}</text>`;
    }).join('');

    el.innerHTML = `<svg viewBox="0 0 ${W} ${height}" role="img">${ticks}${bars}${axis}</svg>`;
  }

  /* ── 스파크라인 (문자열 반환 — 표 셀 안에 넣는 용도) ── */
  function spark(values, { width = 300, height = 34, color = 'var(--flat)', label = '' } = {}) {
    const vals = values.filter((v) => v != null && !isNaN(v));
    if (vals.length < 2) return '';
    const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
    const pts = vals.map((v, i) =>
      `${((i / (vals.length - 1)) * width).toFixed(1)},${(height - 4 - ((v - min) / span) * (height - 8)).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
      ${label ? `<text x="${width - 2}" y="10" text-anchor="end" class="axis-label">${esc(label)}</text>` : ''}
    </svg>`;
  }

  /* ── 시간축 포맷터 ──
   * 간격 이름(1h·15m)이 아니라 **실제로 걸친 기간**으로 정한다.
   * 1시간봉 200개는 8일치라 시:분만 찍으면 "04:00 → 22:00 → 17:00"처럼
   * 시간이 거꾸로 가는 것처럼 읽힌다. */
  function timeAxis(candles) {
    if (!candles?.length) return (t) => '';
    const spanDays = (candles[candles.length - 1].t - candles[0].t) / 86400000;
    /* 로케일 포맷터를 쓰면 ko-KR 이 "08. 11." 처럼 꼬리 점과 공백을 붙여
     * 축 라벨이 지저분해지고 폭도 낭비된다. 직접 조립한다. */
    if (spanDays > 60) return (t) => { const d = new Date(t); return `${String(d.getFullYear() % 100).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`; };
    if (spanDays > 4) return (t) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };
    // 2~4일 구간에서 날짜만 찍으면 같은 라벨이 연달아 나와 시간 정보가 사라진다
    if (spanDays > 0.8) {
      // ko-KR 로케일은 hour 포맷에 이미 '시'를 붙인다 — 직접 붙이면 '09시시'가 된다.
      // 숫자만 필요하므로 en-GB 로 뽑아 쓴다.
      return (t) => {
        const d = new Date(t);
        return `${d.getDate()}일 ${d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit' })}시`;
      };
    }
    return (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }

  /* 날짜 라벨 — 페이지마다 로케일 포맷터를 따로 부르면 "08. 11." 같은 게 다시 새어 나온다 */
  const md = (t) => { const d = new Date(t); return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`; };

  /* 계열색은 CSS 토큰에서 읽는다.
   * JS 에 하드코딩하면 라이트 모드에서 그 색만 안 따라와서, 흰 배경 위에
   * 연한 민트/앰버 선이 그려져 거의 안 보이게 된다. */
  const token = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };
  const series = (i) => token(`--series-${i}`, ['#4dd6a8', '#f0b23f'][i - 1] || '#4dd6a8');

  /* ── 데이터 시점 표시 ──
   * "지금 값인가, 언제 것인가"를 한 곳에서 판정한다.
   * 페이지마다 제각각 문구를 만들면 같은 상태를 다르게 말하게 된다. */
  const MARKET_LABEL = { OPEN: '장중', PRE: '장전', POST: '장후', CLOSED: '마감' };

  function asOf(marketState, opts = {}) {
    const { at = null, prefix = '' } = opts;
    if (!marketState) return null;
    const live = marketState === 'OPEN';
    const label = MARKET_LABEL[marketState] || marketState;
    const when = at ? ` ${at}` : '';
    return { live, label, text: `${prefix}${label}${when}`,
             cls: live ? 'live' : 'closed' };
  }

  // 배지 HTML — 값 옆에 바로 붙인다
  function asOfBadge(marketState, opts) {
    const a = asOf(marketState, opts);
    if (!a) return '';
    return `<span class="as-of ${a.cls}">${a.text}</span>`;
  }

  return { line, candles, spark, niceStep, timeAxis, md, token, series,
           asOf, asOfBadge, MARKET_LABEL, PAD };
})();
