# 个人工作台

一个面向个人工作管理的网页应用：**项目 → 待办 → 子步骤**，支持等待他人与自动催办、到点提醒、早报 / 晚报推送（iPhone 可添加到主屏幕接收通知）、材料收集进度追踪，以及可选的 AI 助手（DeepSeek，可完全关闭）。

- 运行在 [WorkBuddy](https://www.workbuddy.cn/) 云托管上：微信扫码登录 + 云数据库
- 零依赖：`node server.js` 即可运行，前端为原生 ES Modules，无需构建、无需 npm 安装
- 电脑与手机均可使用；本机 `127.0.0.1` 打开时自动进入「本地模拟模式」，不需要登录即可体验

## 部署

按 **[docs/部署与初始化.md](docs/部署与初始化.md)** 一步步操作：在你自己的 WorkBuddy 中创建应用并部署、执行 `db/migrations` 下的建表脚本、选择推送口令方式、在 iPhone 上测试。

`public/config.js` 不在仓库里：它是你自己应用的云服务配置，由 WorkBuddy 在部署（云服务激活）时生成，格式见 `public/config.example.js`。

## 本地体验

```bash
node server.js
```

浏览器打开 http://127.0.0.1:3000/ ，首页点「填充示例数据」。Mac 也可以双击 `start-mac.command`。

## 开发与维护

所有约定（目录结构、数据表、改表流程、界面规范、业务规则）见 **[docs/开发规范.md](docs/开发规范.md)**。让 AI 或他人修改代码前，请先阅读这份规范。

## 第三方

- `public/vendor/workbuddy-cloud-sdk.global.js`：WorkBuddy Cloud SDK（`@tencent-ai/workbuddy-cloud-sdk`，MIT 许可）
