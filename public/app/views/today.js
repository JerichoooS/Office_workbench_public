// today.js — 首页「今天」
// 展开：逾期 / 今天 / 等待他人；折叠：即将到期（未来 7 天）
// AI 开启时顶部多一条简报（可收起）

import { esc, toast, icon, openSheet, closeSheet } from '../core/dom.js';
import { openOverview, bindOverviewSwipe } from '../components/overview.js';
import * as calendar from './calendar.js';
import { todayTitle, dayDiff, isOverdue } from '../core/dates.js';
import { listTodos, setStatus } from '../data/repos/todos.js';
import { listTasks } from '../data/repos/tasks.js';
import { todoRow, byId } from '../components/todo-row.js';
import { mountCapture } from '../components/capture.js';
import { openTodo } from '../components/todo-detail.js';
import { aiOn } from '../data/ai.js';
import { openAiChat } from '../components/ai-chat.js';
import { cachedSettings } from '../data/repos/settings.js';

let soonOpen = false, reviewToggle = null, justToggled = '';
// 晚报通知打开 #/today?review=1 时默认展开「今天完成」
const reviewOpen = () => reviewToggle !== null ? reviewToggle : /[?&]review=1/.test(location.hash);

export async function mount(root) {
  const [todos, tasks] = await Promise.all([listTodos(), listTasks()]);
  const T = byId(tasks);
  const open = todos.filter(t => t.status !== 'done');
  const overdue = open.filter(t => isOverdue(t));
  const today = open.filter(t => !isOverdue(t) && t.due_at && dayDiff(new Date(t.due_at)) === 0 && t.status !== 'waiting');
  const waiting = open.filter(t => t.status === 'waiting' && !isOverdue(t));
  const soon = open.filter(t => t.status !== 'waiting' && t.due_at && dayDiff(new Date(t.due_at)) > 0 && dayDiff(new Date(t.due_at)) <= 7);
  const noDate = open.filter(t => !t.due_at && t.status !== 'waiting');
  const doneToday = todos.filter(t => t.status === 'done' && t.completed_at && dayDiff(new Date(t.completed_at)) === 0);
  const activeTask = tasks.find(t => t.start_date && t.end_date);

  const group = (title, rows, { cls = '', note = '', empty = '' } = {}) => rows.length || empty ? `<div class="group">
      <div class="group-h ${cls}"><b>${title}</b><span class="num">${rows.length}</span>${note ? `<span>· ${note}</span>` : ''}</div>
      <div class="list">${rows.map(t => todoRow(t, { tasks: T })).join('') || `<div class="empty">${empty}</div>`}</div></div>` : '';

  root.innerHTML = `<div class="wrap">
    <div class="page-head home-head">
      <button class="icon-btn" data-act="overview" aria-label="概览（也可从左往右滑）" title="概览">${icon('overview')}</button>
      <div style="flex:1;min-width:0"><h1>今天</h1><div class="sub">${todayTitle()}${doneToday.length ? ` · 已完成 <span class="num">${doneToday.length}</span> 件` : ''}</div></div>
      ${aiOn('chat') ? `<button class="icon-btn ai-btn" data-act="ai" aria-label="AI 助手" title="AI 助手">✦</button>` : ''}
      <button class="icon-btn quick-add" id="qa-btn" aria-label="记一条" aria-expanded="false" title="记一条"></button>
      <button class="icon-btn" data-act="calendar" aria-label="日历" title="日历">${icon('cal')}</button></div>
    <div id="cap-box"></div>
    ${aiOn() ? ''
      : (cachedSettings() && cachedSettings().ai_enabled ? '<div class="brief"><span class="tag">AI</span><p>AI 已开启，但还没填 DeepSeek Key。<a href="#/settings">去设置</a></p></div>' : '')}
    ${group('逾期', overdue, { cls: 'bad' })}
    ${group('今天', today, { empty: '今天没有到期的待办' })}
    ${group('等待他人', waiting, { note: '按项目剩余时间自动催办' })}
    ${noDate.length ? group('未定时间', noDate) : ''}
    <div class="group"><button class="group-h" data-act="soon"><b>${soonOpen ? '▾' : '▸'} 即将到期</b><span class="num">${soon.length}</span><span>· 未来 7 天${soonOpen ? '' : '，点开查看'}</span></button>
      ${soonOpen ? `<div class="list ${justToggled === 'soon' ? 'reveal' : ''}">${soon.map(t => todoRow(t, { tasks: T })).join('') || '<div class="empty">未来 7 天没有到期的待办</div>'}</div>` : ''}</div>
    ${doneToday.length ? `<div class="group"><button class="group-h" data-act="review"><b>${reviewOpen() ? '▾' : '▸'} 今天完成</b><span class="num">${doneToday.length}</span></button>
      ${reviewOpen() ? `<div class="list ${justToggled === 'review' ? 'reveal' : ''}">${doneToday.map(t => todoRow(t, { tasks: T })).join('')}</div>` : ''}</div>` : ''}
    <a class="all-link" href="#/all">查看全部待办 ›</a>
    ${!todos.length && window.WBBoot.mock && window.WBMock.isEmpty() ? `<div class="placeholder">本地模拟库是空的。<button class="btn small" data-act="seed">填充示例数据</button></div>` : ''}
  </div>`;

  mountCapture(root.querySelector('#cap-box'), { trigger: root.querySelector('#qa-btn') });
  if (!root._swipe) { root._swipe = true; bindOverviewSwipe(root); }

  root.onclick = async e => {
    const chk = e.target.closest('[data-check]');
    if (chk) {
      e.stopPropagation();
      const t = todos.find(x => String(x.id) === chk.dataset.check);
      const r = await setStatus(t, t.status === 'done' ? 'todo' : 'done', { task: T[t.task_id] });
      toast(t.status === 'done' ? '已恢复' : r.next ? '完成 ✓ 已生成下一次' : '完成 ✓');
      return;
    }
    const row = e.target.closest('[data-todo]');
    if (row) { row.classList.add('sel'); openTodo(row.dataset.todo); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'soon') { soonOpen = !soonOpen; justToggled = 'soon'; await mount(root); justToggled = ''; }
    if (act.dataset.act === 'overview') openOverview();
    if (act.dataset.act === 'ai') openAiChat({ todos, tasks });
    if (act.dataset.act === 'calendar') {
      const el = openSheet('<div class="sheet-head"><b>日历</b><span class="sp"></span><button class="btn small" data-x>关闭</button></div><div id="cal-box" class="in-sheet"></div>', { label: '日历' });
      el.querySelector('[data-x]').onclick = () => closeSheet();
      calendar.mount(el.querySelector('#cal-box'), {}, { inSheet: true });
    }
    if (act.dataset.act === 'review') { reviewToggle = !reviewOpen(); justToggled = 'review'; await mount(root); justToggled = ''; }
    if (act.dataset.act === 'seed') window.WBMock.seed();
  };
}

