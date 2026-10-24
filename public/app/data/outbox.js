// outbox.js — 没信号也能记（第二阶段第一步：只管「记一条」）
// 记一条保存时网络不通（err.code === 'WB_OFFLINE'）：把这条连同它的 client_id 存进本机队列（localStorage wb-outbox），
// 输入框照常清空。联网后自动补存：启动时、同步状态回到「已同步」、浏览器 online 事件、页面回到前台。
//   - 一次一条，遇到网络错误就停，下次再试；补存前先轻轻探一下网络（失败不弹提示，后台补存不打扰人）
//   - 用同一个 client_id 补存：上次其实已经存上了（只是回应没回来）也不会变成两条（createTodo 负责）
//   - 「同一天已经有一条同样的重复待办」= 等于已经存上了，从队列里拿掉
//   - 其他原因没存上（数据库拒绝等）：标记出错、不再自动重试；在「N 条待同步」里可以重试或删掉
// 队列只在这台设备上；同步状态点（components/sync.js）显示「N 条待同步」，点开能看到标题。

import { table, onSync, syncState } from './db.js';
import { createTodo } from './repos/todos.js';
import { toast } from '../core/dom.js';

const KEY = 'wb-outbox';
let mem = [];   // localStorage 用不了（无痕模式）时的退路，本次打开期间有效

export function pending() {
  try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (_) { return mem; }
}
function save(list) {
  try { if (list.length) localStorage.setItem(KEY, JSON.stringify(list)); else localStorage.removeItem(KEY); } catch (_) { mem = list; }
  emit();
}

const subs = new Set();
/** 队列变化时回调 fn(条数) */
export const onOutbox = fn => { subs.add(fn); return () => subs.delete(fn); };
function emit() { const n = pending().length; subs.forEach(fn => { try { fn(n); } catch (e) { console.error(e); } }); }

/**
 * 放进队列。item：{ client_id, title（显示用）, data（createTodo 的参数）, remind, task（项目行，排催办用，可空） }
 * 同一个 client_id 只留一份。
 */
export function addOutbox(item) {
  const list = pending().filter(x => x.client_id !== item.client_id);
  list.push({ ...item, at: new Date().toISOString(), failed: null });
  save(list);
}
export function removeOutbox(clientId) { save(pending().filter(x => x.client_id !== clientId)); }
/** 删掉后撤销：原样放回 */
export function putBack(item) { if (!pending().some(x => x.client_id === item.client_id)) save([...pending(), item]); }
function markFailed(clientId, msg) { save(pending().map(x => (x.client_id === clientId ? { ...x, failed: msg } : x))); }

/** 网络通不通：不走 run()（它失败会弹提示），只看有没有回应。拿不到登录凭证也算不通（否则会以匿名身份写入） */
async function reachable() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const auth = window.cloud && window.cloud.auth;
  if (auth && typeof auth.getAccessToken === 'function' && !(await auth.getAccessToken().catch(() => null))) return false;
  if (!window.cloud || !window.cloud.database) return false;
  let timer;
  const res = await Promise.race([
    Promise.resolve(table('todos').select('id').limit(1)).catch(e => ({ error: e })),
    new Promise(r => { timer = setTimeout(() => r({ error: { code: 'WB_TIMEOUT' } }), 8000); }),
  ]).finally(() => clearTimeout(timer));
  return !(res && res.error);
}

let flushing = null;
/** 补存队列里的。force = 连标记出错的也重试（用户点了「现在保存」）。返回这次存上的条数 */
export function flushOutbox({ force = false } = {}) {
  if (!flushing) flushing = doFlush(force).catch(e => { console.warn('补存没做完', e); return 0; }).finally(() => { flushing = null; });
  return flushing;
}

async function doFlush(force) {
  const todo = pending().filter(x => force || !x.failed);
  if (!todo.length || !(await reachable())) return 0;
  let saved = 0;
  for (const item of todo) {
    if (!pending().some(x => x.client_id === item.client_id)) continue;   // 刚被删掉了
    try {
      await createTodo({ ...item.data, client_id: item.client_id }, { remind: item.remind || 'default', task: item.task || null });
      removeOutbox(item.client_id); saved++;
    } catch (e) {
      if (e && e.code === 'WB_OFFLINE') break;
      if (e && e.code === 'WB_DUP_REPEAT') { removeOutbox(item.client_id); saved++; continue; }
      markFailed(item.client_id, (e && e.handled && e.message) || '没有保存成功');
    }
  }
  if (saved) toast(`没信号时记下的 ${saved} 条已保存到云端`);
  return saved;
}

let inited = false;
/** 启动时调用一次（main.js，读完功能开关之后）：先补存一次，再挂上自动补存的时机 */
export function initOutbox() {
  if (inited) return;
  inited = true;
  let prev = syncState().state;
  onSync(s => { const was = prev; prev = s.state; if (s.state === 'ok' && was !== 'ok' && pending().length) flushOutbox(); });
  window.addEventListener('online', () => { if (pending().length) flushOutbox(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pending().length) flushOutbox(); });
  window.addEventListener('storage', e => { if (e.key === KEY) emit(); });   // 另一个标签页改了队列
  if (pending().length) flushOutbox();
}
