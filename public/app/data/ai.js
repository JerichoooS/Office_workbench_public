// ai.js — AI 增强层（可选）。关闭 AI 或没填 Key 时，所有函数安静地返回空结果，界面照常可用。
// 调用链（沿用 v1）：同源代理 /api/deepseek/chat → DeepSeek 直连 → cloud.llm 免 Key 兜底
// 发给模型的每段文字都先把电话号码打码（maskPhones）：手机 13800138000 → 138****8000，座机 010-12345678 → 010-****5678。

import { cachedSettings } from './repos/settings.js';
import { toast } from '../core/dom.js';

let fallbackNoticed = false;

// ---------- 电话打码 ----------
const MOBILE = /(?<![\d+])((?:\+?86[- ]?)?1[3-9]\d)[- ]?\d{4}[- ]?(\d{4})(?!\d)/g;
const LANDLINE = /(?<![\d-])(0\d{2,3})(-?)\d{3,4}(\d{4})(?![\d-])/g;
/** 把文字里的手机号、座机号中间几位换成 ****（发给模型前用） */
export function maskPhones(text) {
  if (typeof text !== 'string') return text;
  return text.replace(MOBILE, (m, head, tail) => `${head}****${tail}`).replace(LANDLINE, (m, area, dash, tail) => `${area}${dash}****${tail}`);
}
/** 模型回来的文字里带着打过码的号码（如时间识别返回的标题）：换回原文里的号码，免得存进待办的是 138****8000 */
export function unmaskPhones(out, original) {
  if (typeof out !== 'string' || typeof original !== 'string') return out;
  const pairs = [];
  original.replace(MOBILE, m => { pairs.push([maskPhones(m), m]); return m; });
  original.replace(LANDLINE, m => { pairs.push([maskPhones(m), m]); return m; });
  return pairs.reduce((s, [masked, real]) => s.split(masked).join(real), out);
}   // 退回平台模型时只提示一次

/** AI 是否可用。feature 可选：'parse' 时间识别 / 'tags' 标签推荐 / 'brief' 简报 / 'top5' Top 5 */
export const aiOn = feature => {
  const s = cachedSettings();
  if (!(s && s.ai_enabled && s.llm_api_key)) return false;
  if (!feature) return true;
  const f = s.ai_features || {};
  return f[feature] !== false;
};
export const AI_FEATURES = [
  { k: 'parse', label: '时间识别增强', desc: '「下班前」「月底」这类说法，本地规则认不全时请 AI 补充' },
  { k: 'tags', label: '标签推荐', desc: '记一条、待办详情里，补充 AI 建议的标签' },
  { k: 'chat', label: 'AI 对话', desc: '首页标题行的 ✦：问 AI 关于你待办的问题（只读，不改数据）' },
  { k: 'brief', label: '「简报」提示', desc: 'AI 对话里的「简报」快捷提问：今天先做什么、要跟进什么' },
  { k: 'top5', label: '「Top 5」提示', desc: 'AI 对话里的「Top 5」快捷提问：建议先做的五件事' },
];

async function consumeSSE(res, onDelta) {
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '';
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { const j = JSON.parse(payload); const d = j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message); if (d && d.content) { text += d.content; if (onDelta) onDelta(d.content); } } catch (_) { /* 半包 */ }
    }
  }
  if (!text) throw new Error('模型未返回内容');
  return text;
}

const HTTP_MSG = { 400: '请求格式有误', 401: 'Key 无效', 402: '账户余额不足', 403: '没有权限（Key 无效或被限制）', 404: '接口地址或模型不对', 429: '请求太频繁，请稍后再试', 500: 'DeepSeek 服务异常', 503: 'DeepSeek 服务繁忙' };
function httpError(status) { const e = new Error(HTTP_MSG[status] || `调用失败（${status}）`); e.status = status; return e; }

async function viaProxy(s, messages, onDelta, signal, extra = {}) {
  const res = await fetch('/api/deepseek/chat', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-ds-key': s.llm_api_key }, body: JSON.stringify({ model: s.llm_model, messages, stream: true, ...extra }) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (/origin not allowed|too many requests|missing key/.test(body)) { const e = new Error('本站代理暂不可用'); e.proxy = true; throw e; }   // 代理自己的拒绝，换直连
    throw httpError(res.status);
  }
  return consumeSSE(res, onDelta);
}
async function viaDirect(s, messages, onDelta, signal, extra = {}) {
  const base = (s.llm_base_url || 'https://api.deepseek.com').replace(/\/+$/, '');
  let res;
  try { res = await fetch(base + '/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.llm_api_key }, body: JSON.stringify({ model: s.llm_model, messages, stream: true, ...extra }) }); }
  catch (err) { if (signal && signal.aborted) throw err; throw new Error('连不上 DeepSeek（网络或浏览器拦截）'); }
  if (!res.ok) throw httpError(res.status);
  return consumeSSE(res, onDelta);
}
async function viaKeyless(messages, onDelta, signal) {
  const models = await cloud.llm.models.list();
  const model = models.find(m => m.disabled !== true);
  if (!model) throw new Error('无可用模型');
  let text = '';
  for await (const chunk of cloud.llm.chat.completions.create({ model: model.id, messages, stream: true, signal })) {
    const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (d && d.content) { text += d.content; if (onDelta) onDelta(d.content); }
  }
  return text;
}

/** 流式对话。onDelta 逐段回调，返回全文。override 可临时指定 Key/模型/地址（设置页「测试连接」测还没保存的 Key） */
export async function chat(messages, onDelta, signal, override = null, { maxTokens } = {}) {
  const s = override ? { ...cachedSettings(), ...override } : cachedSettings();
  if (!s || !s.llm_api_key) throw new Error('尚未配置 API Key，请到「设置」填写');
  messages = messages.map(m => ({ ...m, content: maskPhones(m.content) }));   // 电话一律打码再发
  let last;
  // 测试指定 Key 时不走免 Key 兜底，否则 Key 错了也会显示「成功」
  const extra = maxTokens ? { max_tokens: maxTokens } : {};
  const chain = [() => viaProxy(s, messages, onDelta, signal, extra), () => viaDirect(s, messages, onDelta, signal, extra)];
  if (!override) chain.push(async () => {
    const out = await viaKeyless(messages, onDelta, signal);
    if (!fallbackNoticed) { fallbackNoticed = true; toast('DeepSeek 暂时连不上，这次用了平台自带模型回答'); }
    return out;
  });
  for (const fn of chain) {
    try { return await fn(); } catch (e) {
      if (signal && signal.aborted) throw e;
      last = e;
      if (!e.proxy && e.status && [401, 402].includes(e.status)) break;   // DeepSeek 明确说 Key/余额问题，换通道也没用
    }
  }
  throw last;
}

/** 标签推荐（「自动补全」式）：返回最多 3 个短标签 */
export async function aiSuggestTags(text, exclude = []) {
  if (!aiOn('tags')) return [];
  const out = await chat([
    { role: 'system', content: '你给工作待办打标签。只输出 1~3 个中文短标签（每个 2~4 字），用英文逗号分隔，不要解释。领域：项目推进、对外协调、行政事务。' },
    { role: 'user', content: text },
  ]);
  return out.split(/[,，、\s#]+/).map(x => x.trim()).filter(x => x && x.length <= 6 && !exclude.includes(x)).slice(0, 3);
}

/** 今日简报：基于待办 JSON，2~3 句话 */
export function brief(payload, onDelta, signal) {
  return chat([
    { role: 'system', content: '你是工作助理。根据待办数据用 2~3 句中文给出今天的重点：先做什么、哪些逾期或等待太久需要跟进。只用数据里的事实，不要客套。' },
    { role: 'user', content: JSON.stringify(payload) },
  ], onDelta, signal);
}

/** Top 5 建议行动 */
export function top5(payload, onDelta, signal) {
  return chat([
    { role: 'system', content: '基于待办清单给出排序后的 Top 5 行动建议（Markdown 有序列表），每条一句理由。规则：逾期 > P0/P1 > 今天截止 > 等待过久 > 其他。不虚构清单外的事项。' },
    { role: 'user', content: JSON.stringify(payload) },
  ], onDelta, signal);
}

/**
 * AI 增强的快速记录解析。返回与 core/parse.js 相同形状的结果；失败或超时返回 null（调用方保留规则解析结果）。
 * 只在规则解析「不确定」时调用（见 capture.js），避免每次输入都消耗额度。
 */
export async function aiParse(text, now = new Date(), timeoutMs = 6000) {
  if (!aiOn('parse')) return null;
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} 周${'日一二三四五六'[now.getDay()]}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const out = await chat([
      { role: 'system', content: `把用户的一句话解析成待办。现在是 ${stamp}（北京时间）。只输出一行 JSON，不要解释：
{"title":"去掉时间词后的待办标题","date":"YYYY-MM-DD 或 null","time":"HH:MM 或 null","remind":true/false,"waiting":true/false}
规则：没说日期但说了时刻 → 今天（若已过则明天）；「下班前」=17:30，「中午」=12:00，「上午」默认10:00，「下午」默认15:00，「晚上」默认20:00；「催/等某人回复」→ waiting=true；说了「提醒」或有具体时刻 → remind=true。` },
      { role: 'user', content: text },
    ], null, ctl.signal);
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    if (!j || typeof j.title !== 'string') return null;
    let due = null, allDay = true;
    if (j.date && /^\d{4}-\d{2}-\d{2}$/.test(j.date)) {
      const [y, m, d] = j.date.split('-').map(Number);
      due = new Date(y, m - 1, d, 23, 59);
      if (j.time && /^\d{2}:\d{2}$/.test(j.time)) { const [h, mi] = j.time.split(':').map(Number); due.setHours(h, mi, 0, 0); allDay = false; }
    }
    if (due && isNaN(due)) return null;
    const label = due ? `${due.getMonth() + 1}/${due.getDate()} 周${'日一二三四五六'[due.getDay()]}${allDay ? '' : ' ' + pad(due.getHours()) + ':' + pad(due.getMinutes())}` : '';
    return { title: unmaskPhones(j.title.trim(), text) || text, due, allDay, remind: !!j.remind || !allDay, waiting: !!j.waiting, label, ai: true };
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}
