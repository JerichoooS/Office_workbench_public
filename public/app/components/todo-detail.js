// todo-detail.js — 待办详情（桌面右侧抽屉 / 手机全屏）
// 常用项直接显示：标题、状态、截止、提醒、所属项目、子步骤、进展记录
// 低频项收进「更多设置」：重复、优先级、标签、备注

import { esc, openDrawer, closeDrawer, toast, confirmSheet } from '../core/dom.js';
import { dueLabel, ago, ymd, hm, dayDiff } from '../core/dates.js';
import { TODO_STATUS, PRIORITY, repeatLabel, contactKind, CONTACT_KIND } from '../data/schema.js';
import { getTodo, updateTodo, setStatus, removeTodo, listLogs, addLog, listReminders, addReminder, removeReminder, resetReminders, scheduleNudge } from '../data/repos/todos.js';
import { listTasks, getTask, taskContactIds } from '../data/repos/tasks.js';
import { listContacts, contactById, createContact } from '../data/repos/contacts.js';
import { suggestTags, bumpTags, listTags } from '../data/repos/tags.js';
import { taskProgress, nudgeIntervalDays } from '../core/schedule.js';
import { aiOn, aiSuggestTags } from '../data/ai.js';

const KIND_LABEL = { before_due: '截止前', at_time: '准时', nudge: '催办' };
let openId = null;

let firstDraw = false;
export async function openTodo(id) {
  openId = id;
  firstDraw = true;
  const el = openDrawer('<div class="d-head">加载中…</div>', { label: '待办详情', onClose: () => { openId = null; document.querySelectorAll('.item.sel').forEach(x => x.classList.remove('sel')); } });
  await draw(el);
}

async function draw(el) {
  const t = await getTodo(openId);
  if (!t) { closeDrawer(); toast('这条待办已不存在'); return; }
  const [tasks, contacts, logs, rems] = await Promise.all([listTasks(), listContacts(), listLogs(t.id), listReminders(t.id)]);
  const task = t.task_id ? (tasks.find(x => x.id == t.task_id) || await getTask(t.task_id)) : null;
  const tcIds = task ? await taskContactIds(task.id) : [];
  const waitOptions = [...tcIds.map(contactById).filter(Boolean), ...contacts.filter(c => !tcIds.some(id => String(id) === String(c.id)))].slice(0, 12);
  const w = contactById(t.waiting_on);
  const cl = t.checklist || [];
  let nudge = rems.find(r => r.kind === 'nudge' && !r.sent_at);
  if (t.status === 'waiting' && !nudge) nudge = { fire_at: (await scheduleNudge(t, task)).toISOString() };   // 自愈：等待中必须有下一次催办
  const pend = rems.filter(r => r.kind !== 'nudge' && !r.sent_at);
  const dueVal = t.due_at ? (t.due_all_day ? ymd(new Date(t.due_at)) : `${ymd(new Date(t.due_at))}T${hm(new Date(t.due_at))}`) : '';
  const tagSug = await suggestTags(t.title, t.tags || [], 3);
  const allTags = (await listTags()).map(x => x.name);
  const prog = taskProgress(task);

  el.innerHTML = `<div class="d-head">
      <span class="crumb">${task ? `<a href="#/tasks/${task.id}" data-close>${esc(task.title)}</a>` : '<span>零星待办</span>'}<span class="crumb-sep">›</span><span>待办</span></span><span class="sp"></span>
      <button class="btn small" data-act="edit-title">✎ 编辑</button><button class="btn small" data-act="close">关闭</button></div>
    <div class="d-body ${firstDraw ? 'stagger' : ''}">
      <textarea class="d-title-in" id="d-title" rows="2" aria-label="待办标题">${esc(t.title)}</textarea>
      <div class="statuses" role="group" aria-label="状态">${TODO_STATUS.map(s => `<button data-status="${s.v}" aria-pressed="${t.status === s.v}">${s.label}</button>`).join('')}</div>

      ${t.status === 'waiting' ? `<div class="nudge">
        <div>等待 <b>${w ? esc(w.name) : '（选下面的对象）'}</b>${w && w.org ? ' · ' + esc(w.org) : ''}${t.waiting_since ? ` · 已 <span class="num">${Math.max(0, -dayDiff(new Date(t.waiting_since)))}</span> 天` : ''}</div>
        <div>下次自动催办：<b>${nudge ? esc(dueLabel(nudge.fire_at, false)) : '—'}</b>${prog !== null ? `（项目时间已过 <span class="num">${Math.round(prog * 100)}%</span>，每 ${nudgeIntervalDays(task)} 天催一次）` : `（每 ${nudgeIntervalDays(null)} 天催一次）`}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${waitOptions.map(c => `<button class="chip ${String(t.waiting_on) === String(c.id) ? 'wait' : 'ghost'}" data-wait="${c.id}">${esc(c.name)}<span class="hint">${contactKind(c.kind)}</span></button>`).join('')}
          <button class="chip ghost" data-act="new-contact">＋ 其他对象</button></div>
        <div id="new-contact" hidden class="inline-input"><input id="nc-name" placeholder="名称，如：设备科"><select id="nc-kind" class="time-in">${CONTACT_KIND.map(k => `<option value="${k.v}">${k.label}</option>`).join('')}</select><button class="btn small" data-act="add-contact">添加</button></div>
      </div>` : ''}

      <dl class="kv">
        <dt>截止</dt><dd><input class="time-in" id="d-due" type="${t.due_all_day ? 'date' : 'datetime-local'}" value="${dueVal}">
          <button class="chip ${t.due_all_day ? 'accent' : 'ghost'}" data-act="allday">${t.due_all_day ? '全天' : '有时刻'}</button>${t.due_at ? '<button class="chip ghost" data-act="clear-due">清除</button>' : ''}</dd>
        <dt>提醒</dt><dd>${pend.map(r => `<span class="chip warn">${KIND_LABEL[r.kind]} ${esc(dueLabel(r.fire_at, false))}<button data-delrem="${r.id}" aria-label="删除提醒">×</button></span>`).join('')}
          <select class="time-in" id="d-addrem" aria-label="添加提醒"><option value="">＋ 添加</option>${t.due_at ? '<option value="b15">截止前 15 分钟</option><option value="b60">截止前 1 小时</option><option value="b1440">截止前 1 天</option>' : ''}${t.due_at && !t.due_all_day ? '<option value="at">截止时准时</option>' : ''}<option value="custom">指定时间…</option></select>
          <input class="time-in" id="d-remat" type="datetime-local" hidden></dd>
        <dt>标签</dt><dd id="d-tags">${(t.tags || []).map(x => `<button class="chip accent" data-untag="${esc(x)}">#${esc(x)} ×</button>`).join('')}
          ${tagSug.map(x => `<button class="chip ghost" data-tag="${esc(x)}">＋ #${esc(x)}</button>`).join('')}
          ${aiOn('tags') ? '<button class="chip ghost" data-act="ai-tags">✦ AI 推荐</button>' : ''}
          <button class="chip ghost" data-act="add-tag">＋ 标签</button>
          <span class="tag-add" id="d-tag-box" hidden><input id="d-newtag" list="d-tag-list" placeholder="标签名，回车添加" enterkeyhint="done"><datalist id="d-tag-list">${allTags.map(x => `<option value="${esc(x)}">`).join('')}</datalist></span></dd>
        <dt>所属项目</dt><dd><select class="time-in" id="d-task" style="max-width:100%"><option value="">零星待办（不归入项目）</option>${tasks.map(x => `<option value="${x.id}" ${x.id == t.task_id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></dd>
      </dl>

      <details class="fold" ${sessionStorage.getItem('wb-fold') === '1' ? 'open' : ''}><summary>更多设置
        ${t.repeat_rule ? `<span class="chip">↻ ${esc(repeatLabel(t.repeat_rule))}</span>` : ''}${t.priority != null ? `<span class="chip">P${t.priority}</span>` : ''}${t.notes ? '<span class="chip">有备注</span>' : ''}</summary>
        <dl class="kv">
          <dt>重复</dt><dd><select class="time-in" id="d-repeat">
            <option value="">不重复</option><option value="daily" ${t.repeat_rule && t.repeat_rule.freq === 'daily' ? 'selected' : ''}>每天</option>
            <option value="weekdays" ${t.repeat_rule && t.repeat_rule.freq === 'weekdays' ? 'selected' : ''}>每个工作日</option>
            <option value="weekly" ${t.repeat_rule && t.repeat_rule.freq === 'weekly' ? 'selected' : ''}>每周（同一天）</option>
            <option value="monthly" ${t.repeat_rule && t.repeat_rule.freq === 'monthly' ? 'selected' : ''}>每月（同一号）</option></select></dd>
          <dt>优先级</dt><dd>${PRIORITY.map(p => `<button class="chip ${t.priority === p.v ? p.chip || 'accent' : 'ghost'}" data-pr="${p.v}">${p.label}</button>`).join('')}</dd>
          <dt>备注</dt><dd><textarea class="input" id="d-notes" rows="2" placeholder="补充说明">${esc(t.notes || '')}</textarea></dd>
        </dl></details>

      <div><div class="sec-h">子步骤 <span class="num">${cl.filter(c => c.done).length}/${cl.length}</span><span class="hint" style="letter-spacing:0">· 这条待办里的检查项，全部勾完不等于待办完成</span></div>
        <div class="sub-list">${cl.map((c, i) => `<label><input type="checkbox" data-cl="${i}" ${c.done ? 'checked' : ''}><span style="flex:1">${esc(c.text)}</span><button class="hint" data-cldel="${i}" aria-label="删除">×</button></label>`).join('')}</div>
        <div class="inline-input" style="margin-top:8px"><input id="d-clnew" placeholder="加一个子步骤，回车保存"></div></div>

      <div><div class="sec-h">进展记录</div>
        <div class="timeline">${logs.map(l => `<div class="tl"><span class="when num">${esc(ago(l.created_at))}</span><span class="dot"></span><span class="what">${esc(l.content)}</span></div>`).join('') || '<span class="hint" style="margin-bottom:8px">还没有记录。每次跟进后记一笔，方便回头查。</span>'}</div>
        <div class="inline-input"><input id="d-log" placeholder="记一笔进展，回车保存"><button class="btn small" data-act="log">记录</button></div></div>

      <div style="display:flex;justify-content:flex-end"><button class="btn small danger" data-act="delete">删除这条待办</button></div>
    </div>`;

  firstDraw = false;
  const $ = s => el.querySelector(s);
  const refresh = () => draw(el);
  const save = async patch => { await updateTodo(t.id, patch); await refresh(); };

  el.querySelector('details.fold').addEventListener('toggle', e => { try { sessionStorage.setItem('wb-fold', e.target.open ? '1' : '0'); } catch (_) {} });

  const title = $('#d-title');
  title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { const v = title.value.trim(); if (v && v !== t.title) { updateTodo(t.id, { title: v }); toast('标题已保存'); } });

  $('#d-due').addEventListener('change', async e => {
    const v = e.target.value;
    const due = v ? (t.due_all_day ? new Date(v + 'T23:59:00') : new Date(v)) : null;
    const row = await updateTodo(t.id, { due_at: due ? due.toISOString() : null });
    await resetReminders(row, { remind: 'default' });
    await refresh();
  });
  $('#d-addrem').addEventListener('change', async e => {
    const v = e.target.value; if (!v) return;
    if (v === 'custom') { $('#d-remat').hidden = false; $('#d-remat').focus(); return; }
    const due = new Date(t.due_at);
    if (v === 'at') await addReminder(t.id, 'at_time', due);
    else { const m = +v.slice(1); const at = t.due_all_day ? new Date(due.setHours(9, 0, 0, 0) - (m >= 1440 ? 86400000 : 0)) : new Date(due - m * 60000); await addReminder(t.id, 'before_due', at, m); }
    await refresh();
  });
  $('#d-remat').addEventListener('change', async e => { if (e.target.value) { await addReminder(t.id, 'at_time', new Date(e.target.value)); await refresh(); } });
  $('#d-task').addEventListener('change', e => save({ task_id: e.target.value || null }));
  $('#d-repeat').addEventListener('change', e => {
    const v = e.target.value, base = t.due_at ? new Date(t.due_at) : new Date();
    save({ repeat_rule: !v ? null : v === 'weekly' ? { freq: 'weekly', days: [base.getDay()] } : v === 'monthly' ? { freq: 'monthly', day: base.getDate() } : { freq: v } });
  });
  $('#d-notes').addEventListener('change', e => save({ notes: e.target.value.trim() || null }));
  $('#d-newtag').addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const v = e.target.value.trim().replace(/^#/, ''); if (!v) return;
    await bumpTags([v]); await save({ tags: [...new Set([...(t.tags || []), v])] });
  });
  $('#d-clnew').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || !e.target.value.trim()) return;
    save({ checklist: [...cl, { text: e.target.value.trim(), done: false }] });
  });
  const logIt = async () => { const v = $('#d-log').value.trim(); if (!v) return; await addLog(t.id, v); toast('已记录'); await refresh(); };
  $('#d-log').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) logIt(); });

  el.onclick = async e => {
    const b = e.target.closest('button, a, input[type="checkbox"]'); if (!b) return;
    const d = b.dataset;
    if (d.close !== undefined) { closeDrawer(); return; }
    if (d.status) { const r = await setStatus(t, d.status, { task }); if (r.next) toast('已完成 · 已生成下一次重复'); await refresh(); return; }
    if (d.wait) { await save({ waiting_on: d.wait }); return; }
    if (d.pr !== undefined) { await save({ priority: t.priority === +d.pr ? null : +d.pr }); return; }
    if (d.tag) { await bumpTags([d.tag]); await save({ tags: [...(t.tags || []), d.tag] }); return; }
    if (d.untag) { await save({ tags: (t.tags || []).filter(x => x !== d.untag) }); return; }
    if (d.delrem) { await removeReminder(d.delrem); await refresh(); return; }
    if (d.cl !== undefined) { const n = cl.map((c, i) => i === +d.cl ? { ...c, done: b.checked } : c); await save({ checklist: n }); return; }
    if (d.cldel !== undefined) { e.preventDefault(); await save({ checklist: cl.filter((_, i) => i !== +d.cldel) }); return; }
    switch (d.act) {
      case 'close': closeDrawer(); break;
      case 'edit-title': title.focus(); title.select(); break;
      case 'allday': {
        const allDay = !t.due_all_day;
        let due = t.due_at ? new Date(t.due_at) : null;
        if (due) { if (allDay) due.setHours(23, 59, 0, 0); else due.setHours(9, 0, 0, 0); }
        await save({ due_all_day: allDay, due_at: due ? due.toISOString() : null }); break;
      }
      case 'clear-due': { const row = await updateTodo(t.id, { due_at: null }); await resetReminders(row, { remind: 'none' }); await refresh(); break; }
      case 'new-contact': $('#new-contact').hidden = false; $('#nc-name').focus(); break;
      case 'add-contact': { const name = $('#nc-name').value.trim(); if (!name) return; const c = await createContact({ name, kind: $('#nc-kind').value }); await save({ waiting_on: c.id }); break; }
      case 'add-tag': { b.hidden = true; const bx = $('#d-tag-box'); bx.hidden = false; bx.classList.add('enter'); $('#d-newtag').focus(); break; }
      case 'ai-tags': { b.classList.add('loading'); b.innerHTML = '✦ <span class="typing"><i></i><i></i><i></i></span>'; const tags = await aiSuggestTags(t.title, t.tags || []).catch(() => []); if (!tags.length) { toast('AI 暂时没有给出建议'); b.classList.remove('loading'); b.textContent = '✦ AI 推荐'; return; } b.outerHTML = tags.map((x, i) => `<button class="chip ghost enter" style="animation-delay:${i * 60}ms" data-tag="${esc(x)}">✦ #${esc(x)}</button>`).join(''); break; }
      case 'log': logIt(); break;
      case 'delete': if (await confirmSheet(`删除「${t.title}」？进展记录和提醒会一起删除。`, '删除', true)) { await removeTodo(t.id); closeDrawer(); toast('已删除'); } break;
    }
  };
}
