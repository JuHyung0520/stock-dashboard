/* 공통 내비게이션 — 페이지가 11개라 각 HTML에 링크를 하드코딩하면
 * 페이지 하나 추가할 때마다 11곳을 고쳐야 한다. 한 곳에서 렌더한다.
 * <div class="nav-links" data-nav></div> 만 두면 채워진다.
 *
 * 줄바꿈하지 않고 가로로 스크롤한다(chart.css). 그래서 두 가지를 여기서 챙긴다:
 *  - 지금 있는 페이지가 화면 밖에 있으면 보이게 밀어준다
 *  - 끝까지 밀었는지에 따라 오른쪽 흐림(더 있다는 신호)을 켜고 끈다
 */

/* 아이콘은 이모지 대신 선(stroke) SVG.
 * 이모지는 자기 색을 고집해서 회색 링크 줄에서 혼자 총천연색으로 튄다 —
 * OS 마다 모양도 달라 통제가 안 된다. stroke: currentColor 로 그리면
 * 비활성(회색)·현재 페이지(강조색)·라이트/다크가 전부 글자색을 따라온다. */
const ICO = {
  chart:    '<polyline points="3.5 17 9.5 10.5 13.5 14.5 20.5 6.5"/><polyline points="14.5 6.5 20.5 6.5 20.5 12.5"/>',
  target:   '<circle cx="12" cy="12" r="7.5"/><line x1="12" y1="1.8" x2="12" y2="5.6"/><line x1="12" y1="18.4" x2="12" y2="22.2"/><line x1="1.8" y1="12" x2="5.6" y2="12"/><line x1="18.4" y1="12" x2="22.2" y2="12"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  terminal: '<polyline points="4 17 10 11.5 4 6"/><line x1="12.5" y1="18" x2="20" y2="18"/>',
  bars:     '<line x1="5.5" y1="20" x2="5.5" y2="14"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="18.5" y1="20" x2="18.5" y2="3.5"/>',
  scale:    '<line x1="12" y1="3.5" x2="12" y2="20.5"/><line x1="7.5" y1="20.5" x2="16.5" y2="20.5"/><line x1="4.5" y1="6.5" x2="19.5" y2="6.5"/><path d="M4.5 6.5 2 13a2.6 2.6 0 0 0 5 0Z"/><path d="M19.5 6.5 17 13a2.6 2.6 0 0 0 5 0Z"/>',
  peak:     '<path d="m8.5 4.5 3.6 7.2 3.2-3.2 6 12H2.5Z"/>',
  chip:     '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><line x1="9" y1="2.2" x2="9" y2="5"/><line x1="15" y1="2.2" x2="15" y2="5"/><line x1="9" y1="19" x2="9" y2="21.8"/><line x1="15" y1="19" x2="15" y2="21.8"/><line x1="2.2" y1="9" x2="5" y2="9"/><line x1="2.2" y1="15" x2="5" y2="15"/><line x1="19" y1="9" x2="21.8" y2="9"/><line x1="19" y1="15" x2="21.8" y2="15"/>',
  globe:    '<circle cx="12" cy="12" r="8.8"/><line x1="3.2" y1="12" x2="20.8" y2="12"/><path d="M12 3.2a13.4 13.4 0 0 1 0 17.6 13.4 13.4 0 0 1 0-17.6Z"/>',
  percent:  '<line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/><circle cx="7" cy="7" r="2.6"/><circle cx="17" cy="17" r="2.6"/>',
  wallet:   '<path d="M20.5 12V7.5H6a2.25 2.25 0 0 1 0-4.5h13v4.5"/><path d="M3.75 5.25V18a2.5 2.5 0 0 0 2.5 2.5h14.25V15"/><path d="M17.5 12a1.75 1.75 0 0 0 0 3.5h4V12Z"/>',
  bell:     '<path d="M6.3 9.3a5.7 5.7 0 0 1 11.4 0c0 6 2.55 7.7 2.55 7.7H3.75s2.55-1.7 2.55-7.7"/><path d="M10.4 20.5a1.85 1.85 0 0 0 3.2 0"/>',
  /* 테마 토글용 */
  monitor:  '<rect x="2.8" y="4" width="18.4" height="13" rx="2"/><line x1="8.5" y1="20.6" x2="15.5" y2="20.6"/><line x1="12" y1="17" x2="12" y2="20.6"/>',
  sun:      '<circle cx="12" cy="12" r="4.4"/><line x1="12" y1="1.8" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.2"/><line x1="1.8" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.2" y2="12"/><line x1="4.8" y1="4.8" x2="6.4" y2="6.4"/><line x1="17.6" y1="17.6" x2="19.2" y2="19.2"/><line x1="4.8" y1="19.2" x2="6.4" y2="17.6"/><line x1="17.6" y1="6.4" x2="19.2" y2="4.8"/>',
  moon:     '<path d="M12 3.2a6.8 6.8 0 0 0 8.8 8.8A8.8 8.8 0 1 1 12 3.2Z"/>',
};
const icon = (name, size = 14) =>
  `<svg class="nav-ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[name]}</svg>`;

const NAV_PAGES = [
  { href: '/', icon: 'chart', label: '대시보드' },
  { href: '/flow', icon: 'target', label: '세력좌표' },
  { href: '/terminal', icon: 'terminal', label: '터미널' },
  { href: '/idx', icon: 'bars', label: '지수' },
  { href: '/marketcap', icon: 'scale', label: '시총비교' },
  { href: '/peak', icon: 'peak', label: '전고대비' },
  { href: '/ram', icon: 'chip', label: '램값' },
  { href: '/adr', icon: 'globe', label: '하닉ADR' },
  { href: '/etf', icon: 'percent', label: 'ETF' },
  { href: '/assets', icon: 'wallet', label: '자산' },
  { href: '/alerts', icon: 'bell', label: '알림' },
];

/* ── 테마 토글 ──
 * 세 상태를 돈다: 시스템 → 라이트 → 다크 → 시스템.
 * '시스템'을 없애고 라이트/다크만 두면, OS 를 바꿔도 대시보드가 안 따라와서
 * 결국 사용자가 두 곳을 관리하게 된다. 기본값은 시스템이어야 한다.
 *
 * 깜빡임(FOUC) 방지는 각 HTML <head> 의 인라인 스크립트가 맡는다.
 * 이 파일은 body 끝에서 로드되므로 여기서 적용하면 이미 한 번 그려진 뒤다. */
const THEME_KEY = 'theme-v1';
const THEME_CYCLE = [
  { v: 'system', icon: 'monitor', label: '시스템' },
  { v: 'light',  icon: 'sun', label: '라이트' },
  { v: 'dark',   icon: 'moon', label: '다크' },
];

function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return THEME_CYCLE.some((t) => t.v === v) ? v : 'system';
  } catch { return 'system'; }
}

function applyTheme(v) {
  const root = document.documentElement;
  if (v === 'system') delete root.dataset.theme;
  else root.dataset.theme = v;
  try { localStorage.setItem(THEME_KEY, v); } catch { /* 사생활 모드면 기억만 못 할 뿐 */ }
  /* 차트는 SVG 속성에 색 문자열을 박아 그린다 — CSS 변수가 바뀌어도 이미 그려진 선은
   * 옛 색 그대로다. 각 페이지가 이 신호를 받아 다시 그린다.
   *
   * rAF 로 미루면 안 된다: 탭이 숨어 있을 때 rAF 는 아예 안 돌아서 신호가 영영 안 간다.
   * 대신 getComputedStyle 을 한 번 읽어 스타일 재계산을 강제한 뒤 그 자리에서 쏜다 —
   * 이러면 리스너가 이미 새 변수 값을 읽는다. */
  getComputedStyle(root).getPropertyValue('--series-1');
  dispatchEvent(new Event('themechange'));
}

function themeButton() {
  const btn = document.createElement('button');
  btn.className = 'theme-btn';
  btn.type = 'button';

  const paint = () => {
    const cur = THEME_CYCLE.find((t) => t.v === readTheme());
    // 시스템일 때는 지금 실제로 어느 쪽인지도 같이 알려준다
    const actual = matchMedia('(prefers-color-scheme: light)').matches ? '라이트' : '다크';
    btn.innerHTML = icon(cur.icon, 15);
    btn.title = cur.v === 'system' ? `테마: 시스템 (현재 ${actual})` : `테마: ${cur.label}`;
    btn.setAttribute('aria-label', btn.title);
  };

  btn.addEventListener('click', () => {
    const i = THEME_CYCLE.findIndex((t) => t.v === readTheme());
    const next = THEME_CYCLE[(i + 1) % THEME_CYCLE.length].v;
    applyTheme(next);
    paint();
  });

  // 시스템 설정이 바뀌면 '시스템' 모드일 때 표시를 갱신한다
  // OS 설정이 바뀌면 '시스템' 모드에서는 실제 색이 바뀐다 — 차트도 다시 그려야 한다
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    paint();
    if (readTheme() === 'system') dispatchEvent(new Event('themechange'));
  });
  paint();
  return btn;
}

(function renderNav() {
  const box = document.querySelector('[data-nav]');
  if (!box) return;
  const here = location.pathname.replace(/\/$/, '') || '/';

  box.innerHTML = NAV_PAGES.map((pg) => {
    const active = pg.href === here;
    return `<a class="flow-link${active ? ' active' : ''}" href="${pg.href}"${active ? ' aria-current="page"' : ''}>${icon(pg.icon)} ${pg.label}</a>`;
  }).join('');

  // 넘치지 않으면 흐림을 끈다. 넘치면 끝에 닿았을 때만 끈다.
  const syncFade = () => {
    const over = box.scrollWidth - box.clientWidth;
    const atEnd = over <= 1 || box.scrollLeft >= over - 1;
    box.dataset.end = atEnd ? '1' : '0';
  };
  box.addEventListener('scroll', syncFade, { passive: true });
  addEventListener('resize', syncFade);

  // 현재 페이지가 스크롤 밖에 숨어 있으면 끌어온다 (부드럽게 하면 로드 직후 덜컹거린다)
  const cur = box.querySelector('.active');
  if (cur) {
    const c = cur.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (c.left < b.left || c.right > b.right) {
      box.scrollLeft = cur.offsetLeft - box.clientWidth / 2 + cur.offsetWidth / 2;
    }
  }
  syncFade();

  /* 상단 브랜드의 이모지도 같은 아이콘으로 맞춘다 — 내비만 바꾸면 둘이 따로 논다 */
  const mark = document.querySelector('.brand-mark');
  const me = NAV_PAGES.find((pg) => pg.href === here);
  if (mark && me) mark.innerHTML = icon(me.icon, 18);

  /* 토글은 내비 스크롤 영역 밖에 둔다 — 안에 넣으면 링크가 많을 때 밀려서 안 보인다 */
  const host = document.querySelector('.status') || box.parentElement;
  if (host && !host.querySelector('.theme-btn')) host.prepend(themeButton());
})();
