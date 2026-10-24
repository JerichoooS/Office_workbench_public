// today.js — 首页「今天」
// 分组顺序（2026-10-22 确认）：逾期 / 今天 / 等待他人 / 即将到期（折叠，未来 7 天）/ 未定时间（超过 5 条时折叠）/ 今天完成（折叠）
// 日期旁的小圆点是同步状态（components/sync.js）；等待他人的行显示下次催办时间。

import { icon, openSheet, closeSheet } from '../core/dom.js';
import { openOverview, bindOverviewSwipe } from '../components/overview.js';
import * as calendar from './calendar.js';
import { todayTitle, dayDiff, isOverdue } from '../core/dates.js';
import { listTodos } from '../data/repos/todos.js';
import { listTasks } from '../data/repos/tasks.js';
import { todoRow, byId, toggleDone, pendingNudges } from '../components/todo-row.js';
import { syncDot } from '../components/sync.js';
import { mountCapture } from '../components/capture.js';
import { mountHomeNotice } from '../components/home-notice.js';
import { openTodo } from '../components/todo-detail.js';
import { aiOn } from '../data/ai.js';
import { openAiChat } from '../components/ai-chat.js';
import { cachedSettings } from '../data/repos/settings.js';

let soonOpen = false, noDateOpen = false, reviewToggle = null, justToggled = '';
// 晚报通知打开 #/today?review=1 时默认展开「今天完成」
const reviewOpen = () => reviewToggle !== null ? reviewToggle : /[?&]review=1/.test(location.hash);

export async function mount(root) {
  const [todos, tasks, archived, nudges] = await Promise.all([listTodos(), listTasks(), listTasks({ archived: true }), pendingNudges().catch(() => ({}))]);
  const T = byId([...tasks, ...archived]);
  const open = todos.filter(t => t.status !== 'done');
  const overdue = open.filter(t => isOverdue(t));
  const today = open.filter(t => !isOverdue(t) && t.due_at && dayDiff(new Date(t.due_at)) === 0 && t.status !== 'waiting');
  const waiting = open.filter(t => t.status === 'waiting' && !isOverdue(t));
  const soon = open.filter(t => t.status !== 'waiting' && t.due_at && dayDiff(new Date(t.due_at)) > 0 && dayDiff(new Date(t.due_at)) <= 7);
  const noDate = open.filter(t => !t.due_at && t.status !== 'waiting');
  const doneToday = todos.filter(t => t.status === 'done' && t.completed_at && dayDiff(new Date(t.completed_at)) === 0);
  const activeTask = tasks.find(t => t.start_date && t.end_date);

  const ctx = { tasks: T, nudges };
  const group = (title, rows, { cls = '', note = '', empty = '' } = {}) => rows.length || empty ? `<div class="group">
      <div class="group-h ${cls}"><b>${title}</b><span class="num">${rows.length}</span>${note ? `<span>· ${note}</span>` : ''}</div>
      <div class="list">${rows.map(t => todoRow(t, ctx)).join('') || `<div class="empty">${empty}</div>`}</div></div>` : '';
  // 可折叠的分组：标题行是按钮
  const fold = (key, title, rows, open, note) => `<div class="group"><button class="group-h" data-act="${key}" aria-expanded="${open}"><b>${open ? '▾' : '▸'} ${title}</b><span class="num">${rows.length}</span>${note ? `<span>· ${note}</span>` : ''}</button>
      ${open ? `<div class="list ${justToggled === key ? 'reveal' : ''}">${rows.map(t => todoRow(t, ctx)).join('') || '<div class="empty">没有</div>'}</div>` : ''}</div>`;

  root.innerHTML = `<div class="wrap">
    <div class="page-head home-head">
      <button class="icon-btn" data-act="overview" aria-label="概览（也可从左往右滑）" title="概览">${icon('overview')}</button>
      <div style="flex:1;min-width:0"><h1>今天</h1><div class="sub">${todayTitle()}${doneToday.length ? ` · 已完成 <span class="num">${doneToday.length}</span> 件` : ''} ${syncDot()}</div></div>
      ${aiOn('chat') ? `<button class="icon-btn ai-btn" data-act="ai" aria-label="AI 助手" title="AI 助手">✦</button>` : ''}
      <button class="icon-btn quick-add" id="qa-btn" aria-label="记一条" aria-expanded="false" title="记一条"></button>
      <button class="icon-btn" data-act="calendar" aria-label="日历" title="日历">${icon('cal')}</button></div>
    <div id="cap-box"></div>
    <div id="home-notice"></div>
    ${aiOn() ? ''
      : (cachedSettings() && cachedSettings().ai_enabled ? '<div class="brief"><span class="tag">AI</span><p>AI 已开启，但还没填 DeepSeek Key。<a href="#/settings">去设置</a></p></div>' : '')}
    ${group('逾期', overdue, { cls: 'bad' })}
    ${group('今天', today, { empty: '今天没有到期的待办' })}
    ${group('等待他人', waiting, { note: '到时间自动催办' })}
    ${fold('soon', '即将到期', soon, soonOpen, '未来 7 天' + (soonOpen ? '' : '，点开查看'))}
    ${noDate.length > 5 ? fold('nodate', '未定时间', noDate, noDateOpen, '还没定截止日期') : noDate.length ? group('未定时间', noDate) : ''}
    ${doneToday.length ? fold('review', '今天完成', doneToday, reviewOpen()) : ''}
    <a class="all-link" href="#/all">查看全部待办 ›</a>
    ${!todos.length && window.WBBoot.mock && window.WBMock.isEmpty() ? `<div class="placeholder">本地模拟库是空的。<button class="btn small" data-act="seed">填充示例数据</button></div>` : ''}
  </div>`;

  mountCapture(root.querySelector('#cap-box'), { trigger: root.querySelector('#qa-btn') });
  mountHomeNotice(root.querySelector('#home-notice'));   // 不等它：提示卡晚一点出现没关系
  if (!root._swipe) { root._swipe = true; bindOverviewSwipe(root); }

  root.onclick = async e => {
    const chk = e.target.closest('[data-check]');
    if (chk) {
      e.stopPropagation();
      const t = todos.find(x => String(x.id) === chk.dataset.check);
      await toggleDone(t, { task: T[t.task_id], el: chk });
      return;
    }
    const row = e.target.closest('[data-todo]');
    if (row) { row.classList.add('sel'); openTodo(row.dataset.todo); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'soon') { soonOpen = !soonOpen; justToggled = 'soon'; await mount(root); justToggled = ''; }
    if (act.dataset.act === 'nodate') { noDateOpen = !noDateOpen; justToggled = 'nodate'; await mount(root); justToggled = ''; }
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

