/* mock.js — 本地调试用的模拟云服务（仅 127.0.0.1 / localhost 下由 boot.js 加载；线上不会加载）
 * 模拟：已登录用户 + cloud.database 查询构造器（存 localStorage）+ cloud.llm 占位输出。
 * 字段默认值、级联删除与 db/migrations/001_init.sql 保持一致——改表结构时两边一起改。
 * 控制台：WBMock.reset() 清空；WBMock.seed() 填充示例数据。
 */
'use strict';

(function () {
  var KEY = 'wb2-mock-db';
  var UID = 'local-mock-user';
  var USER = { id: UID, name: '本地调试用户', nickname: '本地调试用户' };

  // 与 001_init.sql 的 DEFAULT 对齐（id/owner_id/created_at/updated_at 统一处理）
  var DEFAULTS = {
    user_settings: { morning_on: true, morning_time: '08:30', evening_on: true, evening_time: '18:00', default_reminder: 'before_60',
      ai_enabled: false, ai_features: { parse: true, tags: true, brief: true, top5: true }, llm_api_key: null, llm_base_url: 'https://api.deepseek.com', llm_model: 'deepseek-chat', theme: 'linen',
      timezone: 'Asia/Shanghai', last_morning_sent: null, last_evening_sent: null },
    contacts: { kind: 'person', org: null, phone: null, note: null },
    tasks: { description: null, start_date: null, end_date: null, status: 'in_progress', archived_at: null, source_task_id: null, tags: [] },
    task_contacts: { role: null },
    todos: { task_id: null, notes: null, status: 'todo', priority: null, due_at: null, due_all_day: true, waiting_on: null, waiting_since: null,
      repeat_rule: null, checklist: [], tags: [], sort_order: 0, completed_at: null },
    todo_logs: {},
    reminders: { offset_minutes: null, sent_at: null },
    collections: { task_id: null, due_at: null, note: null, closed_at: null },
    collection_targets: { contact_id: null, kind: 'department', submitted_at: null, note: null },
    tags: { use_count: 0 },
    push_subscriptions: { user_agent: null, last_ok_at: null },
  };
  var NO_ID = { user_settings: 'owner_id' };           // 主键不是 id 的表
  var NO_UPDATED = { task_contacts: 1, todo_logs: 1, reminders: 1, collection_targets: 1, tags: 1, push_subscriptions: 1 };
  // 外键：删除父行时的行为（CASCADE 删除子行 / SET NULL 置空）
  var FK = [
    ['task_contacts', 'task_id', 'tasks', 'cascade'], ['task_contacts', 'contact_id', 'contacts', 'cascade'],
    ['todos', 'task_id', 'tasks', 'null'], ['todos', 'waiting_on', 'contacts', 'null'],
    ['todo_logs', 'todo_id', 'todos', 'cascade'], ['reminders', 'todo_id', 'todos', 'cascade'],
    ['collections', 'task_id', 'tasks', 'null'], ['collection_targets', 'collection_id', 'collections', 'cascade'],
    ['collection_targets', 'contact_id', 'contacts', 'null'], ['tasks', 'source_task_id', 'tasks', 'null'],
  ];

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || { seq: 0, t: {} }; } catch (_) { return { seq: 0, t: {} }; } }
  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
  function same(a, b) { return a === b || (a != null && b != null && String(a) === String(b)); }
  function cmp(a, b) { if (a == null || b == null) return null; return typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; }
  // 真实数据库的 bigint 外键会把 "103" 自动转成 103；模拟层同样处理，避免本地测试和线上行为不一致
  function coerceIds(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    Object.keys(obj).forEach(k => { if ((/_id$/.test(k) || k === 'waiting_on' || k === 'id') && typeof obj[k] === 'string' && /^\d+$/.test(obj[k])) obj[k] = +obj[k]; });
    return obj;
  }
  function err(message, code) { return { data: null, error: { message: message, code: code || 'MOCK' } }; }

  function cascade(db, table, ids) {
    FK.forEach(function (fk) {
      if (fk[2] !== table) return;
      var rows = db.t[fk[0]] || [];
      if (fk[3] === 'cascade') {
        var gone = rows.filter(function (r) { return ids.some(function (id) { return same(r[fk[1]], id); }); });
        db.t[fk[0]] = rows.filter(function (r) { return gone.indexOf(r) < 0; });
        if (gone.length) cascade(db, fk[0], gone.map(function (r) { return r.id; }));
      } else rows.forEach(function (r) { if (ids.some(function (id) { return same(r[fk[1]], id); })) r[fk[1]] = null; });
    });
  }

  function Query(table) {
    this.table = table; this.op = 'select'; this.payload = null; this.filters = []; this.orders = [];
    this.one = null; this.returning = false; this.lim = null; this.off = 0; this.conflict = null;
  }
  var P = Query.prototype;
  P.select = function () { if (this.op !== 'select') this.returning = true; return this; };
  P.insert = function (v) { this.op = 'insert'; this.payload = v; return this; };
  P.upsert = function (v, o) { this.op = 'upsert'; this.payload = v; this.conflict = (o && o.onConflict) || NO_ID[this.table] || 'id'; return this; };
  P.update = function (v) { this.op = 'update'; this.payload = v; return this; };
  P.delete = function () { this.op = 'delete'; return this; };
  P._f = function (fn) { this.filters.push(fn); return this; };
  P.eq = function (c, v) { return this._f(function (r) { return same(r[c], v); }); };
  P.neq = function (c, v) { return this._f(function (r) { return !same(r[c], v); }); };
  P.in = function (c, vs) { return this._f(function (r) { return vs.some(function (v) { return same(r[c], v); }); }); };
  P.gt = function (c, v) { return this._f(function (r) { var x = cmp(r[c], v); return x !== null && x > 0; }); };
  P.gte = function (c, v) { return this._f(function (r) { var x = cmp(r[c], v); return x !== null && x >= 0; }); };
  P.lt = function (c, v) { return this._f(function (r) { var x = cmp(r[c], v); return x !== null && x < 0; }); };
  P.lte = function (c, v) { return this._f(function (r) { var x = cmp(r[c], v); return x !== null && x <= 0; }); };
  P.is = function (c, v) { return this._f(function (r) { return v === null ? r[c] == null : r[c] === v; }); };
  P.not = function (c, op, v) { var inner = new Query(); inner[op](c, v); var f = inner.filters[0]; return this._f(function (r) { return !f(r); }); };
  P.ilike = function (c, pat) { var re = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i'); return this._f(function (r) { return re.test(r[c] || ''); }); };
  P.contains = function (c, arr) { return this._f(function (r) { return arr.every(function (v) { return (r[c] || []).indexOf(v) >= 0; }); }); };
  P.order = function (c, o) { this.orders.push({ col: c, asc: !o || o.ascending !== false, nullsFirst: o && o.nullsFirst }); return this; };
  P.limit = function (n) { this.lim = n; return this; };
  P.range = function (a, b) { this.off = a; this.lim = b - a + 1; return this; };
  P.single = function () { this.one = 'single'; return this; };
  P.maybeSingle = function () { this.one = 'maybe'; return this; };

  P._exec = function () {
    var db = load(), table = this.table;
    if (!DEFAULTS[table]) return err('relation "' + table + '" does not exist', '42P01');
    var rows = db.t[table] = db.t[table] || [];
    var filters = this.filters, now = new Date().toISOString(), pk = NO_ID[table] || 'id';
    function match(r) { return filters.every(function (f) { return f(r); }); }
    function fresh(it) {
      var row = Object.assign({}, clone(DEFAULTS[table]), { owner_id: UID, created_at: now }, NO_UPDATED[table] ? {} : { updated_at: now }, coerceIds(clone(it)));
      if (pk === 'id' && row.id == null) row.id = ++db.seq;
      return row;
    }
    var out;
    if (this.op === 'insert' || this.op === 'upsert') {
      var items = Array.isArray(this.payload) ? this.payload : [this.payload], conflict = this.conflict, op = this.op;
      out = items.map(function (it) {
        if (op === 'upsert') {
          var key = conflict === 'owner_id' ? UID : it[conflict];
          var hit = rows.find(function (r) { return same(r[conflict], key); });
          if (hit) { Object.assign(hit, coerceIds(clone(it))); if (!NO_UPDATED[table]) hit.updated_at = now; return hit; }
        }
        var row = fresh(it);
        if (pk !== 'id' && rows.some(function (r) { return same(r[pk], row[pk]); })) throw { code: '23505' };
        rows.push(row);
        return row;
      });
    } else if (this.op === 'update') {
      var patch = this.payload;
      out = rows.filter(match);
      out.forEach(function (r) { Object.assign(r, coerceIds(clone(patch))); if (!NO_UPDATED[table]) r.updated_at = now; });
    } else if (this.op === 'delete') {
      out = rows.filter(match);
      db.t[table] = rows.filter(function (r) { return !match(r); });
      cascade(db, table, out.map(function (r) { return r[pk]; }));
    } else {
      out = rows.filter(match);
      var orders = this.orders;
      out.sort(function (a, b) {
        for (var i = 0; i < orders.length; i++) {
          var o = orders[i], x = a[o.col], y = b[o.col];
          if (x == null && y == null) continue;
          if (x == null || y == null) { var nf = o.nullsFirst != null ? o.nullsFirst : !o.asc; return (x == null) === nf ? -1 : 1; }
          var c = cmp(x, y); if (c) return o.asc ? c : -c;
        }
        return 0;
      });
      if (this.lim != null) out = out.slice(this.off, this.off + this.lim);
    }
    if (this.op !== 'select') save(db);
    out = clone(out);
    if (this.op !== 'select' && !this.returning) return { data: null, error: null };
    if (this.one) {
      if (out.length > 1) return err('multiple rows', 'PGRST116');
      if (!out.length && this.one === 'single') return err('no rows', 'PGRST116');
      out = out[0] || null;
    }
    return { data: out, error: null };
  };
  P.then = function (resolve, reject) {
    var self = this;
    return new Promise(function (r) {
      setTimeout(function () { try { r(self._exec()); } catch (e) { r(err(e.message || 'mock error', e.code)); } }, 25);
    }).then(resolve, reject);
  };

  async function* placeholderStream(opts) {
    var last = (opts.messages || []).slice(-1)[0];
    var text = '【本地模拟回复】真实模型未调通（Key 无效或网络不通），这是本地占位输出。输入长度 ' + ((last && last.content) || '').length + ' 字。';
    for (var i = 0; i < text.length; i += 8) { await new Promise(function (r) { setTimeout(r, 20); }); yield { choices: [{ delta: { content: text.slice(i, i + 8) } }] }; }
  }

  // ---------- 示例数据（通用内容，相对今天生成，便于本地看效果） ----------
  function seed() {
    var d = function (n, h, m) { var x = new Date(); x.setDate(x.getDate() + n); x.setHours(h == null ? 23 : h, m || 0, 0, 0); return x.toISOString(); };
    var day = function (n) { var x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    var db = { seq: 100, t: {} }, now = new Date().toISOString();
    function add(table, it) { var row = Object.assign({}, clone(DEFAULTS[table]), { owner_id: UID, created_at: now }, NO_UPDATED[table] ? {} : { updated_at: now }, it); if (!NO_ID[table] && row.id == null) row.id = ++db.seq; (db.t[table] = db.t[table] || []).push(row); return row; }
    add('user_settings', {});
    var c1 = add('contacts', { name: '张三', kind: 'person', org: '某公司 · 采购部' });
    var c2 = add('contacts', { name: '李四', kind: 'person', org: '某公司 · 技术部' });
    var c3 = add('contacts', { name: '行政部', kind: 'department' });
    var c4 = add('contacts', { name: '财务部', kind: 'department' });
    var c5 = add('contacts', { name: '某供应商', kind: 'unit' });
    var t1 = add('tasks', { title: '年度报告编写', description: '汇总全年工作数据，完成年度报告初稿与定稿。', start_date: day(-10), end_date: day(20), tags: ['报告'] });
    var t2 = add('tasks', { title: '办公室搬迁', description: '新办公室布置、设备采购与搬迁安排。', start_date: day(-5), end_date: day(12), tags: ['搬迁', '采购'] });
    add('tasks', { title: '上一年度报告编写', start_date: day(-375), end_date: day(-345), status: 'done', archived_at: d(-345), tags: ['报告'] });
    [[t1, c1], [t1, c3], [t2, c2], [t2, c4], [t2, c5]].forEach(function (p) { add('task_contacts', { task_id: p[0].id, contact_id: p[1].id }); });
    var a = add('todos', { title: '等张三确认数据口径', task_id: t1.id, status: 'waiting', priority: 1, due_at: d(-1, 18), due_all_day: false, waiting_on: c1.id, waiting_since: d(-3, 10), tags: ['报告'],
      checklist: [{ text: '发出数据模板', done: true }, { text: '约定口径', done: true }, { text: '收到确认', done: false }] });
    var b = add('todos', { title: '整理新办公室采购清单', task_id: t2.id, status: 'doing', priority: 0, due_at: d(0, 17), due_all_day: false, tags: ['采购'],
      checklist: [{ text: '桌椅', done: true }, { text: '网络设备', done: true }, { text: '会议室设备', done: false }] });
    add('todos', { title: '提交周报', status: 'todo', due_at: d(0, 16), due_all_day: false, repeat_rule: { freq: 'weekly', days: [new Date().getDay()] }, tags: ['周报'] });
    add('todos', { title: '确认会议室预订', task_id: t2.id, priority: 1, due_at: d(0, 14, 30), due_all_day: false, tags: ['会议'] });
    add('todos', { title: '等供应商回复报价', task_id: t2.id, status: 'waiting', due_at: d(4), waiting_on: c5.id, waiting_since: d(-1, 15), tags: ['采购'] });
    add('todos', { title: '报销单：催未交部门', status: 'doing', due_at: d(3), tags: ['报销'] });
    add('todos', { title: '预约搬家公司', task_id: t2.id, status: 'done', due_at: d(-1), completed_at: d(-1, 11), tags: ['搬迁'] });
    add('todos', { title: '年度报告初稿', task_id: t1.id, due_at: d(8), tags: ['报告'], checklist: [{ text: '收集数据', done: false }, { text: '撰写正文', done: false }, { text: '内部审阅', done: false }] });
    add('todo_logs', { todo_id: a.id, content: '已发数据模板，张三说周五前回复', created_at: d(-3, 10, 20) });
    add('todo_logs', { todo_id: a.id, content: '电话确认在整理中', created_at: d(-2, 16, 5) });
    add('todo_logs', { todo_id: b.id, content: '桌椅、网络设备已定', created_at: d(-1, 9, 40) });
    var col = add('collections', { title: '季度报销单', due_at: d(4, 17) });
    [['行政部', 'department', 1], ['财务部', 'department', 1], ['市场部', 'department', 0], ['技术部', 'department', 1], ['人事部', 'department', 0]].forEach(function (x) {
      add('collection_targets', { collection_id: col.id, name: x[0], kind: x[1], submitted_at: x[2] ? d(-1, 15) : null });
    });
    ['周报', '报告', '采购', '会议', '报销', '搬迁'].forEach(function (n, i) { add('tags', { name: n, use_count: 6 - i }); });
    save(db);
  }

  var session = { user: USER, access_token: 'local-mock' };
  window.WBMock = {
    reset: function () { localStorage.removeItem(KEY); location.reload(); },
    seed: function () { seed(); location.reload(); },
    isEmpty: function () { var db = load(); return !Object.keys(db.t).some(function (k) { return k !== 'user_settings' && db.t[k].length; }); },
    client: {
      auth: {
        getSession: async function () { return { data: session, error: null }; },
        signInWithOAuth: async function () { return { data: { url: location.origin + '/' }, error: null }; },
        handleWechatWebCallback: async function () { return { data: session, error: null }; },
        handleWorkBuddyCallback: async function () { return { data: session, error: null }; },
        signOut: async function () { return { error: null }; },
      },
      database: {
        from: function (t) { return new Query(t); },
        rpc: async function (fn) { return err('rpc ' + fn + ' 在本地模拟中未实现'); },
      },
      llm: {
        models: { list: async function () { return [{ id: 'local-mock-model' }]; } },
        chat: { completions: { create: placeholderStream } },
      },
    },
  };
})();
