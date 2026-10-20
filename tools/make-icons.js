// 生成 PWA 图标（零依赖：手写 PNG 编码）。用法：node tools/make-icons.js
// 图案：苔绿灰圆角方块 + 白色对勾（与界面左上角品牌标一致）
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const BG = [0x55, 0x72, 0x68], FG = [0xf7, 0xf8, 0xf5];
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }

function distToSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); }

function icon(size, { rounded = true, padding = 0 } = {}) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = rounded ? size * 0.22 : 0, S = 4;   // 4x4 超采样抗锯齿
  const s = size * (1 - padding * 2), o = size * padding;   // 对勾所在区域（maskable 留安全边距）
  const A = [o + s * 0.27, o + s * 0.53], B = [o + s * 0.44, o + s * 0.69], C = [o + s * 0.75, o + s * 0.35], W = s * 0.075;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let inBg = 0, inFg = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = x + (sx + 0.5) / S, py = y + (sy + 0.5) / S;
        const cx = Math.max(r - px, 0, px - (size - r)), cy = Math.max(r - py, 0, py - (size - r));
        if (!rounded || Math.hypot(cx, cy) <= r) { inBg++; if (Math.min(distToSeg(px, py, ...A, ...B), distToSeg(px, py, ...B, ...C)) <= W) inFg++; }
      }
      const a = inBg / (S * S), f = inBg ? inFg / inBg : 0, i = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[i + k] = Math.round(BG[k] * (1 - f) + FG[k] * f);
      raw[i + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), icon(180, { rounded: false }));   // iOS 自己加圆角
fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512));
fs.writeFileSync(path.join(out, 'maskable-512.png'), icon(512, { rounded: false, padding: 0.1 }));
fs.writeFileSync(path.join(out, 'badge-96.png'), icon(96));
console.log('icons written to public/icons/');
