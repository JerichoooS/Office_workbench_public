// settings.js — 设置（用户确认的结构，2026-10-20）
//   #/settings              分组列表：通知与提醒 › / AI 助手 › / 常用联系人 › / 外观（行内切换）/ 账号与关于 ›
//   #/settings/notify       本机通知、早报、晚报、默认提醒、催办节奏
//   #/settings/ai           总开关、Key、各项 AI 功能开关；模型与接口地址收在「高级」
//   #/settings/contacts     常用联系人：按使用次数排序，新增 / 编辑 / 删除
//   #/settings/account      登录账号、退出、版本
// 规则：常改的直接在列表行上操作；多项设置进子页面；单个选项用下拉或弹层。
// 外观（深浅色）是「本设备」偏好，存 localStorage；其余存 user_settings，跨设备同步。

import { esc, toast, openSheet, closeSheet, confirmSheet } from '../core/dom.js';
import { DEFAULT_REMINDER, CONTACT_KIND, contactKind } from '../data/schema.js';
import { getSettings, updateSettings } from '../data/repos/settings.js';
import { listContacts, createContact, updateContact, removeContact, mergeContact } from '../data/repos/contacts.js';
import { table, run } from '../data/db.js';
import { signOut, userName } from '../core/auth.js';
import { chat, AI_FEATURES } from '../data/ai.js';
import { pushState, enablePush, disablePush, sendTestPush, deviceCount, isIOS, handOverServerToken } from '../core/pwa.js';

// ---------- 外观 ----------
const THEME_KEY = 'wb-theme-mode';
export function applyTheme(mode) {
  try { if (mode === undefined) mode = localStorage.getItem(THEME_KEY) || ''; else localStorage.setItem(THEME_KEY, mode); } catch (_) { mode = mode || ''; }
  if (mode) document.documentElement.setAttribute('data-theme', mode); else document.documentElement.removeAttribute('data-theme');
  syncThemeColor();
  return mode;
}

/** 让浏览器/主屏幕 App 的状态栏颜色等于页面底色（iOS 不认 theme-color 的 media 写法，所以用脚本按实际主题设置） */
export function syncThemeColor() {
  const meta = document.getElementById('theme-color');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f1efeb');
}
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor); } catch (_) { /* 旧浏览器 */ }
const themeMode = () => { try { return localStorage.getItem(THEME_KEY) || ''; } catch (_) { return ''; } };

const sw = (id, on, label) => `<button class="switch" role="switch" id="${id}" aria-checked="${!!on}" aria-label="${label}"></button>`;
const sub = title => `<div><a class="btn small" href="#/settings">‹ 设置</a></div><div class="page-head"><h1>${title}</h1></div>`;
const navRow = (path, title, desc) => `<a class="set-row nav-row" href="#${path}"><div>${title}<div class="d">${desc}</div></div><span class="chev" aria-hidden="true">›</span></a>`;

export async function mount(root, params, ctx) {
  const section = params.section || '';
  const s = await getSettings(true);
  if (section === 'notify') return notify(root, s);
  if (section === 'ai') return ai(root, s);
  if (section === 'contacts') return contacts(root);
  if (section === 'account') return account(root, ctx.session);
  return home(root, s, ctx.session);
}

// ---------- 设置首页 ----------
async function home(root, s, session) {
  const mode = themeMode();
  const n = (await listContacts()).length;
  const reports = [s.morning_on ? `早报 ${s.morning_time}` : '早报关', s.evening_on ? `晚报 ${s.evening_time}` : '晚报关'].join(' · ');
  const aiDesc = !s.ai_enabled ? '未开启 · 不接入也能完整使用' : !s.llm_api_key ? '已开启，还没填 Key' : `已开启 · ${AI_FEATURES.filter(f => (s.ai_features || {})[f.k] !== false).length} 项功能在用`;
  root.innerHTML = `<div class="wrap">
    <div class="page-head"><h1>设置</h1></div>
    <div class="list">
      ${navRow('/settings/notify', '通知与提醒', reports + ' · 本机通知')}
      ${navRow('/settings/ai', 'AI 助手', aiDesc)}
      ${navRow('/settings/contacts', '常用联系人', `${n} 个 · 人、部门、科室、单位`)}
    </div>
    <div class="list">
      <div class="set-row"><div>外观<div class="d">只影响这台设备</div></div><div class="seg" role="group" aria-label="深浅色">
        ${[['', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, l]) => `<button data-theme="${v}" aria-pressed="${mode === v}">${l}</button>`).join('')}</div></div>
    </div>
    <div class="list">${navRow('/settings/account', '账号与关于', esc(userName(session)))}</div>
  </div>`;
  root.onclick = e => {
    const b = e.target.closest('[data-theme]'); if (!b) return;
    applyTheme(b.dataset.theme); root.querySelectorAll('[data-theme]').forEach(x => x.setAttribute('aria-pressed', x === b));
  };
}

// ---------- 通知与提醒 ----------
const PUSH_DESC = {
  'need-home-screen': '需要先把工作台添加到主屏幕：在 Safari 里点底部「分享」→「添加到主屏幕」，然后从主屏幕图标打开，再回到这里开启（需 iOS 16.4 以上）。',
  unsupported: '这个浏览器不支持后台通知。电脑建议用 Chrome 或 Edge；iPhone 请用 Safari 添加到主屏幕。',
  denied: '通知权限被拒绝了。iPhone：设置 → 通知 → 工作台 → 允许通知；电脑：点地址栏左侧的锁形图标，允许通知。',
  off: '开启后，到点提醒、催办、早晚报会像 App 一样弹出来。',
  'server-off': '服务器刚重启（例如重新部署后），推送暂停中。管理员打开工作台即可恢复；你如果是管理员，点「恢复」。错过的提醒会在 6 小时内补发。',
  on: '这台设备已开启。早晚报、到点提醒、催办都会推送到这里。',
};

async function notify(root, s) {
  root.innerHTML = `<div class="wrap">${sub('通知与提醒')}
    <div class="group"><div class="group-h"><b>本机</b></div><div class="list">
      <div class="set-row"><div>接收通知<div class="d" id="push-desc">检查中…</div></div><div class="ctl" id="push-ctl"></div></div></div></div>
    <div class="group"><div class="group-h"><b>每日汇总</b></div><div class="list">
      <div class="set-row"><div>早报<div class="d">今日待办、逾期、等待中的事项；点通知直达首页</div></div>
        <div class="ctl"><input class="time-in" id="s-mt" type="time" value="${esc(s.morning_time)}" ${s.morning_on ? '' : 'disabled'} aria-label="早报时间">${sw('s-mo', s.morning_on, '早报开关')}</div></div>
      <div class="set-row"><div>晚报<div class="d">今天完成了什么、还剩什么、明天到期</div></div>
        <div class="ctl"><input class="time-in" id="s-et" type="time" value="${esc(s.evening_time)}" ${s.evening_on ? '' : 'disabled'} aria-label="晚报时间">${sw('s-eo', s.evening_on, '晚报开关')}</div></div></div></div>
    <div class="group"><div class="group-h"><b>单条提醒</b></div><div class="list">
      <div class="set-row"><div>新建待办的默认提醒<div class="d">每条待办里还可以单独加减</div></div>
        <select class="time-in" id="s-def">${DEFAULT_REMINDER.map(r => `<option value="${r.v}" ${s.default_reminder === r.v ? 'selected' : ''}>${r.label}</option>`).join('')}</select></div>
      <div class="set-row"><div>催办节奏<div class="d">「等待他人」的待办：项目时间过半前每 3 天催一次，过半后每 2 天，最后 20% 每天；都在早上 9 点</div></div><span class="chip">自动</span></div></div></div>
  </div>`;
  const $ = q => root.querySelector(q);
  const save = async (patch, msg) => { await updateSettings(patch); if (msg) toast(msg); };
  $('#s-mt').onchange = e => save({ morning_time: e.target.value }, '早报时间已保存');
  $('#s-et').onchange = e => save({ evening_time: e.target.value }, '晚报时间已保存');
  $('#s-def').onchange = e => save({ default_reminder: e.target.value }, '已保存');
  drawPush(root);
  root.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 's-mo') return save({ morning_on: !s.morning_on }, s.morning_on ? '早报已关闭' : '早报已开启');
    if (b.id === 's-eo') return save({ evening_on: !s.evening_on }, s.evening_on ? '晚报已关闭' : '晚报已开启');
    switch (b.dataset.act) {
      case 'push-on': b.disabled = true; b.textContent = '开启中…'; try { await enablePush(); toast('通知已开启'); } catch (err) { toast(err.message); } drawPush(root); break;
      case 'push-off': await disablePush(); toast('这台设备不再接收通知'); drawPush(root); break;
      case 'push-retry': drawPush(root); break;
      case 'push-test': try { await sendTestPush(); toast('已发送，几秒内会收到'); } catch (err) { toast(err.message); } break;
    }
  };
}

async function drawPush(root) {
  const desc = root.querySelector('#push-desc'), ctl = root.querySelector('#push-ctl');
  if (!desc) return;
  await handOverServerToken();   // 先尝试交接，避免服务器刚重启时误显示「暂停」
  const st = await pushState().catch(() => 'unsupported');
  const n = await deviceCount().catch(() => 0);
  if (!root.contains(desc)) return;
  desc.textContent = PUSH_DESC[st] + (n ? `（已开启的设备：${n} 台）` : '');
  ctl.innerHTML = st === 'off' ? '<button class="btn small primary" data-act="push-on">开启通知</button>'
    : st === 'on' ? '<button class="btn small" data-act="push-test">发测试通知</button><button class="btn small" data-act="push-off">关闭</button>'
    : `<span class="chip ${st === 'need-home-screen' && isIOS() ? 'warn' : ''}">${st === 'need-home-screen' ? '先添加到主屏幕' : st === 'denied' ? '已拒绝' : st === 'server-off' ? '已暂停' : '不支持'}</span>${st === 'server-off' ? '<button class="btn small" data-act="push-retry">恢复</button>' : ''}`;
}

// ---------- AI 助手 ----------
async function ai(root, s) {
  const f = s.ai_features || {};
  const on = !!s.ai_enabled;
  root.innerHTML = `<div class="wrap">${sub('AI 助手')}
    <div class="list"><div class="set-row"><div>接入 AI<div class="d">关闭后所有 AI 入口隐藏，也不会发出任何 AI 请求；其他功能完全不受影响。</div></div>${sw('ai-master', on, '接入 AI')}</div></div>
    ${on ? `<div class="group"><div class="group-h"><b>DeepSeek Key</b></div><div class="list"><div class="set-row" style="grid-template-columns:1fr"><div class="form">
        <input id="ai-key" type="password" autocomplete="off" placeholder="${s.llm_api_key ? '已配置（' + esc(s.llm_api_key.slice(0, 5)) + '…），留空表示不修改' : 'sk-…'}" aria-label="DeepSeek API Key">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary small" data-act="save-key">保存</button><button class="btn small" data-act="test">测试连接</button><span class="hint" id="ai-msg"></span></div>
        <span class="hint">Key 只保存在你的账号下，用于调用 DeepSeek，不会进代码或仓库。</span></div></div></div></div>
      <div class="group"><div class="group-h"><b>启用哪些功能</b></div><div class="list">
        ${AI_FEATURES.map(x => `<div class="set-row"><div>${x.label}<div class="d">${x.desc}</div></div>${sw('ai-f-' + x.k, f[x.k] !== false, x.label)}</div>`).join('')}</div></div>
      <details class="fold"><summary>高级</summary><div class="form" style="padding:4px 12px 12px">
        <label>模型<select id="ai-model"><option value="deepseek-chat" ${s.llm_model === 'deepseek-chat' ? 'selected' : ''}>deepseek-chat（快）</option><option value="deepseek-reasoner" ${s.llm_model === 'deepseek-reasoner' ? 'selected' : ''}>deepseek-reasoner（推理，较慢）</option></select></label>
        <label>接口地址<input id="ai-base" value="${esc(s.llm_base_url)}"></label></div></details>` : ''}
  </div>`;
  const $ = q => root.querySelector(q);
  if (on) {
    $('#ai-model').onchange = async e => { await updateSettings({ llm_model: e.target.value }); toast('已保存'); };
    $('#ai-base').onchange = async e => { await updateSettings({ llm_base_url: e.target.value.trim() || 'https://api.deepseek.com' }); toast('已保存'); };
  }
  root.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'ai-master') { await updateSettings({ ai_enabled: !on }); toast(on ? '已关闭 AI，所有功能照常可用' : 'AI 已开启，请填写 Key'); return; }
    if (b.id && b.id.startsWith('ai-f-')) { const k = b.id.slice(5); await updateSettings({ ai_features: { ...f, [k]: f[k] === false } }); return; }
    if (b.dataset.act === 'save-key') { const key = $('#ai-key').value.trim(); if (!key) { toast('请先填写 Key'); return; } await updateSettings({ llm_api_key: key }); toast('Key 已保存'); }
    if (b.dataset.act === 'test') {
      const msg = $('#ai-msg'); msg.textContent = '调用中…';
      // 测试输入框里的 Key（还没保存也能测）；输入框为空就测已保存的 Key
      const typed = $('#ai-key').value.trim();
      if (!typed && !s.llm_api_key) { msg.textContent = '请先填写 Key'; return; }
      const override = { llm_api_key: typed || s.llm_api_key, llm_model: $('#ai-model').value, llm_base_url: $('#ai-base').value.trim() || 'https://api.deepseek.com' };
      try { const out = await chat([{ role: 'user', content: '只回复「连接成功」四个字' }], null, null, override); msg.textContent = '✓ ' + out.trim().slice(0, 30) + (typed ? ' · 记得点「保存」' : ''); }
      catch (err) { msg.textContent = '✗ ' + err.message; }
    }
  };
}

// ---------- 常用联系人 ----------
async function contacts(root) {
  const [list, links, waits, targets] = await Promise.all([
    listContacts(true),
    run(table('task_contacts').select('contact_id')),
    run(table('todos').select('waiting_on').not('waiting_on', 'is', null)),
    run(table('collection_targets').select('contact_id').not('contact_id', 'is', null)),
  ]);
  const uses = {};
  [...links.map(x => x.contact_id), ...waits.map(x => x.waiting_on), ...targets.map(x => x.contact_id)].forEach(id => { uses[id] = (uses[id] || 0) + 1; });
  const sorted = [...list].sort((a, b) => (uses[b.id] || 0) - (uses[a.id] || 0) || a.name.localeCompare(b.name, 'zh'));
  root.innerHTML = `<div class="wrap">${sub('常用联系人')}
    <div style="display:flex;gap:8px;align-items:center"><span class="hint">按使用次数排序（关联的项目、等待对象、收集对象）</span><span class="sp"></span><button class="btn primary small" data-act="add">＋ 添加</button></div>
    <div class="list">${sorted.map(c => `<button class="item" data-c="${c.id}" style="width:100%;text-align:left"><span class="av-sm">${esc(c.name[0])}</span>
      <div style="min-width:0"><div class="t-title">${esc(c.name)}</div><div class="t-meta"><span>${contactKind(c.kind)}</span>${c.org ? `<span>${esc(c.org)}</span>` : ''}${c.phone ? `<span class="num">${esc(c.phone)}</span>` : ''}</div></div>
      <span class="t-side">${uses[c.id] ? `用过 <span class="num">${uses[c.id]}</span> 次` : '未使用'}</span></button>`).join('') || '<div class="empty">还没有联系人。项目、等待对象、材料收集里添加的人和部门都会出现在这里。</div>'}</div>
  </div>`;
  root.onclick = e => {
    if (e.target.closest('[data-act="add"]')) return editContact(null, 0, list);
    const c = e.target.closest('[data-c]'); if (c) editContact(list.find(x => String(x.id) === c.dataset.c), uses[c.dataset.c] || 0, list);
  };
}

function editContact(c, used = 0, all = []) {
  const isNew = !c;
  c = c || { name: '', kind: 'person', org: '', phone: '', note: '' };
  const el = openSheet(`<div class="sheet-head"><b>${isNew ? '添加联系人' : '编辑联系人'}</b><span class="sp"></span><button class="btn small" data-x="cancel">取消</button><button class="btn small primary" data-x="save">保存</button></div>
    <div class="form">
      <label>名称<input id="c-name" value="${esc(c.name)}" placeholder="如：张三 / 行政部 / 某供应商"></label>
      <label>类型<select id="c-kind">${CONTACT_KIND.map(k => `<option value="${k.v}" ${c.kind === k.v ? 'selected' : ''}>${k.label}</option>`).join('')}</select></label>
      <label>所属单位 / 部门<input id="c-org" value="${esc(c.org || '')}" placeholder="如：某公司 · 采购部"></label>
      <label>电话<input id="c-phone" value="${esc(c.phone || '')}" inputmode="tel"></label>
      <label>备注<textarea id="c-note" rows="2">${esc(c.note || '')}</textarea></label>
      ${isNew ? '' : `<details class="fold"><summary>合并重复的联系人</summary><div class="form" style="padding:4px 12px 12px">
        <span class="hint">同一个人/部门录成了两个名字时用。把「${esc(c.name)}」合并进下面选的那个：它的项目、等待、收集记录都会转过去，然后删除「${esc(c.name)}」。</span>
        <select id="c-merge"><option value="">选择要保留的联系人…</option>${all.filter(x => x.id !== c.id).map(x => `<option value="${x.id}">${esc(x.name)}（${contactKind(x.kind)}）</option>`).join('')}</select>
        <button class="btn small" data-x="merge" style="align-self:flex-start">合并</button></div></details>
      <button class="btn small danger" data-x="del" style="align-self:flex-start">删除这个联系人</button>`}
    </div>`, { label: isNew ? '添加联系人' : '编辑联系人' });
  setTimeout(() => el.querySelector('#c-name').focus(), 250);
  el.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const v = id => el.querySelector(id).value.trim();
    if (b.dataset.x === 'cancel') { closeSheet(); return; }
    if (b.dataset.x === 'save') {
      if (!v('#c-name')) { toast('请填写名称'); return; }
      const data = { name: v('#c-name'), kind: v('#c-kind'), org: v('#c-org') || null, phone: v('#c-phone') || null, note: v('#c-note') || null };
      if (isNew) await createContact(data); else await updateContact(c.id, data);
      closeSheet(); toast('已保存');
    }
    if (b.dataset.x === 'merge') {
      const to = el.querySelector('#c-merge').value; if (!to) { toast('请先选择要保留的联系人'); return; }
      const target = all.find(x => String(x.id) === to);
      closeSheet();
      if (await confirmSheet(`把「${c.name}」合并进「${target.name}」？合并后「${c.name}」会被删除。`, '合并')) { await mergeContact(c.id, to); toast('已合并'); }
      return;
    }
    if (b.dataset.x === 'del') {
      closeSheet();
      if (await confirmSheet(`删除「${c.name}」？${used ? `它在 ${used} 处被用到：项目里会移除它，等待对象会清空，收集对象保留名称。` : ''}`, '删除', true)) { await removeContact(c.id); toast('已删除'); }
    }
  };
}

// ---------- 账号与关于 ----------
async function account(root, session) {
  let version = '';
  try { version = (await (await fetch('/api/version', { cache: 'no-store' })).json()).version; } catch (_) { /* 离线 */ }
  root.innerHTML = `<div class="wrap">${sub('账号与关于')}
    <div class="list">
      <div class="set-row"><div>${esc(userName(session))}<div class="d">${window.WBBoot.mock ? '本地模拟模式：数据只存在这台电脑的浏览器里' : '微信登录 · 数据保存在云端'}</div></div>
        ${window.WBBoot.mock ? '<button class="btn small" data-act="reset">清空模拟数据</button>' : '<button class="btn small" data-act="logout">退出登录</button>'}</div>
      <div class="set-row"><div>版本<div class="d">每次部署后版本号会变；有新版本时页面顶部会提示更新</div></div><span class="chip num">${esc(version || '—')}</span></div>
    </div>
  </div>`;
  root.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'logout' && await confirmSheet('退出登录？', '退出')) await signOut();
    if (b.dataset.act === 'reset' && await confirmSheet('清空本地模拟数据？', '清空', true)) window.WBMock.reset();
  };
}
