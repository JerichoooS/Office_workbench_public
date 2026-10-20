// ai-chat.js — AI 对话框：首页标题行的 ✦ 按钮打开（手机从底部弹出，电脑居中弹出）
// 显示条件：AI 总开关开启 + 已填 Key + 「AI 对话」功能开启；Tips「简报」「Top 5」各自受对应开关控制
// - 每次提问都附上当前待办摘要，模型只基于这些数据回答
// - 回答长度与格式受限，适配对话框：≤120 字；需要列举时最多 5 条编号列表，每条 ≤25 字；不用标题/表格/代码块
// - 输入框上方的 Tips：「简报」「Top 5」等，点一下即发送（原来的两个按钮改成 Tips）
// - 对话只保存在本次打开期间（内存），不入库

import { esc, openSheet, closeSheet } from '../core/dom.js';
import { todayTitle, isOverdue, dayDiff } from '../core/dates.js';
import { buildIndex, retrieve, refHref } from '../data/knowledge.js';
import { chat, aiOn } from '../data/ai.js';

const TIPS = [   // [显示, 发送的问题, 受哪个功能开关控制]
  ['简报', '给我今天的简报：先做什么、哪些要跟进', 'brief'],
  ['Top 5', '我今天应该先做哪 5 件事？', 'top5'],
  ['本周到期', '本周还有哪些到期的？', 'chat'],
  ['等谁最久', '我在等谁回复最久？该催谁？', 'chat'],
  ['材料没交齐', '哪些材料收集还没交齐？谁没交？', 'chat'],
];

const SYSTEM = `你是个人工作台里的 AI 助手，帮用户安排和跟进工作（项目推进、对外协调、行政事务）。
下面给出的是从用户工作台里检索出的相关数据（待办、项目、材料收集、联系人），每条开头有编号，如 [T12]。
回答规则（必须遵守，回答显示在一个很小的对话框里）：
1. 只依据给出的数据回答，不编造；数据里找不到就直接说「工作台里没有找到相关记录」。
2. 提到具体的待办/项目/收集/联系人时，在后面带上它的编号，如「提交周报 [T12]」，方便用户点开。
3. 总长度不超过 120 个汉字（编号不算）。
4. 需要列举时用编号列表，最多 5 条，每条不超过 25 个汉字，可以把最关键的词用 **加粗**。
5. 不要标题、不要表格、不要代码块、不要客套话。你只能查看，不能修改数据。`;

const history = [];   // [{role, content}]，本次打开期间有效

/** 把模型输出（受限的 Markdown）转成安全的 HTML：只支持加粗、编号/圆点列表、换行 */
function render(md) {
  const lines = esc(md || '').split('\n').map(l => l.trim()).filter(Boolean);
  let html = '', inList = false;
  for (const l of lines) {
    const m = l.match(/^(?:\d+[.、)]|[-*•])\s*(.*)$/);
    if (m) { if (!inList) { html += '<ol>'; inList = true; } html += `<li>${m[1]}</li>`; }
    else { if (inList) { html += '</ol>'; inList = false; } html += `<p>${l}</p>`; }
  }
  if (inList) html += '</ol>';
  return html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([TPCK]\d+)\]/g, (m, ref) => { const h = refHref(ref); return h ? `<a class="ref" href="${h}" data-ref="${ref}" title="打开">↗</a>` : ''; });
}

function contextLegacy(todos, tasks) {
  const T = Object.fromEntries(tasks.map(t => [t.id, t.title]));
  const slim = t => ({ 标题: t.title, 状态: { todo: '未开始', doing: '进行中', waiting: '等待他人', done: '已完成' }[t.status], 优先级: t.priority != null ? 'P' + t.priority : undefined,
    截止: t.due_at || undefined, 逾期: isOverdue(t) || undefined, 项目: T[t.task_id] || '零星待办', 等待开始: t.waiting_since || undefined });
  const open = todos.filter(t => t.status !== 'done');
  const doneToday = todos.filter(t => t.status === 'done' && t.completed_at && dayDiff(new Date(t.completed_at)) === 0);
  return `今天：${todayTitle()}\n未完成待办：${JSON.stringify(open.slice(0, 60).map(slim))}\n今天已完成：${JSON.stringify(doneToday.map(t => t.title))}`;
}

let indexPromise = null;   // 本次打开对话时建一次索引

export function openAiChat(data) {
  const el = openSheet('<div id="ai-box"></div>', { label: 'AI 助手', onClose: () => el.classList.remove('ai-sheet') });
  el.classList.add('ai-sheet');
  indexPromise = buildIndex().catch(() => null);
  mountAiChat(el.querySelector('#ai-box'), data);
  setTimeout(() => { const i = el.querySelector('#ai-q'); if (i && !window.matchMedia('(pointer: coarse)').matches) i.focus(); }, 250);
}

function mountAiChat(box, { todos, tasks }) {
  box.innerHTML = `<div class="ai-chat">
    <div class="sheet-head"><b>✦ AI 助手</b><span class="hint">只读你的待办，不会修改数据</span><span class="sp"></span>${history.length ? '<button class="btn small" data-clear>清空</button>' : ''}<button class="btn small" data-close>关闭</button></div>
    ${history.length ? '' : '<div class="ai-empty hint">可以直接问，也可以点下面的提示。</div>'}
    <div class="ai-msgs" id="ai-msgs">${history.map(m => `<div class="ai-msg ${m.role}">${m.role === 'user' ? esc(m.content) : render(m.content)}</div>`).join('')}</div>
    <div class="ai-tips">${TIPS.filter(t => aiOn(t[2])).map(([l, q]) => `<button class="chip ghost" data-tip="${esc(q)}">${esc(l)}</button>`).join('')}</div>
    <form class="ai-input" id="ai-form"><input id="ai-q" placeholder="问问 AI，比如：今天先做什么？" autocomplete="off" enterkeyhint="send" aria-label="问 AI"><button class="btn primary small" type="submit">发送</button></form>
  </div>`;
  const msgs = box.querySelector('#ai-msgs'), inp = box.querySelector('#ai-q'), form = box.querySelector('#ai-form');
  msgs.scrollTop = msgs.scrollHeight;
  let busy = false;

  async function ask(q) {
    if (busy || !q.trim()) return;
    busy = true; form.classList.add('busy');
    history.push({ role: 'user', content: q.trim() });
    const empty = box.querySelector('.ai-empty'); if (empty) empty.remove();
    msgs.insertAdjacentHTML('beforeend', `<div class="ai-msg user enter">${esc(q.trim())}</div><div class="ai-msg assistant enter"><span class="typing"><i></i><i></i><i></i></span></div>`);
    const out = msgs.lastElementChild;
    msgs.scrollTop = msgs.scrollHeight;
    let text = '';
    try {
      const index = await indexPromise;
      const ctx = index ? retrieve(index, q + ' ' + history.slice(-3, -1).map(m => m.content).join(' ')) : contextLegacy(todos, tasks);
      await chat([{ role: 'system', content: SYSTEM + '\n\n今天：' + todayTitle() + '\n' + ctx }, ...history.slice(-7)], d => { text += d; out.innerHTML = render(text); msgs.scrollTop = msgs.scrollHeight; }, null, null, { maxTokens: 320 });
      history.push({ role: 'assistant', content: text });
    } catch (err) {
      out.innerHTML = `<p class="hint">AI 暂时不可用：${esc(err.message)}</p>`;
      history.pop();
    }
    busy = false; form.classList.remove('busy');
  }

  form.onsubmit = e => { e.preventDefault(); const q = inp.value; inp.value = ''; ask(q); };
  box.onclick = e => {
    const t = e.target.closest('[data-tip]'); if (t) { ask(t.dataset.tip); return; }
    const r = e.target.closest('a.ref'); if (r) { e.preventDefault(); closeSheet(); location.hash = r.getAttribute('href').slice(1); return; }
    if (e.target.closest('[data-clear]')) { history.length = 0; mountAiChat(box, { todos, tasks }); return; }
    if (e.target.closest('[data-close]')) { history.length = 0; closeSheet(); }   // 关闭即清空（仅本次会话）
  };
}
