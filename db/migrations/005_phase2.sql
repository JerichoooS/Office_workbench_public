-- =====================================================================
-- 个人工作台 v2 · 005 第二阶段「放得心」
-- 执行方式：WorkBuddy 按顺序逐条执行（mode=migrate）。语句之间空一行；函数体、DO 块内的分号属于同一条语句。
-- 执行前：先把整个库导出一份留底（所有表）。
-- 前置：001、002、004 已执行（003 可选）。本文件可以重复执行：已经有的会跳过。
-- 最后一条把「005」记进 schema_migrations；前端读到它才打开第二阶段的功能（没执行时照旧可用，只是没有这些新功能）。
--
-- 内容：
--   1. schema_migrations：记录执行过哪些数据库改动
--   2. 待办 client_id：没信号时记下的待办，联网补存不会重复
--   3. 重复待办：同一系列、同一天只能有一条没完成的（数据库兜底）
--   4. 催办：同一条待办只保留一条待发的催办（手机补排与服务器续排撞车时不会催两次）
--   5. 提醒发送失败重试（最多 3 次）与「没送达」记录
--   6. 进展记录分类：手写 / 自动留痕（转等待、完成、改期、已催）
--   7. 最近删除：删除待办、收集对象前自动存一份，30 天内可恢复
--   8. 每日云端快照：服务器每天存一份完整数据，保留 14 天
--   9. 前端读取数据库版本
-- =====================================================================

-- ---------- 1. 执行记录（前端只能通过 wb_schema_version() 读） ----------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  note       text,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE schema_migrations FROM anon, authenticated;

INSERT INTO schema_migrations (version, note) VALUES ('001', '初始化（005 补记）'), ('002', '推送（005 补记）'), ('004', 'AI 分项开关（005 补记）') ON CONFLICT (version) DO NOTHING;

-- ---------- 2. 待办 client_id（前端生成；同一用户内唯一） ----------
ALTER TABLE todos ADD COLUMN IF NOT EXISTS client_id text;

CREATE UNIQUE INDEX IF NOT EXISTS todos_client_id ON todos (owner_id, client_id) WHERE client_id IS NOT NULL;

-- ---------- 3. 重复待办：同标题、同项目、同规则、同一天（北京时间）只能有一条没完成的 ----------
-- 库里如果已经有这样的重复（以前连点留下的），建索引会失败：这里跳过并提示，不删任何数据；前端仍有防重复检查。
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS todos_repeat_once ON todos (owner_id, title, (COALESCE(task_id, 0)), repeat_rule, ((due_at AT TIME ZONE 'Asia/Shanghai')::date))
    WHERE repeat_rule IS NOT NULL AND status <> 'done';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE '库里已有重复的待办，跳过「重复待办唯一」约束（不影响使用）';
END $$;

-- ---------- 4. 催办：每条待办最多一条待发的催办 ----------
-- 先清掉已经重复排上的（只删多出来的待发催办提醒，不动待办本身）
DELETE FROM reminders r USING reminders r2
WHERE r.kind = 'nudge' AND r2.kind = 'nudge' AND r.sent_at IS NULL AND r2.sent_at IS NULL AND r.todo_id = r2.todo_id AND r.id > r2.id;

CREATE UNIQUE INDEX IF NOT EXISTS reminders_one_nudge ON reminders (todo_id) WHERE kind = 'nudge' AND sent_at IS NULL;

CREATE OR REPLACE FUNCTION wb_schedule_nudge(p_token text, p_todo_id bigint, p_fire_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM wb_server_auth(p_token);
  IF p_fire_at <= now() OR p_fire_at > now() + interval '30 days' THEN RETURN false; END IF;
  INSERT INTO reminders (owner_id, todo_id, kind, fire_at)
  SELECT t.owner_id, t.id, 'nudge', p_fire_at FROM todos t
  WHERE t.id = p_todo_id AND t.status = 'waiting'
  ON CONFLICT (todo_id) WHERE kind = 'nudge' AND sent_at IS NULL DO NOTHING;
  RETURN FOUND;
END $$;

-- ---------- 5. 提醒发送失败重试 ----------
-- attempts 已重试次数；retry_at 下次重试时间（fire_at 保持原定时间，推送里「补发 · 原定 xx:xx」照旧准确）；
-- failed_at 重试用完仍没送达（首页提示「有提醒没送达」）
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 0;

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS retry_at timestamptz;

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS failed_at timestamptz;

CREATE OR REPLACE FUNCTION wb_claim_due(p_token text, p_limit integer DEFAULT 200) RETURNS json
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v json;
BEGIN
  PERFORM wb_server_auth(p_token);
  WITH claimed AS (
    UPDATE reminders r SET sent_at = now()
    WHERE r.id IN (
      SELECT id FROM reminders WHERE sent_at IS NULL AND COALESCE(retry_at, fire_at) <= now()
      ORDER BY COALESCE(retry_at, fire_at) LIMIT LEAST(GREATEST(p_limit, 1), 500) FOR UPDATE SKIP LOCKED
    )
    RETURNING r.id, r.owner_id, r.todo_id, r.kind, r.fire_at, r.attempts
  )
  SELECT COALESCE(json_agg(json_build_object(
    'reminder', json_build_object('id', c.id, 'kind', c.kind, 'fire_at', c.fire_at, 'attempts', c.attempts),
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

-- 一条提醒没送达：p_retry = true 且还没重试满 3 次 → 放回队列，2/4/6 分钟后再发；否则记为没送达。
-- 催办从不重试（认领时下一次催办已经排上，放回去会撞「每条待办一条待发催办」）
CREATE OR REPLACE FUNCTION wb_reminder_failed(p_token text, p_id bigint, p_retry boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n smallint; k text;
BEGIN
  PERFORM wb_server_auth(p_token);
  SELECT attempts, kind INTO n, k FROM reminders WHERE id = p_id;
  IF NOT FOUND THEN RETURN 'gone'; END IF;
  IF p_retry AND n < 3 AND k <> 'nudge' THEN
    UPDATE reminders SET sent_at = NULL, attempts = n + 1, retry_at = now() + make_interval(mins => 2 * (n + 1)) WHERE id = p_id;
    RETURN 'retry';
  END IF;
  UPDATE reminders SET failed_at = now(), attempts = n + 1 WHERE id = p_id;
  RETURN 'failed';
END $$;

-- ---------- 6. 进展记录分类 ----------
-- note 手写；status 状态变化（转等待、完成…）；due 改期；nudged 已催。自动记的在界面上用浅色小字
ALTER TABLE todo_logs ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'status', 'due', 'nudged'));

-- ---------- 7. 最近删除 ----------
CREATE TABLE IF NOT EXISTS trash (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  owner_id   text NOT NULL DEFAULT auth.uid(),
  kind       text NOT NULL CHECK (kind IN ('todo', 'collection_target')),
  item_id    bigint NOT NULL,                        -- 原来的 id（恢复时原样放回）
  title      text NOT NULL,
  data       jsonb NOT NULL,                         -- 待办：{ todo, logs, reminders }；收集对象：{ target, collection_title }
  deleted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trash_owner_time ON trash (owner_id, deleted_at DESC);

ALTER TABLE trash ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trash TO authenticated, anon;

DROP POLICY IF EXISTS trash_own ON trash;

CREATE POLICY trash_own ON trash FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- 删除前自动存一份（以删除人的身份执行，受上面的权限规则约束）。
-- pg_trigger_depth() > 1 = 删父行连带删除的（删整个材料收集时它的对象）：不进最近删除。顺手清掉 30 天前的。
CREATE OR REPLACE FUNCTION wb_trash_todo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  INSERT INTO trash (owner_id, kind, item_id, title, data) VALUES (OLD.owner_id, 'todo', OLD.id, OLD.title, jsonb_build_object(
    'todo', to_jsonb(OLD),
    'logs', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM todo_logs l WHERE l.todo_id = OLD.id), '[]'::jsonb),
    'reminders', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM reminders r WHERE r.todo_id = OLD.id AND r.sent_at IS NULL), '[]'::jsonb)));
  DELETE FROM trash WHERE owner_id = OLD.owner_id AND deleted_at < now() - interval '30 days';
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS t_todos_trash ON todos;

CREATE TRIGGER t_todos_trash BEFORE DELETE ON todos FOR EACH ROW EXECUTE FUNCTION wb_trash_todo();

CREATE OR REPLACE FUNCTION wb_trash_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  INSERT INTO trash (owner_id, kind, item_id, title, data) VALUES (OLD.owner_id, 'collection_target', OLD.id, OLD.name, jsonb_build_object(
    'target', to_jsonb(OLD),
    'collection_title', (SELECT c.title FROM collections c WHERE c.id = OLD.collection_id)));
  DELETE FROM trash WHERE owner_id = OLD.owner_id AND deleted_at < now() - interval '30 days';
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS t_targets_trash ON collection_targets;

CREATE TRIGGER t_targets_trash BEFORE DELETE ON collection_targets FOR EACH ROW EXECUTE FUNCTION wb_trash_target();

-- ---------- 8. 每日云端快照（服务器调用；不依赖 pg_cron） ----------
CREATE TABLE IF NOT EXISTS snapshots (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  owner_id   text NOT NULL DEFAULT auth.uid(),
  day        date NOT NULL,                          -- 用户时区的日期
  data       jsonb NOT NULL,                         -- { 表名: [行…] }，格式与「导出 JSON」的 tables 相同
  bytes      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, day)
);

ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;

GRANT SELECT, DELETE ON TABLE public.snapshots TO authenticated, anon;

DROP POLICY IF EXISTS snapshots_read ON snapshots;

CREATE POLICY snapshots_read ON snapshots FOR SELECT TO authenticated, anon USING (owner_id = auth.uid());

DROP POLICY IF EXISTS snapshots_delete ON snapshots;

CREATE POLICY snapshots_delete ON snapshots FOR DELETE TO authenticated, anon USING (owner_id = auth.uid());

-- 每个用户每天一份（当天已有就跳过，可以反复调用）；只保留最近 14 天。不含 AI Key、推送订阅、服务器口令。返回本次新存了几份
CREATE OR REPLACE FUNCTION wb_daily_snapshots(p_token text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record; d date; v jsonb; n integer := 0;
BEGIN
  PERFORM wb_server_auth(p_token);
  FOR s IN SELECT owner_id, COALESCE(NULLIF(timezone, ''), 'Asia/Shanghai') AS tz FROM user_settings LOOP
    d := (now() AT TIME ZONE s.tz)::date;
    CONTINUE WHEN EXISTS (SELECT 1 FROM snapshots WHERE owner_id = s.owner_id AND day = d);
    v := jsonb_build_object(
      'user_settings', (SELECT COALESCE(jsonb_agg(to_jsonb(x) - 'llm_api_key'), '[]'::jsonb) FROM user_settings x WHERE x.owner_id = s.owner_id),
      'contacts', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM contacts x WHERE x.owner_id = s.owner_id),
      'tasks', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM tasks x WHERE x.owner_id = s.owner_id),
      'task_contacts', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM task_contacts x WHERE x.owner_id = s.owner_id),
      'todos', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM todos x WHERE x.owner_id = s.owner_id),
      'todo_logs', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM todo_logs x WHERE x.owner_id = s.owner_id),
      'reminders', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM reminders x WHERE x.owner_id = s.owner_id),
      'collections', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM collections x WHERE x.owner_id = s.owner_id),
      'collection_targets', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM collection_targets x WHERE x.owner_id = s.owner_id),
      'tags', (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) FROM tags x WHERE x.owner_id = s.owner_id));
    INSERT INTO snapshots (owner_id, day, data, bytes) VALUES (s.owner_id, d, v, octet_length(v::text)) ON CONFLICT (owner_id, day) DO NOTHING;
    IF FOUND THEN n := n + 1; END IF;
    DELETE FROM snapshots WHERE owner_id = s.owner_id AND day <= d - 14;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION wb_reminder_failed(text, bigint, boolean), wb_daily_snapshots(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION wb_reminder_failed(text, bigint, boolean), wb_daily_snapshots(text) TO anon, authenticated;

-- ---------- 9. 前端读数据库版本（只返回执行过的编号） ----------
CREATE OR REPLACE FUNCTION wb_schema_version() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(version ORDER BY version), '{}') FROM schema_migrations
$$;

REVOKE ALL ON FUNCTION wb_schema_version() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION wb_schema_version() TO anon, authenticated;

-- ---------- 最后：记下 005 已执行（前面任何一条失败都不要执行这一条，把报错发给我） ----------
INSERT INTO schema_migrations (version, note) VALUES ('005', '第二阶段：放得心') ON CONFLICT (version) DO NOTHING;
