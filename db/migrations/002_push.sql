-- =====================================================================
-- 个人工作台 v2 · 002 推送（服务器专用接口）
-- 执行方式：WorkBuddy 按顺序逐条执行（mode=migrate）。语句之间空一行；函数体内的分号属于同一条语句。
--
-- 背景：平台没有环境变量、没有 pg_net。推送只能由 server.js 发送；server.js 用公开的
--       publishable key 以 anon 身份调用下面这些 SECURITY DEFINER 函数。为防止任何拿到公开 key
--       的人调用，每个函数都先校验「服务器口令」：库里只存口令的 sha256，不存明文。
-- 安全收口：
--   * server_config 开启 RLS 且没有任何策略，前端读不到（含推送签名私钥）。
--   * 函数只开放推送必需的最小数据：到期提醒（标题/时间/状态）、推送订阅、早晚报所需的待办摘要。
--     不返回 AI Key、备注、进展记录等其他内容。
--   * 口令错误直接报错；口令为 2 个 gen_random_uuid 拼接（约 244 位随机），无法穷举。
-- 口令怎么到服务器手里（两种都支持，见 docs/开发规范.md §8）：
--   B. 部署目录里有 server/server-token.txt（tools/new-server-token.js 生成）→ 服务器启动即可推送
--   C. 没有该文件 → 管理员（本应用的主人）登录后，应用自动把口令交给服务器（只存内存；
--      平台重启后推送暂停，直到管理员下次打开应用，错过的提醒随后补发）
-- =====================================================================

CREATE TABLE server_config (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token_hash    text,                 -- 服务器口令的 sha256（hex），用于校验
  token_plain   text,                 -- 口令明文：只有管理员登录后能通过 wb_admin_server_token() 取到（方案 C）
  admin_owner   text,                 -- 管理员（应用主人）的 owner_id
  vapid_public  text,                 -- 推送签名公钥（服务器首次启动时自动生成并写入）
  vapid_private text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO server_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 生成口令（库内生成，明文不经过任何人）。用 tools/new-server-token.js 可改为自带口令（方案 B）。
UPDATE server_config SET token_plain = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE id = 1 AND token_plain IS NULL;

UPDATE server_config SET token_hash = encode(sha256(convert_to(token_plain, 'UTF8')), 'hex') WHERE id = 1;

-- 管理员 = 已在线上登录过的那位用户（user_settings 里最早的一行）。执行前请确认表里只有你自己一行：
--   SELECT owner_id, created_at FROM user_settings ORDER BY created_at;
UPDATE server_config SET admin_owner = (SELECT owner_id FROM user_settings ORDER BY created_at LIMIT 1) WHERE id = 1 AND admin_owner IS NULL;

ALTER TABLE server_config ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE server_config FROM anon, authenticated;

-- ---------- 口令校验 ----------
CREATE OR REPLACE FUNCTION wb_server_auth(p_token text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR NOT EXISTS (
    SELECT 1 FROM server_config WHERE id = 1 AND token_hash IS NOT NULL
      AND token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------- 推送签名密钥：读取 / 首次写入 ----------
CREATE OR REPLACE FUNCTION wb_server_vapid(p_token text) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v json;
BEGIN
  PERFORM wb_server_auth(p_token);
  SELECT CASE WHEN vapid_public IS NULL THEN NULL ELSE json_build_object('publicKey', vapid_public, 'privateKey', vapid_private) END
    INTO v FROM server_config WHERE id = 1;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION wb_server_init_vapid(p_token text, p_public text, p_private text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM wb_server_auth(p_token);
  IF length(p_public) <> 87 OR length(p_private) <> 43 THEN RAISE EXCEPTION 'invalid key'; END IF;
  UPDATE server_config SET vapid_public = p_public, vapid_private = p_private, updated_at = now()
    WHERE id = 1 AND vapid_public IS NULL;
  RETURN FOUND;
END $$;

-- ---------- 认领到期提醒（原子：标记已发并返回，重复调用不会重复返回） ----------
CREATE OR REPLACE FUNCTION wb_claim_due(p_token text, p_limit integer DEFAULT 200) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v json;
BEGIN
  PERFORM wb_server_auth(p_token);
  WITH claimed AS (
    UPDATE reminders r SET sent_at = now()
    WHERE r.id IN (
      SELECT id FROM reminders WHERE sent_at IS NULL AND fire_at <= now()
      ORDER BY fire_at LIMIT LEAST(GREATEST(p_limit, 1), 500) FOR UPDATE SKIP LOCKED
    )
    RETURNING r.id, r.owner_id, r.todo_id, r.kind, r.fire_at
  )
  SELECT COALESCE(json_agg(json_build_object(
    'reminder', json_build_object('id', c.id, 'kind', c.kind, 'fire_at', c.fire_at),
    'todo', (SELECT json_build_object('id', t.id, 'title', t.title, 'status', t.status, 'due_at', t.due_at, 'due_all_day', t.due_all_day,
                                      'waiting_since', t.waiting_since, 'task_id', t.task_id) FROM todos t WHERE t.id = c.todo_id),
    'task', (SELECT json_build_object('id', k.id, 'title', k.title, 'start_date', k.start_date, 'end_date', k.end_date)
               FROM todos t JOIN tasks k ON k.id = t.task_id WHERE t.id = c.todo_id),
    'waitingName', (SELECT ct.name FROM todos t JOIN contacts ct ON ct.id = t.waiting_on WHERE t.id = c.todo_id),
    'timezone', COALESCE((SELECT s.timezone FROM user_settings s WHERE s.owner_id = c.owner_id), 'Asia/Shanghai'),
    'subs', COALESCE((SELECT json_agg(json_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
                        FROM push_subscriptions p WHERE p.owner_id = c.owner_id), '[]'::json)
  )), '[]'::json) INTO v FROM claimed c;
  RETURN v;
END $$;

-- ---------- 催办续排（只给仍在「等待他人」、且没有待发催办的待办排下一次） ----------
CREATE OR REPLACE FUNCTION wb_schedule_nudge(p_token text, p_todo_id bigint, p_fire_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM wb_server_auth(p_token);
  IF p_fire_at <= now() OR p_fire_at > now() + interval '30 days' THEN RETURN false; END IF;
  INSERT INTO reminders (owner_id, todo_id, kind, fire_at)
  SELECT t.owner_id, t.id, 'nudge', p_fire_at FROM todos t
  WHERE t.id = p_todo_id AND t.status = 'waiting'
    AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.todo_id = t.id AND r.kind = 'nudge' AND r.sent_at IS NULL);
  RETURN FOUND;
END $$;

-- ---------- 早晚报候选：开了早报或晚报、且至少有一台设备订阅的用户 ----------
CREATE OR REPLACE FUNCTION wb_digest_candidates(p_token text) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v json;
BEGIN
  PERFORM wb_server_auth(p_token);
  SELECT COALESCE(json_agg(json_build_object(
    'settings', json_build_object('owner_id', s.owner_id, 'morning_on', s.morning_on, 'morning_time', s.morning_time,
                                  'evening_on', s.evening_on, 'evening_time', s.evening_time, 'timezone', s.timezone,
                                  'last_morning_sent', s.last_morning_sent, 'last_evening_sent', s.last_evening_sent),
    'todos', COALESCE((SELECT json_agg(json_build_object('id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
                                                          'due_at', t.due_at, 'due_all_day', t.due_all_day, 'completed_at', t.completed_at))
                         FROM todos t WHERE t.owner_id = s.owner_id
                           AND (t.status <> 'done' OR t.completed_at > now() - interval '2 days')), '[]'::json),
    'subs', (SELECT json_agg(json_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
               FROM push_subscriptions p WHERE p.owner_id = s.owner_id)
  )), '[]'::json) INTO v
  FROM user_settings s
  WHERE (s.morning_on OR s.evening_on) AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.owner_id = s.owner_id);
  RETURN v;
END $$;

-- ---------- 标记早/晚报已发（当天只成功一次） ----------
CREATE OR REPLACE FUNCTION wb_mark_digest(p_token text, p_owner text, p_kind text, p_day date) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM wb_server_auth(p_token);
  IF p_kind = 'morning' THEN
    UPDATE user_settings SET last_morning_sent = p_day WHERE owner_id = p_owner AND last_morning_sent IS DISTINCT FROM p_day;
  ELSIF p_kind = 'evening' THEN
    UPDATE user_settings SET last_evening_sent = p_day WHERE owner_id = p_owner AND last_evening_sent IS DISTINCT FROM p_day;
  ELSE
    RAISE EXCEPTION 'invalid kind';
  END IF;
  RETURN FOUND;
END $$;

-- ---------- 删除失效订阅（推送服务返回 404/410） ----------
CREATE OR REPLACE FUNCTION wb_remove_subscription(p_token text, p_endpoint text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM wb_server_auth(p_token);
  DELETE FROM push_subscriptions WHERE endpoint = p_endpoint;
END $$;

-- ---------- 管理员取口令（方案 C：登录后的应用交给服务器） ----------
CREATE OR REPLACE FUNCTION wb_admin_server_token() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v text;
BEGIN
  SELECT token_plain INTO v FROM server_config WHERE id = 1 AND admin_owner IS NOT NULL AND admin_owner = auth.uid();
  RETURN v;   -- 不是管理员 → NULL
END $$;

-- ---------- 权限：只开放执行，且只给需要的角色 ----------
REVOKE ALL ON FUNCTION wb_server_auth(text) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION wb_server_vapid(text), wb_server_init_vapid(text, text, text), wb_claim_due(text, integer), wb_schedule_nudge(text, bigint, timestamptz), wb_digest_candidates(text), wb_mark_digest(text, text, text, date), wb_remove_subscription(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION wb_server_vapid(text), wb_server_init_vapid(text, text, text), wb_claim_due(text, integer), wb_schedule_nudge(text, bigint, timestamptz), wb_digest_candidates(text), wb_mark_digest(text, text, text, date), wb_remove_subscription(text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION wb_admin_server_token() FROM PUBLIC;

-- 微信登录用户在这个平台上可能是 anon 角色（与 001_rls.sql 一致两者都授权）；函数内部按 auth.uid() 判断管理员，非管理员拿到 NULL
GRANT EXECUTE ON FUNCTION wb_admin_server_token() TO anon, authenticated;
