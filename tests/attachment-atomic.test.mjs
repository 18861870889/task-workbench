import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { uploadRawAttachment } from '../worker/attachments.ts';

function database() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(name, directory), 'utf8'));
  const sizeAfter = () => sql.prepare('PRAGMA page_count').get().page_count * sql.prepare('PRAGMA page_size').get().page_size;
  const prepare = (query, bindings = []) => {
    const execute = () => {
      const statement = sql.prepare(query);
      if (statement.columns().length) return { success: true, results: statement.all(...bindings), meta: { changes: 0, size_after: sizeAfter() } };
      const result = statement.run(...bindings);
      return { success: true, results: [], meta: { changes: Number(result.changes), size_after: sizeAfter() } };
    };
    return {
      bind: (...values) => prepare(query, values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)),
      execute,
      async first(column) { const row = sql.prepare(query).get(...bindings); return column ? row?.[column] ?? null : row ?? null; },
      async all() { return execute(); },
      async run() { return execute(); },
    };
  };
  const DB = { prepare, async batch(statements) {
    sql.exec('BEGIN');
    try { const results = statements.map(statement => statement.execute()); sql.exec('COMMIT'); return results; }
    catch (error) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw error; }
  } };
  const now = new Date().toISOString();
  sql.prepare("INSERT INTO tasks(id,title,status_id,received_at,created_at,updated_at) VALUES('task','D1附件原子提交',?,?,?,?)")
    .run('status-todo', now, now, now);
  return { sql, DB };
}

function uploadRequest(id = crypto.randomUUID(), name = 'file.txt', bytes = Buffer.from('abc')) {
  return new Request('https://tasks.example.com/api/tasks/task/attachments', {
    method: 'POST', headers: {
      'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name),
      'X-File-Size': String(bytes.length), 'X-Upload-Id': id,
    }, body: bytes,
  });
}

function assertUnchanged(sql, before) {
  assert.equal(sql.prepare('SELECT count(*) AS count FROM attachments').get().count, 0);
  assert.equal(sql.prepare('SELECT count(*) AS count FROM activities').get().count, 0);
  assert.deepEqual(sql.prepare('SELECT * FROM tasks').get(), before);
}

test('actual D1 upload reader rejects short and oversized declared streams before any database write', async () => {
  const { sql, DB } = database();
  try {
    const before = sql.prepare('SELECT * FROM tasks').get();
    let databaseAccesses = 0;
    const unreadDatabase = {
      prepare() { databaseAccesses++; throw new Error('Malformed streams must be rejected before reading D1'); },
      batch() { databaseAccesses++; throw new Error('Malformed streams must be rejected before writing D1'); },
    };
    for (const declared of [2, 4]) {
      const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
      const request = new Request('https://tasks.example.com/api/tasks/task/attachments', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'mismatch.bin', 'X-File-Size': String(declared) }, body, duplex: 'half',
      });
      await assert.rejects(uploadRawAttachment({ DB: unreadDatabase }, 'task', request), error => error.status === 400);
      assert.equal(databaseAccesses, 0);
      assertUnchanged(sql, before);
    }
  } finally { sql.close(); }
});

test('D1 upload rolls back attachment bytes, history and task version when either later write fails', async () => {
  for (const trigger of [
    "CREATE TRIGGER reject_history BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'injected history failure'); END",
    "CREATE TRIGGER reject_version BEFORE UPDATE OF version ON tasks BEGIN SELECT RAISE(ABORT,'injected version failure'); END",
  ]) {
    const { sql, DB } = database();
    try {
      const before = sql.prepare('SELECT * FROM tasks').get();
      sql.exec(trigger);
      await assert.rejects(uploadRawAttachment({ DB }, 'task', uploadRequest()), /injected (history|version) failure/);
      assertUnchanged(sql, before);
    } finally { sql.close(); }
  }
});

test('a full D1 database rejects the upload without leaving metadata, history or a version change', async () => {
  const { sql, DB } = database();
  try {
    const before = sql.prepare('SELECT * FROM tasks').get();
    const pages = sql.prepare('PRAGMA page_count').get().page_count;
    sql.exec(`PRAGMA max_page_count=${pages}`);
    await assert.rejects(uploadRawAttachment({ DB }, 'task', uploadRequest(crypto.randomUUID(), 'full.bin', Buffer.alloc(64 * 1024, 0x6b))), error => error.status === 413);
    assertUnchanged(sql, before);
  } finally { sql.close(); }
});

test('concurrent D1 uploads of the same ID produce one blob, one history record and one version increment', async () => {
  const { sql, DB } = database();
  try {
    const id = crypto.randomUUID();
    const results = await Promise.all([1, 2].map(() => uploadRawAttachment({ DB }, 'task', uploadRequest(id))));
    assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
    for (const result of results) assert.equal(result.attachment.id, id);
    const attachment = sql.prepare('SELECT * FROM attachments').get();
    assert.equal(attachment.id, id);
    assert.deepEqual(Buffer.from(attachment.content), Buffer.from('abc'));
    assert.equal(sql.prepare('SELECT count(*) AS count FROM attachments').get().count, 1);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM activities').get().count, 1);
    assert.equal(sql.prepare('SELECT version FROM tasks').get().version, 2);
  } finally { sql.close(); }
});

test('a lost D1 commit response can be retried with the same ID without duplicating the saved file or history', async () => {
  const { sql, DB } = database();
  let dropResponse = true;
  const interruptedDB = { ...DB, async batch(statements) {
    const result = await DB.batch(statements);
    if (dropResponse && sql.prepare('SELECT count(*) AS count FROM attachments').get().count > 0) {
      dropResponse = false; throw new Error('response lost after commit');
    }
    return result;
  } };
  try {
    const id = crypto.randomUUID();
    // The uploader may recover by reading its committed row, or report an
    // uncertain response. In either case the same-ID retry must be safe.
    await uploadRawAttachment({ DB: interruptedDB }, 'task', uploadRequest(id)).catch(() => {});
    assert.equal(dropResponse, false);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM attachments').get().count, 1);
    const retry = await uploadRawAttachment({ DB }, 'task', uploadRequest(id));
    assert.equal(retry.reused, true);
    assert.equal(retry.attachment.id, id);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM attachments').get().count, 1);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM activities').get().count, 1);
    assert.equal(sql.prepare('SELECT version FROM tasks').get().version, 2);
    assert.deepEqual(Buffer.from(sql.prepare('SELECT content FROM attachments').get().content), Buffer.from('abc'));
  } finally { sql.close(); }
});

test('competing D1 capacity snapshots cannot partially commit a second upload and its retry remains safe', async () => {
  const { sql, DB } = database();
  try {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.allSettled(ids.map((id, index) => uploadRawAttachment({ DB }, 'task', uploadRequest(id, `${index}.txt`))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failedIndex = results.findIndex(result => result.status === 'rejected');
    assert.equal(results[failedIndex].reason.status, 409);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM attachments').get().count, 1);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM activities').get().count, 1);
    assert.equal(sql.prepare('SELECT version FROM tasks').get().version, 2);
    const retry = await uploadRawAttachment({ DB }, 'task', uploadRequest(ids[failedIndex], `${failedIndex}.txt`));
    assert.equal(retry.reused, false);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM attachments').get().count, 2);
    assert.equal(sql.prepare('SELECT count(*) AS count FROM activities').get().count, 2);
    assert.equal(sql.prepare('SELECT version FROM tasks').get().version, 3);
  } finally { sql.close(); }
});
