// board.js — 看板：专门管「正在推进的事」（用户确认 a + b + d + e，2026-10-20）
//   a. 默认展开「进行中」「等待他人」，「未开始」「已完成」收起（点列头可展开）
//   b. 顶部项目标签切换：全部 / 各项目 / 零星待办
//   d. 卡片显示：所属项目、截止时间、等待对象、子步骤进度
//   e. 拖动卡片到别的列 = 改状态（鼠标直接拖；手机长按 LONG_PRESS_MS 后拖，按住时卡片会下沉提示）
// 列的顺序与默认收起在 COLS 里改。

import { esc, toast } from '../core/dom.js';
import { todoStatus } from '../data/schema.js';
import { listTodos, setStatus } from '../data/repos/todos.js';
import { listTasks } from '../data/repos/tasks.js';
import { todoCard, byId } from '../components/todo-row.js';
import { openTodo } from '../components/todo-detail.js';

const LONG_PRESS_MS = 300;   // 手机长按多久开始拖（真机试用后可调）
const COLS = [['doing', false], ['waiting', false], ['todo', true], ['done', true]];   // [状态, 默认收起]
const collapsed = Object.fromEntries(COLS.map(([k, c]) => [k, c]));
let filter = '';   // '' 全部 / 'inbox' / 项目 id
let unbind = null; // 上一次的拖动监听（看板内部重绘也要先解绑）

export async function mount(root) {
  if (unbind) { unbind(); unbind = null; }
  const [todos, tasks] = await Promise.all([listTodos(), listTasks()]);
  const T = byId(tasks);
  const rows = filter === 'inbox' ? todos.filter(t => !t.task_id) : filter ? todos.filter(t => String(t.task_id) === filter) : todos;
  const chips = [['', '全部'], ...tasks.map(t => [String(t.id), t.title]), ['inbox', '零星待办']];
  root.innerHTML = `<div class="wrap wide">
    <div class="page-head"><div><h1>看板</h1><div class="sub">正在推进的事。拖动卡片换列即可改状态（手机上长按再拖）</div></div></div>
    <div class="chip-row" role="tablist" aria-label="按项目筛选">${chips.map(([v, l]) => `<button class="chip ${filter === v ? 'accent' : 'ghost'}" data-filter="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    <div class="board">${COLS.map(([k]) => {
      const s = todoStatus(k), list = rows.filter(t => t.status === k);
      return `<div class="col ${collapsed[k] ? 'collapsed' : ''}" data-status="${k}">
        <button class="col-h" data-col="${k}"><span class="bullet" style="background:${s.color}"></span>${s.label}<span class="n num">${list.length}</span><span class="caret">▾</span></button>
        ${list.map(t => todoCard(t, { tasks: T })).join('') || '<div class="hint col-empty">拖到这里</div>'}</div>`;
    }).join('')}</div></div>`;

  root.onclick = e => {
    if (dragged) { dragged = false; return; }   // 拖动结束时不当作点击
    const f = e.target.closest('[data-filter]'); if (f) { filter = f.dataset.filter; mount(root); return; }
    const c = e.target.closest('[data-col]');
    if (c) { collapsed[c.dataset.col] = !collapsed[c.dataset.col]; const col = c.parentElement; col.classList.toggle('collapsed'); col.classList.toggle('just-opened', !collapsed[c.dataset.col]); return; }
    const card = e.target.closest('[data-todo]');
    if (card) openTodo(card.dataset.todo);
  };
  unbind = bindDrag(root, id => todos.find(t => String(t.id) === String(id)), T);
  return () => { if (unbind) { unbind(); unbind = null; } };   // 切页时解绑
}

// ---------- 拖动改状态 ----------
let dragged = false;
function bindDrag(root, findTodo, T) {
  const board = root.querySelector('.board');
  let start = null, ghost = null, card = null, timer = null, overCol = null;

  const begin = (x, y) => {
    ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    const r = card.getBoundingClientRect();
    ghost.style.width = r.width + 'px';
    ghost._dx = x - r.left; ghost._dy = y - r.top;
    document.body.appendChild(ghost);
    card.classList.add('drag-src');
    move(x, y);
    if (navigator.vibrate) navigator.vibrate(10);
  };
  const move = (x, y) => {
    ghost.style.transform = `translate(${x - ghost._dx}px, ${y - ghost._dy}px) rotate(1.5deg)`;
    const col = document.elementFromPoint(x, y)?.closest('.board .col');
    if (col !== overCol) { if (overCol) overCol.classList.remove('drop'); overCol = col; if (col) col.classList.add('drop'); }
  };
  const end = async () => {
    clearTimeout(timer);
    if (card) card.classList.remove('pressing');
    if (ghost) {
      ghost.remove(); ghost = null; card.classList.remove('drag-src'); dragged = true;
      const target = overCol && overCol.dataset.status;
      if (overCol) overCol.classList.remove('drop');
      const t = findTodo(card.dataset.todo);
      overCol = null;
      if (t && target && target !== t.status) { await setStatus(t, target, { task: T[t.task_id] }); toast(`已移到「${todoStatus(target).label}」`); }
    }
    start = null; card = null;
  };

  board.addEventListener('pointerdown', e => {
    const c = e.target.closest('.card'); if (!c || e.button > 0) return;
    card = c; start = { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
    if (start.touch) {   // 手机：按住时卡片轻微下沉提示，满 LONG_PRESS_MS 开始拖
      c.classList.add('pressing');
      timer = setTimeout(() => { if (card) { card.classList.remove('pressing'); begin(start.x, start.y); } }, LONG_PRESS_MS);
    }
  });
  const onMove = e => {
    if (!start) return;
    if (ghost) { move(e.clientX, e.clientY); return; }
    const d = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (start.touch) { if (d > 8) { clearTimeout(timer); card.classList.remove('pressing'); start = null; card = null; } }   // 长按前就动了 = 在滚动页面
    else if (d > 6) begin(e.clientX, e.clientY);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // 拖动中阻止页面滚动（手机）
  board.addEventListener('touchmove', e => { if (ghost) e.preventDefault(); }, { passive: false });
  board.addEventListener('contextmenu', e => { if (e.target.closest('.card')) e.preventDefault(); });
  return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); if (ghost) ghost.remove(); };
}
