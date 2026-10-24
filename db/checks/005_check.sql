-- 005 执行情况核对（只读，不改任何数据；一条语句，执行一次即可）
-- 每一行是一项，ok 列应全部是 true；有 false 的就把整张结果发回来。
-- todos 同一天同一条重复待办（todos_repeat_once）：库里原本就有重复时 005 会跳过它，这一项是 false 也不影响使用。
SELECT item, ok FROM (VALUES
  (1,  '待办 client_id 列',            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todos' AND column_name = 'client_id')),
  (2,  '提醒 重试三列',                 (SELECT count(*) = 3 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reminders' AND column_name IN ('attempts', 'retry_at', 'failed_at'))),
  (3,  '进展 kind 列',                  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'todo_logs' AND column_name = 'kind')),
  (4,  '索引 todos_client_id',          to_regclass('public.todos_client_id') IS NOT NULL),
  (5,  '索引 todos_repeat_once',        to_regclass('public.todos_repeat_once') IS NOT NULL),
  (6,  '索引 reminders_one_nudge',      to_regclass('public.reminders_one_nudge') IS NOT NULL),
  (7,  '表 trash（含 RLS）',            COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.trash')), false)),
  (8,  '表 snapshots（含 RLS）',        COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.snapshots')), false)),
  (9,  '表 schema_migrations（含 RLS）', COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.schema_migrations')), false)),
  (10, '访问策略 3 条',                 (SELECT count(*) = 3 FROM pg_policies WHERE schemaname = 'public' AND policyname IN ('trash_own', 'snapshots_read', 'snapshots_delete'))),
  (11, '删除前存一份 触发器 2 个',      (SELECT count(*) = 2 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('t_todos_trash', 't_targets_trash'))),
  (12, '函数 7 个',                     (SELECT count(DISTINCT proname) = 7 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('wb_schedule_nudge', 'wb_claim_due', 'wb_reminder_failed', 'wb_trash_todo', 'wb_trash_target', 'wb_daily_snapshots', 'wb_schema_version'))),
  (13, '催办函数是新版',                EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'wb_schedule_nudge' AND prosrc ILIKE '%ON CONFLICT%')),
  (14, '取提醒函数是新版',              EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'wb_claim_due' AND prosrc ILIKE '%retry_at%')),
  (15, '前端能读 trash',                COALESCE(has_table_privilege('anon', to_regclass('public.trash'), 'SELECT'), false)),
  (16, '前端能读 snapshots',            COALESCE(has_table_privilege('anon', to_regclass('public.snapshots'), 'SELECT'), false)),
  (17, '前端能读数据库版本',            EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'wb_schema_version' AND has_function_privilege('anon', oid, 'EXECUTE'))),
  (18, '服务器能调重试和快照',          (SELECT count(*) = 2 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('wb_reminder_failed', 'wb_daily_snapshots') AND has_function_privilege('anon', oid, 'EXECUTE'))),
  (19, '已记录 001/002/004/005',        CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN false ELSE (xpath('/row/c/text()', query_to_xml($q$SELECT count(*) AS c FROM schema_migrations WHERE version IN ('001', '002', '004', '005')$q$, false, true, '')))[1]::text = '4' END)
) AS t(n, item, ok) ORDER BY n;
