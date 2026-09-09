/* 디자인 토큰 불변식 — public/tokens.css
 *
 * 색은 손으로 보면 통과한 것처럼 보인다. 이 화면은 10.8px 글씨가 다수라
 * 대비를 눈으로 판정하면 반드시 틀린다. 그래서 숫자로 잠근다.
 * 팔레트가 7종 × 2테마 = 14가지가 되면서, 하나 추가할 때마다 손으로 재는 건 불가능해졌다. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'tokens.css'), 'utf8');
const PALETTES = ['slate', 'mocha', 'violet', 'ocean', 'forest', 'rose'];

/* ── CSS 블록 읽기 ── */
function blocks(selector) {
  const out = [];
  const needle = `${selector} {`;
  let i = 0;
  while ((i = CSS.indexOf(needle, i)) !== -1) {
    const end = CSS.indexOf('}', i);
    out.push(CSS.slice(i + needle.length, end));
    i = end;
  }
  return out;
}
/* 주석·공백·순서를 무시하고 선언만 비교한다 — 두 벌로 적힌 블록이 같은지 볼 때 쓴다 */
const norm = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  .split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean).sort();
const declsOf = (text) => Object.fromEntries(
  [...text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const merge = (...texts) => Object.assign({}, ...texts.map(declsOf));

/* 테마를 명시적으로 고른 경로를 검사한다. @media(시스템 추종) 블록은
   같은 값의 사본이어야 하며, 그 사본 여부는 아래에서 따로 잠근다. */
function tokensFor(palette, theme) {
  const parts = [...blocks(':root')];
  if (theme === 'light') parts.push(...blocks(':root[data-theme="light"]'));
  if (palette !== 'default') {
    parts.push(...blocks(`:root[data-palette="${palette}"]`));
    if (theme === 'light') parts.push(...blocks(`:root[data-theme="light"][data-palette="${palette}"]`));
  }
  return merge(...parts);
}

/* ── 색 계산 ── */
const parse = (v) => {
  let m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/.exec(v.trim());
  if (m) { const n = m[1].split(',').map(Number); return [n[0], n[1], n[2], n[3] ?? 1]; }
  return null;
};
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (fg, bg) => {
  const a = lum(fg), b = lum(bg), [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};
const over = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3]));

/* ── 1. 구조 ── */
test('팔레트는 세 블록이 정확히 같은 토큰 집합을 정의한다', () => {
  // 다크에만 있는 토큰이 하나라도 생기면 라이트 모드에서 그 토큰만 다크 값으로 남는다 → 흰 판에 흰 글씨
  for (const p of PALETTES) {
    const dark = Object.keys(declsOf(blocks(`:root[data-palette="${p}"]`)[0])).sort();
    const light = Object.keys(declsOf(blocks(`:root[data-theme="light"][data-palette="${p}"]`)[0])).sort();
    assert.ok(dark.length > 0, `${p}: 다크 블록이 없다`);
    assert.deepEqual(light, dark, `${p}: 라이트/다크 토큰 집합이 다르다`);
  }
});

test('시스템 추종(@media) 블록은 수동 선택 블록과 값이 같다', () => {
  // 두 벌로 적어 둔 곳이라, 한쪽만 고치면 "OS 가 라이트"와 "라이트를 직접 선택"의 색이 갈라진다
  // :not() 이 앞에 오기도(기본) 뒤에 오기도(팔레트) 한다 — 순서에 의존하지 않게 통째로 받아 걷어낸다
  const media = /@media \(prefers-color-scheme: light\) \{\s*:root([^{]*)\{([^}]*)\}/g;
  const bySuffix = new Map();
  let m;
  while ((m = media.exec(CSS))) {
    const suffix = m[1].replace(/:not\(\[data-theme="dark"\]\)/, '')
      .replace(/\s+$/, '').replace(/\s+/g, ' ');   // ' .skel' 의 앞 공백은 선택자의 일부다
    if (!bySuffix.has(suffix)) bySuffix.set(suffix, []);
    bySuffix.get(suffix).push(norm(m[2]));
  }
  assert.ok(bySuffix.size > 0, '@media 라이트 블록을 하나도 못 찾았다');

  let pairs = 0;
  for (const [suffix, mediaDecls] of bySuffix) {
    // 같은 선택자가 여러 번 나온다(토큰·그림자·스켈레톤) — 파일 등장 순서대로 짝짓는다
    const manual = blocks(`:root[data-theme="light"]${suffix}`).map(norm);
    assert.equal(manual.length, mediaDecls.length,
      `${suffix.trim() || '(기본)'}: @media ${mediaDecls.length}개 vs 수동 ${manual.length}개 — 한쪽만 늘었다`);
    mediaDecls.forEach((d, i) => {
      assert.deepEqual(d, manual[i], `@media 사본이 어긋났다: ${suffix.trim() || '(기본)'} #${i + 1}`);
      pairs++;
    });
  }
  assert.ok(pairs >= 9, `짝 검사가 ${pairs}건뿐 — 기본 3(토큰·그림자·스켈레톤) + 팔레트 6 이상이어야 한다`);
});

test('팔레트는 의미색을 건드리지 않는다', () => {
  // 상승=빨강·하락=파랑은 국내 관례이자 화면의 의미 축이다. 색조 취향으로 흔들리면 안 된다
  const 금지 = ['up', 'down', 'ok', 'series-1', 'series-2', 'series-3', 'on-up-tint', 'on-down-tint'];
  for (const p of PALETTES) {
    for (const sel of [`:root[data-palette="${p}"]`, `:root[data-theme="light"][data-palette="${p}"]`]) {
      const keys = Object.keys(declsOf(blocks(sel)[0]));
      const 위반 = keys.filter((k) => 금지.includes(k));
      assert.deepEqual(위반, [], `${p} 가 의미색을 덮었다: ${위반}`);
    }
  }
});

/* ── 2. 대비 ── */
const FG = ['text', 'text-dim', 'text-faint', 'up', 'down', 'ok', 'accent'];

for (const palette of ['default', ...PALETTES]) {
  for (const theme of ['dark', 'light']) {
    test(`대비 — ${palette}/${theme}`, () => {
      const t = tokensFor(palette, theme);
      const panel = parse(t.panel), bg = parse(t.bg), panel2 = parse(t['panel-2']);
      assert.ok(panel && bg && panel2, `${palette}/${theme}: 표면 토큰을 못 읽었다`);

      const surfaces = {
        panel, bg, 'panel-2': panel2,
        // 관심종목에서 선택된 행 — 그 위에 상승/하락 숫자가 얹힌다
        '선택행': over(parse(t['accent-tint-weak']), panel),
      };
      for (const f of FG) {
        const fg = parse(t[f]);
        assert.ok(fg, `${palette}/${theme}: --${f} 를 못 읽었다`);
        for (const [name, surf] of Object.entries(surfaces)) {
          const cr = contrast(fg, surf);
          assert.ok(cr >= 4.5, `${palette}/${theme}: --${f} on ${name} = ${cr.toFixed(2)} (4.5 미만)`);
        }
      }
      // 강조색 배경 위 글자 (활성 칩·버튼)
      const oa = contrast(parse(t['on-accent']), parse(t.accent));
      assert.ok(oa >= 4.5, `${palette}/${theme}: --on-accent on --accent = ${oa.toFixed(2)}`);
    });
  }
}
