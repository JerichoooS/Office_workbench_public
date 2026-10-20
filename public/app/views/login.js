// login.js — 未登录时的登录卡片

import { esc } from '../core/dom.js';
import { signInWechat } from '../core/auth.js';

export function renderLogin(root, error) {
  root.innerHTML = `<div class="login"><div class="login-card">
    <h1><span class="brand-mark"></span>工作台</h1>
    <p class="sub">待办、项目、提醒，电脑和手机同步。</p>
    <button class="btn primary block" id="btn-login">微信扫码登录</button>
    <p class="login-err" id="login-err" role="alert">${esc(error || '')}</p>
  </div></div>`;
  const btn = root.querySelector('#btn-login');
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = '正在打开微信登录…';
    const err = await signInWechat();
    if (err) { root.querySelector('#login-err').textContent = err; btn.disabled = false; btn.textContent = '微信扫码登录'; }
  };
}
