// router.js — hash 路由：#/today、#/tasks/12 ……
// OAuth 回调必须落在根路径（/?code=…），所以页面路由一律用 hash，不改 pathname。

const routes = [];   // [{ re, view, keys }]

/** 注册路由：pattern 如 '/tasks/:id' */
export function route(pattern, view) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, view, keys, pattern });
}

export function current() {
  const path = (location.hash.replace(/^#/, '') || '/today').split('?')[0];
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) return { view: r.view, pattern: r.pattern, path, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return { view: routes[0].view, pattern: routes[0].pattern, path: '/today', params: {} };
}

export function go(path) {
  if (location.hash === '#' + path) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = path;
}

export function onChange(fn) { window.addEventListener('hashchange', fn); }
