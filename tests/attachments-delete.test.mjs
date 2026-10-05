import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8788';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Mutation tests must use an isolated local database');
const vars = process.env.TEST_APP_PASSWORD ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const password = process.env.TEST_APP_PASSWORD || vars.split('\n').find(s => s.startsWith('APP_PASSWORD='))?.slice(13);
const maxBytes = 1_990_000;
const marker = `附件回收站验收-${crypto.randomUUID().slice(0, 8)}`;
let cookie = '';

async function request(path, { method = 'GET', data, body, headers = {}, authenticated = true } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: data === undefined ? body : JSON.stringify(data),
    ...(body instanceof ReadableStream || body?.[Symbol.asyncIterator] ? { duplex: 'half' } : {}),
  });
  return response;
}
async function json(path, method = 'GET', data, options = {}) {
  const response = await request(path, { method, data, ...options });
  return { status: response.status, body: await response.json(), response };
}
const ok = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.body)); return result.body; };
const makeTask = async (title, extra = {}) => ok(await json('/tasks', 'POST', { title: `${marker} ${title}`, reminder_offsets: [], overdue_interval: 0, ...extra })).task;
const detail = async id => ok(await json(`/tasks/${id}`));
const versionOf = async id => (await detail(id)).task.version;
const remove = async task => json(`/tasks/${task.id}`, 'DELETE', { version: task.version });
const restore = async task => json(`/tasks/${task.id}/restore`, 'POST', { version: task.version });
const selection = tasks => tasks.map(({ id, version }) => ({ id, version }));
const rawHeaders = (name, size, extra = {}) => ({ 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Size': String(size), ...extra });
async function upload(taskId, name, body, size, extraHeaders = {}) {
  const response = await request(`/tasks/${taskId}/attachments`, { method: 'POST', body, headers: rawHeaders(name, size, extraHeaders) });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { error: text }; }
  return { status: response.status, body: result, response };
}
function malformedUpload(taskId, declaredSize) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/tasks/${taskId}/attachments`);
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = transport(url, { method: 'POST', agent: false, headers: {
      Cookie: cookie, ...rawHeaders(`length-${declaredSize}.bin`, declaredSize),
      'Content-Length': '3',
      Connection: 'close',
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let body;
        try { body = JSON.parse(text); } catch { body = { error: text }; }
        resolve({ status: response.statusCode, body });
      });
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error('Malformed local upload timed out')));
    // Send the complete tiny payload in one write on a fresh socket. Fetch's
    // streaming transport can cancel an unread body when the Worker rejects
    // its headers, which the local proxy may surface as an unrelated 500.
    request.end(Buffer.from('abc'));
  });
}
async function* byteStream(size, chunk = Buffer.alloc(64 * 1024, 0x5a)) {
  for (let offset = 0; offset < size; offset += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, size - offset));
}
async function digest(stream) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

describe('D1 attachments and recoverable deletion (isolated local database)', { concurrency: false }, () => {
  before(async () => {
    assert.ok(password);
    const login = await json('/login', 'POST', { password });
    ok(login);
    cookie = login.response.headers.get('set-cookie').split(';')[0];
  });
  after(async () => { if (cookie) ok(await json('/logout', 'POST')); });

  it('accepts exactly 1,990,000 bytes and downloads the D1 attachment intact', async () => {
    const capabilities = ok(await json('/bootstrap')).capabilities;
    assert.equal(capabilities.max_attachment_bytes, maxBytes);
    assert.equal(capabilities.max_database_bytes, 500_000_000);
    assert.equal(capabilities.attachment_storage, 'd1');
    assert.ok(capabilities.used_database_bytes >= capabilities.used_attachment_bytes);
    const task = await makeTask('1.99MB原始附件上传');
    const name = `${marker} 1.99MB 中文附件.bin`;
    const expected = await digest(byteStream(maxBytes));
    const uploaded = ok(await upload(task.id, name, byteStream(maxBytes), maxBytes, { 'Content-Length': String(maxBytes) })).attachment;
    assert.equal(uploaded.name, name);
    assert.equal(uploaded.size, maxBytes);
    const response = await request(`/attachments/${uploaded.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment/i);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await digest(response.body), expected);
    const stored = await detail(task.id);
    assert.equal(stored.attachments.length, 1);
    assert.equal(stored.attachments[0].id, uploaded.id);
    assert.equal(stored.task.version, task.version + 1);
    assert.equal(stored.activities.filter(activity => activity.kind === 'attachment').length, 1);
  });

  it('rejects 1,990,001 bytes and dishonest file lengths without recording attachments or history', async () => {
    const task = await makeTask('上传大小校验');
    const before = await detail(task.id);
    // Use a complete File-like payload and its actual HTTP length, as browsers
    // do. Streaming a rejected generator can leave the local Wrangler proxy's
    // body RPC unfinished and cause unrelated later requests to fail with 500.
    const isolatedConnection = { Connection: 'close' };
    assert.equal((await upload(task.id, 'oversized.bin', Buffer.alloc(maxBytes + 1), maxBytes + 1, { ...isolatedConnection, 'Content-Length': String(maxBytes + 1) })).status, 413);
    for (const declared of [2, 4]) {
      // Artificial streams without Content-Length (both short and long) are
      // asserted against the real uploadRawAttachment handler in
      // attachment-atomic.test.mjs, including zero database access or writes.
      const result = await malformedUpload(task.id, declared);
      assert.equal(result.status, 400, `declared=${declared}, actual=3: ${JSON.stringify(result.body)}`);
    }
    assert.equal((await upload(task.id, 'invalid-id.bin', Buffer.from('abc'), 3, { 'X-Upload-Id': 'not-a-uuid' })).status, 400);
    const stored = await detail(task.id);
    assert.equal(stored.attachments.length, 0);
    assert.deepEqual(stored, before);
  });

  it('keeps a retried upload idempotent and accepts several separate files on one task', async () => {
    const task = await makeTask('批量附件和上传重试');
    const uploadId = crypto.randomUUID();
    const first = ok(await upload(task.id, 'first.txt', Buffer.from('one'), 3, { 'X-Upload-Id': uploadId })).attachment;
    const replay = await upload(task.id, 'first.txt', Buffer.from('one'), 3, { 'X-Upload-Id': uploadId });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.attachment.id, first.id);
    const mismatch = await upload(task.id, 'different.txt', Buffer.from('one'), 3, { 'X-Upload-Id': uploadId });
    assert.equal(mismatch.status, 409);
    for (const name of ['second.txt', 'third.txt']) ok(await upload(task.id, name, Buffer.from(name), Buffer.byteLength(name)));
    assert.equal((await detail(task.id)).attachments.length, 3);
  });

  it('commits concurrent retries of one upload exactly once, including history and version', async () => {
    const task = await makeTask('同一附件并发重试');
    const uploadId = crypto.randomUUID();
    const responses = await Promise.all([1, 2].map(() => upload(task.id, 'same.txt', Buffer.from('same'), 4, { 'X-Upload-Id': uploadId })));
    assert.deepEqual(responses.map(result => result.status).sort(), [200, 201]);
    for (const response of responses) assert.equal(response.body.attachment.id, uploadId);
    const stored = await detail(task.id);
    assert.equal(stored.attachments.length, 1);
    assert.equal(stored.activities.filter(activity => activity.kind === 'attachment').length, 1);
    assert.equal(stored.task.version, task.version + 1);
  });

  it('requires a session and the same origin for upload, delete, bulk delete and restore', async () => {
    const task = await makeTask('鉴权保护');
    const mutations = [
      { path: `/tasks/${task.id}`, method: 'DELETE', data: { version: task.version } },
      { path: '/tasks/bulk-delete', method: 'POST', data: { tasks: selection([task]) } },
      { path: `/tasks/${task.id}/restore`, method: 'POST', data: { version: task.version } },
      { path: `/tasks/${task.id}/attachments`, method: 'POST', body: Buffer.from('x'), headers: rawHeaders('private.txt', 1) },
    ];
    for (const { path, ...options } of mutations) {
      assert.equal((await request(path, { ...options, authenticated: false })).status, 401, path);
      assert.equal((await request(path, { ...options, headers: { ...options.headers, Origin: 'https://unrelated.invalid' } })).status, 403, path);
      assert.equal((await request(path, { ...options, headers: { ...options.headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403, path);
    }
    assert.equal((await detail(task.id)).task.deleted_at, null);
    assert.equal((await detail(task.id)).attachments.length, 0);
  });

  it('moves active and archived tasks only into trash, preserves their content and restores their prior status', async () => {
    const active = await makeTask('活动任务', { notes: '保留备注', progress: 45 });
    const archived = await makeTask('已归档任务', { status_id: 'status-done', progress: 100 });
    ok(await json(`/tasks/${active.id}/activities`, 'POST', { kind: 'communication', content: '删除前的沟通记录' }));
    const attachment = ok(await upload(active.id, '保留文件.txt', Buffer.from('keep'), 4)).attachment;
    const before = await detail(active.id);
    active.version = before.task.version;
    ok(await json('/tasks/bulk-delete', 'POST', { tasks: selection([active, archived]) }));
    for (const view of ['active', 'archive', 'all']) {
      const ids = ok(await json(`/tasks?view=${view}&q=${encodeURIComponent(marker)}`)).tasks.map(t => t.id);
      assert.ok(!ids.includes(active.id) && !ids.includes(archived.id), view);
    }
    const trash = ok(await json(`/tasks?view=trash&q=${encodeURIComponent(marker)}`)).tasks;
    for (const original of [active, archived]) assert.ok(trash.some(t => t.id === original.id && t.deleted_at));
    const deleted = await detail(active.id);
    assert.equal(deleted.task.notes, before.task.notes);
    assert.equal(deleted.task.progress, before.task.progress);
    assert.equal(deleted.task.received_at, before.task.received_at);
    assert.equal(deleted.attachments[0].id, attachment.id);
    for (const activity of before.activities) assert.ok(deleted.activities.some(a => a.id === activity.id));
    const file = await request(`/attachments/${attachment.id}`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'keep');
    assert.equal((await request(`/attachments/${attachment.id}`, { authenticated: false })).status, 401);
    ok(await restore(deleted.task));
    ok(await restore((await detail(archived.id)).task));
    assert.equal((await detail(active.id)).task.deleted_at, null);
    assert.ok(ok(await json('/tasks?view=active')).tasks.some(t => t.id === active.id));
    assert.ok(ok(await json('/tasks?view=archive')).tasks.some(t => t.id === archived.id));
    assert.equal((await detail(archived.id)).task.completed_at, archived.completed_at);
    assert.equal((await detail(active.id)).attachments[0].id, attachment.id);
  });

  it('rejects stale single deletes and restores without losing a newer change', async () => {
    const task = await makeTask('版本保护');
    const updated = ok(await json(`/tasks/${task.id}`, 'PATCH', { version: task.version, notes: '另一窗口的修改' })).task;
    assert.equal((await remove(task)).status, 409);
    assert.equal((await detail(task.id)).task.notes, '另一窗口的修改');
    ok(await remove(updated));
    assert.equal((await restore(updated)).status, 409);
    assert.ok((await detail(task.id)).task.deleted_at);
    ok(await restore((await detail(task.id)).task));
    assert.equal((await detail(task.id)).task.notes, '另一窗口的修改');
  });

  it('leaves every selected task unchanged when a bulk selection is stale, missing or invalid', async () => {
    const first = await makeTask('批量原子性一');
    const second = await makeTask('批量原子性二');
    ok(await json(`/tasks/${second.id}`, 'PATCH', { version: second.version, notes: '较新的修改' }));
    const before = await Promise.all([detail(first.id), detail(second.id)]);
    const cases = [
      { tasks: selection([first, second]), status: 409 },
      { tasks: [...selection([first]), { id: crypto.randomUUID(), version: 1 }], status: 404 },
      { tasks: selection([first, first]), status: 400 },
      { tasks: [], status: 400 },
      { tasks: Array.from({ length: 101 }, () => ({ id: crypto.randomUUID(), version: 1 })), status: 400 },
    ];
    for (const { tasks, status } of cases) {
      const result = await json('/tasks/bulk-delete', 'POST', { tasks });
      assert.equal(result.status, status, JSON.stringify(result.body));
      const after = await Promise.all([detail(first.id), detail(second.id)]);
      assert.deepEqual(after, before);
    }
  });

  it('commits one conflicting bulk delete and keeps the losing batch completely intact', async () => {
    const shared = await makeTask('并发批量公共任务');
    const left = await makeTask('并发批量甲');
    const right = await makeTask('并发批量乙');
    const responses = await Promise.all([[shared, left], [shared, right]].map(tasks => json('/tasks/bulk-delete', 'POST', { tasks: selection(tasks) })));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = responses[0].status === 200 ? left : right;
    const loser = responses[0].status === 200 ? right : left;
    assert.ok((await detail(shared.id)).task.deleted_at);
    assert.ok((await detail(winner.id)).task.deleted_at);
    assert.equal((await detail(loser.id)).task.deleted_at, null);
    assert.equal(await versionOf(loser.id), loser.version);
  });

  it('keeps followups independent and blocks editing, new followups and uploads while the parent is deleted', async () => {
    const parent = await makeTask('父任务');
    const child = await makeTask('已有跟进', { parent_id: parent.id });
    ok(await remove((await detail(parent.id)).task));
    const deleted = (await detail(parent.id)).task;
    assert.equal((await detail(child.id)).task.deleted_at, null);
    assert.ok(ok(await json('/tasks?view=active')).tasks.some(t => t.id === child.id));
    assert.equal((await json(`/tasks/${parent.id}`, 'PATCH', { version: deleted.version, notes: '不应写入' })).status, 409);
    assert.equal((await json(`/tasks/${parent.id}/activities`, 'POST', { kind: 'communication', content: '不应写入' })).status, 409);
    assert.equal((await json('/tasks', 'POST', { title: `${marker} 不应创建跟进`, parent_id: parent.id })).status, 409);
    assert.equal((await upload(parent.id, 'blocked.txt', Buffer.from('x'), 1)).status, 409);
    const form = new FormData(); form.set('file', new Blob(['x']), 'legacy-blocked.txt');
    assert.equal((await request(`/tasks/${parent.id}/attachments`, { method: 'POST', body: form })).status, 409);
    assert.equal((await detail(parent.id)).task.version, deleted.version);
    assert.equal((await detail(parent.id)).attachments.length, 0);
    ok(await restore(deleted));
    assert.ok((await detail(parent.id)).followups.some(t => t.id === child.id));
  });
});
