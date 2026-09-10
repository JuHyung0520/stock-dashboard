/* DOM·네트워크 헬퍼 — pure.js 와 갈라 둔다.
 * pure.js 는 "DOM 을 안 건드린다"가 규칙이고 그래서 Node 테스트가 직접 부를 수 있다.
 * fetch 와 querySelector 를 거기 넣으면 그 성질이 깨진다.
 *
 * 이 둘도 11개 페이지가 각자 정의하고 있었다 — 구현이 같으니 한 곳에 둔다. */
const $ = (sel) => document.querySelector(sel);

/* opts 는 alerts 의 PUT 때문에 필요하다. 나머지 페이지는 안 넘기면 그만이라
 * 상위 집합인 이 형태 하나로 충분하다. */
const api = async (p, opts) => {
  const r = await fetch(p, opts);
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
