// sync.js — 同步状态小圆点：首页日期旁、电脑侧边栏底部
// 绿 = 已同步；橙 = 网络不稳定（页面保留当前内容，恢复后自动同步，点一下立即重试）；红 = 有改动没保存成功
// 第二阶段：没信号时记下、还没存到云端的（data/outbox.js）显示「N 条待同步」（橙色），点开能看到是哪几条。
// 状态来自 data/db.js（每次读写云端后更新）。

import { esc, openSheet, closeSheet, toast } from '../core/dom.js';
import { syncState, onSync, changed } from '../data/db.js';
import { pending, onOutbox, flushOutbox, removeOutbox, putBack } from '../data/outbox.js';
import { hm, ago } from '../core/dates.js';

const TEXT = { ok: '已同步', offline: '网络不稳定 · 点此重试', error: '有改动没保存成功' };
function title(s, n = pending().length) {
  if (n) return s.state === 'offline' ? `网络不稳定 · ${n} 条待同步` : `${n} 条待同步`;
  return s.state === 'ok' ? (s.at ? `已同步 ${hm(s.at)}` : '已同步') : TEXT[s.state];
}

/** wide = 显示文字（侧边栏）；否则只在异常（或有待同步的）时显示文字 */
export function syncDot({ wide = false } = {}) {
  const s = syncState(), n = pending().length, t = title(s, n);
  return `<button type="button" class="sync ${wide ? 'wide' : ''}" data-sync="${s.state}" ${n ? 'data-pending' : ''} title="${esc(t)}" aria-label="${esc(t)}"><i></i><span class="sync-t">${esc(wide || s.state !== 'ok' || n ? t : '')}</span></button>`;
}

function paint() {
  const s = syncState(), n = pending().length, t = title(s, n);
  document.querySelectorAll('.sync').forEach(el => {
    el.dataset.sync = s.state;
    el.toggleAttribute('data-pending', !!n);
    el.title = t; el.setAttribute('aria-label', t);
    el.querySelector('.sync-t').textContent = el.classList.contains('wide') || s.state !== 'ok' || n ? t : '';
  });
}
onSync(paint);
onOutbox(() => { paint(); if (document.querySelector('#sheet.open .outbox-sheet')) openOutbox(); });

document.addEventListener('click', e => {
  if (!e.target.closest('.sync')) return;
  if (pending().length) { openOutbox(); return; }
  if (syncState().state !== 'ok') changed('retry');
});

/** 待同步的列表：没信号时记下的，存在这台设备上 */
function openOutbox() {
  const list = pending();
  if (!list.length) { closeSheet(); return; }
  const el = openSheet(`<div class="outbox-sheet"><div class="sheet-head"><b>待同步 · <span class="num">${list.length}</span> 条</b><span class="sp"></span><button class="btn small" data-x="close">关闭</button></div>
    <p class="hint">没信号时记下的，先存在这台设备上；联网后会自动保存到云端，不会重复。</p>
    <div class="list">${list.map(x => `<div class="item plain"><div style="min-width:0"><div class="t-title clamp">${esc(x.title)}</div>
      <div class="t-meta"><span>${esc(ago(x.at))} 记下</span>${x.failed ? `<span class="t-bad">没存上：${esc(x.failed)}</span>` : ''}</div></div>
      <button class="btn small row-act" data-del="${esc(x.client_id)}">删除</button></div>`).join('')}</div>
    <div class="sheet-actions"><button class="btn primary" data-x="retry">现在保存</button></div></div>`, { label: '待同步' });
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.x === 'close') { closeSheet(); return; }
    if (b.dataset.del) {
      const item = pending().find(x => x.client_id === b.dataset.del);
      if (!item) return;
      removeOutbox(item.client_id);
      toast('已删除这条没保存的记录', { action: { label: '撤销', onClick: () => putBack(item) } });
      return;
    }
    if (b.dataset.x === 'retry') {
      b.disabled = true; b.textContent = '保存中…';
      const n = await flushOutbox({ force: true });
      if (!pending().length) closeSheet();
      else { if (!n && !pending().some(x => x.failed)) toast('还是连不上云端，网络恢复后会自动保存'); openOutbox(); }
    }
  };
}
