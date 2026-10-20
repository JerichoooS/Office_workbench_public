// WorkBuddy 云服务公开配置 —— 示例文件
// 部署时，WorkBuddy 在「云服务激活」后会自动生成 public/config.js（内容与下面格式相同），一般不需要手动创建。
// 如需手动创建：复制本文件为 public/config.js，并把下面的值换成你自己应用的（在 WorkBuddy 的云服务信息里可以看到）。
// 这些值本来就会下发给浏览器，不是机密；但不要使用别人的配置，否则账号和数据会落在别人的应用里。
window.WB_PUBLIC_CONFIG = {
  resourceId: 'wbcs_xxxxxxxxxxxxxxxxxxxxxx',
  endpoint: 'https://your-app.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
};
