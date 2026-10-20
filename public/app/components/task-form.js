// task-form.js — 新建 / 编辑项目；新建时可搜索历史项目一键套用（日期自动平移）

import { esc, openSheet, closeSheet, toast } from '../core/dom.js';
import { ymd, parseYmd } from '../core/dates.js';
import { TASK_STATUS, CONTACT_KIND, contactKind } from '../data/schema.js';
import { createTask, updateTask, taskContactIds, searchTasks, cloneTask } from '../data/repos/tasks.js';
import { listContacts, createContact } from '../data/repos/contacts.js';
import { go } from '../core/router.js';

export async function openTaskForm(task = null) {
  const contacts = await listContacts();
  let picked = task ? (await taskContactIds(task.id)).map(String) : [];
  const isNew = !task;
  const t = task || { title: '', start_date: ymd(new Date()), end_date: '', status: 'in_progress', description: '' };

  const el = openSheet(`<div class="sheet-head"><b>${isNew ? '新建项目' : '编辑项目'}</b><span class="sp"></span>
      <button class="btn small" data-x="cancel">取消</button><button class="btn small primary" data-x="save">保存</button></div>
    ${isNew ? `<div><div class="search"><span class="hint">套用以前的项目</span><input id="tf-q" placeholder="搜索项目名，如：年度报告" autocomplete="off"></div><div id="tf-hits" class="list" hidden style="margin-top:6px"></div></div>` : ''}
    <div class="form">
      <label>名称<input id="tf-title" value="${esc(t.title)}" placeholder="如：年度报告编写"></label>
      <div class="row2"><label>开始<input id="tf-s" type="date" value="${esc(t.start_date || '')}"></label><label>结束<input id="tf-e" type="date" value="${esc(t.end_date || '')}"></label></div>
      ${isNew ? '' : `<label>状态<select id="tf-st">${TASK_STATUS.map(s => `<option value="${s.v}" ${t.status === s.v ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>`}
      <div class="field">联系人（可多选；人、部门、科室、单位都可以）
        <div class="contacts" id="tf-contacts"></div>
        <div class="inline-input"><input id="tf-nc" placeholder="新联系人名称"><select id="tf-nck" class="time-in">${CONTACT_KIND.map(k => `<option value="${k.v}">${k.label}</option>`).join('')}</select><button class="btn small" data-x="addc">添加</button></div></div>
      <label>说明<textarea id="tf-desc" rows="3" placeholder="这件事要做成什么样">${esc(t.description || '')}</textarea></label>
      <span class="hint">结束日期过后自动归档；归档的项目在「项目」页底部，可以恢复。</span>
    </div>`, { label: isNew ? '新建项目' : '编辑项目' });

  const $ = s => el.querySelector(s);
  const drawContacts = () => {
    $('#tf-contacts').innerHTML = contacts.map(c => `<button class="chip ${picked.includes(String(c.id)) ? 'accent' : 'ghost'}" data-c="${c.id}">${esc(c.name)}<span class="hint">${contactKind(c.kind)}</span></button>`).join('') || '<span class="hint">还没有联系人，在下面添加</span>';
  };
  drawContacts();
  setTimeout(() => $('#tf-title').focus(), 250);

  let source = null;
  if (isNew) {
    let timer;
    $('#tf-q').addEventListener('input', e => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      timer = setTimeout(async () => {
        const box = $('#tf-hits');
        if (!q) { box.hidden = true; return; }
        const hits = await searchTasks(q);
        box.hidden = false;
        box.innerHTML = hits.map(h => `<div class="item plain" style="cursor:default"><div><div class="t-title">${esc(h.title)}</div><div class="t-meta"><span class="num">${esc(h.start_date || '')} → ${esc(h.end_date || '')}</span>${h.archived_at ? '<span>已归档</span>' : ''}</div></div><button class="btn small primary" data-src="${h.id}">套用</button></div>`).join('') || '<div class="empty">没有找到</div>';
      }, 250);
    });
  }

  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.c) { const id = b.dataset.c; picked = picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id]; drawContacts(); return; }
    if (b.dataset.src) {
      const hits = await searchTasks($('#tf-q').value.trim());
      source = hits.find(h => String(h.id) === b.dataset.src);
      picked = (await taskContactIds(source.id)).map(String);
      $('#tf-title').value = source.title.replace(/第(\d+)届/, (m, n) => `第${+n + 1}届`);
      $('#tf-desc').value = source.description || '';
      if (source.start_date && source.end_date && $('#tf-s').value) {
        const len = (parseYmd(source.end_date) - parseYmd(source.start_date)) / 86400000;
        const e2 = parseYmd($('#tf-s').value); e2.setDate(e2.getDate() + len); $('#tf-e').value = ymd(e2);
      }
      drawContacts();
      $('#tf-hits').innerHTML = `<div class="empty">将套用「${esc(source.title)}」：联系人、待办清单、材料收集一起复制，日期按新的开始日整体平移。改好名称和开始日期后点保存。</div>`;
      return;
    }
    switch (b.dataset.x) {
      case 'cancel': closeSheet(); break;
      case 'addc': {
        const name = $('#tf-nc').value.trim(); if (!name) return;
        const c = await createContact({ name, kind: $('#tf-nck').value });
        contacts.push(c); picked.push(String(c.id)); $('#tf-nc').value = ''; drawContacts(); break;
      }
      case 'save': {
        const title = $('#tf-title').value.trim();
        if (!title) { toast('请填写项目名称'); $('#tf-title').focus(); return; }
        const data = { title, start_date: $('#tf-s').value || null, end_date: $('#tf-e').value || null, description: $('#tf-desc').value.trim() || null };
        if (data.start_date && data.end_date && data.end_date < data.start_date) { toast('结束日期不能早于开始日期'); return; }
        b.disabled = true;
        if (isNew && source) {
          const r = await cloneTask(source.id, { title, start_date: data.start_date });
          await updateTask(r.task.id, { end_date: data.end_date, description: data.description }, picked);
          closeSheet(); toast(`已套用：${r.todoCount} 条待办，日期顺延 ${r.shift} 天`); go('/tasks/' + r.task.id);
        } else if (isNew) {
          const nt = await createTask(data, picked); closeSheet(); toast('项目已创建'); go('/tasks/' + nt.id);
        } else {
          await updateTask(task.id, { ...data, status: $('#tf-st').value }, picked); closeSheet(); toast('项目已保存');
        }
      }
    }
  };
}
