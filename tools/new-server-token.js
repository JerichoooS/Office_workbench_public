// 生成一个新的「服务器口令」（方案 B：口令放部署目录，服务器重启后推送不中断）
// 用法：node tools/new-server-token.js
//   1) 写入 server/server-token.txt（默认被 .gitignore 忽略；要随仓库部署时，从 .gitignore 删掉这一行再提交，仓库必须是私有的）
//   2) 打印一条 SQL，交给 WorkBuddy 执行，让数据库认这个新口令（旧口令随即失效）
// 给同事部署时：每个部署各自运行一次，生成自己的口令。
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const token = crypto.randomBytes(32).toString('hex');
const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
const file = path.join(__dirname, '..', 'server', 'server-token.txt');
fs.writeFileSync(file, token + '\n', { mode: 0o600 });
console.log('已写入', path.relative(process.cwd(), file));
console.log('\n请让 WorkBuddy 执行这一条（mode=migrate）：\n');
console.log(`UPDATE server_config SET token_plain = '${token}', token_hash = '${hash}', updated_at = now() WHERE id = 1;`);
