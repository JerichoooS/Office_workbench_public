// capture.js — 「记一条」：一句话 → 自动识别时间、重复、提醒、等待对象、归属项目、标签
// 用在：首页标题行下拉（trigger）、项目详情内嵌（taskId）、手机底部「+」弹层（openCapture）。不接 AI 也完整可用。
// 草稿：每敲一个字就存 localStorage —— 收起、页面重绘（数据刷新会重挂首页）、切去微信再回来、整页刷新都不丢；保存成功才清。
//   首页下拉和手机「+」共用一份（wb-capture-draft），项目页按项目各存一份（wb-capture-draft:task:<项目id>）。
// 同一页可能同时有两个输入框（首页下拉 + 手机「+」弹层）：组件内只用 class，不用固定 id。
// 没信号也能记（第二阶段，features.phase2()）：保存前先生成 client_id；网络不通没存上时放进本机队列（data/outbox.js），
//   输入框和草稿照样清空，联网后用同一个 client_id 自动补存（不会变成两条）。旧库（没执行 005）照旧：没存上就把字留在框里。

import { esc, icon, openSheet, closeSheet, toast } from '../core/dom.js';
import { parseQuick } from '../core/parse.js';
import { createTodo, newClientId } from '../data/repos/todos.js';
import { phase2 } from '../data/features.js';
import { addOutbox } from '../data/outbox.js';
import { listTasks, listAllTaskContacts } from '../data/repos/tasks.js';
import { listContacts } from '../data/repos/contacts.js';
import { suggestTags, listTags } from '../data/repos/tags.js';
import { repeatLabel } from '../data/schema.js';
import { aiSuggestTags, aiParse, aiOn } from '../data/ai.js';
import { openTodo } from './todo-detail.js';

const DRAFT = 'wb-capture-draft';
const MAX_H = 168;   // 输入框最多长到约 6 行，再多在框里滚动
// 规则解析后，标题里还残留时间说法（说明规则没吃透），才请 AI 补充（省额度）；「9.2号馆」「5点位」不算
const TIME_LEFT = /下班|上班|中午|早上|上午|下午|晚上|傍晚|月底|月初|月中|之前|以前|前$|[0-9一二三四五六七八九十]+点(?!位)|[0-9]+号(?![馆楼厅房门口位线台机])|星期|礼拜|周[一二三四五六日天末]|节前|节后|会前|会后/;

const live = new Set();     // 挂在页面上的输入框；同一份草稿互相同步（手机「+」里写的，收起后首页下拉里也是它）
const saving = new Set();   // 正在保存的草稿 key：连按回车 / 连点保存只记一条；保存中重挂出来的新输入框先空着
const mem = new Map();      // localStorage 用不了（无痕模式等）时的退路，本次打开期间有效
let dropOpen = false, focusKey = null, seq = 0;   // 首页重挂时恢复：下拉是否展开、焦点是否在输入框里
const readDraft = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return mem.get(k) || null; } };
const writeDraft = (k, d) => { try { if (d) localStorage.setItem(k, JSON.stringify(d)); else localStorage.removeItem(k); } catch (_) { if (d) mem.set(k, d); else mem.delete(k); } };
function sync(key, from) { live.forEach(c => { if (!c.box.isConnected) live.delete(c); else if (c.key === key && c !== from) c.reload(); }); }
window.addEventListener('storage', e => { if (e.key && e.key.startsWith(DRAFT)) sync(e.key, null); });   // 另一个标签页改了草稿

/** 从文本猜等待对象：联系人名字或所属单位关键字（如「某公司」→ 所属单位为「某公司 · 采购部」的张三） */
function guessContact(text, contacts) {
  return contacts.find(c => text.includes(c.name))
    || contacts.find(c => c.org && c.org.split(/[\s·,，]/).some(w => w.length >= 2 && text.includes(w)))
    || null;
}

/**
 * 「点了外面」才收起：必须是轻点（按下到松开移动不超过 10px），拖动、滚动、双指缩放都不算。
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
 * 点按钮向下展开并聚焦，按钮旋转成 ×；点外部 / Esc / 再点按钮 收起（内容留作草稿，圆圈变色）。
 * 返回 { focus, blur }。
 */
export function mountCapture(box, { taskId = null, onSaved, autofocus = false, trigger = null } = {}) {
  const key = taskId ? `${DRAFT}:task:${taskId}` : DRAFT, uid = `cap${++seq}`;
  box.innerHTML = `<div class="capture">
    <div class="capture-row"><span class="plus" aria-hidden="true"></span>
      <textarea class="cap-in" rows="1" placeholder="记一条，例如：明天下午3点提醒我交周报" autocomplete="off" enterkeyhint="done" aria-label="记一条"></textarea>
      <button class="btn primary small cap-save" type="button" disabled>保存</button></div>
    <div class="parse cap-parse"></div></div>`;
  const wrap = box.querySelector('.capture'), inp = box.querySelector('.cap-in'), out = box.querySelector('.cap-parse'), btn = box.querySelector('.cap-save');
  let prevKeys = new Set(), tagEditing = false;
  let state = null, tasks = [], links = [], contacts = [], pickedTags = [], dropTaskId = null, dropWait = false, sug = [], aiTimer, aiParsed = null, parseTimer;
  const aiTags = new Set(); let allTags = [];
  const hasText = () => !!inp.value.trim();
  /** 输入框跟着内容长高（rows=1 起），超过 MAX_H 在框里滚动 */
  const grow = () => { inp.style.height = 'auto'; const h = inp.scrollHeight; inp.style.height = Math.min(h, MAX_H) + 'px'; inp.style.overflowY = h > MAX_H ? 'auto' : 'hidden'; };
  const refresh = () => { btn.disabled = !hasText(); if (trigger) trigger.classList.toggle('draft', hasText()); grow(); };
  // 存草稿并通知同一份草稿的另一个输入框（否则首页下拉里留着旧字，保存时会把弹层里新写的冲掉）
  const keep = () => { writeDraft(key, hasText() ? { text: inp.value, tags: pickedTags, at: Date.now() } : null); sync(key, me); };
  const load = () => { const d = saving.has(key) ? null : readDraft(key); inp.value = (d && d.text) || ''; pickedTags = d && Array.isArray(d.tags) ? d.tags : []; refresh(); };
  /** 别处（另一个输入框 / 另一个标签页）改了同一份草稿：正在这里打字时不打扰 */
  const reload = () => { if (document.activeElement === inp) return; load(); state = null; aiParsed = null; if (hasText()) update(); else out.innerHTML = ''; };
  const me = { box, key, reload };
  sync(null, null); live.add(me);   // 顺手清掉已被替换的旧输入框

  Promise.all([listTasks(), listAllTaskContacts(), listContacts(), listTags()]).then(([t, l, c, g]) => {
    tasks = t; links = l; contacts = c; allTags = g.map(x => x.name);
    if (hasText()) update();   // 带着草稿打开时，项目/联系人加载完再猜一次
  }).catch(() => {});

  /** 识别结果（同步：保存时直接用，不等标签建议） */
  function compute(text) {
    let p = parseQuick(text);
    if (aiParsed && aiParsed.text === text) p = { ...p, ...aiParsed.p, repeat: p.repeat, notes: p.notes, title: p.notes ? p.title : aiParsed.p.title };
    if (!p.waiting) dropWait = false;   // 不像等待了；以后再出现「催/等」时重新识别
    const waiting = p.waiting && !dropWait;
    const who = waiting ? guessContact(text, contacts) : null;
    let task = taskId ? tasks.find(t => t.id == taskId) || null : null;
    if (!taskId) {
      const c = who || guessContact(text, contacts);
      if (c) { const l = links.find(x => String(x.contact_id) === String(c.id)); task = l ? tasks.find(t => t.id == l.task_id) : null; }
      if (!task) task = tasks.find(t => (t.tags || []).some(tag => text.includes(tag))) || null;
      if (task && String(task.id) === String(dropTaskId)) task = null;   // 用户点掉过的项目不再猜
    }
    return { p, waiting, who, task };
  }

  async function update() {
    const text = inp.value.trim();
    if (!text) { out.innerHTML = ''; state = null; return; }
    state = compute(text);
    const { p } = state;
    if (!(aiParsed && aiParsed.text === text) && !p.repeat && (!p.due || p.allDay) && aiOn('parse') && TIME_LEFT.test(p.title)) {
      clearTimeout(parseTimer);
      parseTimer = setTimeout(async () => {
        const r = await aiParse(text);
        if (r && r.due && inp.value.trim() === text) { aiParsed = { text, p: r }; update(); }
      }, 800);
    }
    const s = await suggestTags(text, pickedTags, 3).catch(() => []);
    if (inp.value.trim() !== text) return;   // 等标签建议期间又改了字：交给下一次 update
    sug = s; draw();
    if (aiOn('tags')) {
      clearTimeout(aiTimer);
      aiTimer = setTimeout(async () => {
        const more = await aiSuggestTags(text, pickedTags).catch(() => []);
        if (inp.value.trim() === text && more.length) { more.forEach(t => aiTags.add(t)); sug = [...new Set([...more, ...sug])].filter(x => !pickedTags.includes(x)).slice(0, 4); draw(); }
      }, 700);
    }
  }

  function draw() {
    if (!state) return;
    const { p, waiting, who, task } = state;
    const chips = [`<span class="chip cap-title">「${esc(p.title)}」</span>`];
    if (p.notes) chips.push(`<span class="chip">${icon('note')}原文存入备注</span>`);
    if (p.label) chips.push(`<span class="chip accent">${p.ai ? '✦ ' : icon('calendar')}${esc(p.label)}</span>`);
    if (p.repeat) chips.push(`<span class="chip accent">${icon('repeat')}${esc(repeatLabel(p.repeat))}</span>`);
    if (p.remind && p.due) chips.push(`<span class="chip warn">${icon('clock')}${p.allDay ? '提醒' : '到点提醒'}</span>`);
    // 没认出具体是谁也能点掉；点掉 = 记成普通待办
    if (waiting) chips.push(`<button class="chip wait" type="button" data-x="wait" title="不是等别人：点掉">等待 ${who ? esc(who.name) : '他人'} ×</button>`);
    if (taskId) { if (task) chips.push(`<span class="chip">归入项目：${esc(task.title)}</span>`); }
    else if (task) chips.push(`<button class="chip" type="button" data-x="task" title="点掉">归入项目：${esc(task.title)} ×</button>`);
    else chips.push('<span class="chip ghost">放入零星待办</span>');
    pickedTags.forEach(t => chips.push(`<button class="chip accent" type="button" data-k="p:${esc(t)}" data-untag="${esc(t)}">#${esc(t)} ×</button>`));
    sug.filter(t => !pickedTags.includes(t)).forEach(t => chips.push(`<button class="chip ghost" type="button" data-k="s:${esc(t)}" data-tag="${esc(t)}">${aiTags.has(t) ? '✦' : '＋'} #${esc(t)}</button>`));
    chips.push(tagEditing ? `<span class="tag-add"><input class="cap-tag-in" list="${uid}-tags" placeholder="标签名，回车添加" enterkeyhint="done" aria-label="标签名"><datalist id="${uid}-tags">${allTags.map(t => `<option value="${esc(t)}">`).join('')}</datalist></span>`
      : '<button class="chip ghost" type="button" data-k="addtag" data-x="addtag">＋ 自定义标签</button>');
    chips.push('<span class="hint cap-hint">回车保存 · Shift+回车换行</span>');
    out.innerHTML = chips.join('');
    // 只有新出现的标签做弹出动画，已有的保持不动
    const now = new Set();
    out.querySelectorAll('[data-k]').forEach(el => { now.add(el.dataset.k); if (!prevKeys.has(el.dataset.k)) el.classList.add('enter'); });
    prevKeys = now;
    if (tagEditing) {
      const ti = out.querySelector('.cap-tag-in'); ti.focus();
      ti.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); ev.stopPropagation(); const v = ti.value.trim().replace(/^#/, ''); if (v && !pickedTags.includes(v)) pickedTags.push(v); tagEditing = false; keep(); update(); inp.focus(); }
        if (ev.key === 'Escape') { ev.stopPropagation(); tagEditing = false; draw(); inp.focus(); }
      });
    }
  }

  async function save() {
    const text = inp.value.trim();
    if (!text || saving.has(key)) return;   // 先占位再做别的：连按回车 / 连点保存只记一条
    saving.add(key); wrap.classList.add('busy'); inp.readOnly = true; btn.disabled = true;
    clearTimeout(parseTimer); clearTimeout(aiTimer);
    const { p, waiting, who, task } = compute(text);
    const wasOpen = dropOpen; if (trigger) dropOpen = false;   // 首页保存后列表重绘，下拉随之收起（与以前一致）
    const data = {
      title: p.title, notes: p.notes, due_at: p.due, due_all_day: p.allDay, task_id: taskId || (task ? task.id : null), repeat_rule: p.repeat,
      status: waiting ? 'waiting' : 'todo', waiting_on: who ? who.id : null, tags: pickedTags,
    };
    const remind = p.remind && !p.allDay ? 'at_time' : 'default';
    const queueable = phase2(), cid = queueable ? newClientId() : undefined;   // 第一次保存前就定下 client_id，补存时用同一个
    const cleared = () => {
      writeDraft(key, null);
      inp.value = ''; pickedTags = []; out.innerHTML = ''; state = null; aiParsed = null; prevKeys = new Set(); dropWait = false; dropTaskId = null; tagEditing = false;
      sync(key, me);   // 另一个输入框里同一份草稿也清掉
      if (trigger) closeDrop();
      if (onSaved) onSaved();
    };
    try {
      const todo = await createTodo({ ...data, client_id: cid }, { remind, task });
      toast(`已记下${p.label ? ' · ' + p.label : ''}${p.repeat ? ' · ' + repeatLabel(p.repeat) : ''}`, { action: { label: '打开', onClick: () => openTodo(todo.id) } });
      cleared();
    } catch (e) {
      if (queueable && e && e.code === 'WB_OFFLINE') {
        // 没信号：先存在这台设备上，联网后自动补存
        addOutbox({ client_id: cid, title: p.title, data, remind, task: task || null });
        toast('没有网络，这条先存在这台设备上，联网后自动保存', { ms: 4000 });
        cleared();
      } else dropOpen = wasOpen;   // 没存上：run() 已提示原因；文字和草稿都还在，可以再点保存
    } finally { saving.delete(key); wrap.classList.remove('busy'); inp.readOnly = false; refresh(); }
  }

  out.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tag && !pickedTags.includes(b.dataset.tag)) pickedTags.push(b.dataset.tag);
    if (b.dataset.untag) pickedTags = pickedTags.filter(x => x !== b.dataset.untag);
    if (b.dataset.x === 'task' && state && state.task) dropTaskId = state.task.id;
    if (b.dataset.x === 'wait') dropWait = true;
    if (b.dataset.x === 'addtag') { tagEditing = true; draw(); return; }
    keep(); update(); inp.focus();
  });
  inp.addEventListener('input', e => { keep(); refresh(); if (!e.isComposing) update(); });   // 拼音输入中只存草稿，选完字再识别
  inp.addEventListener('compositionend', () => update());
  // 回车保存；Shift+回车换行。输入法选字的回车不算（Safari 选字回车 isComposing 为 false，但 keyCode 是 229）
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault(); save();
  });
  btn.addEventListener('mousedown', e => e.preventDefault());   // 电脑上点「保存」不抢输入框焦点，接着记下一条
  btn.addEventListener('click', () => save());
  inp.addEventListener('focus', () => { focusKey = key; });
  // 被页面重绘拿掉（不在页面上了）不算离开：新输入框会接回焦点
  inp.addEventListener('blur', () => setTimeout(() => { if (inp.isConnected && document.activeElement !== inp && focusKey === key) focusKey = null; }, 0));

  let openDrop = null, closeDrop = () => {};
  if (trigger) {
    box.classList.add('cap-drop', 'closed'); box.inert = true;   // 收起时 Tab 也进不去
    // 同步聚焦（不放 setTimeout 里）：iPhone 只有在点按的同一轮里聚焦才弹出键盘
    openDrop = (focus = true) => { dropOpen = true; box.classList.remove('closed'); box.inert = false; trigger.classList.add('on'); trigger.setAttribute('aria-expanded', 'true'); grow(); if (focus) inp.focus({ preventScroll: true }); };
    closeDrop = () => { dropOpen = false; box.classList.add('closed'); box.inert = true; trigger.classList.remove('on'); trigger.setAttribute('aria-expanded', 'false'); inp.blur(); };
    trigger.addEventListener('click', () => (box.classList.contains('closed') ? openDrop() : closeDrop()));
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrop(); });
    onOutsideTap(box, [box, trigger], closeDrop);
  }

  load();
  if (hasText()) update();
  // 数据刷新重挂首页时：下拉原来开着 → 直接开着（不放动画）；焦点原来在这里 → 接回焦点，光标放到最后
  const refocus = focusKey === key && (!document.activeElement || document.activeElement === document.body);
  if (openDrop && dropOpen) { box.classList.add('no-anim'); openDrop(false); void box.offsetWidth; box.classList.remove('no-anim'); }
  if (autofocus || (refocus && (!trigger || dropOpen))) { inp.focus({ preventScroll: true }); inp.setSelectionRange(inp.value.length, inp.value.length); }
  return { focus: () => inp.focus(), blur: () => inp.blur() };
}

/** 手机「+」：弹层里的记一条。「收起」只是收起，没保存的内容留作草稿，下次点「+」还在 */
export function openCapture(opts = {}) {
  let cap = null;
  const el = openSheet(`<div class="sheet-head"><b>记一条</b><span class="sp"></span><button class="btn small" data-x>收起</button></div><div class="cap-sheet-box"></div>
    <div class="hint">可以直接说时间：「周五前交采购清单」「明晚8点提醒我回电话」「每周一上午9点开例会」「等张三确认会议时间」</div>`, { label: '记一条', onClose: () => cap && cap.blur() });
  cap = mountCapture(el.querySelector('.cap-sheet-box'), { ...opts, autofocus: true });
  el.querySelector('[data-x]').onclick = () => closeSheet();
}
