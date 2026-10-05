import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { isAllowedPushEndpoint, latestReminder, notificationsRoutes, runReminders } from '../worker/notifications.ts';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const schema = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
  .map(name => readFileSync(new URL(name, migrationDirectory), 'utf8')).join('\n');
const iso = (offsetMinutes = 0) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(schema);
  const prepare = (query, bindings = []) => ({
    bind: (...values) => prepare(query, values),
    async first() { return sql.prepare(query).get(...bindings) ?? null; },
    async all() { return { results: sql.prepare(query).all(...bindings), success: true }; },
    async run() { const result = sql.prepare(query).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
  });
  return { sql, DB: { prepare, async batch(statements) { return Promise.all(statements.map(s => s.run())); } } };
}

async function keyMaterial() {
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const vapidPrivate = await crypto.subtle.exportKey('jwk', vapid.privateKey);
  const subscription = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return {
    VAPID_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url'),
    VAPID_PRIVATE_KEY: vapidPrivate.d,
    VAPID_SUBJECT: 'mailto:test@example.com',
    p256dh: Buffer.from(await crypto.subtle.exportKey('raw', subscription.publicKey)).toString('base64url'),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
}
const keys = await keyMaterial();

function fixture() {
  const db = database();
  return { ...db, env: { DB: db.DB, ...keys, APP_ORIGIN: 'https://tasks.example.com' } };
}
function addSubscription(sql, id = 'device-one', endpoint = 'https://web.push.apple.com/valid-token') {
  sql.prepare('INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)')
    .run(id, endpoint, keys.p256dh, keys.auth, iso(-20_000));
}
function addTask(sql, id = 'task-one', overrides = {}) {
  const task = { id, title: '测试任务', due_at: iso(60), created_at: iso(-10_000), reminder_offsets: '[4320,1440,0]', overdue_interval: 1440, ...overrides };
  sql.prepare(`INSERT INTO tasks(id,title,status_id,received_at,due_at,created_at,updated_at,reminder_offsets,overdue_interval)
    VALUES(?,?,'status-todo',?,?,?,?,?,?)`).run(task.id, task.title, task.created_at, task.due_at, task.created_at, task.created_at, task.reminder_offsets, task.overdue_interval);
}
async function withFetch(fn, action) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await action(); } finally { globalThis.fetch = original; }
}

test('push endpoint validation rejects SSRF, user-info, ports and misleading suffixes', () => {
  for (const url of ['https://web.push.apple.com/token', 'https://fcm.googleapis.com/token', 'https://updates.push.services.mozilla.com/token', 'https://eu.updates.push.services.mozilla.com/token']) assert.equal(isAllowedPushEndpoint(url), true);
  for (const url of ['http://web.push.apple.com/token', 'https://127.0.0.1/', 'https://web.push.apple.com.evil.test/', 'https://fcm.googleapis.com@localhost/', 'https://web.push.apple.com:8443/token', 'https://web.push.apple.com/token#fragment', 'https://evilpush.apple.com/']) assert.equal(isAllowedPushEndpoint(url), false, url);
});

test('new task does not replay offsets before creation; downtime chooses only latest relevant window', () => {
  const now = Date.now();
  const task = { id: 't', title: '任务', due_at: new Date(now + 60 * 60_000).toISOString(), created_at: new Date(now - 1_000).toISOString(), completed_at: null, is_closed: 0, reminder_offsets: '[4320,1440,0]', overdue_interval: 1440 };
  const sub = { id: 's', created_at: new Date(now - 10_000_000).toISOString() };
  assert.equal(latestReminder(task, sub, now), null);
  task.created_at = new Date(now - 10 * 86400_000).toISOString();
  sub.created_at = task.created_at;
  task.due_at = new Date(now - 3.5 * 86400_000).toISOString();
  const current = latestReminder(task, sub, now);
  assert.equal(JSON.parse(current.key)[2], 'overdue');
  assert.equal(JSON.parse(current.key)[4], 3);
  task.is_closed = 1;
  assert.equal(latestReminder(task, sub, now), null);
});

test('cron with no device creates no fake successful delivery', async () => {
  const { sql, env } = fixture();
  addTask(sql);
  await withFetch(() => { throw new Error('must not send'); }, () => runReminders(env));
  assert.equal(sql.prepare('SELECT count(*) AS count FROM notifications').get().count, 0);
  sql.close();
});

test('SQL queue and JS validation agree, and unrelated edits cannot replay a reminder', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  let sends = 0;
  await withFetch(async (url, init) => {
    sends++;
    assert.equal(url, 'https://web.push.apple.com/valid-token');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get('content-encoding'), 'aes128gcm');
    return new Response(null, { status: 201 });
  }, async () => {
    await runReminders(env);
    sql.prepare("UPDATE tasks SET notes='新增备注',version=version+1").run();
    await runReminders(env);
  });
  assert.equal(sends, 1);
  assert.equal(sql.prepare('SELECT status FROM notifications').get().status, 'sent');
  sql.close();
});

test('missed overdue windows coalesce rather than flood, with a separate record per device', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addSubscription(sql, 'device-two', 'https://fcm.googleapis.com/second');
  addTask(sql, 'overdue', { due_at: iso(-3.5 * 1440) });
  let sends = 0;
  await withFetch(async () => { sends++; return new Response(null, { status: 201 }); }, async () => {
    await runReminders(env);
    await runReminders(env);
  });
  assert.equal(sends, 2);
  const jobs = sql.prepare('SELECT reminder_key,status FROM notifications').all();
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    assert.equal(job.status, 'sent');
    assert.equal(JSON.parse(job.reminder_key)[4], 3);
  }
  sql.close();
});

test('each cron sends at most two jobs and leaves the rest durably queued', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  for (let i = 0; i < 5; i++) addTask(sql, `t-${i}`);
  let sends = 0;
  await withFetch(async () => { sends++; return new Response(null, { status: 201 }); }, () => runReminders(env));
  assert.equal(sends, 2);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM notifications WHERE status='pending'").get().count, 3);
  sql.close();
});

test('changed deadline cancels an old retry without contacting a push service', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  await withFetch(async () => new Response(null, { status: 503 }), () => runReminders(env));
  assert.equal(sql.prepare('SELECT status,attempts FROM notifications').get().status, 'retry');
  sql.prepare('UPDATE tasks SET due_at=?,version=version+1').run(iso(20_000));
  sql.prepare('UPDATE notifications SET next_attempt_at=?').run(iso(-1));
  await withFetch(() => { throw new Error('stale reminder must not send'); }, () => runReminders(env));
  assert.equal(sql.prepare('SELECT status FROM notifications').get().status, 'cancelled');
  sql.close();
});

test('a deleted task never enters the reminder queue or passes send-time validation', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  sql.prepare('UPDATE tasks SET deleted_at=?').run(iso(-1));
  const task = sql.prepare('SELECT t.*,s.is_closed FROM tasks t JOIN taxonomies s ON s.id=t.status_id').get();
  assert.equal(latestReminder(task, { id: 'device-one', created_at: iso(-20_000) }, Date.now()), null);
  await withFetch(() => { throw new Error('deleted task must not send'); }, () => runReminders(env));
  assert.equal(sql.prepare('SELECT count(*) AS count FROM notifications').get().count, 0);
  sql.close();
});

test('deletion cancels a queued retry and restoration does not replay that cancelled occurrence', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  await withFetch(async () => new Response(null, { status: 503 }), () => runReminders(env));
  const queued = sql.prepare('SELECT * FROM notifications').get();
  assert.equal(queued.status, 'retry');
  sql.prepare('UPDATE tasks SET deleted_at=?,version=version+1').run(iso());
  sql.prepare('UPDATE notifications SET next_attempt_at=?').run(iso(-1));
  await withFetch(() => { throw new Error('deleted retry must not send'); }, () => runReminders(env));
  assert.equal(sql.prepare('SELECT status FROM notifications WHERE id=?').get(queued.id).status, 'cancelled');
  sql.prepare('UPDATE tasks SET deleted_at=NULL,version=version+1').run();
  await withFetch(() => { throw new Error('restoration must not replay a cancelled occurrence'); }, () => runReminders(env));
  assert.equal(sql.prepare('SELECT count(*) AS count FROM notifications').get().count, 1);
  // A later deadline is a new reminder occurrence; reminders resume after restoration.
  sql.prepare('UPDATE tasks SET due_at=?,version=version+1').run(iso(120));
  let sends = 0;
  await withFetch(async () => { sends++; return new Response(null, { status: 201 }); }, () => runReminders(env));
  assert.equal(sends, 1);
  assert.equal(sql.prepare("SELECT count(*) AS count FROM notifications WHERE status='sent'").get().count, 1);
  sql.close();
});

test('restoring a task resumes the current undelivered reminder once and preserves sent history', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  sql.prepare('UPDATE tasks SET deleted_at=?').run(iso(-1));
  await withFetch(() => { throw new Error('deleted task must not send'); }, () => runReminders(env));
  sql.prepare('UPDATE tasks SET deleted_at=NULL,version=version+1').run();
  let sends = 0;
  await withFetch(async () => { sends++; return new Response(null, { status: 201 }); }, async () => {
    await runReminders(env);
    const delivered = sql.prepare('SELECT * FROM notifications').get();
    assert.equal(delivered.status, 'sent');
    sql.prepare('UPDATE tasks SET deleted_at=?,version=version+1').run(iso());
    await runReminders(env);
    sql.prepare('UPDATE tasks SET deleted_at=NULL,version=version+1').run();
    await runReminders(env);
    assert.deepEqual(sql.prepare('SELECT * FROM notifications').get(), delivered);
  });
  assert.equal(sends, 1);
  sql.close();
});

test('an expired lease is recovered, and parallel runs claim a due job only once', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  await withFetch(async () => new Response(null, { status: 503 }), () => runReminders(env));
  sql.prepare("UPDATE notifications SET status='processing',lease_until=?,next_attempt_at=NULL").run(iso(-1));
  let sends = 0;
  await withFetch(async () => { sends++; return new Response(null, { status: 201 }); }, () => Promise.all([runReminders(env), runReminders(env)]));
  assert.equal(sends, 1);
  assert.equal(sql.prepare('SELECT attempts FROM notifications').get().attempts, 2);
  sql.close();
});

test('explicit test requires target endpoint, sends only to it, and reports timeout visibly', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addSubscription(sql, 'device-two', 'https://fcm.googleapis.com/second');
  const request = body => notificationsRoutes.request('/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
  const missing = await request({});
  assert.equal(missing.status, 400);
  const targets = [];
  const result = await withFetch(async url => { targets.push(url); throw new DOMException('provider secret must not leak', 'TimeoutError'); }, () => request({ endpoint: 'https://fcm.googleapis.com/second' }));
  assert.equal(result.status, 502);
  assert.deepEqual(targets, ['https://fcm.googleapis.com/second']);
  const body = await result.json();
  assert.match(body.error, /超时/);
  assert.doesNotMatch(JSON.stringify(body), /provider secret/);
  sql.close();
});

test('HTTP 410 removes expired subscription and does not record successful delivery', async () => {
  const { sql, env } = fixture();
  addSubscription(sql);
  addTask(sql);
  await withFetch(async () => new Response(null, { status: 410 }), () => runReminders(env));
  assert.equal(sql.prepare('SELECT count(*) AS count FROM push_subscriptions').get().count, 0);
  const job = sql.prepare('SELECT status,sent_at FROM notifications').get();
  assert.equal(job.status, 'failed');
  assert.equal(job.sent_at, null);
  sql.close();
});
