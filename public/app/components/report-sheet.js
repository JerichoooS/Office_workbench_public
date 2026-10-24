// report-sheet.js — 周报草稿弹层：本周 / 上周切换，可直接改，一键复制
// 入口：概览「写周报」、标题含「周报」的待办详情。

import { openSheet, closeSheet, toast, copyText, icon } from '../core/dom.js';
import { weeklyReport } from '../data/report.js';

export function openReport(offset = 0) {
  const el = openSheet(`<div class="sheet-head"><b>周报草稿</b><span class="sp"></span>
      <div class="seg" role="group" aria-label="哪一周"><button data-w="0" aria-pressed="${offset === 0}">本周</button><button data-w="-1" aria-pressed="${offset === -1}">上周</button></div>
      <button class="btn small" data-x="close">关闭</button></div>
    <p class="hint">按待办和进展自动整理，只是草稿，可以直接在下面改。</p>
    <textarea class="report-text" id="rp-text" aria-label="周报内容" readonly>正在整理…</textarea>
    <div class="sheet-actions"><button class="btn primary" data-x="copy">${icon('copy')}复制全文</button></div>`, { label: '周报草稿' });
  const ta = el.querySelector('#rp-text');
  const load = async w => {
    ta.readOnly = true; ta.value = '正在整理…';
    try { const r = await weeklyReport(w); ta.value = r.text; ta.readOnly = false; }
    catch (e) { ta.value = '没能整理出周报：' + (e.message || '请稍后重试'); }
  };
  load(offset);
  el.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.w !== undefined) { el.querySelectorAll('[data-w]').forEach(x => x.setAttribute('aria-pressed', x === b)); load(+b.dataset.w); return; }
    if (b.dataset.x === 'close') closeSheet();
    if (b.dataset.x === 'copy') toast(await copyText(ta.value) ? '已复制，可以粘贴到微信或文档里' : '复制失败，请长按文字手动复制');
  };
}
