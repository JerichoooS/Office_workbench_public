// todo-detail.js — 待办详情（桌面右侧抽屉 / 手机全屏）
// 从上到下（2026-10-22 重排，按使用频率）：
//   标题 → 状态 → 记一笔 + 最近 2 条进展 → 等待信息一行（拨打 / 换人）
//   → 截止（今天 / 明天 / 下周一 快捷）、提醒、所属项目、标签 → 子步骤 → 备注（网址、电话可点）
//   → 全部进展 → 更多设置（重复、优先级）→ 删除
// 改任何一项后只重画详情，滚动位置不变；「已保存」只在真正保存成功后提示。
// 基于界面上的旧行算出的改动（子步骤、标签、等待对象）一律用 updateTodoWith，两处同时改不会互相覆盖。
// 只记进展：备注里放说明、链接、电话；文件、照片、网络参数、公文正文不放进工作台（用户确认，2026-10-22）。
// 第二阶段：自动留痕（改状态、改截止、已催）在最近 2 条和全部进展里用浅色小字，和手写的区分开；
//   等待一行有「已催」：记一笔并从现在起重排下一次催办；改截止一律走 todos.changeDue（提醒跟着改，不丢手动加的）。

import { esc, icon, linkify, openDrawer, closeDrawer, openSheet, closeSheet, toast, confirmSheet } from '../core/dom.js';
import { dueLabel, ago, ymd, hm, dayDiff, addDays, startOfDay } from '../core/dates.js';
import { TODO_STATUS, PRIORITY, repeatLabel, contactKind, CONTACT_KIND } from '../data/schema.js';
import { getTodo, updateTodo, updateTodoWith, setStatus, removeTodo, listLogs, addLog, listReminders, addReminder, removeReminder, scheduleNudge, changeDue, markNudged } from '../data/repos/todos.js';
import { listTasks, getTask, taskContactIds, taskEnded } from '../data/repos/tasks.js';
import { listContacts, contactById, createContact } from '../data/repos/contacts.js';
import { suggestTags, bumpTags, listTags } from '../data/repos/tags.js';
import { taskProgress, nudgeIntervalDays, beforeDueAt } from '../core/schedule.js';
import { aiOn, aiSuggestTags } from '../data/ai.js';
import { saveFailed } from '../data/db.js';
import { openReport } from './report-sheet.js';
import { phase2 } from '../data/features.js';
import { toastDeleted } from '../data/repos/trash.js';

const KIND_LABEL = { before_due: '截止前', at_time: '准时', nudge: '催办' };
let openId = null;
let firstDraw = false;

export async function openTodo(id) {
  openId = id;
  firstDraw = true;
  const el = openDrawer('<div class="d-head">加载中…</div>', { label: '待办详情', onClose: () => { openId = null; document.querySelectorAll('.item.sel').forEach(x => x.classList.remove('sel')); } });
  try { await draw(el); }
  catch (e) {
    if (openId !== id) return;
    el.innerHTML = `<div class="d-head"><span class="sp"></span><button class="btn small" data-x>关闭</button></div><div class="d-body"><div class="placeholder">${esc(e.handled ? e.message : '没能打开这条待办')}<button class="btn small" data-retry>重试</button></div></div>`;
    el.onclick = ev => { if (ev.target.closest('[data-x]')) closeDrawer(); if (ev.target.closest('[data-retry]')) openTodo(id); };
  }
}

const dueAtDay = (d, t) => {   // 快捷改日期：全天的存当天 23:59；有时刻的保留原来的时刻
  const x = new Date(d);
  if (t.due_all_day || !t.due_at) x.setHours(23, 59, 0, 0);
  else { const o = new Date(t.due_at); x.setHours(o.getHours(), o.getMinutes(), 0, 0); }
  return x;
};
const nextMonday = () => { const d = startOfDay(new Date()); return addDays(d, ((8 - d.getDay()) % 7) || 7); };
const isAuto = l => !!l.kind && l.kind !== 'note';   // 自动留痕（改状态、改截止、已催）

async function draw(el) {
  const id = openId;
  const t = await getTodo(id);
  if (openId !== id) return;
  if (!t) { closeDrawer(); toast('这条待办已不存在'); return; }
  const [tasks, contacts, logs, rems, tagSug, allTagRows] = await Promise.all([listTasks(), listContacts(), listLogs(t.id), listReminders(t.id), suggestTags(t.title, t.tags || [], 3), listTags()]);
  const task = t.task_id ? (tasks.find(x => x.id == t.task_id) || await getTask(t.task_id)) : null;
  const w = contactById(t.waiting_on);
  const cl = t.checklist || [];
  let nudge = rems.find(r => r.kind === 'nudge' && !r.sent_at);
  // 自愈：等待中必须有下一次催办。项目已过结束日的不补（收尾时可能点了「停止催办」；要重新催点「已催」）
  const stopped = t.status === 'waiting' && !nudge && taskEnded(task);
  if (t.status === 'waiting' && !nudge && !stopped) nudge = { fire_at: (await scheduleNudge(t, task)).toISOString() };
  if (openId !== id) return;
  const pend = rems.filter(r => r.kind !== 'nudge' && !r.sent_at);
  const dueVal = t.due_at ? (t.due_all_day ? ymd(new Date(t.due_at)) : `${ymd(new Date(t.due_at))}T${hm(new Date(t.due_at))}`) : '';
  const allTags = allTagRows.map(x => x.name);
  const prog = taskProgress(task);
  const recent = logs.slice(-2).reverse();
  const quick = [['今天', startOfDay(new Date())], ['明天', addDays(startOfDay(new Date()), 1)], ['下周一', nextMonday()]];
  const dueDay = t.due_at ? ymd(new Date(t.due_at)) : '';

  // 重画前记下滚动位置（改完一项不再跳回顶部）
  const oldBody = el.querySelector('.d-body'), y = oldBody ? oldBody.scrollTop : 0;
  el.innerHTML = `<div class="d-head">
      <span class="crumb">${task ? `<a href="#/tasks/${task.id}" data-close>${esc(task.title)}</a>` : '<span>零星待办</span>'}<span class="crumb-sep">›</span><span>待办</span></span><span class="sp"></span>
      <button class="btn small" data-act="close">关闭</button></div>
    <div class="d-body ${firstDraw ? 'stagger' : ''}">
      <textarea class="d-title-in" id="d-title" rows="2" aria-label="待办标题（可直接修改）">${esc(t.title)}</textarea>
      <div class="statuses" role="group" aria-label="状态">${TODO_STATUS.map(s => `<button data-status="${s.v}" aria-pressed="${t.status === s.v}">${s.label}</button>`).join('')}</div>
      ${/周报/.test(t.title) ? `<button class="btn" data-act="report" style="align-self:flex-start">${icon('report')}生成本周周报草稿</button>` : ''}

      <div class="log-box">
        <div class="inline-input"><input id="d-log" placeholder="记一笔进展（打了电话、对方答复…），回车保存" enterkeyhint="send" aria-label="记一笔进展"><button class="btn small primary" data-act="log">记录</button></div>
        ${recent.length ? `<div class="recent">${recent.map(l => `<div class="rc ${isAuto(l) ? 'auto' : ''}"><span class="when num">${esc(ago(l.created_at))}</span><span class="what">${linkify(l.content)}</span></div>`).join('')}
          ${logs.length > 2 ? `<button class="hint" data-act="all-logs">全部 ${logs.length} 条进展 ↓</button>` : ''}</div>` : ''}
      </div>

      ${t.status === 'waiting' ? `<div class="nudge">
        <div class="wait-line"><span>等 <b>${w ? esc(w.name) : '（还没选）'}</b>${w && w.org ? `<span class="hint"> · ${esc(w.org)}</span>` : ''}${t.waiting_since ? ` · 已 <span class="num">${Math.max(0, -dayDiff(new Date(t.waiting_since)))}</span> 天` : ''}</span><span class="sp"></span>
          ${w && w.phone ? `<a class="btn small" href="tel:${esc(w.phone.replace(/[^\d+]/g, ''))}">${icon('phone')}拨打</a>` : ''}
          <button class="btn small" data-act="nudged" title="已经催过对方：记一笔，从现在起重新算下次催办">已催</button>
          <button class="btn small ${w ? '' : 'primary'}" data-act="pick-wait">${w ? '换人' : '选择等待对象'}</button></div>
        <div class="hint">${stopped ? '项目已过结束日，已停止自动催办（点「已催」重新开始）' : `下次自动催办：${nudge ? esc(dueLabel(nudge.fire_at, false)) : '—'}${prog !== null ? `（项目时间已过 <span class="num">${Math.round(prog * 100)}%</span>，每 ${nudgeIntervalDays(task)} 天催一次）` : `（每 ${nudgeIntervalDays(null)} 天催一次）`}`}</div>
      </div>` : ''}

      <dl class="kv">
        <dt>截止</dt><dd><input class="time-in" id="d-due" type="${t.due_all_day ? 'date' : 'datetime-local'}" value="${dueVal}" aria-label="截止">
          ${quick.map(([l, d]) => `<button class="chip ${dueDay === ymd(d) ? 'accent' : 'ghost'}" data-quick="${ymd(d)}">${l}</button>`).join('')}
          <button class="chip ghost" data-act="allday" title="切换全天 / 有具体时刻">${t.due_all_day ? '全天' : '有时刻'}</button>${t.due_at ? '<button class="chip ghost" data-act="clear-due">清除</button>' : ''}</dd>
        <dt>提醒</dt><dd>${pend.map(r => `<span class="chip warn">${KIND_LABEL[r.kind]} ${esc(dueLabel(r.fire_at, false))}<button data-delrem="${r.id}" aria-label="删除提醒">×</button></span>`).join('')}
          <select class="time-in" id="d-addrem" aria-label="添加提醒"><option value="">＋ 添加</option>${t.due_at ? `<option value="b15">截止前 15 分钟</option><option value="b60">截止前 1 小时</option><option value="b1440">截止前 1 天</option>` : ''}${t.due_at && !t.due_all_day ? '<option value="at">截止时准时</option>' : ''}<option value="custom">指定时间…</option></select>
          <input class="time-in" id="d-remat" type="datetime-local" hidden aria-label="提醒时间"></dd>
        <dt>项目</dt><dd><select class="time-in" id="d-task" style="max-width:100%" aria-label="所属项目"><option value="">零星待办（不归入项目）</option>${tasks.map(x => `<option value="${x.id}" ${x.id == t.task_id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}${task && task.archived_at ? `<option value="${task.id}" selected>${esc(task.title)}（已归档）</option>` : ''}</select></dd>
        <dt>标签</dt><dd id="d-tags">${(t.tags || []).map(x => `<button class="chip tag" data-untag="${esc(x)}" aria-label="去掉标签 ${esc(x)}">#${esc(x)} ×</button>`).join('')}
          ${tagSug.map(x => `<button class="chip ghost" data-tag="${esc(x)}">＋ #${esc(x)}</button>`).join('')}
          ${aiOn('tags') ? '<button class="chip ghost" data-act="ai-tags">✦ AI 推荐</button>' : ''}
          <button class="chip ghost" data-act="add-tag">＋ 标签</button>
          <span class="tag-add" id="d-tag-box" hidden><input id="d-newtag" list="d-tag-list" placeholder="标签名，回车添加" enterkeyhint="done"><datalist id="d-tag-list">${allTags.map(x => `<option value="${esc(x)}">`).join('')}</datalist></span></dd>
      </dl>

      <div><div class="sec-h">子步骤 <span class="num">${cl.filter(c => c.done).length}/${cl.length}</span><span class="hint" style="letter-spacing:0">· 全部勾完不等于待办完成</span></div>
        <div class="sub-list">${cl.map((c, i) => `<label><input type="checkbox" data-cl="${i}" ${c.done ? 'checked' : ''}><span style="flex:1">${esc(c.text)}</span><button class="hint rm" data-cldel="${i}" aria-label="删除子步骤">×</button></label>`).join('')}</div>
        <div class="inline-input" style="margin-top:8px"><input id="d-clnew" placeholder="加一个子步骤，回车保存" enterkeyhint="done" aria-label="加一个子步骤"></div></div>

      <div><div class="sec-h">备注<span class="sp"></span>${t.notes ? '<button class="hint" data-act="edit-notes">编辑</button>' : ''}</div>
        ${t.notes ? `<div class="notes" data-act="edit-notes">${linkify(t.notes)}</div>`
          : '<textarea class="input notes-in" id="d-notes" rows="2" placeholder="补充说明、共享盘或 OA 链接、电话。只记进展，文件和参数留在单位系统里"></textarea>'}</div>

      <div id="d-logs"><div class="sec-h">全部进展 <span class="num">${logs.length}</span></div>
        <div class="timeline">${logs.map(l => `<div class="tl ${isAuto(l) ? 'auto' : ''}"><span class="when num">${esc(ago(l.created_at))}</span><span class="dot"></span><span class="what">${linkify(l.content)}</span></div>`).join('') || '<span class="hint">还没有记录。每次跟进后在上面记一笔，方便回头查、写周报。</span>'}</div></div>

      <details class="fold" ${sessionStorage.getItem('wb-fold') === '1' ? 'open' : ''}><summary>更多设置
        ${t.repeat_rule ? `<span class="chip">↻ ${esc(repeatLabel(t.repeat_rule))}</span>` : ''}${t.priority != null ? `<span class="chip">P${t.priority}</span>` : ''}</summary>
        <dl class="kv">
          <dt>重复</dt><dd><select class="time-in" id="d-repeat" aria-label="重复">
            <option value="">不重复</option><option value="daily" ${t.repeat_rule && t.repeat_rule.freq === 'daily' ? 'selected' : ''}>每天</option>
            <option value="weekdays" ${t.repeat_rule && t.repeat_rule.freq === 'weekdays' ? 'selected' : ''}>每个工作日（跳过法定节假日）</option>
            <option value="weekly" ${t.repeat_rule && t.repeat_rule.freq === 'weekly' ? 'selected' : ''}>每周（同一天）</option>
            <option value="monthly" ${t.repeat_rule && t.repeat_rule.freq === 'monthly' ? 'selected' : ''}>每月（同一号）</option></select>
            ${t.repeat_rule && t.repeat_rule.freq === 'weekdays' ? '<span class="hint">法定节假日不生成，调休上班的周六、周日照常</span>' : ''}</dd>
          <dt>优先级</dt><dd>${PRIORITY.map(p => `<button class="chip ${t.priority === p.v ? p.chip || 'accent' : 'ghost'}" data-pr="${p.v}" aria-pressed="${t.priority === p.v}">${p.label}</button>`).join('')}</dd>
        </dl></details>

      <div class="d-foot"><span class="hint">创建于 ${esc(ago(t.created_at))}</span><span class="sp"></span><button class="btn small danger" data-act="delete">删除这条待办</button></div>
    </div>`;
  firstDraw = false;
  el.querySelector('.d-body').scrollTop = y;

  const $ = s => el.querySelector(s);
  const refresh = () => draw(el);
  // 保存后再提示；失败时 run() 已经弹出原因，这里不再说「已保存」
  const save = async (build, msg) => {
    const row = await (typeof build === 'function' ? updateTodoWith(t.id, build) : updateTodo(t.id, build)).catch(e => { saveFailed(e); return undefined; });
    if (row === undefined) return;
    if (msg) toast(msg);
    await refresh();
    return row;
  };

  $('details.fold').addEventListener('toggle', e => { try { sessionStorage.setItem('wb-fold', e.target.open ? '1' : '0'); } catch (_) { /* 无痕模式 */ } });

  const title = $('#d-title');
  title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => {
    const v = title.value.trim();
    if (!v) { title.value = t.title; return; }
    if (v !== t.title) updateTodo(t.id, { title: v }).then(() => { t.title = v; toast('标题已保存'); }).catch(saveFailed);
  });

  // 改截止：提醒按原来的意思跟着改、记一条留痕（todos.changeDue）
  const setDue = async patch => {
    const row = await changeDue(t, patch).catch(e => { saveFailed(e); return null; });
    if (row) await refresh();
  };
  $('#d-due').addEventListener('change', e => {
    const v = e.target.value;
    setDue({ due_at: v ? (t.due_all_day ? new Date(v + 'T23:59:00') : new Date(v)) : null });
  });
  $('#d-addrem').addEventListener('change', async e => {
    const v = e.target.value; if (!v) return;
    if (v === 'custom') { $('#d-remat').hidden = false; $('#d-remat').focus(); return; }
    if (v === 'at') await addReminder(t.id, 'at_time', new Date(t.due_at));
    else { const m = +v.slice(1); await addReminder(t.id, 'before_due', beforeDueAt(t.due_at, t.due_all_day, m), m); }
    await refresh();
  });
  $('#d-remat').addEventListener('change', async e => { if (e.target.value) { await addReminder(t.id, 'at_time', new Date(e.target.value)); await refresh(); } });
  $('#d-task').addEventListener('change', e => save({ task_id: e.target.value || null }, '已移到' + (e.target.value ? '「' + e.target.selectedOptions[0].textContent + '」' : '零星待办')));
  $('#d-repeat').addEventListener('change', e => {
    const v = e.target.value, base = t.due_at ? new Date(t.due_at) : new Date();
    save({ repeat_rule: !v ? null : v === 'weekly' ? { freq: 'weekly', days: [base.getDay()] } : v === 'monthly' ? { freq: 'monthly', day: base.getDate() } : { freq: v } }, '已保存');
  });
  const notesIn = $('#d-notes');
  if (notesIn) bindNotes(notesIn, t, save);
  $('#d-newtag').addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const v = e.target.value.trim().replace(/^#/, ''); if (!v) return;
    await bumpTags([v]); await save(r => ({ tags: [...new Set([...(r.tags || []), v])] }));
  });
  $('#d-clnew').addEventListener('keydown', e => {
    const v = e.target.value.trim();
    if (e.key !== 'Enter' || e.isComposing || !v) return;
    e.target.value = '';
    save(r => ({ checklist: [...(r.checklist || []), { text: v, done: false }] }));
  });
  let logging = false;
  const logIt = async () => {
    const inp = $('#d-log'), v = inp.value.trim(); if (!v || logging) return;
    logging = true;
    try { await addLog(t.id, v); inp.value = ''; toast('已记录'); await refresh(); } catch (e) { saveFailed(e); /* 输入框里的字保留 */ } finally { logging = false; }
  };
  $('#d-log').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) logIt(); });

  el.onclick = async e => {
    if (e.target.closest('.notes a, .what a')) return;   // 备注、进展里的链接和电话：直接打开
    const b = e.target.closest('button, a, input[type="checkbox"], [data-act]'); if (!b) return;
    const d = b.dataset;
    if (d.close !== undefined) { closeDrawer(); return; }
    if (d.status) { if (d.status === t.status) return; const r = await setStatus(t, d.status, { task }).catch(e => { saveFailed(e); return null; }); if (!r) return; toast(r.next ? `已完成 · 已生成下一次重复${r.skipped ? `（跳过了 ${r.skipped} 期）` : ''}` : `已改为「${TODO_STATUS.find(s => s.v === d.status).label}」`); await refresh(); return; }
    if (d.quick) { await setDue({ due_at: dueAtDay(new Date(d.quick + 'T00:00:00'), t) }); return; }
    if (d.pr !== undefined) { await save(r => ({ priority: r.priority === +d.pr ? null : +d.pr })); return; }
    if (d.tag) { await bumpTags([d.tag]); await save(r => ({ tags: [...new Set([...(r.tags || []), d.tag])] })); return; }
    if (d.untag) { await save(r => ({ tags: (r.tags || []).filter(x => x !== d.untag) })); return; }
    if (d.delrem) { await removeReminder(d.delrem).catch(() => {}); await refresh(); return; }
    // 子步骤：按位置改库里最新的那份（连点、两处同时改都不会丢）
    if (d.cl !== undefined) { const i = +d.cl, on = b.checked; await save(r => ({ checklist: (r.checklist || []).map((c, j) => j === i ? { ...c, done: on } : c) })); return; }
    if (d.cldel !== undefined) { e.preventDefault(); const i = +d.cldel; await save(r => ({ checklist: (r.checklist || []).filter((_, j) => j !== i) })); return; }
    switch (d.act) {
      case 'close': closeDrawer(); break;
      case 'report': openReport(); break;
      case 'log': logIt(); break;
      case 'all-logs': $('#d-logs').scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
      case 'pick-wait': pickWait(t, task, save); break;
      case 'nudged': {
        const r = await markNudged(t, { task }).catch(e => { saveFailed(e); return undefined; });
        if (r === undefined) break;
        toast(r ? `已记下。下次提醒你催：${dueLabel(r.at, false)}` : '这条已经不在等待了');
        await refresh(); break;
      }
      case 'edit-notes': {
        const box = el.querySelector('.notes'); if (!box) break;
        const ta = document.createElement('textarea');
        ta.className = 'input notes-in'; ta.id = 'd-notes'; ta.value = t.notes || ''; ta.rows = 4;
        box.replaceWith(ta); ta.focus(); bindNotes(ta, t, save);
        break;
      }
      case 'allday': {   // 全天 → 有时刻：当天 09:00；有时刻 → 全天：当天 23:59。提醒跟着重算
        const allDay = !t.due_all_day;
        const due = t.due_at ? new Date(t.due_at) : null;
        if (due && !allDay) due.setHours(9, 0, 0, 0);
        await setDue({ due_at: due, due_all_day: allDay });
        break;
      }
      case 'clear-due': await setDue({ due_at: null }); break;
      case 'add-tag': { b.hidden = true; const bx = $('#d-tag-box'); bx.hidden = false; bx.classList.add('enter'); $('#d-newtag').focus(); break; }
      case 'ai-tags': { b.classList.add('loading'); b.innerHTML = '✦ <span class="typing"><i></i><i></i><i></i></span>'; const tags = await aiSuggestTags(t.title, t.tags || []).catch(() => []); if (!tags.length) { toast('AI 暂时没有给出建议'); b.classList.remove('loading'); b.textContent = '✦ AI 推荐'; return; } b.outerHTML = tags.map((x, i) => `<button class="chip ghost enter" style="animation-delay:${i * 60}ms" data-tag="${esc(x)}">✦ #${esc(x)}</button>`).join(''); break; }
      case 'delete':
        // 第二阶段：直接删，提示条上可撤销（进「最近删除」，30 天内可恢复）；旧库照旧先确认
        if (phase2()) { await removeTodo(t.id); closeDrawer(); toastDeleted('todo', t.id, { opened: r => openTodo(r.id) }); }
        else if (await confirmSheet(`删除「${t.title}」？进展记录和提醒会一起删除。`, '删除', true)) { await removeTodo(t.id); closeDrawer(); toast('已删除'); }
        break;
    }
  };
}

/** 备注输入框：自动变高，离开时保存（内容没变不保存） */
function bindNotes(ta, t, save) {
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 480) + 'px'; };
  grow(); ta.addEventListener('input', grow);
  ta.addEventListener('blur', () => { const v = ta.value.trim() || null; if (v !== (t.notes || null)) save({ notes: v }, '备注已保存'); });
}

/** 选择 / 更换等待对象：项目里的联系人排前面，可搜索，可直接新建 */
async function pickWait(t, task, save) {
  const [all, tcIds] = await Promise.all([listContacts(), task ? taskContactIds(task.id) : []]);
  const inTask = c => tcIds.some(id => String(id) === String(c.id));
  const list = [...all.filter(inTask), ...all.filter(c => !inTask(c))];
  const el = openSheet(`<div class="sheet-head"><b>在等谁？</b><span class="sp"></span><button class="btn small" data-x="cancel">取消</button></div>
    <div class="search">${icon('search')}<input id="pw-q" type="search" placeholder="搜索或输入新名称" autocomplete="off" aria-label="搜索联系人"></div>
    <div class="list pick-list" id="pw-list"></div>
    <div class="inline-input" id="pw-new" hidden><select id="pw-kind" class="time-in" aria-label="类型">${CONTACT_KIND.map(k => `<option value="${k.v}">${k.label}</option>`).join('')}</select><button class="btn small primary" data-x="create">新建「<span id="pw-name"></span>」</button></div>`, { label: '选择等待对象' });
  const q = el.querySelector('#pw-q'), box = el.querySelector('#pw-list');
  const drawList = () => {
    const k = q.value.trim().toLowerCase();
    const rows = list.filter(c => !k || [c.name, c.org].some(x => x && x.toLowerCase().includes(k)));
    box.innerHTML = rows.slice(0, 30).map(c => `<button class="item plain" data-c="${c.id}"><div style="min-width:0"><div class="t-title">${esc(c.name)}${String(c.id) === String(t.waiting_on) ? ' <span class="chip wait">当前</span>' : ''}</div><div class="t-meta"><span>${contactKind(c.kind)}</span>${c.org ? `<span>${esc(c.org)}</span>` : ''}${inTask(c) ? '<span>本项目</span>' : ''}</div></div><span class="t-side num">${esc(c.phone || '')}</span></button>`).join('') || '<div class="empty">没有匹配的联系人</div>';
    el.querySelector('#pw-new').hidden = !k || rows.some(c => c.name.toLowerCase() === k);
    el.querySelector('#pw-name').textContent = q.value.trim();
  };
  drawList();
  q.addEventListener('input', drawList);
  el.onclick = async e => {
    const c = e.target.closest('[data-c]');
    if (c) { closeSheet(); await save({ waiting_on: c.dataset.c }, '已改为等「' + (contactById(c.dataset.c) || {}).name + '」'); return; }
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cancel') { closeSheet(); return; }
    if (b.dataset.x === 'create') {
      const name = q.value.trim(); if (!name) return;
      const row = await createContact({ name, kind: el.querySelector('#pw-kind').value }).catch(() => null);
      if (!row) return;
      closeSheet(); await save({ waiting_on: row.id }, `已添加「${name}」并设为等待对象`);
    }
  };
}
