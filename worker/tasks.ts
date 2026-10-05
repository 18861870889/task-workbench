import { Hono } from 'hono';
import { z } from 'zod';
import type { AppSettings, Attachment, Bootstrap, Task, Taxonomy } from '../shared/types';
import { ApiError } from './errors';
import { attachmentUsage, fileName, fileMime, LEGACY_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES, MAX_DATABASE_BYTES, RESERVED_DATABASE_BYTES, storeD1Attachment, uploadRawAttachment } from './attachments';

const MAX_JSON_BYTES = 128 * 1024;
const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, '无效的记录编号');
const isoDate = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const idsSchema = z.array(idSchema).max(50).transform((ids) => [...new Set(ids)].sort());
const offsetsSchema = z.array(z.number().int().min(0).max(525600)).max(20)
  .transform((offsets) => [...new Set(offsets)].sort((a, b) => b - a));
const binarySchema = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((value) => value ? 1 : 0);
const taskFields = {
  title: z.string().trim().min(1, '请填写任务名称').max(300),
  description: z.string().max(30000),
  notes: z.string().max(30000),
  status_id: idSchema,
  priority: z.number().int().min(1).max(4),
  progress: z.number().int().min(0).max(100),
  received_at: isoDate,
  due_at: isoDate.nullable(),
  parent_id: idSchema.nullable(),
  category_ids: idsSchema,
  tag_ids: idsSchema,
  reminder_offsets: offsetsSchema,
  overdue_interval: z.number().int().min(0).max(525600),
};
const createTaskSchema = z.object(taskFields).partial().extend({ title: taskFields.title }).strict();
const patchTaskSchema = z.object(taskFields).partial().extend({ version: z.number().int().positive() }).strict();
const taxonomyFields = {
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色须为六位十六进制值'),
  is_closed: binarySchema,
  sort_order: z.number().int().min(0).max(100000),
  archived: binarySchema,
};
const createTaxonomySchema = z.object(taxonomyFields).partial().extend({
  kind: z.enum(['category', 'tag', 'status']), name: taxonomyFields.name,
}).strict();
const patchTaxonomySchema = z.object(taxonomyFields).partial().strict();
const settingsSchema = z.object({
  timezone: z.string().min(1).max(100).refine((timezone) => {
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); return true; } catch { return false; }
  }, '请选择有效时区'),
  default_reminder_offsets: offsetsSchema,
  default_overdue_interval: z.number().int().min(0).max(525600),
  email: z.union([z.literal(''), z.string().email().max(254)]),
  email_enabled: z.boolean(),
}).strict();

type TaskRow = Omit<Task, 'category_ids' | 'tag_ids' | 'reminder_offsets'> & {
  category_ids: string; tag_ids: string; reminder_offsets: string;
};
type SqlValue = string | number | null;
type Changes = Record<string, { before: unknown; after: unknown }>;

// JSON aggregation avoids N+1 reads and keeps categories and tags independent.
const TASK_SELECT = `SELECT t.*,
  COALESCE((SELECT json_group_array(x.id) FROM task_taxonomies tt JOIN taxonomies x ON x.id=tt.taxonomy_id
    WHERE tt.task_id=t.id AND x.kind='category'), '[]') AS category_ids,
  COALESCE((SELECT json_group_array(x.id) FROM task_taxonomies tt JOIN taxonomies x ON x.id=tt.taxonomy_id
    WHERE tt.task_id=t.id AND x.kind='tag'), '[]') AS tag_ids
  FROM tasks t`;

function toTask(row: TaskRow): Task {
  return {
    ...row,
    category_ids: z.array(z.string()).parse(JSON.parse(row.category_ids)).sort(),
    tag_ids: z.array(z.string()).parse(JSON.parse(row.tag_ids)).sort(),
    reminder_offsets: z.array(z.number()).parse(JSON.parse(row.reminder_offsets)),
  };
}

async function taskById(db: D1Database, id: string): Promise<Task> {
  const row = await db.prepare(`${TASK_SELECT} WHERE t.id=?`).bind(id).first<TaskRow>();
  if (!row) throw new ApiError('找不到此任务', 404);
  return toTask(row);
}

async function settingsFromDb(db: D1Database): Promise<{ settings: AppSettings; raw: string }> {
  const row = await db.prepare('SELECT value FROM settings WHERE id=1').first<{ value: string }>();
  if (!row) throw new Error('Missing application settings');
  return { settings: settingsSchema.parse(JSON.parse(row.value)), raw: row.value };
}

// Bound streams before parsing, including chunked requests without Content-Length.
async function boundedBody(request: Request, maximum: number): Promise<ArrayBuffer> {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maximum) throw new ApiError('提交的内容过大', 413);
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ApiError('提交的内容过大', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { combined.set(chunk, position); position += chunk.byteLength; }
  return combined.buffer;
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError('请使用 JSON 格式提交', 415);
  }
  const bytes = await boundedBody(request, MAX_JSON_BYTES);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError('JSON 格式不正确'); }
}

function changedFields(before: Task, after: Task): Changes {
  const changes: Changes = {};
  for (const field of Object.keys(taskFields) as (keyof typeof taskFields)[]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      changes[field] = { before: before[field], after: after[field] };
    }
  }
  if (before.completed_at !== after.completed_at) changes.completed_at = { before: before.completed_at, after: after.completed_at };
  return changes;
}

async function validateRelations(db: D1Database, task: Task, before?: Task): Promise<Taxonomy[]> {
  const requested = [task.status_id, ...task.category_ids, ...task.tag_ids];
  const { results } = await db.prepare('SELECT * FROM taxonomies WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(requested)).all<Taxonomy>();
  const lookup = new Map(results.map((taxonomy) => [taxonomy.id, taxonomy]));
  const status = lookup.get(task.status_id);
  if (!status || status.kind !== 'status' || (status.archived && before?.status_id !== status.id)) {
    throw new ApiError('请选择有效且未停用的状态');
  }
  for (const [kind, selected, existing] of [
    ['category', task.category_ids, before?.category_ids ?? []],
    ['tag', task.tag_ids, before?.tag_ids ?? []],
  ] as const) {
    for (const id of selected) {
      const taxonomy = lookup.get(id);
      if (!taxonomy || taxonomy.kind !== kind || (taxonomy.archived && !existing.includes(id))) {
        throw new ApiError(kind === 'category' ? '分类不存在或已停用，请重新选择' : '标签不存在或已停用，请重新选择');
      }
    }
  }
  if (task.parent_id) {
    if (task.parent_id === task.id) throw new ApiError('后续事项不能以自身作为原任务');
    const parentTask = await db.prepare('SELECT deleted_at FROM tasks WHERE id=?').bind(task.parent_id).first<{ deleted_at: string | null }>();
    if (parentTask?.deleted_at && task.parent_id !== before?.parent_id) throw new ApiError('原任务已删除，请先恢复后再添加跟进', 409);
    const parent = await db.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM tasks WHERE id=? UNION
      SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
    ) SELECT id FROM ancestors`).bind(task.parent_id).all<{ id: string }>();
    if (parent.results.length === 0) throw new ApiError('原任务不存在');
    if (parent.results.some((ancestor) => ancestor.id === task.id)) throw new ApiError('后续事项不能形成循环关联');
  }
  return results;
}

// Re-check relations inside the write transaction: a taxonomy can be disabled or
// a parent can change after the read above. Existing disabled links may be kept.
function relationGuard(task: Task, status: Taxonomy, before?: Task): { sql: string; values: SqlValue[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM taxonomies WHERE id=? AND kind='status' AND is_closed=?
        AND (archived=0 OR id=?))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN taxonomies x ON x.id=j.value
        WHERE x.id IS NULL OR x.kind!='category' OR (x.archived!=0 AND NOT EXISTS
          (SELECT 1 FROM task_taxonomies tt WHERE tt.task_id=? AND tt.taxonomy_id=x.id)))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN taxonomies x ON x.id=j.value
        WHERE x.id IS NULL OR x.kind!='tag' OR (x.archived!=0 AND NOT EXISTS
          (SELECT 1 FROM task_taxonomies tt WHERE tt.task_id=? AND tt.taxonomy_id=x.id)))
      AND (? IS NULL OR (EXISTS (SELECT 1 FROM tasks WHERE id=? AND (deleted_at IS NULL OR id=?)) AND ?!=? AND NOT EXISTS (
        WITH RECURSIVE ancestors(id,parent_id) AS (
          SELECT id,parent_id FROM tasks WHERE id=? UNION
          SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
        ) SELECT 1 FROM ancestors WHERE id=?)))`,
    values: [
      task.status_id, status.is_closed, before?.status_id ?? '',
      JSON.stringify(task.category_ids), before?.id ?? '', JSON.stringify(task.tag_ids), before?.id ?? '',
      task.parent_id, task.parent_id, before?.parent_id ?? '', task.parent_id, task.id, task.parent_id, task.id,
    ],
  };
}

function linkStatements(db: D1Database, task: Task, activityId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM task_taxonomies WHERE task_id=? AND EXISTS (SELECT 1 FROM activities WHERE id=?)')
      .bind(task.id, activityId),
    db.prepare(`INSERT INTO task_taxonomies(task_id,taxonomy_id)
      SELECT ?,value FROM json_each(?) WHERE EXISTS (SELECT 1 FROM activities WHERE id=?)`)
      .bind(task.id, JSON.stringify([...task.category_ids, ...task.tag_ids]), activityId),
  ];
}

function taxonomyHistory(db: D1Database, before: Taxonomy, after: Taxonomy, marker: string, now: string): D1PreparedStatement[] {
  const kindName = { category: '分类', tag: '标签', status: '状态' }[after.kind];
  return [
    db.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
      SELECT ?||'-'||t.id,t.id,'taxonomy',?,?,? FROM tasks t
      WHERE changes()=1 AND (t.status_id=? OR EXISTS
        (SELECT 1 FROM task_taxonomies tt WHERE tt.task_id=t.id AND tt.taxonomy_id=?))`)
      .bind(marker, `${kindName}「${before.name}」的设置已更新`, JSON.stringify({ taxonomy: { before, after } }), now, after.id, after.id),
    db.prepare(`UPDATE tasks SET version=version+1,updated_at=?
      WHERE EXISTS (SELECT 1 FROM activities WHERE id=?||'-'||tasks.id)`)
      .bind(now, marker),
  ];
}

export const taskRoutes = new Hono<{ Bindings: Env }>();

taskRoutes.onError((error, c) => {
  if (error instanceof ApiError) return c.json({ error: error.message }, error.status);
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return c.json({ error: `输入无效${issue?.path.length ? `（${issue.path.join('.')}）` : ''}：${issue?.message ?? '请检查填写内容'}` }, 400);
  }
  if (error.message.includes('UNIQUE constraint failed: taxonomies.')) return c.json({ error: '同类名称已经存在，请使用其他名称或重新启用已有项' }, 409);
  console.error('task_api_failed', { message: error.message });
  return c.json({ error: '保存或读取失败，请稍后重试；原有数据仍保留' }, 500);
});

taskRoutes.get('/bootstrap', async (c) => {
  const [taxonomies, { settings }, usage] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY kind,sort_order,name COLLATE NOCASE,id').all<Taxonomy>(),
    settingsFromDb(c.env.DB),
    attachmentUsage(c.env.DB),
  ]);
  const push = Boolean(c.env.VAPID_PUBLIC_KEY?.trim() && c.env.VAPID_PRIVATE_KEY?.trim() && c.env.VAPID_SUBJECT?.trim());
  const bootstrap: Bootstrap = {
    taxonomies: taxonomies.results,
    settings: { ...settings, email_enabled: false },
    capabilities: { push, email: false, attachments: true, attachment_storage: 'd1', max_attachment_bytes: MAX_ATTACHMENT_BYTES,
      max_database_bytes: MAX_DATABASE_BYTES, used_database_bytes: usage.databaseUsed, used_attachment_bytes: usage.used,
      reserved_database_bytes: RESERVED_DATABASE_BYTES, available_attachment_bytes: usage.available },
    vapid_public_key: push ? c.env.VAPID_PUBLIC_KEY : null,
  };
  return c.json(bootstrap);
});

taskRoutes.get('/tasks', async (c) => {
  const query = z.object({
    q: z.string().trim().max(200).default(''),
    view: z.enum(['active', 'archive', 'all', 'trash']).default('active'),
    category: idSchema.optional(), tag: idSchema.optional(), status: idSchema.optional(),
    priority: z.coerce.number().int().min(1).max(4).optional(),
    due_from: isoDate.optional(), due_to: isoDate.optional(),
    received_from: isoDate.optional(), received_to: isoDate.optional(),
    sort: z.enum(['due_at', 'received_at', 'priority', 'status', 'category', 'tag']).default('due_at'),
    direction: z.enum(['asc', 'desc']).default('asc'),
  }).parse(Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== '')));
  const conditions: string[] = [query.view === 'trash' ? 't.deleted_at IS NOT NULL' : 't.deleted_at IS NULL'];
  const values: SqlValue[] = [];
  if (query.view === 'active') conditions.push('t.completed_at IS NULL');
  if (query.view === 'archive') conditions.push('t.completed_at IS NOT NULL');
  if (query.status) { conditions.push('t.status_id=?'); values.push(query.status); }
  if (query.priority !== undefined) { conditions.push('t.priority=?'); values.push(query.priority); }
  // Bounds are inclusive instants. Clients convert a selected calendar day using
  // their displayed timezone; undated tasks do not match a due-date range.
  for (const [column, from, to] of [
    ['due_at', query.due_from, query.due_to],
    ['received_at', query.received_from, query.received_to],
  ] as const) {
    if (from && to && from > to) throw new ApiError('筛选的开始时间不能晚于结束时间');
    if (from) { conditions.push(`t.${column}>=?`); values.push(from); }
    if (to) { conditions.push(`t.${column}<=?`); values.push(to); }
  }
  for (const [kind, id] of [['category', query.category], ['tag', query.tag]] as const) {
    if (id) {
      conditions.push(`EXISTS (SELECT 1 FROM task_taxonomies tt JOIN taxonomies x ON x.id=tt.taxonomy_id
        WHERE tt.task_id=t.id AND x.kind=? AND x.id=?)`);
      values.push(kind, id);
    }
  }
  if (query.q) {
    // Literal substring matching works for Chinese without a word tokenizer.
    // Escape SQL LIKE metacharacters so searching %, _ or a backslash is literal.
    const pattern = `%${query.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    const match = (expression: string) => `lower(COALESCE(${expression},'')) LIKE ? ESCAPE '\\'`;
    const taskText = `t.title||' '||t.description||' '||t.notes||' '||t.id||' '||t.received_at||' '||
      COALESCE(t.due_at,'')||' '||t.created_at||' '||t.updated_at||' '||COALESCE(t.completed_at,'')`;
    conditions.push(`(${match(taskText)} OR EXISTS (SELECT 1 FROM taxonomies x WHERE x.id=t.status_id AND ${match('x.name')})
      OR EXISTS (SELECT 1 FROM task_taxonomies tt JOIN taxonomies x ON x.id=tt.taxonomy_id
        WHERE tt.task_id=t.id AND ${match('x.name')})
      OR EXISTS (SELECT 1 FROM activities a WHERE a.task_id=t.id AND ${match("a.content||' '||COALESCE(a.changes,'')||' '||a.created_at")})
      OR EXISTS (SELECT 1 FROM attachments a WHERE a.task_id=t.id AND ${match("a.name||' '||a.mime||' '||a.created_at")}))`);
    values.push(pattern, pattern, pattern, pattern, pattern);
  }
  const sortExpression: Record<typeof query.sort, string> = {
    due_at: 't.due_at', received_at: 't.received_at', priority: 't.priority',
    status: '(SELECT sort_order FROM taxonomies WHERE id=t.status_id)',
    category: `(SELECT MIN(x.name COLLATE NOCASE) FROM task_taxonomies tt JOIN taxonomies x ON x.id=tt.taxonomy_id WHERE tt.task_id=t.id AND x.kind='category')`,
    tag: `(SELECT MIN(x.name COLLATE NOCASE) FROM task_taxonomies tt JOIN taxonomies x ON x.id=tt.taxonomy_id WHERE tt.task_id=t.id AND x.kind='tag')`,
  };
  const sort = sortExpression[query.sort];
  const direction = query.direction === 'desc' ? 'DESC' : 'ASC';
  const result = await c.env.DB.prepare(`${TASK_SELECT}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY (${sort} IS NULL) ASC,${sort} COLLATE NOCASE ${direction},t.created_at DESC,t.id ASC`)
    .bind(...values).all<TaskRow>();
  return c.json({ tasks: result.results.map(toTask) });
});

taskRoutes.post('/tasks', async (c) => {
  const input = createTaskSchema.parse(await readJson(c.req.raw));
  const { settings } = await settingsFromDb(c.env.DB);
  const defaultStatus = input.status_id ? undefined : await c.env.DB.prepare(`SELECT id FROM taxonomies
    WHERE kind='status' AND archived=0 ORDER BY is_closed,sort_order,name,id LIMIT 1`).first<{ id: string }>();
  if (!input.status_id && !defaultStatus) throw new ApiError('请先创建一个可用状态');
  const now = new Date().toISOString();
  const task: Task = {
    id: crypto.randomUUID(), title: input.title, description: input.description ?? '', notes: input.notes ?? '',
    status_id: input.status_id ?? defaultStatus!.id, priority: input.priority ?? 2, progress: input.progress ?? 0,
    received_at: input.received_at ?? now, due_at: input.due_at ?? null,
    created_at: now, updated_at: now, completed_at: null, deleted_at: null, parent_id: input.parent_id ?? null, version: 1,
    category_ids: input.category_ids ?? [], tag_ids: input.tag_ids ?? [],
    reminder_offsets: input.reminder_offsets ?? settings.default_reminder_offsets,
    overdue_interval: input.overdue_interval ?? settings.default_overdue_interval,
  };
  const taxonomies = await validateRelations(c.env.DB, task);
  const status = taxonomies.find((taxonomy) => taxonomy.id === task.status_id)!;
  task.completed_at = status.is_closed ? now : null;
  const guard = relationGuard(task, status);
  const activityId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO tasks(id,title,description,notes,status_id,priority,progress,received_at,due_at,
      created_at,updated_at,completed_at,parent_id,version,reminder_offsets,overdue_interval)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard.sql}`)
      .bind(task.id, task.title, task.description, task.notes, task.status_id, task.priority, task.progress,
        task.received_at, task.due_at, task.created_at, task.updated_at, task.completed_at, task.parent_id,
        task.version, JSON.stringify(task.reminder_offsets), task.overdue_interval, ...guard.values),
    c.env.DB.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
      SELECT ?,?,'created','创建任务',?,? WHERE changes()=1`)
      .bind(activityId, task.id, JSON.stringify({ task: { before: null, after: task }, taxonomies }), now),
    ...linkStatements(c.env.DB, task, activityId),
  ]);
  if (results[0].meta.changes !== 1) throw new ApiError('状态、分类或原任务刚刚发生变化，请刷新后重试', 409);
  return c.json({ task: await taskById(c.env.DB, task.id) }, 201);
});

const taskVersionSchema = z.object({ version: z.number().int().positive() }).strict();
const selectedTaskSchema = taskVersionSchema.extend({ id: idSchema });
const bulkDeleteSchema = z.object({ tasks: z.array(selectedTaskSchema).min(1).max(100)
  .refine(tasks => new Set(tasks.map(task => task.id)).size === tasks.length, '请勿重复选择同一任务') }).strict();

async function deleteTasks(db: D1Database, selected: z.output<typeof selectedTaskSchema>[]): Promise<void> {
  const encoded = JSON.stringify(selected);
  const existing = await db.prepare(`SELECT id,version,deleted_at FROM tasks
    WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`)
    .bind(encoded).all<{ id: string; version: number; deleted_at: string | null }>();
  if (existing.results.length !== selected.length) throw new ApiError('部分任务不存在，请刷新后重新选择', 404);
  if (existing.results.some(task => task.deleted_at || selected.find(item => item.id === task.id)?.version !== task.version)) {
    throw new ApiError('部分任务已更新或已删除，本次未删除任何任务，请刷新后重新选择', 409);
  }
  const marker = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await db.batch([
    // This single statement rechecks the entire selection in the same write
    // transaction. A concurrent edit/delete prevents every history marker, so
    // later statements cannot partially delete the remaining tasks.
    db.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
      SELECT ?||'-'||t.id,t.id,'deleted','移入回收站',
        json_object('deleted_at',json_object('before',NULL,'after',?),
          'version',json_object('before',t.version,'after',t.version+1)),?
      FROM tasks t JOIN json_each(?) selected ON t.id=json_extract(selected.value,'$.id')
      WHERE NOT EXISTS (SELECT 1 FROM json_each(?) requested
        LEFT JOIN tasks current ON current.id=json_extract(requested.value,'$.id')
        WHERE current.id IS NULL OR current.deleted_at IS NOT NULL
          OR current.version!=json_extract(requested.value,'$.version'))`)
      .bind(marker, now, now, encoded, encoded),
    db.prepare(`UPDATE tasks SET deleted_at=?,updated_at=?,version=version+1
      WHERE EXISTS (SELECT 1 FROM activities WHERE id=?||'-'||tasks.id)`)
      .bind(now, now, marker),
    db.prepare(`UPDATE notifications SET status='cancelled',lease_until=NULL,next_attempt_at=NULL,last_error='任务已移入回收站，提醒已取消'
      WHERE status IN ('pending','retry','processing') AND EXISTS
        (SELECT 1 FROM activities WHERE id=?||'-'||notifications.task_id)`)
      .bind(marker),
  ]);
  if (results[0].meta.changes !== selected.length) {
    throw new ApiError('部分任务已更新或已删除，本次未删除任何任务，请刷新后重新选择', 409);
  }
}

taskRoutes.post('/tasks/bulk-delete', async (c) => {
  const input = bulkDeleteSchema.parse(await readJson(c.req.raw));
  await deleteTasks(c.env.DB, input.tasks);
  return c.json({ ok: true, deleted_count: input.tasks.length });
});

taskRoutes.delete('/tasks/:id', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const { version } = taskVersionSchema.parse(await readJson(c.req.raw));
  await deleteTasks(c.env.DB, [{ id, version }]);
  return c.json({ task: await taskById(c.env.DB, id) });
});

taskRoutes.post('/tasks/:id/restore', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const { version } = taskVersionSchema.parse(await readJson(c.req.raw));
  const before = await taskById(c.env.DB, id);
  if (!before.deleted_at || before.version !== version) throw new ApiError('任务已更新或已恢复，请刷新后重试', 409);
  const now = new Date().toISOString();
  const activityId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE tasks SET deleted_at=NULL,updated_at=?,version=version+1
      WHERE id=? AND version=? AND deleted_at IS NOT NULL`).bind(now, id, version),
    c.env.DB.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
      SELECT ?,?,'restored','从回收站恢复任务',?,? WHERE changes()=1`)
      .bind(activityId, id, JSON.stringify({ deleted_at: { before: before.deleted_at, after: null },
        version: { before: version, after: version + 1 } }), now),
  ]);
  if (results[0].meta.changes !== 1) throw new ApiError('任务已更新或已恢复，请刷新后重试', 409);
  return c.json({ task: await taskById(c.env.DB, id) });
});

taskRoutes.get('/tasks/:id', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`${TASK_SELECT} WHERE t.id=?`).bind(id),
    c.env.DB.prepare('SELECT * FROM activities WHERE task_id=? ORDER BY created_at DESC,rowid DESC').bind(id),
    c.env.DB.prepare('SELECT id,task_id,name,mime,size,created_at FROM attachments WHERE task_id=? ORDER BY created_at DESC,id').bind(id),
    c.env.DB.prepare(`${TASK_SELECT} WHERE t.parent_id=? AND t.deleted_at IS NULL ORDER BY t.created_at,t.id`).bind(id),
  ]);
  const task = results[0].results[0] as TaskRow | undefined;
  if (!task) throw new ApiError('找不到此任务', 404);
  return c.json({ task: toTask(task), activities: results[1].results, attachments: results[2].results,
    followups: (results[3].results as TaskRow[]).map(toTask) });
});

taskRoutes.patch('/tasks/:id', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const { version, ...input } = patchTaskSchema.parse(await readJson(c.req.raw));
  const before = await taskById(c.env.DB, id);
  if (before.deleted_at) throw new ApiError('任务在回收站中，请恢复后再修改', 409);
  if (before.version !== version) throw new ApiError('任务已在其他操作中更新，请刷新后再保存', 409);
  const now = new Date().toISOString();
  const task: Task = { ...before, ...input, version: version + 1, updated_at: now };
  const taxonomies = await validateRelations(c.env.DB, task, before);
  const status = taxonomies.find((taxonomy) => taxonomy.id === task.status_id)!;
  task.completed_at = status.is_closed ? before.completed_at ?? now : null;
  const changes = changedFields(before, task);
  if (!Object.keys(changes).length) return c.json({ task: before });
  const guard = relationGuard(task, status, before);
  const activityId = crypto.randomUUID();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE tasks SET title=?,description=?,notes=?,status_id=?,priority=?,progress=?,received_at=?,
      due_at=?,updated_at=?,completed_at=?,parent_id=?,version=version+1,reminder_offsets=?,overdue_interval=?
      WHERE id=? AND version=? AND deleted_at IS NULL AND ${guard.sql}`)
      .bind(task.title, task.description, task.notes, task.status_id, task.priority, task.progress,
        task.received_at, task.due_at, now, task.completed_at, task.parent_id, JSON.stringify(task.reminder_offsets),
        task.overdue_interval, id, version, ...guard.values),
    // The unique history id is the transaction's success marker. A version miss
    // cannot modify links or produce phantom history in the remaining statements.
    c.env.DB.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
      SELECT ?,?,'updated',?,?,? WHERE changes()=1`)
      .bind(activityId, id, task.completed_at && !before.completed_at ? '完成任务并归档' :
        !task.completed_at && before.completed_at ? '重新打开任务' : '更新任务',
        JSON.stringify({ ...changes, version: { before: version, after: task.version } }), now),
    ...linkStatements(c.env.DB, task, activityId),
  ]);
  if (results[0].meta.changes !== 1) throw new ApiError('任务或相关设置已改变，请刷新后再保存', 409);
  return c.json({ task: await taskById(c.env.DB, id) });
});

taskRoutes.post('/tasks/:id/activities', async (c) => {
  const taskId = idSchema.parse(c.req.param('id'));
  const input = z.object({ kind: z.enum(['progress', 'communication', 'note']),
    content: z.string().trim().min(1).max(20000) }).strict().parse(await readJson(c.req.raw));
  const current = await taskById(c.env.DB, taskId);
  if (current.deleted_at) throw new ApiError('任务在回收站中，请恢复后再添加记录', 409);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO activities(id,task_id,kind,content,changes,created_at)
      SELECT ?,id,?,?,json_object('version',json_object('before',version,'after',version+1)),? FROM tasks WHERE id=? AND deleted_at IS NULL`)
      .bind(id, input.kind, input.content, now, taskId),
    c.env.DB.prepare(`UPDATE tasks SET version=version+1,updated_at=?
      WHERE id=? AND EXISTS (SELECT 1 FROM activities WHERE id=?)`).bind(now, taskId, id),
    c.env.DB.prepare('SELECT * FROM activities WHERE id=?').bind(id),
  ]);
  if (results[0].meta.changes !== 1) throw new ApiError('任务已删除，请刷新后重试', 409);
  return c.json({ activity: results[2].results[0] }, 201);
});

taskRoutes.post('/tasks/:id/attachments', async (c) => {
  const taskId = idSchema.parse(c.req.param('id'));
  const current = await taskById(c.env.DB, taskId);
  if (current.deleted_at) throw new ApiError('任务在回收站中，请恢复后再上传附件', 409);
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    const result = await uploadRawAttachment(c.env, taskId, c.req.raw);
    return c.json({ attachment: result.attachment }, result.reused ? 200 : 201);
  }
  const body = await boundedBody(c.req.raw, LEGACY_ATTACHMENT_BYTES + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch { throw new ApiError('文件上传格式不正确'); }
  const files = form.getAll('file');
  if (files.length !== 1 || !(files[0] instanceof File)) throw new ApiError('每次请选择一个文件');
  const file = files[0];
  if (file.size === 0) throw new ApiError('不能上传空文件');
  if (file.size > LEGACY_ATTACHMENT_BYTES) throw new ApiError('旧版上传接口最多 1 MiB；请刷新页面使用 1.99 MB 上传接口', 413);
  const name = fileName(file.name);
  const mime = fileMime(file.type);
  const attachment: Attachment = { id: crypto.randomUUID(), task_id: taskId, name, mime,
    size: file.size, created_at: new Date().toISOString() };
  const result = await storeD1Attachment(c.env.DB, attachment, await file.arrayBuffer());
  return c.json({ attachment: result.attachment }, result.reused ? 200 : 201);
});

taskRoutes.get('/attachments/:id', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const attachment = await c.env.DB.prepare('SELECT name,mime,size,content,storage_key FROM attachments WHERE id=?')
    .bind(id).first<{ name: string; mime: string; size: number; content: number[] | ArrayBuffer; storage_key: string | null }>();
  if (!attachment) throw new ApiError('附件不存在', 404);
  if (attachment.storage_key) throw new ApiError('此附件不在当前数据库中，请联系管理员恢复文件', 503);
  const bytes = attachment.content instanceof ArrayBuffer ? attachment.content : new Uint8Array(attachment.content);
  if (bytes.byteLength !== attachment.size) throw new ApiError('附件文件不完整，请联系管理员恢复文件', 503);
  const asciiName = attachment.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encodedName = encodeURIComponent(attachment.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(bytes, { headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    'Content-Length': String(attachment.size), 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
});

taskRoutes.post('/taxonomies', async (c) => {
  const input = createTaxonomySchema.parse(await readJson(c.req.raw));
  if (input.kind !== 'status' && input.is_closed) throw new ApiError('只有状态可以标记为完成');
  const taxonomy: Taxonomy = { id: crypto.randomUUID(), kind: input.kind, name: input.name,
    color: input.color ?? '#64748b', is_closed: input.is_closed ?? 0,
    sort_order: input.sort_order ?? 0, archived: input.archived ?? 0 };
  const result = await c.env.DB.prepare(`INSERT INTO taxonomies(id,kind,name,color,is_closed,sort_order,archived)
    SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM taxonomies WHERE kind=? AND lower(name)=lower(?))`)
    .bind(taxonomy.id, taxonomy.kind, taxonomy.name, taxonomy.color, taxonomy.is_closed, taxonomy.sort_order,
      taxonomy.archived, taxonomy.kind, taxonomy.name).run();
  if (result.meta.changes !== 1) throw new ApiError('同类名称已经存在，请使用其他名称或重新启用已有项', 409);
  return c.json({ taxonomy }, 201);
});

async function updateTaxonomy(db: D1Database, id: string, input: z.output<typeof patchTaxonomySchema>): Promise<Taxonomy> {
  const before = await db.prepare('SELECT * FROM taxonomies WHERE id=?').bind(id).first<Taxonomy>();
  if (!before) throw new ApiError('此分类、标签或状态不存在', 404);
  const after = { ...before, ...input };
  if (after.kind !== 'status' && after.is_closed) throw new ApiError('只有状态可以标记为完成');
  if (after.kind === 'status' && before.is_closed !== after.is_closed) {
    const used = await db.prepare('SELECT id FROM tasks WHERE status_id=? LIMIT 1').bind(id).first<{ id: string }>();
    if (used) throw new ApiError('该状态已有任务使用，不能改变其完成含义；请新建状态，再手动迁移任务', 409);
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return before;
  const now = new Date().toISOString();
  const marker = crypto.randomUUID();
  const results = await db.batch([
    db.prepare(`UPDATE taxonomies SET name=?,color=?,is_closed=?,sort_order=?,archived=?
      WHERE id=? AND name=? AND color=? AND is_closed=? AND sort_order=? AND archived=?
      AND (is_closed=? OR NOT EXISTS (SELECT 1 FROM tasks WHERE status_id=?))
      AND NOT EXISTS (SELECT 1 FROM taxonomies x WHERE x.id!=? AND x.kind=? AND lower(x.name)=lower(?))
      AND (?=0 OR kind!='status' OR EXISTS (SELECT 1 FROM taxonomies x WHERE x.id!=? AND x.kind='status' AND x.archived=0))`)
      .bind(after.name, after.color, after.is_closed, after.sort_order, after.archived,
        id, before.name, before.color, before.is_closed, before.sort_order, before.archived,
        after.is_closed, id, id, after.kind, after.name, after.archived, id),
    ...taxonomyHistory(db, before, after, marker, now),
  ]);
  if (results[0].meta.changes !== 1) throw new ApiError('保存失败：名称已存在、状态正在使用或已被修改；至少保留一个可用状态。请刷新后重试', 409);
  return after;
}

taskRoutes.patch('/taxonomies/:id', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const input = patchTaxonomySchema.parse(await readJson(c.req.raw));
  return c.json({ taxonomy: await updateTaxonomy(c.env.DB, id, input) });
});

taskRoutes.delete('/taxonomies/:id', async (c) => {
  const id = idSchema.parse(c.req.param('id'));
  const taxonomy = await updateTaxonomy(c.env.DB, id, { archived: 1 });
  return c.json({ ok: true, taxonomy });
});

taskRoutes.patch('/settings', async (c) => {
  const input = settingsSchema.partial().parse(await readJson(c.req.raw));
  if (input.email_enabled) throw new ApiError('此试用版尚未接通邮件服务，请使用设备推送提醒');
  const { settings: before, raw } = await settingsFromDb(c.env.DB);
  const settings: AppSettings = { ...before, ...input, email_enabled: false };
  const result = await c.env.DB.prepare('UPDATE settings SET value=? WHERE id=1 AND value=?')
    .bind(JSON.stringify(settings), raw).run();
  if (result.meta.changes !== 1) throw new ApiError('设置已被修改，请刷新后重试', 409);
  return c.json({ settings });
});

taskRoutes.get('/export', async (c) => {
  // One read transaction gives a coherent export; never include sessions, secrets,
  // push endpoints, or attachment bytes in the JSON export.
  const results = await c.env.DB.batch([
    c.env.DB.prepare(`${TASK_SELECT} ORDER BY t.created_at,t.id`),
    c.env.DB.prepare('SELECT * FROM taxonomies ORDER BY kind,sort_order,id'),
    c.env.DB.prepare('SELECT * FROM activities ORDER BY created_at,id'),
    c.env.DB.prepare('SELECT id,task_id,name,mime,size,created_at FROM attachments ORDER BY created_at,id'),
    c.env.DB.prepare('SELECT value FROM settings WHERE id=1'),
    c.env.DB.prepare(`SELECT id,task_id,title,body,channel,status,scheduled_at,created_at,sent_at,attempts,last_error
      FROM notifications ORDER BY created_at,id`),
  ]);
  const settingsRow = results[4].results[0] as { value: string } | undefined;
  const exportedAt = new Date().toISOString();
  c.header('Content-Disposition', `attachment; filename="task-workbench-${exportedAt.slice(0, 10)}.json"`);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ format: 'task-workbench', format_version: 1, exported_at: exportedAt,
    attachment_bytes_included: false,
    attachment_download_instructions: '本文件包含附件信息，不含文件内容；请登录系统后下载 /api/attachments/{id}（回收站附件仍可下载）。完整恢复另需 D1 数据库备份（含附件文件）。',
    tasks: (results[0].results as TaskRow[]).map(toTask), taxonomies: results[1].results,
    activities: results[2].results, attachments: results[3].results,
    settings: settingsRow ? settingsSchema.parse(JSON.parse(settingsRow.value)) : null,
    notifications: results[5].results,
  });
});
