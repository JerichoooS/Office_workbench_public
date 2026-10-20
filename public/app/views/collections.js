// collections.js — 材料收集：列表 + 详情（点对象切换已交/未交，生成催办文字复制后自己发）
// 路由参数：#/collections?c=<id> 打开某个收集；?new=<taskId> 直接新建并归属项目

import { esc, toast, openSheet, closeSheet, confirmSheet } from '../core/dom.js';
import { go } from '../core/router.js';
import { dueLabel } from '../core/dates.js';
import { CONTACT_KIND, contactKind } from '../data/schema.js';
import { listCollections, getCollection, createCollection, toggleTarget, addTarget, removeTarget, removeCollection, updateCollection, chaserText } from '../data/repos/collections.js';
import { listTasks } from '../data/repos/tasks.js';
import { listContacts } from '../data/repos/contacts.js';

const qs = () => new URLSearchParams(location.hash.split('?')[1] || '');

export async function mount(root) {
  const q = qs();
  if (q.get('new') === null) root._newOpened = false;
  else if (!root._newOpened) { root._newOpened = true; openNew(q.get('new')); }
  const id = q.get('c');
  if (id) return detail(root, id);
  const [cols, tasks] = await Promise.all([listCollections(), listTasks()]);
  const T = Object.fromEntries(tasks.map(t => [t.id, t]));
  const open = cols.filter(c => !c.closed_at), closed = cols.filter(c => c.closed_at);
  const row = c => `<a class="item plain" href="#/collections?c=${c.id}" style="color:inherit;text-decoration:none">
    <div style="min-width:0"><div class="t-title">${esc(c.title)}</div><div class="t-meta">${T[c.task_id] ? `<span class="task">${esc(T[c.task_id].title)}</span>` : ''}${c.due_at ? `<span>截止 ${esc(dueLabel(c.due_at, false))}</span>` : ''}</div></div>
    <div class="t-side num ${c.done < c.total ? '' : ''}">${c.done}/${c.total}</div></a>`;
  root.innerHTML = `<div class="wrap">
    <div class="page-head"><div><h1>材料收集</h1><div class="sub">向多个部门、科室、单位收材料，记录谁交了</div></div><span class="sp"></span><button class="btn primary" data-new>＋ 发起收集</button></div>
    <div class="group"><div class="group-h"><b>进行中</b><span class="num">${open.length}</span></div><div class="list">${open.map(row).join('') || '<div class="empty">没有进行中的收集</div>'}</div></div>
    ${closed.length ? `<div class="group"><div class="group-h"><b>已结束</b><span class="num">${closed.length}</span></div><div class="list">${closed.map(row).join('')}</div></div>` : ''}
  </div>`;
  root.onclick = e => { if (e.target.closest('[data-new]')) openNew(); };
}

async function detail(root, id) {
  const c = await getCollection(id);
  if (!c) { root.innerHTML = '<div class="wrap"><div class="placeholder">这个收集不存在。<a href="#/collections">返回</a></div></div>'; return; }
  const done = c.targets.filter(t => t.submitted_at).length, total = c.targets.length;
  const text = chaserText(c);
  root.innerHTML = `<div class="wrap">
    <div><a class="btn small" href="#/collections">← 材料收集</a></div>
    <div class="page-head"><div style="min-width:0"><h1>${esc(c.title)}</h1><div class="sub">${c.due_at ? `截止 ${esc(dueLabel(c.due_at, false))}` : '未设截止'}${c.closed_at ? ' · 已结束' : ''}</div></div><span class="sp"></span>
      <button class="btn small" data-act="${c.closed_at ? 'reopen' : 'close'}">${c.closed_at ? '重新打开' : '结束收集'}</button></div>
    <div class="list" style="padding:16px 18px;display:flex;flex-direction:column;gap:14px">
      <div class="coll-head">
        <div><span class="num big">${done}</span><span class="num" style="color:var(--ink-3)"> / ${total}</span><div class="hint">已交</div></div>
        <div style="flex:1;min-width:140px"><div class="prog" style="height:8px"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div><div class="hint" style="margin-top:6px">点对象切换「已交 / 未交」</div></div></div>
      <div class="targets">${c.targets.map(t => `<div class="target ${t.submitted_at ? 'ok' : ''}"><button class="nm" data-tg="${t.id}" style="text-align:left">${esc(t.name)}</button><button class="chip ${t.submitted_at ? 'ok' : 'bad'}" data-tg="${t.id}">${t.submitted_at ? '已交' : '未交'}</button><button class="rm" data-rm="${t.id}" aria-label="移除 ${esc(t.name)}">×</button></div>`).join('')}</div>
      <div class="inline-input"><input id="c-add" placeholder="添加对象，多个用顿号隔开"><select id="c-kind" class="time-in">${CONTACT_KIND.map(k => `<option value="${k.v}" ${k.v === 'department' ? 'selected' : ''}>${k.label}</option>`).join('')}</select><button class="btn small" data-act="add">添加</button></div>
      ${text ? `<div><div class="sec-h">催办文字（复制后自己发）<span class="sp"></span><button class="btn small" data-act="copy">复制</button></div>
        <div class="chaser" id="chaser" style="background:var(--sunken);border-radius:9px;padding:12px 14px;font-size:13px;white-space:pre-wrap;color:var(--ink-2)">${esc(text)}</div></div>` : '<div class="chip ok" style="align-self:flex-start">已全部收齐 ✓</div>'}
    </div>
    <div style="display:flex;justify-content:flex-end"><button class="btn small danger" data-act="delete">删除这个收集</button></div>
  </div>`;
  root.onclick = async e => {
    const tg = e.target.closest('[data-tg]'); if (tg) { await toggleTarget(c.targets.find(t => String(t.id) === tg.dataset.tg)); return; }
    const rm = e.target.closest('[data-rm]'); if (rm) { await removeTarget(rm.dataset.rm); return; }
    const a = e.target.closest('[data-act]'); if (!a) return;
    switch (a.dataset.act) {
      case 'add': {
        const names = root.querySelector('#c-add').value.split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean);
        for (const name of names) await addTarget(c.id, { name, kind: root.querySelector('#c-kind').value });
        break;
      }
      case 'copy': {
        try { await navigator.clipboard.writeText(text); toast('已复制，去微信或 OA 粘贴发送'); }
        catch (_) { const r = document.createRange(); r.selectNodeContents(root.querySelector('#chaser')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('已选中文字，请按复制'); }
        break;
      }
      case 'close': await updateCollection(c.id, { closed_at: new Date().toISOString() }); toast('已结束'); break;
      case 'reopen': await updateCollection(c.id, { closed_at: null }); break;
      case 'delete': if (await confirmSheet(`删除「${c.title}」？`, '删除', true)) { await removeCollection(c.id); go('/collections'); } break;
    }
  };
}

async function openNew(taskId = null) {
  const [tasks, contacts] = await Promise.all([listTasks(), listContacts()]);
  const orgs = contacts.filter(c => c.kind !== 'person');
  const el = openSheet(`<div class="sheet-head"><b>发起材料收集</b><span class="sp"></span><button class="btn small" data-x="cancel">取消</button><button class="btn small primary" data-x="save">创建</button></div>
    <div class="form">
      <label>收什么<input id="n-title" placeholder="如：季度报销单"></label>
      <div class="row2"><label>截止<input id="n-due" type="datetime-local"></label>
        <label>所属项目<select id="n-task"><option value="">不归入</option>${tasks.map(t => `<option value="${t.id}" ${String(t.id) === String(taskId) ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select></label></div>
      <div class="field">向谁收（点选常用对象，或在下面输入）
        <div class="contacts" id="n-pick">${orgs.map(c => `<button class="chip ghost" data-c="${esc(c.name)}" data-k="${c.kind}">${esc(c.name)}<span class="hint">${contactKind(c.kind)}</span></button>`).join('')}</div></div>
      <label>其他对象（顿号或逗号隔开）<input id="n-more" placeholder="行政部、财务部、市场部"></label>
    </div>`, { label: '发起材料收集', onClose: () => { if (qs().get('new') !== null) go('/collections'); } });
  const picked = new Map();
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.c) { if (picked.has(b.dataset.c)) picked.delete(b.dataset.c); else picked.set(b.dataset.c, b.dataset.k); b.classList.toggle('accent'); b.classList.toggle('ghost'); return; }
    if (b.dataset.x === 'cancel') { closeSheet(); return; }
    if (b.dataset.x === 'save') {
      const title = el.querySelector('#n-title').value.trim();
      if (!title) { toast('请填写收什么'); return; }
      const more = el.querySelector('#n-more').value.split(/[、,，\n]+/).map(s => s.trim()).filter(Boolean);
      const targets = [...[...picked].map(([name, kind]) => ({ name, kind })), ...more.filter(n => !picked.has(n)).map(name => ({ name, kind: 'department' }))];
      const due = el.querySelector('#n-due').value;
      const c = await createCollection({ title, task_id: el.querySelector('#n-task').value || null, due_at: due ? new Date(due).toISOString() : null }, targets);
      closeSheet(); toast('已创建'); go('/collections?c=' + c.id);
    }
  };
}
