/**
 * 个人云端工作台 — 零依赖 Node 单端口服务
 * 功能：public/ 静态托管 + /api/deepseek/chat SSE 代理（消除浏览器直连 DeepSeek 的 CORS 不确定性）
 *       + /api/push/*（状态、口令交接、推送公钥、测试推送）+ 每分钟推送调度（server/scheduler.js）
 * 部署：监听 PORT 环境变量，绑定 0.0.0.0（WorkBuddy Sites 托管要求）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STARTED_AT = new Date().toISOString();   // 本次启动时间：设置页据此区分「刚启动还没跑第一轮」和「调度停了」
const { sendPush } = require('./server/webpush');
const keys = require('./server/keys');
const scheduler = require('./server/scheduler');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// ---------- 简易频率限制（代理接口防滥用） ----------
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const rateBuckets = new Map(); // ip -> { count, windowStart }
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.windowStart > RATE_WINDOW_MS) {
    b = { count: 0, windowStart: now };
    rateBuckets.set(ip, b);
  }
  b.count += 1;
  // 顺手清理过期桶，防内存膨胀
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now - v.windowStart > RATE_WINDOW_MS) rateBuckets.delete(k);
  }
  return b.count > RATE_MAX;
}

// ---------- DeepSeek SSE 代理 ----------
// 前端 POST /api/deepseek/chat  { model, messages, stream: true }
// 头 x-ds-key = 用户自己的 DeepSeek key（必须自带，代理不做无 key 转发）
// 服务端仅做管道：转发请求 + SSE 透传，不解析、不落盘、不记日志。
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyDeepseek(req, res) {
  const key = req.headers['x-ds-key'];
  const origin = req.headers.origin || '';
  const referer = req.headers.referer || '';
  if (!key) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'missing key' } })); return; }
  // 只允许本站页面调用：与当前请求同源，或任意层级的 *.workbuddy.host，或本机调试
  const sameOrigin = (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
  if (origin && origin !== 'null' && !sameOrigin && !/^https:\/\/([a-z0-9-]+\.)*workbuddy\.host$/i.test(origin)
      && !/^https?:\/\/localhost(:\d+)?$/i.test(origin) && !/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'origin not allowed' } })); return;
  }
  if (rateLimited(req.socket.remoteAddress || 'unknown')) {
    res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'too many requests' } })); return;
  }

  let body;
  try { body = await readBody(req, 2 * 1024 * 1024); } catch { res.writeHead(413); res.end(); return; }

  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid json' } })); return; }
  if (!parsed || parsed.stream !== true) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'stream:true required' } })); return;
  }

  const upstreamReq = https.request({
    hostname: 'api.deepseek.com',
    path: '/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key,
      'Accept': 'text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, {
      'Content-Type': upstreamRes.headers['content-type'] || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream unavailable' } }));
  });
  upstreamReq.write(body);
  upstreamReq.end();
}

// ---------- 推送 ----------
// 只允许发往各浏览器的官方推送服务，防止被当作跳板访问任意地址
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/i;
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

async function handlePush(req, res, pathname) {
  // push：on / locked / waiting / off（见 keys.js）；其余是调度心跳（scheduler.js heartbeat），设置页显示「提醒服务正常 · 1 分钟前」。
  // 只有状态和时间：不含口令、错误内容、用户数据
  if (pathname === '/api/push/status' && req.method === 'GET') return json(res, 200, { push: await keys.status(), ...scheduler.heartbeat(), startedAt: STARTED_AT });
  if (pathname === '/api/push/unlock' && req.method === 'POST') {
    if (rateLimited('unlock:' + (req.socket.remoteAddress || ''))) return json(res, 429, { error: { message: 'too many requests' } });
    let t;
    try { t = JSON.parse((await readBody(req, 1024)).toString('utf8')).token; } catch { return json(res, 400, { error: { message: 'invalid json' } }); }
    return (await keys.unlock(t)) ? json(res, 200, { push: 'on' }) : json(res, 403, { error: { message: 'rejected' } });
  }
  const vapid = await keys.getVapid();
  if (!vapid) return json(res, 503, { error: { message: '推送尚未在服务器启用' } });
  if (pathname === '/api/push/key' && req.method === 'GET') return json(res, 200, { publicKey: vapid.publicKey });
  if (pathname === '/api/push/test' && req.method === 'POST') {
    if (rateLimited('push:' + (req.socket.remoteAddress || ''))) return json(res, 429, { error: { message: 'too many requests' } });
    let sub;
    try { sub = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8')).subscription; } catch { return json(res, 400, { error: { message: 'invalid json' } }); }
    let host = '';
    try { host = new URL(sub.endpoint).hostname; } catch { /* 下方统一拒绝 */ }
    if (!sub || !sub.keys || !sub.keys.p256dh || !sub.keys.auth || !PUSH_HOSTS.test(host)) return json(res, 400, { error: { message: 'invalid subscription' } });
    try {
      const r = await sendPush(sub, { title: '工作台', body: '通知已开启，以后到点会这样提醒你。', url: '/#/settings', tag: 'test' }, { vapid, subject: keys.SUBJECT, ttl: 600 });
      return json(res, r.status < 300 ? 200 : 502, { status: r.status, gone: r.gone });
    } catch (e) { return json(res, 502, { error: { message: 'push service unreachable' } }); }
  }
  return json(res, 404, { error: { message: 'not found' } });
}

// ---------- 版本指纹（前端据此提示「有新版本」） ----------
const crypto = require('crypto');
function computeVersion(dir) {
  const h = crypto.createHash('sha1');
  (function walk(d) {
    for (const name of fs.readdirSync(d).sort()) {
      const f = path.join(d, name), st = fs.statSync(f);
      if (st.isDirectory()) walk(f); else h.update(path.relative(dir, f) + ':' + st.size + ':' + st.mtimeMs + ';');
    }
  })(dir);
  return h.digest('hex').slice(0, 12);
}
const VERSION = computeVersion(PUBLIC_DIR);

// ---------- 静态托管 ----------
function serveStatic(req, res, pathname) {
  // 坏的百分号编码（如 /%E0%A4%A）会让 decodeURIComponent 抛错、含 \0 的路径会让 fs.stat 同步抛错——都会让整个进程退出（网站和推送一起停），所以先挡成 400
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (_) { res.writeHead(400); res.end(); return; }
  if (rel.includes('\0')) { res.writeHead(400); res.end(); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // 带上分隔符比较：只比前缀的话 public 旁边叫 public2/ 之类的目录也会被放行
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (_) { res.writeHead(400); res.end(); return; }   // 解析不了的地址：400，不能让进程崩
  if (req.method === 'POST' && u.pathname === '/api/deepseek/chat') {
    proxyDeepseek(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
    return;
  }
  if (u.pathname === '/api/version') { json(res, 200, { version: VERSION }); return; }
  if (u.pathname.startsWith('/api/push/')) {
    handlePush(req, res, u.pathname).catch(() => { if (!res.headersSent) json(res, 500, { error: { message: 'error' } }); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  serveStatic(req, res, u.pathname);
});

server.listen(PORT, HOST, () => {
  console.log('workbench listening on ' + HOST + ':' + server.address().port);   // 取实际端口（PORT=0 时由系统分配，自检用）
  // 推送调度：服务器口令就绪且数据库已执行 002_push.sql 后才会真正发送（见 server/keys.js）
  // 本机调试（HOST 是回环地址）默认不跑：口令文件是线上的，本机调度会抢先认领线上提醒，手机就收不到了
  if (keys.PUSH_ON) scheduler.start(keys.getContext, { subject: keys.SUBJECT, log: (...a) => console.log('[push]', ...a) });
  else console.log('[push] 本机调试：推送调度已关闭，不会认领线上提醒（确需在本机测推送：WB_PUSH=1 node server.js）');
});
