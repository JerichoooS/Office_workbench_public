/* boot.js — 启动面板、全局错误兜底、云客户端初始化（经典脚本，先于应用模块加载）
 * 本地调试：地址是 127.0.0.1 / localhost 时自动加载 /app/data/mock.js，模拟已登录 + 浏览器本地数据。
 *          ?mock=0 关闭（会记住），?mock=1 恢复。线上域名永远不会进入模拟分支。
 */
'use strict';

(function () {
  var WBBoot = window.WBBoot = {};
  var settled = false, failed = false, watchdog, initialization;

  var messages = {
    WB_SDK_UNAVAILABLE: '云服务组件未能加载，请重试。',
    WB_CONFIG_MISSING: '应用配置不完整，请联系维护人员。',
    WB_AUTH_TIMEOUT: '登录状态检查超时，请检查网络后重试。',
    WB_AUTH_UNAVAILABLE: '暂时无法检查登录状态，请稍后重试。',
    WB_STARTUP_TIMEOUT: '页面启动超时，请重试。',
    WB_SCRIPT_LOAD: '页面组件加载失败，请重试。',
    WB_SCRIPT_ERROR: '页面脚本运行异常，请联系维护人员。',
    WB_STARTUP_FAILED: '页面启动失败，请重试。',
    WB_OPERATION_FAILED: '操作未完成，请重试。'
  };

  function issue(code) { var e = new Error(messages[code] || messages.WB_STARTUP_FAILED); e.code = code; return e; }
  WBBoot.issue = issue;

  WBBoot.withTimeout = function (promise, ms, code) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(issue(code)); }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  };

  /** 启动完成：隐藏面板 */
  WBBoot.settle = function () {
    if (failed) return;
    settled = true;
    clearTimeout(watchdog);
    var p = document.getElementById('boot-status');
    if (p) p.hidden = true;
  };

  /** 启动前失败 → 面板显示错误；启动后失败 → 只弹提示，不清空页面 */
  WBBoot.fail = function (error) {
    var code = error && messages[error.code] ? error.code : (settled ? 'WB_OPERATION_FAILED' : 'WB_STARTUP_FAILED');
    if (settled) {
      if (window.WBToast) window.WBToast(messages[code]);
      console.error('[workbench]', code, error && error.message);
      return;
    }
    failed = true;
    clearTimeout(watchdog);
    var p = document.getElementById('boot-status');
    if (!p) return;
    p.hidden = false;
    p.setAttribute('role', 'alert');
    document.getElementById('boot-title').textContent = '工作台暂时无法打开';
    document.getElementById('boot-message').textContent = messages[code] + ' 错误代码：' + code;
    var root = document.getElementById('root');
    if (root) root.hidden = true;
  };

  document.addEventListener('DOMContentLoaded', function () {
    var retry = document.getElementById('boot-retry');
    if (retry) retry.addEventListener('click', function () {
      var url = new URL(location.href);
      ['code', 'state', 'provider', 'error', 'error_description'].forEach(function (k) { url.searchParams.delete(k); });
      location.replace(url.pathname + url.search + url.hash);
    });
  });

  window.addEventListener('error', function (event) {
    if (event.target && event.target.tagName === 'SCRIPT') {
      // 本机调试时 config.js 可以不存在（模拟模式用不到云配置；公开仓库不带 config.js）
      if (WBBoot.isLocal && /\/config\.js/.test(event.target.src || '')) return;
      WBBoot.fail(issue('WB_SCRIPT_LOAD'));
    }
    else if (event.error || event.message) WBBoot.fail(issue('WB_SCRIPT_ERROR'));
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    event.preventDefault();
    WBBoot.fail(event.reason);
  });
  watchdog = setTimeout(function () { WBBoot.fail(issue('WB_STARTUP_TIMEOUT')); }, 15000);

  // ---------- 本地模拟模式 ----------
  WBBoot.isLocal = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  function useMock() {
    if (!WBBoot.isLocal) return false;
    try {
      var flag = new URL(location.href).searchParams.get('mock');
      if (flag === '0' || flag === '1') localStorage.setItem('wb-mock-off', flag === '0' ? '1' : '');
      return localStorage.getItem('wb-mock-off') !== '1';
    } catch (_) { return true; }
  }
  function loadMock() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/app/data/mock.js?v=2.0.0';
      s.onload = function () {
        var b = document.createElement('div');
        b.className = 'mock-badge';
        b.textContent = '本地模拟模式';
        document.body.appendChild(b);
        resolve(window.WBMock.client);
      };
      s.onerror = function () { reject(issue('WB_SCRIPT_LOAD')); };
      document.head.appendChild(s);
    });
  }

  /** 返回云客户端（真实 SDK 或本地模拟），全局只初始化一次 */
  WBBoot.initCloud = function () {
    if (initialization) return initialization;
    WBBoot.mock = useMock();
    initialization = (WBBoot.mock ? loadMock() : Promise.resolve(null)).then(function (mock) {
      if (mock) return (window.cloud = mock);
      if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') throw issue('WB_SDK_UNAVAILABLE');
      var c = window.WB_PUBLIC_CONFIG;
      if (!c || !c.endpoint || !c.publishableKey || !c.oauthRelayBaseUrl) throw issue('WB_CONFIG_MISSING');
      window.cloud = window.WorkBuddyCloud.createWorkBuddyCloud({ endpoint: c.endpoint, publishableKey: c.publishableKey, oauthRelayBaseUrl: c.oauthRelayBaseUrl });
      return window.cloud;
    });
    return initialization;
  };
})();
