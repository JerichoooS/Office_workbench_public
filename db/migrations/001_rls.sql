-- 个人工作台 v2 · 001 RLS（紧接 001_init.sql 执行；逐条执行）
-- 与 v1 一致：授权给 authenticated 与 anon，策略限定 owner_id = auth.uid()（anon 无 uid，读不到任何行）

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_settings TO authenticated, anon;

DROP POLICY IF EXISTS user_settings_own ON user_settings;

CREATE POLICY user_settings_own ON user_settings FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contacts TO authenticated, anon;

DROP POLICY IF EXISTS contacts_own ON contacts;

CREATE POLICY contacts_own ON contacts FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasks TO authenticated, anon;

DROP POLICY IF EXISTS tasks_own ON tasks;

CREATE POLICY tasks_own ON tasks FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE task_contacts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.task_contacts TO authenticated, anon;

DROP POLICY IF EXISTS task_contacts_own ON task_contacts;

CREATE POLICY task_contacts_own ON task_contacts FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.todos TO authenticated, anon;

DROP POLICY IF EXISTS todos_own ON todos;

CREATE POLICY todos_own ON todos FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE todo_logs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.todo_logs TO authenticated, anon;

DROP POLICY IF EXISTS todo_logs_own ON todo_logs;

CREATE POLICY todo_logs_own ON todo_logs FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.reminders TO authenticated, anon;

DROP POLICY IF EXISTS reminders_own ON reminders;

CREATE POLICY reminders_own ON reminders FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE collections ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collections TO authenticated, anon;

DROP POLICY IF EXISTS collections_own ON collections;

CREATE POLICY collections_own ON collections FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE collection_targets ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_targets TO authenticated, anon;

DROP POLICY IF EXISTS collection_targets_own ON collection_targets;

CREATE POLICY collection_targets_own ON collection_targets FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tags TO authenticated, anon;

DROP POLICY IF EXISTS tags_own ON tags;

CREATE POLICY tags_own ON tags FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_subscriptions TO authenticated, anon;

DROP POLICY IF EXISTS push_subscriptions_own ON push_subscriptions;

CREATE POLICY push_subscriptions_own ON push_subscriptions FOR ALL TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
