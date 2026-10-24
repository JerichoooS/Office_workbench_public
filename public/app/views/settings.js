// settings.js — 设置（用户确认的结构，2026-10-20；2026-10-22 外观、数据与备份改为子页面）
//   #/settings              分组列表：通知与提醒 › / AI 助手 › / 常用联系人 › / 外观 › / 数据与备份 › / 账号与关于 ›
//   #/settings/notify       本机通知、早报、晚报、默认提醒、催办节奏
//   #/settings/ai           总开关、Key、各项 AI 功能开关；模型与接口地址收在「高级」
//   #/settings/contacts     常用联系人：按使用次数排序，新增 / 编辑 / 删除（删除前提示有哪些待办在等这个人）
//   #/settings/appearance   深浅色 → 配色（带小样）→ 现场模式 → 字号
//   #/settings/data         同步状态、找回（最近删除 ›、从备份文件找回）、每日云端快照、一键导出（JSON / Markdown / CSV）、数据去向与边界、工作台记什么
//   #/settings/trash        最近删除（第二阶段）：30 天内删掉的待办、收集对象，可以恢复
//   #/settings/account      登录账号、退出、版本
// 规则：常改的直接在列表行上操作；多项设置进子页面；单个选项用下拉或弹层。
// 外观是「本设备」偏好，存 localStorage（core/appearance.js）；其余存 user_settings，跨设备同步。

import { esc, toast, openSheet, closeSheet, confirmSheet, icon } from '../core/dom.js';
import { DEFAULT_REMINDER, CONTACT_KIND, contactKind } from '../data/schema.js';
import { getSettings, updateSettings } from '../data/repos/settings.js';
import { listContacts, createContact, updateContact, removeContact, mergeContact } from '../data/repos/contacts.js';
import { table, run } from '../data/db.js';
import { signOut, userName } from '../core/auth.js';
import { chat, AI_FEATURES } from '../data/ai.js';
import { pushState, enablePush, disablePush, sendTestPush, deviceCount, isIOS, handOverServerToken, subscriptionOnServer, reEnablePush, serviceStatus, serviceLine } from '../core/pwa.js';
import { SKINS, getAppearance, applyAppearance } from '../core/appearance.js';
import { FORMATS, buildExport, saveFile, snapshotFile, sizeLabel } from '../data/export.js';
import { syncDot } from '../components/sync.js';
import { phase2 } from '../data/features.js';
import { listTrash, restoreTrash, KEEP_DAYS, TRASH_KIND } from '../data/repos/trash.js';
import { listSnapshots, getSnapshot, SNAPSHOT_DAYS } from '../data/repos/snapshots.js';
import { checkBackup, prepareRestore, applyRestore } from '../data/restore.js';
import { listTasks } from '../data/repos/tasks.js';
import { listCollections } from '../data/repos/collections.js';
import { saveFailed } from '../data/db.js';
import { lastHolidayYear } from '../core/holidays.js';
import { parseYmd, dayDiff, ymd, ago, WD } from '../core/dates.js';
import { go } from '../core/router.js';
import { openTodo } from '../components/todo-detail.js';

const sw = (id, on, label) => `<button class="switch" role="switch" id="${id}" aria-checked="${!!on}" aria-label="${label}"></button>`;
const sub = title => `<div><a class="btn small" href="#/settings">‹ 设置</a></div><div class="page-head"><h1>${title}</h1></div>`;
const navRow = (path, title, desc) => `<a class="set-row nav-row" href="#${path}"><div>${title}<div class="d">${desc}</div></div><span class="chev" aria-hidden="true">›</span></a>`;

export async function mount(root, params, ctx) {
  const section = params.section || '';
  if (section === 'appearance') return appearance(root);   // 外观只读本机，不依赖网络
  if (section === 'data') return dataPage(root);
  if (section === 'trash') return trashPage(root);
  const s = await getSettings(true);
  if (section === 'notify') return notify(root, s);
  if (section === 'ai') return ai(root, s);
  if (section === 'contacts') return contacts(root);
  if (section === 'account') return account(root, ctx.session);
  return home(root, s, ctx.session);
}

// ---------- 设置首页 ----------
async function home(root, s, session) {
  const a = getAppearance();
  const look = a.field ? '现场模式' : [SKINS.find(x => x.v === a.skin).label, { '': '跟随系统', light: '浅色', dark: '深色' }[a.mode] || '跟随系统', a.font === 'large' ? '大字号' : ''].filter(Boolean).join(' · ');
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
      ${navRow('/settings/appearance', '外观', look + ' · 只影响这台设备')}
      ${navRow('/settings/data', '数据与备份', phase2() ? '最近删除 · 云端快照 · 导出与找回' : '一键导出 · 从备份找回 · 同步状态')}
    </div>
    <div class="list">${navRow('/settings/account', '账号与关于', esc(userName(session)))}</div>
  </div>`;
  root.onclick = null;
}

// ---------- 外观（只影响这台设备） ----------
function appearance(root) {
  const a = getAppearance();
  const preview = sk => {
    const [bg, card, ink, acc] = sk.light, [dbg, dcard, dink, dacc] = sk.dark;
    // 小样：左浅右深，各画一行待办 + 一个主色按钮（颜色取自 SKINS 登记表，只用于这里）
    const half = (b, c, i, x) => `<span class="pv-half" style="background:${b}"><span class="pv-card" style="background:${c}"><i style="border-color:${x}"></i><b style="background:${i}"></b></span><span class="pv-btn" style="background:${x}"></span></span>`;
    return `<span class="pv" aria-hidden="true">${half(bg, card, ink, acc)}${half(dbg, dcard, dink, dacc)}</span>`;
  };
  root.innerHTML = `<div class="wrap">${sub('外观')}
    <p class="hint">只影响这台设备；手机和电脑可以各用各的。</p>
    <div class="group"><div class="group-h"><b>深浅</b></div><div class="list"><div class="set-row"><div>显示模式<div class="d">跟随系统时，手机切到深色模式这里也跟着变</div></div>
      <div class="seg" role="group" aria-label="深浅色">${[['', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, l]) => `<button data-mode="${v}" aria-pressed="${a.mode === v}">${l}</button>`).join('')}</div></div></div></div>
    <div class="group"><div class="group-h"><b>配色</b>${a.field ? '<span>· 现场模式开着时固定用「现场」</span>' : ''}</div>
      <div class="skins" role="radiogroup" aria-label="配色">${SKINS.map(sk => `<button class="skin" role="radio" data-skin="${sk.v}" aria-checked="${(a.field ? 'venue' : a.skin) === sk.v}" ${a.field ? 'disabled' : ''}>
        ${preview(sk)}<span class="skin-l"><b>${sk.label}</b><span class="hint">${sk.desc}</span></span></button>`).join('')}</div></div>
    <div class="group"><div class="group-h"><b>现场</b></div><div class="list">
      <div class="set-row"><div>现场模式<div class="d">高对比配色 + 大字号。在户外强光下、单手边走边看时打开，回办公室再关掉</div></div>${sw('ap-field', a.field, '现场模式')}</div>
      <div class="set-row"><div>字号<div class="d">${a.field ? '现场模式开着时固定用大字号' : '大字号整体放大约 1/8'}</div></div>
        <div class="seg" role="group" aria-label="字号">${[['', '标准'], ['large', '大']].map(([v, l]) => `<button data-font="${v}" aria-pressed="${(a.field ? 'large' : a.font) === v}" ${a.field ? 'disabled' : ''}>${l}</button>`).join('')}</div></div></div></div>
  </div>`;
  root.onclick = e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.mode !== undefined) applyAppearance({ mode: b.dataset.mode });
    else if (b.dataset.skin) applyAppearance({ skin: b.dataset.skin });
    else if (b.dataset.font !== undefined) applyAppearance({ font: b.dataset.font });
    else if (b.id === 'ap-field') { applyAppearance({ field: !getAppearance().field }); toast(getAppearance().field ? '现场模式已打开' : '现场模式已关闭'); }
    else return;
    appearance(root);
  };
}

// ---------- 数据与备份 ----------
// 第二阶段（features.phase2()）多出：最近删除 ›、每日云端快照（下载 / 找回）。「从备份文件找回」新旧库都能用。
/** 「刚刚」「3 分钟前」后面直接接字，「今天 14:20」后面空一格 */
const agoWord = iso => { const a = ago(iso); return /\d$/.test(a) ? a + ' ' : a; };
const fmtDay = s => { const d = parseYmd(s), n = dayDiff(d); return `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}${n === 0 ? ' · 今天' : n === -1 ? ' · 昨天' : ''}`; };

/** 节假日表快过期了：11 月起还没有明年的、或者连今年的都没有 */
function holidayHint(now = new Date()) {
  const last = lastHolidayYear(), y = now.getFullYear();
  if (last < y) return `节假日表只到 ${last} 年，今年的放假安排需要更新一次。`;
  if (now.getMonth() >= 10 && last < y + 1) return `节假日表只到 ${last} 年，明年的放假安排公布后需要更新一次。`;
  return '';
}

function dataPage(root) {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const p2 = phase2(), hh = holidayHint();
  root.innerHTML = `<div class="wrap">${sub('数据与备份')}
    ${hh ? `<p class="hint warn-line">${hh}</p>` : ''}
    <div class="group"><div class="group-h"><b>同步</b></div><div class="list">
      <div class="set-row"><div>云端同步<div class="d">每次修改都会立即保存到云端；网络不稳定时页面保留当前内容，恢复后自动同步。${p2 ? '没信号时「记一条」先存在这台设备上，联网后自动保存。' : ''}</div></div>${syncDot({ wide: true })}</div></div></div>
    <div class="group"><div class="group-h"><b>找回</b><span>· 只补回现在缺少的，不会覆盖或改动现有内容</span></div><div class="list">
      ${p2 ? navRow('/settings/trash', '最近删除', `删掉的待办、收集对象，${KEEP_DAYS} 天内可以恢复`) : ''}
      <div class="set-row"><div>从备份文件找回<div class="d">选一个「完整备份（JSON）」导出的文件，先看能找回什么，确认后再补回</div></div>
        <button class="btn small row-act" data-act="pick">选择文件</button><input type="file" id="restore-file" accept=".json,application/json" hidden></div></div></div>
    ${p2 ? `<div class="group"><div class="group-h"><b>每日云端快照</b><span>· 服务器每天凌晨自动存一份，保留 ${SNAPSHOT_DAYS} 天</span></div>
      <div class="list" id="snaps"><div class="empty">读取中…</div></div></div>` : ''}
    <div class="group"><div class="group-h"><b>导出</b><span>· 建议每月导出一次完整备份，存到电脑或网盘</span></div><div class="list">
      ${Object.entries(FORMATS).map(([k, f]) => `<div class="set-row"><div>${f.label}<div class="d">${f.desc}</div></div><button class="btn small" data-export="${k}">${icon('download')}导出</button></div>`).join('')}</div>
      <p class="hint">${touch ? '手机上点「导出」后再点一次「保存」，可以存到「文件」或发到电脑。' : '导出的文件会下载到浏览器的下载文件夹。'}AI Key 和推送设置不会导出。</p></div>
    <div class="group"><div class="group-h"><b>数据去向与边界</b></div><div class="list"><div class="set-row" style="grid-template-columns:1fr"><div class="prose">
      <p><b>存在哪：</b>WorkBuddy 云库，只有你自己的账号能读。${p2 ? `服务器每天另存一份快照，保留 ${SNAPSHOT_DAYS} 天。` : ''}</p>
      <p><b>开了 AI 时发出去什么：</b>用 AI 功能时，会把相关待办的标题、进展发给 AI 模型；电话号码先打码（如 138****8000）。不开 AI 就什么都不发。</p>
      <p><b>别放进来：</b>涉密文件、密码、门禁卡号。</p>
      <p><b>iPhone 锁屏：</b>提醒会在锁屏上显示待办标题。不想让旁人看到：设置 › 通知 › 工作台 › 显示预览 → 解锁时。</p></div></div></div></div>
    <div class="group"><div class="group-h"><b>工作台记什么</b></div><div class="list"><div class="set-row" style="grid-template-columns:1fr"><div class="prose">
      <p><b>适合记：</b>待办、进展、等谁回复、联系人和电话、链接（共享盘、OA 页面地址）。</p>
      <p><b>不放进来：</b>文件、照片、网络参数、公文正文。这些留在单位的系统里，工作台只记「做到哪一步了」。</p>
      <p class="hint">备注和进展里的网址、手机号会自动变成可以点的链接。</p></div></div></div></div>
  </div>`;
  const snapBox = root.querySelector('#snaps');
  let snaps = [];
  if (snapBox) {
    listSnapshots().then(list => {
      snaps = list;
      if (!snapBox.isConnected) return;
      snapBox.innerHTML = list.map(s => `<div class="set-row"><div>${fmtDay(s.day)}<div class="d num">${sizeLabel(s.bytes || 0)}</div></div>
        <div class="ctl"><button class="btn small row-act" data-snap-restore="${esc(s.id)}">找回</button><button class="btn small row-act" data-snap="${esc(s.id)}">${icon('download')}下载</button></div></div>`).join('')
        || '<div class="empty">还没有快照。服务器每天凌晨存一份，明天再来看。</div>';
    }).catch(() => { if (snapBox.isConnected) snapBox.innerHTML = '<div class="empty">暂时读不到快照（网络不稳定），稍后再看。</div>'; });
  }
  const fileIn = root.querySelector('#restore-file');
  fileIn.onchange = async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';   // 同一个文件可以再选一次
    if (!f) return;
    let obj;
    try { obj = JSON.parse(await f.text()); } catch (_) { toast('这个文件读不出来，请选「完整备份（JSON）」导出的 .json 文件'); return; }
    let tables;
    try { tables = checkBackup(obj); } catch (e) { toast(e.message); return; }
    const when = obj.source === 'snapshot' && obj.day ? `云端快照 ${fmtDay(obj.day)}` : obj.exported_at ? `${ymd(new Date(obj.exported_at))} 导出的备份` : '备份文件';
    previewRestore(tables, `${when}（${f.name}）`);
  };
  root.onclick = async e => {
    if (e.target.closest('[data-act="pick"]')) { fileIn.click(); return; }
    const sr = e.target.closest('[data-snap-restore]');
    if (sr) {
      sr.disabled = true;
      try { const s = await getSnapshot(sr.dataset.snapRestore); if (s) previewRestore(s.data || {}, `云端快照 ${fmtDay(s.day)}`); else toast('这份快照已经不在了'); }
      catch (err) { if (!err.handled) toast('没能读取这份快照，请重试'); }
      finally { sr.disabled = false; }
      return;
    }
    const sd = e.target.closest('[data-snap]');
    if (sd) return fileButton(sd, touch, async () => { const s = await getSnapshot(sd.dataset.snap); if (!s) throw new Error('这份快照已经不在了'); return snapshotFile(s); });
    const b = e.target.closest('[data-export]');
    if (b) return fileButton(b, touch, () => buildExport(b.dataset.export));
  };
}

/** 生成文件的按钮：电脑上直接下载；手机上先准备好，按钮变成「保存（大小）」，再点一次走系统分享（iOS 要求分享在点按里发起） */
async function fileButton(b, touch, make) {
  if (b.disabled) return;
  if (b._file) { const r = await saveFile(b._file); if (r === 'downloaded') toast('已下载 ' + b._file.name); return; }   // 手机：第二次点 = 分享/保存
  const label = b.innerHTML;
  b.disabled = true; b.textContent = '准备中…';
  try {
    const file = await make();
    const size = sizeLabel(file.size);
    b.disabled = false;
    if (touch) { b._file = file; b.classList.add('primary'); b.textContent = `保存（${size}）`; return; }
    await saveFile(file); b.innerHTML = label; toast(`已下载 ${file.name}（${size}）`);
  } catch (err) { b.disabled = false; b.innerHTML = label; if (!err.handled) toast('没有成功：' + (err.message || '请重试')); }
}

/** 找回前先看：能补回什么（按现在的数据算），确认后写入 */
async function previewRestore(tables, from) {
  let plan;
  try { plan = await prepareRestore(tables); }
  catch (err) { if (!err.handled) toast('没能读取现在的数据，请稍后再试'); return; }
  const titles = (plan.tables.todos || []).slice(0, 5).map(t => `<li>${esc(t.title)}</li>`).join('');
  const more = plan.counts.todos > 5 ? `<li class="hint">还有 ${plan.counts.todos - 5} 条</li>` : '';
  const el = openSheet(`<div class="sheet-head"><b>从备份找回</b><span class="sp"></span><button class="btn small" data-x="cancel">取消</button></div>
    <p class="hint">来源：${esc(from)}</p>
    ${plan.total ? `<p class="restore-sum">可以找回：${esc(plan.summary)}</p>${titles ? `<ul class="restore-list">${titles}${more}</ul>` : ''}
      <p class="hint">只补回现在缺少的；现有的内容不会被覆盖或改动，设置也不变。原来的项目、联系人已经删了的，相关待办放进零星待办、等待对象留空。</p>
      <div class="sheet-actions"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">找回</button></div>`
    : `<p class="restore-sum">备份里的内容现在都在，不需要找回。</p><div class="sheet-actions"><button class="btn primary" data-x="cancel">好的</button></div>`}`, { label: '从备份找回' });
  el.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'cancel') { closeSheet(); return; }
    if (b.disabled) return;
    b.disabled = true; b.textContent = '找回中…';
    try {
      const r = await applyRestore(plan);
      closeSheet();
      toast(r.total >= plan.total ? `已找回：${plan.summary}` : `已找回 ${r.total} 条；另有 ${plan.total - r.total} 条刚好已经有了，跳过`);
    } catch (err) { b.disabled = false; b.textContent = '找回'; saveFailed(err); }
  };
}

// ---------- 最近删除（第二阶段） ----------
async function trashPage(root) {
  const head = `<div><a class="btn small" href="#/settings/data">‹ 数据与备份</a></div><div class="page-head"><h1>最近删除</h1></div>`;
  if (!phase2()) { root.innerHTML = `<div class="wrap">${head}<div class="placeholder">云端数据库还没升级到第二阶段，暂时没有「最近删除」。</div></div>`; root.onclick = null; return; }
  const [rows, tasks, archived, cols] = await Promise.all([listTrash(), listTasks(), listTasks({ archived: true }), listCollections()]);
  const T = new Map([...tasks, ...archived].map(t => [String(t.id), t]));
  const C = new Set(cols.map(c => String(c.id)));
  const where = r => {
    if (r.kind === 'todo') {
      const tid = r.data && r.data.todo && r.data.todo.task_id;
      if (tid == null) return '零星待办';
      return T.has(String(tid)) ? esc(T.get(String(tid)).title) : '项目已删除（恢复后放进零星待办）';
    }
    return `收集「${esc((r.data && r.data.collection_title) || '')}」`;
  };
  const gone = r => r.kind === 'collection_target' && !C.has(String(r.data && r.data.target && r.data.target.collection_id));
  root.innerHTML = `<div class="wrap">${head}
    <p class="hint">删掉的待办、收集对象在这里保留 ${KEEP_DAYS} 天，之后自动清除。待办恢复时，进展和还没到时间的提醒一起放回。</p>
    <div class="list">${rows.map(r => `<div class="item plain"><div style="min-width:0"><div class="t-title clamp">${esc(r.title)}</div>
        <div class="t-meta"><span>${TRASH_KIND[r.kind] || ''}</span><span class="task">${where(r)}</span><span>${esc(agoWord(r.deleted_at))}删除</span></div></div>
        ${gone(r) ? '<span class="t-side">收集已删除<br>无法恢复</span>' : `<button class="btn small row-act" data-restore="${esc(r.id)}">恢复</button>`}</div>`).join('')
      || `<div class="empty">最近 ${KEEP_DAYS} 天没有删除过待办或收集对象</div>`}</div>
  </div>`;
  root.onclick = async e => {
    const b = e.target.closest('[data-restore]'); if (!b || b.disabled) return;
    const row = rows.find(r => String(r.id) === b.dataset.restore); if (!row) return;
    b.disabled = true; b.textContent = '恢复中…';
    try {
      const r = await restoreTrash(row);
      const open = !r.ok ? null : row.kind === 'todo' ? () => openTodo(r.id) : () => go('/collections?c=' + r.collection_id);
      toast(r.message, open ? { action: { label: '打开', onClick: open } } : {});
      if (!r.ok) { b.disabled = false; b.textContent = '恢复'; }
    } catch (err) { b.disabled = false; b.textContent = '恢复'; saveFailed(err); }
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
      <div class="set-row"><div>接收通知<div class="d" id="push-desc">检查中…</div></div><div class="ctl" id="push-ctl"></div></div>
      <div class="set-row" id="svc-row"><div>提醒服务<div class="d" id="svc-desc">检查中…</div></div><span class="chip" id="svc-chip" hidden></span></div></div></div>
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
      case 'push-reon': b.disabled = true; b.textContent = '开启中…'; try { await reEnablePush(); toast('通知已重新开启'); } catch (err) { toast(err.message); } drawPush(root); break;
      case 'push-off': await disablePush(); toast('这台设备不再接收通知'); drawPush(root); break;
      case 'push-retry': drawPush(root); break;
      case 'push-test': try { await sendTestPush(); toast('已发送，几秒内会收到'); } catch (err) { toast(err.message); } break;
    }
  };
}

async function drawService(root) {
  const row = root.querySelector('#svc-row');
  if (!row) return;
  const line = serviceLine(await serviceStatus());   // 规则见 core/pwa.js
  if (!row.isConnected) return;
  if (!line) { row.hidden = true; return; }
  row.querySelector('#svc-desc').textContent = line.text;
  const chip = row.querySelector('#svc-chip');
  chip.hidden = !line.chip; chip.textContent = line.chip; chip.className = `chip ${line.cls}`;
}

async function drawPush(root) {
  const desc = root.querySelector('#push-desc'), ctl = root.querySelector('#push-ctl');
  if (!desc) return;
  await handOverServerToken();   // 先尝试交接，避免服务器刚重启时误显示「暂停」
  drawService(root);
  const st = await pushState().catch(() => 'unsupported');
  const n = await deviceCount().catch(() => 0);
  // 这台设备订阅着，但服务器上那一行已经没了（推送服务退回「订阅失效」时服务器会删掉）：提醒发不到这里，要重新开启
  const lost = st === 'on' && (await subscriptionOnServer().catch(() => null)) === false;
  if (!root.contains(desc)) return;
  if (lost) {
    desc.textContent = '这台设备的通知已经失效（推送服务退回了订阅），提醒发不到这里了。点「重新开启」恢复。';
    ctl.innerHTML = '<span class="chip warn">已失效</span><button class="btn small primary" data-act="push-reon">重新开启</button>';
    return;
  }
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
      // 还有待办在等这个人：先列出来，建议合并到正确的联系人，而不是直接删掉（删了等待对象会清空，催办也停）
      const waiting = await run(table('todos').select('id,title').eq('waiting_on', c.id).neq('status', 'done'));
      if (waiting.length) return deleteGuide(c, waiting, used, all);
      if (await confirmSheet(`删除「${c.name}」？${used ? `它在 ${used} 处被用到：项目里会移除它，收集对象保留名称。` : ''}`, '删除', true)) { await removeContact(c.id); toast('已删除'); }
    }
  };
}

function deleteGuide(c, waiting, used, all) {
  const el = openSheet(`<div class="sheet-head"><b>还有 ${waiting.length} 条待办在等「${esc(c.name)}」</b></div>
    <div class="list">${waiting.slice(0, 5).map(t => `<div class="item plain"><div class="t-title clamp">${esc(t.title)}</div><span></span></div>`).join('')}${waiting.length > 5 ? `<div class="empty">还有 ${waiting.length - 5} 条</div>` : ''}</div>
    <p class="hint">删除后这些待办的等待对象会清空，也不会再自动催办。如果是重复录入的联系人，建议合并到正确的那个：待办会跟着转过去。</p>
    <div class="sheet-actions"><button class="btn" data-x="cancel">取消</button><button class="btn danger" data-x="del">仍然删除</button><button class="btn primary" data-x="merge">合并到…</button></div>`, { label: '删除联系人' });
  el.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    closeSheet();
    if (b.dataset.x === 'merge') { editContact(c, used, all); setTimeout(() => { const d = document.querySelector('#sheet details.fold'); if (d) { d.open = true; d.querySelector('select').focus(); } }, 260); }
    if (b.dataset.x === 'del') { await removeContact(c.id); toast('已删除'); }
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
