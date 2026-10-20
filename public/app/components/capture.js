// capture.js — 「记一条」：一行字 → 自动识别时间、提醒、等待对象、归属项目、标签
// 用在：今天页顶部（内嵌）、手机底部「+」（弹层）。不接 AI 也完整可用。

import { esc, openSheet, closeSheet, toast } from '../core/dom.js';
import { parseQuick } from '../core/parse.js';
import { createTodo } from '../data/repos/todos.js';
import { listTasks, listAllTaskContacts } from '../data/repos/tasks.js';
import { listContacts } from '../data/repos/contacts.js';
import { suggestTags, listTags } from '../data/repos/tags.js';
import { cachedSettings } from '../data/repos/settings.js';
import { aiSuggestTags, aiParse, aiOn } from '../data/ai.js';

/** 从文本猜等待对象：联系人名字或所属单位关键字（如「某公司」→ 所属单位为「某公司 · 采购部」的张三） */
function guessContact(text, contacts) {
  return contacts.find(c => text.includes(c.name))
    || contacts.find(c => c.org && c.org.split(/[\s·,，]/).some(w => w.length >= 2 && text.includes(w)))
    || null;
}

/**
 * 「点了外面」才收起：必须是轻点（按下到松开位移不超过 10px），拖动、滚动、双指缩放都不算。
 * 组件被替换（页面重绘）后自动解绑。
 */
function onOutsideTap(box, insides, close) {
  let down = null;
  const isInside = t => insides.some(el => el.contains(t));
  const onDown = e => {
    if (!box.isConnected) { cleanup(); return; }
    down = !e.isPrimary || isInside(e.target) ? null : { x: e.clientX, y: e.clientY };
  };
  const onUp = e => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved < 10 && !isInside(e.target)) close();
  };
  const onCancel = () => { down = null; };
  function cleanup() { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('pointerup', onUp, true); document.removeEventListener('pointercancel', onCancel, true); }
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);
}

/**
 * opts.trigger：外部的触发按钮（首页标题行里的虚线圆圈）。给了它，输入栏平时收起（高度 0），
 * 点按钮向下展开并聚焦，按钮旋转成 ×；点外部 / Esc / 空着再点按钮 收起。
 */
export function mountCapture(box, { taskId = null, onSaved, autofocus = false, collapsible = false, trigger = null } = {}) {
  box.innerHTML = `<div class="capture ${collapsible ? 'collapsible collapsed' : ''}">
    <div class="capture-row">${collapsible ? '<button class="plus" type="button" aria-label="记一条" aria-expanded="false"></button>' : '<span class="plus" aria-hidden="true"></span>'}
      <input id="cap-in" placeholder="记一条，例如：明天下午3点提醒我交周报" autocomplete="off" enterkeyhint="done" aria-label="记一条"></div>
    <div class="parse" id="cap-parse"></div></div>`;
  const inp = box.querySelector('#cap-in'), out = box.querySelector('#cap-parse');
  if (trigger) {
    box.classList.add('cap-drop', 'closed');
    // 关闭时不清空：没写完的内容留作草稿，圆圈上显示小圆点，下次点开接着写
    const open = () => { box.classList.remove('closed'); trigger.classList.add('on'); trigger.setAttribute('aria-expanded', 'true'); setTimeout(() => inp.focus(), 120); };
    const close = () => { box.classList.add('closed'); trigger.classList.remove('on'); trigger.setAttribute('aria-expanded', 'false'); trigger.classList.toggle('draft', !!inp.value.trim()); inp.blur(); };
    trigger.addEventListener('click', () => (box.classList.contains('closed') ? open() : close()));
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    onOutsideTap(box, [box, trigger], close);
  }
  if (collapsible) {
    const wrap = box.querySelector('.capture'), btn = box.querySelector('.plus');
    const open = () => { wrap.classList.remove('collapsed'); btn.setAttribute('aria-expanded', 'true'); setTimeout(() => inp.focus(), 180); };
    const close = () => { if (inp.value.trim()) return; wrap.classList.add('collapsed'); btn.setAttribute('aria-expanded', 'false'); out.innerHTML = ''; };
    btn.addEventListener('click', () => (wrap.classList.contains('collapsed') ? open() : (inp.value.trim() ? inp.focus() : close())));
    inp.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) close(); }, 150));
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; close(); inp.blur(); } });
    onOutsideTap(box, [box], close);
  }
  let prevKeys = new Set(), tagEditing = false;
  let state = null, tasks = [], links = [], contacts = [], pickedTags = [], dropTask = false, dropWait = false, sug = [], aiTimer, aiParsed = null, parseTimer;
  // 规则解析后，标题里还残留时间说法（说明规则没吃透），才请 AI 补充（省额度）
  const TIME_LEFT = /下班|上班|中午|早上|上午|下午|晚上|傍晚|月底|月初|月中|之前|以前|前$|[0-9一二三四五六七八九十]+点|[0-9]+号|星期|礼拜|周[一二三四五六日天末]|节前|节后|会前|会后/;

  const aiTags = new Set(); let allTags = [];
  Promise.all([listTasks(), listAllTaskContacts(), listContacts(), listTags()]).then(([t, l, c, g]) => { tasks = t; links = l; contacts = c; allTags = g.map(x => x.name); });

  async function update() {
    const text = inp.value.trim();
    if (!text) { out.innerHTML = ''; state = null; return; }
    let p = parseQuick(text);
    if (aiParsed && aiParsed.text === text) p = { ...aiParsed.p };
    else if ((!p.due || p.allDay) && aiOn('parse') && TIME_LEFT.test(p.title)) {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(async () => {
        const r = await aiParse(text);
        if (r && r.due && inp.value.trim() === text) { aiParsed = { text, p: r }; update(); }
      }, 800);
    }
    const who = p.waiting && !dropWait ? guessContact(text, contacts) : null;
    let task = taskId ? tasks.find(t => t.id == taskId) : null;
    if (!task && !dropTask) {
      const c = who || guessContact(text, contacts);
      if (c) { const l = links.find(x => String(x.contact_id) === String(c.id)); task = l ? tasks.find(t => t.id == l.task_id) : null; }
      if (!task) task = tasks.find(t => (t.tags || []).some(tag => text.includes(tag))) || null;
    }
    state = { p, who, task };
    sug = await suggestTags(text, pickedTags, 3);
    draw();
    const s = cachedSettings();
    if (aiOn('tags')) {
      clearTimeout(aiTimer);
      aiTimer = setTimeout(async () => {
        const more = await aiSuggestTags(text, pickedTags).catch(() => []);
        if (inp.value.trim() === text && more.length) { more.forEach(t => aiTags.add(t)); sug = [...new Set([...more, ...sug])].filter(x => !pickedTags.includes(x)).slice(0, 4); draw(true); }
      }, 700);
    }
  }

  function draw(ai = false) {
    if (!state) return;
    const { p, who, task } = state;
    const chips = [`<span class="chip">「${esc(p.title)}」</span>`];
    if (p.label) chips.push(`<span class="chip accent">${p.ai ? '✦ ' : '📅 '}${esc(p.label)}</span>`);
    if (p.remind && p.due) chips.push('<span class="chip warn">⏰ 到点提醒</span>');
    if (who) chips.push(`<button class="chip wait" data-x="wait" title="点掉">等待 ${esc(who.name)} ×</button>`);
    else if (p.waiting) chips.push('<span class="chip wait">等待他人</span>');
    if (task) chips.push(`<button class="chip" data-x="task" title="点掉">归入项目：${esc(task.title)} ×</button>`);
    else chips.push('<span class="chip ghost">放入零星待办</span>');
    pickedTags.forEach(t => chips.push(`<button class="chip accent" data-k="p:${esc(t)}" data-untag="${esc(t)}">#${esc(t)} ×</button>`));
    sug.forEach(t => chips.push(`<button class="chip ghost" data-k="s:${esc(t)}" data-tag="${esc(t)}">${aiTags.has(t) ? '✦' : '＋'} #${esc(t)}</button>`));
    chips.push(tagEditing ? `<span class="tag-add"><input id="cap-tag" list="cap-tags" placeholder="标签名，回车添加" enterkeyhint="done"><datalist id="cap-tags">${allTags.map(t => `<option value="${esc(t)}">`).join('')}</datalist></span>`
      : '<button class="chip ghost" data-k="addtag" data-x="addtag">＋ 自定义标签</button>');
    chips.push(`<span class="hint">回车保存</span>`);
    out.innerHTML = chips.join('');
    // 只有新出现的标签做弹出动画，已有的保持不动
    const now = new Set();
    out.querySelectorAll('[data-k]').forEach(el => { now.add(el.dataset.k); if (!prevKeys.has(el.dataset.k)) el.classList.add('enter'); });
    prevKeys = now;
    if (tagEditing) {
      const ti = out.querySelector('#cap-tag'); ti.focus();
      ti.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); const v = ti.value.trim().replace(/^#/, ''); if (v && !pickedTags.includes(v)) pickedTags.push(v); tagEditing = false; update(); inp.focus(); }
        if (ev.key === 'Escape') { ev.stopPropagation(); tagEditing = false; draw(); inp.focus(); }
      });
    }
  }

  out.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tag) pickedTags.push(b.dataset.tag);
    if (b.dataset.untag) pickedTags = pickedTags.filter(x => x !== b.dataset.untag);
    if (b.dataset.x === 'task') dropTask = true;
    if (b.dataset.x === 'wait') dropWait = true;
    if (b.dataset.x === 'addtag') { tagEditing = true; draw(); return; }
    update(); inp.focus();
  });
  inp.addEventListener('input', () => { dropTask = false; dropWait = false; update(); });
  inp.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.isComposing || !inp.value.trim()) return;
    e.preventDefault();
    await update();
    const { p, who, task } = state;
    inp.disabled = true;
    try {
      const waiting = p.waiting;
      await createTodo({
        title: p.title, due_at: p.due, due_all_day: p.allDay, task_id: task ? task.id : null,
        status: waiting ? 'waiting' : 'todo', waiting_on: who ? who.id : null, tags: pickedTags,
      }, { remind: p.remind && !p.allDay ? 'at_time' : 'default', task });
      toast(p.label ? `已记下 · ${p.label}` : '已记下');
      inp.value = ''; pickedTags = []; out.innerHTML = ''; state = null; aiParsed = null; prevKeys = new Set();
      if (trigger) trigger.classList.remove('draft');
      if (onSaved) onSaved();
    } finally { inp.disabled = false; inp.focus(); }
  });
  if (autofocus) setTimeout(() => inp.focus(), 250);
}

/** 手机「+」：弹层里的记一条 */
export function openCapture(opts = {}) {
  const el = openSheet(`<div class="sheet-head"><b>记一条</b><span class="sp"></span><button class="btn small" data-x>完成</button></div><div id="cap-box"></div>
    <div class="hint">可以直接说时间：「周五上午10点半 交采购清单」「明晚8点提醒我回电话」「等张三确认会议时间」</div>`, { label: '记一条' });
  mountCapture(el.querySelector('#cap-box'), { ...opts, autofocus: true, onSaved: () => { if (opts.onSaved) opts.onSaved(); } });
  el.querySelector('[data-x]').onclick = () => closeSheet();
}
