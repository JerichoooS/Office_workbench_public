/**
 * webpush.js — 零依赖 Web Push（只用 Node 内置 crypto / https）
 *   - VAPID 身份（RFC 8292）：ES256 JWT
 *   - 负载加密（RFC 8291 + RFC 8188 aes128gcm）
 * iPhone（iOS 16.4+，添加到主屏幕的网页）走 web.push.apple.com，同样适用。
 */
'use strict';

const crypto = require('crypto');
const https = require('https');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** 生成一对 VAPID 密钥（base64url：公钥 65 字节未压缩点，私钥 32 字节） */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function vapidPrivateKeyObject(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(unb64u(privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** VAPID Authorization 头 */
function vapidHeader(endpoint, vapid, subject, ttlSec = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(header + '.' + payload), { key: vapidPrivateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapid.publicKey}`;
}

function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

/** RFC 8291 加密：返回可直接作为请求体的 aes128gcm 数据 */
function encrypt(subscription, plaintext) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * 发送一条推送。
 * @returns {Promise<{status:number, gone:boolean}>} gone=true 表示订阅已失效（404/410），应删除
 */
function sendPush(subscription, payload, { vapid, subject, ttl = 24 * 3600, urgency = 'normal', topic } = {}) {
  const body = encrypt(subscription, typeof payload === 'string' ? payload : JSON.stringify(payload));
  const url = new URL(subscription.endpoint);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'Content-Length': body.length,
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidHeader(subscription.endpoint, vapid, subject),
  };
  if (topic) headers.Topic = topic;
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST', headers, timeout: 15000 }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
    });
    req.on('timeout', () => req.destroy(new Error('push timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { generateVapidKeys, vapidHeader, encrypt, sendPush, b64u, unb64u };
