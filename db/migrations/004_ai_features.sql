-- =====================================================================
-- 个人工作台 v2 · 004 AI 分项开关
-- 在总开关 ai_enabled 之外，每项 AI 功能可单独开关。缺省全部开启。
-- （003 编号留给可选的 003_server_token.sql，见 docs/部署与初始化.md）
-- =====================================================================

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_features jsonb NOT NULL DEFAULT '{"parse": true, "tags": true, "brief": true, "top5": true}';
