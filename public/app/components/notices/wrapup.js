// 项目收尾卡（用户确认 决定 4 + 小规则 9）：项目过了结束日、还有没做完的事 → 先不归档，在这里收尾。
// 一次只提示一个项目（结束早的先）；同样一块也放在那个项目详情的顶部（views/task-detail.js 用 wrapupHtml / bindWrapup）。
// 操作：顺延结束日（默认今天 + 7 天，不早于今天）/ 移到零星待办 / 一并完成 / 停止催办（有等待中且还在催的才显示）。
// 处理完没剩下没做完的，就归档（data/repos/tasks.js）。等待中的待办默认照常催办。

import { esc, toast, openSheet, closeSheet, confirmSheet } from '../../core/dom.js';
import { ymd, addDays, parseYmd } from '../../core/dates.js';
import { listWrapups, extendTask, moveOpenToInbox, completeOpen, stopNudging } from '../../data/repos/tasks.js';
import { saveFailed } from '../../data/db.js';

const dayWords = s => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日`; };

/** 收尾块的内容（外层 .notice 由调用方包） */
export function wrapupHtml(w, { link = true } = {}) {
  const { task, open, nudging } = w, n = open.length;
  const name = link ? `<a href="#/tasks/${task.id}">「${esc(task.title)}」</a>` : `「${esc(task.title)}」`;
  return `<div class="notice-t">${name}已过结束日（${dayWords(task.end_date)}），还有 <span class="num">${n}</span> 件没做完</div>
    <ul class="notice-list">${open.slice(0, 3).map(t => `<li>${esc(t.title)}${t.status === 'waiting' ? '<span class="chip wait">等待中</span>' : ''}</li>`).join('')}${n > 3 ? `<li class="hint">还有 ${n - 3} 件</li>` : ''}</ul>
    <div class="notice-d">先收个尾：都处理完了再归档。${nudging ? `等待中的 ${nudging} 件还在照常催办。` : ''}</div>
    <div class="notice-acts">
      <button class="btn small primary" data-wrap="extend">顺延结束日</button>
      <button class="btn small" data-wrap="inbox">移到零星待办</button>
      <button class="btn small" data-wrap="done">一并完成</button>
      ${nudging ? '<button class="btn small" data-wrap="stop">停止催办</button>' : ''}
    </div>`;
}

/** 绑定收尾块的按钮。after() 处理完之后调用（重新挑一张卡 / 重画项目详情） */
export function bindWrapup(el, w, after = () => {}) {
  const { task, open } = w;
  let busy = false;
  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-wrap]'); if (!b || busy) return;
    busy = true;
    try {
      switch (b.dataset.wrap) {
        case 'extend': if (await extendSheet(task)) after(); break;
        case 'inbox': {
          const r = await moveOpenToInbox(task.id);
          toast(`已把 ${r.moved} 件移到零星待办${r.archived ? '，项目已归档' : ''}`);
          after(); break;
        }
        case 'done': {
          if (!(await confirmSheet(`把「${task.title}」剩下的 ${open.length} 件都标为完成？`, '一并完成'))) break;
          const r = await completeOpen(task.id);
          toast(`已完成 ${r.done} 件${r.archived ? '，项目已归档' : ''}`);
          after(); break;
        }
        case 'stop': {
          const n = await stopNudging(task.id);
          toast(`已停止催办 ${n} 件（仍在等待，需要时在详情里点「已催」重新开始）`);
          after(); break;
        }
      }
    } catch (x) { saveFailed(x); }
    finally { busy = false; }
  });
}

/** 顺延结束日：选一个新日期（默认今天 + 7 天，不早于今天）。保存了返回 true */
function extendSheet(task) {
  const today = ymd(new Date()), def = ymd(addDays(new Date(), 7));
  return new Promise(resolve => {
    let ok = false;
    const el = openSheet(`<div class="sheet-head"><b>顺延结束日</b><span class="sp"></span>
        <button class="btn small" data-x="cancel">取消</button><button class="btn small primary" data-x="ok">保存</button></div>
      <div class="form">
        <div class="hint">「${esc(task.title)}」原定 ${dayWords(task.end_date)} 结束。顺延后项目照常进行，到新的结束日再看要不要收尾。</div>
        <label>新的结束日期<input id="wu-end" type="date" value="${def}" min="${today}"></label>
      </div>`, { label: '顺延结束日', onClose: () => resolve(ok) });
    el.onclick = async e => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'cancel') { closeSheet(); return; }
      const end = el.querySelector('#wu-end').value;
      if (!end || end < today) { toast('结束日期不能早于今天'); return; }
      b.disabled = true;
      try { await extendTask(task.id, end); ok = true; closeSheet(); toast(`已顺延到 ${dayWords(end)}`); }
      catch (x) { saveFailed(x); b.disabled = false; }
    };
  });
}

/** 首页提示卡：结束最早的那个待收尾项目 */
export async function notice() {
  const list = await listWrapups();
  if (!list.length) return null;
  const w = list[0];
  return { html: wrapupHtml(w), bind: (el, refresh) => bindWrapup(el, w, refresh) };
}
