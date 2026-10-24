// appearance.js — 外观（只影响当前设备）：深浅色、配色、现场模式、字号
// 存 localStorage：
//   wb-theme-mode   '' 跟随系统 / light / dark（沿用旧键，老用户的选择不丢）
//   wb-appearance   { skin: 'linen'|'paper'|'venue', font: ''|'large', field: true|false }
// 现场模式 = 现场配色 + 大字号，开着时忽略单独选的配色和字号。
// index.html 里有一段同样规则的内联脚本，在页面绘制前套用（避免启动闪白）；改规则时两边一起改。

const MODE_KEY = 'wb-theme-mode';
const KEY = 'wb-appearance';
const DEFAULTS = { skin: 'linen', font: '', field: false };

// 配色登记表。sw = 预览色块 [底色, 卡片, 文字, 主色]（浅色 / 深色），取自 styles/tokens.css，只用于设置页的小样
export const SKINS = [
  { v: 'linen', label: '亚麻', desc: '默认 · 暖灰底、鼠尾草绿', light: ['#f1efeb', '#fbfaf8', '#2a2723', '#345a54'], dark: ['#191714', '#22201d', '#ece7df', '#95c2ba'] },
  { v: 'paper', label: '宣纸', desc: '象牙纸面、松烟墨，几乎无彩', light: ['#f4f0e8', '#fdfcf7', '#25231c', '#3c3833'], dark: ['#171412', '#201e1b', '#efe8e1', '#d4cec2'] },
  { v: 'venue', label: '现场', desc: '高对比，强光下也看得清', light: ['#f4f2ef', '#ffffff', '#13110f', '#014843'], dark: ['#000000', '#141414', '#f8f7f4', '#8cd0c8'] },
];

export function themeMode() { try { return localStorage.getItem(MODE_KEY) || ''; } catch (_) { return ''; } }

export function getAppearance() {
  let a = {};
  try { a = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { /* 无痕模式或数据损坏 */ }
  if (!SKINS.some(s => s.v === a.skin)) a.skin = 'linen';
  return { ...DEFAULTS, ...a, mode: themeMode() };
}

/** 套用外观；patch 可含 mode / skin / font / field，传入的项会保存 */
export function applyAppearance(patch = {}) {
  const { mode, ...rest } = patch;
  try {
    if (mode !== undefined) localStorage.setItem(MODE_KEY, mode);
    if (Object.keys(rest).length) { const { mode: _, ...cur } = getAppearance(); localStorage.setItem(KEY, JSON.stringify({ ...cur, ...rest })); }
  } catch (_) { /* 存不了就只对本次生效 */ }
  const a = { ...getAppearance(), ...rest, ...(mode !== undefined ? { mode } : {}) };
  const d = document.documentElement;
  const skin = a.field ? 'venue' : a.skin, font = a.field ? 'large' : a.font;
  if (skin && skin !== 'linen') d.setAttribute('data-skin', skin); else d.removeAttribute('data-skin');
  if (font) d.setAttribute('data-font', font); else d.removeAttribute('data-font');
  if (a.mode) d.setAttribute('data-theme', a.mode); else d.removeAttribute('data-theme');
  syncThemeColor();
  return a;
}

/** 让浏览器/主屏幕 App 的状态栏颜色等于页面底色（iOS 不认 theme-color 的 media 写法，所以用脚本按实际主题设置） */
export function syncThemeColor() {
  const meta = document.getElementById('theme-color');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f1efeb');
}
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor); } catch (_) { /* 旧浏览器 */ }
