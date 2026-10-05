import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = process.env.TEST_BASE_URL || 'http://127.0.0.1:8788';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Mutation tests must use an isolated local database');
const vars = process.env.TEST_APP_PASSWORD ? '' : await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const password = process.env.TEST_APP_PASSWORD || vars.split('\n').find(s => s.startsWith('APP_PASSWORD='))?.slice(13);
let cookie = '';
async function api(path, method = 'GET', data, options = {}) {
  const response = await fetch(base + '/api' + path, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data && !(data instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
  });
  const body = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body, response };
}
const ok = result => { assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.body)); return result.body; };
let task, categoryA, categoryB, tagA, waiting, attachment;
const marker = `验收-${crypto.randomUUID().slice(0, 8)}`;

describe('Cloudflare task workbench API integration (isolated local test database)', { concurrency: false }, () => {
  before(async () => { assert.ok(password); assert.equal((await api('/health')).status, 200); });
  it('rejects unauthenticated access and cross-origin mutations', async () => {
    assert.equal((await api('/tasks')).status, 401);
    assert.equal((await api('/login', 'POST', { password }, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403);
    assert.equal((await api('/login', 'POST', { password: 'incorrect' })).status, 401);
  });
  it('creates an HttpOnly session and exposes configured features', async () => {
    const login = await api('/login', 'POST', { password }); ok(login);
    const set = login.response.headers.get('set-cookie');
    assert.match(set, /HttpOnly/i); assert.match(set, /SameSite=Strict/i);
    cookie = set.split(';')[0];
    assert.equal(ok(await api('/session')).authenticated, true);
    const b = ok(await api('/bootstrap'));
    for (const id of ['status-todo', 'status-doing', 'status-done']) assert.ok(b.taxonomies.some(t => t.id === id));
    assert.equal(b.capabilities.email, false);
    assert.ok(b.capabilities.max_attachment_bytes > 0);
  });
  it('allows quick capture without a due date', async () => {
    const created = ok(await api('/tasks', 'POST', { title: `${marker}快速记录` })).task;
    assert.equal(created.due_at, null); assert.ok(created.received_at); assert.equal(created.priority, 2);
    assert.equal((await api('/tasks', 'POST', { title: '   ' })).status, 400);
  });
  it('creates independent categories, tags and custom status', async () => {
    const make = async (kind, name, more = {}) => {
      const result = ok(await api('/taxonomies', 'POST', { kind, name, ...more }));
      return result.taxonomy || result;
    };
    categoryA = await make('category', `${marker}培训`);
    categoryB = await make('category', `${marker}安全`);
    tagA = await make('tag', `${marker}SimFer`);
    waiting = await make('status', `${marker}等待RT回复`, { is_closed: 0 });
    assert.ok(categoryA.id && categoryB.id && tagA.id && waiting.id);
  });
  it('stores multiple classifications, independent progress and original receive time', async () => {
    const received = new Date(Date.now() - 86400000).toISOString();
    task = ok(await api('/tasks', 'POST', {
      title: `${marker}培训资料`, description: '文件准备中', notes: '备注关键词青海', status_id: waiting.id,
      received_at: received, due_at: new Date(Date.now() + 5 * 86400000).toISOString(), priority: 4, progress: 40,
      category_ids: [categoryA.id, categoryB.id], tag_ids: [tagA.id], reminder_offsets: [4320, 1440, 0], overdue_interval: 1440,
    })).task;
    assert.equal(task.received_at, received); assert.equal(task.progress, 40);
    assert.deepEqual(task.category_ids.sort(), [categoryA.id, categoryB.id].sort());
    for (const id of [categoryA.id, categoryB.id]) assert.ok(ok(await api(`/tasks?category=${id}`)).tasks.some(t => t.id === task.id));
    assert.ok(ok(await api('/tasks?q=' + encodeURIComponent('青海'))).tasks.some(t => t.id === task.id));
    assert.ok(ok(await api('/tasks?priority=4')).tasks.some(t => t.id === task.id));
    assert.ok(!ok(await api('/tasks?priority=1')).tasks.some(t => t.id === task.id));
    assert.equal((await api('/tasks?priority=5')).status, 400);
    assert.ok(ok(await api('/tasks?received_from=' + encodeURIComponent(received) + '&received_to=' + encodeURIComponent(received))).tasks.some(t => t.id === task.id));
    assert.equal((await api('/tasks?due_from=2026-10-05T00:00:00Z&due_to=2026-10-04T00:00:00Z')).status, 400);
  });
  it('keeps field history and prevents stale writes changing associations', async () => {
    const v = task.version;
    task = ok(await api(`/tasks/${task.id}`, 'PATCH', { version: v, notes: '已修改备注', progress: 60 })).task;
    const stale = await api(`/tasks/${task.id}`, 'PATCH', { version: v, notes: '旧窗口覆盖', category_ids: [] });
    assert.equal(stale.status, 409);
    const detail = ok(await api(`/tasks/${task.id}`));
    assert.equal(detail.task.notes, '已修改备注'); assert.equal(detail.task.category_ids.length, 2);
    assert.ok(detail.activities.some(a => a.changes?.includes('备注关键词青海')));
    assert.ok(ok(await api('/tasks?q=' + encodeURIComponent('青海'))).tasks.some(t => t.id === task.id));
  });
  it('records communication and searches its contents', async () => {
    ok(await api(`/tasks/${task.id}/activities`, 'POST', { kind: 'communication', content: '对方确认：几内亚清单将在周五到达。' }));
    assert.ok(ok(await api('/tasks?q=' + encodeURIComponent('几内亚清单'))).tasks.some(t => t.id === task.id));
  });
  it('commits exactly one concurrent edit including its history and classifications', async () => {
    task = ok(await api(`/tasks/${task.id}`)).task;
    const before = ok(await api(`/tasks/${task.id}`));
    const variants = [
      { version: task.version, notes: '并发窗口甲', category_ids: [categoryA.id] },
      { version: task.version, notes: '并发窗口乙', category_ids: [categoryB.id] },
    ];
    const responses = await Promise.all(variants.map(body => api(`/tasks/${task.id}`, 'PATCH', body)));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const winner = variants[responses.findIndex(r => r.status === 200)];
    const after = ok(await api(`/tasks/${task.id}`));
    assert.equal(after.task.notes, winner.notes);
    assert.deepEqual(after.task.category_ids, winner.category_ids);
    assert.equal(after.activities.length, before.activities.length + 1);
    task = ok(await api(`/tasks/${task.id}`, 'PATCH', { version: after.task.version, category_ids: [categoryA.id, categoryB.id] })).task;
  });
  it('stores and downloads attachment bytes and searches attachment names', async () => {
    const form = new FormData(); form.set('file', new Blob(['test <script>alert(1)</script>'], { type: 'text/html' }), 'SimFer_培训名单.html');
    const uploaded = ok(await api(`/tasks/${task.id}/attachments`, 'POST', form));
    attachment = uploaded.attachment;
    assert.ok(attachment.id);
    assert.ok(ok(await api('/tasks?q=' + encodeURIComponent('培训名单'))).tasks.some(t => t.id === task.id));
    const download = await api(`/attachments/${attachment.id}`);
    assert.equal(download.status, 200); assert.match(download.response.headers.get('content-disposition'), /^attachment/);
    assert.equal(download.body, 'test <script>alert(1)</script>');
    const tooLarge = new FormData(); tooLarge.set('file', new Blob([new Uint8Array(1048577)]), 'too-large.bin');
    assert.equal((await api(`/tasks/${task.id}/attachments`, 'POST', tooLarge)).status, 413);
  });
  it('auto-archives by completion and retains the same identity and attachments', async () => {
    task = ok(await api(`/tasks/${task.id}`)).task;
    task = ok(await api(`/tasks/${task.id}`, 'PATCH', { version: task.version, status_id: 'status-done' })).task;
    assert.ok(task.completed_at);
    assert.ok(!ok(await api('/tasks?view=active')).tasks.some(t => t.id === task.id));
    assert.ok(ok(await api('/tasks?view=archive')).tasks.some(t => t.id === task.id));
    assert.ok(ok(await api('/tasks?view=all&q=' + encodeURIComponent('培训名单'))).tasks.some(t => t.id === task.id));
    const detail = ok(await api(`/tasks/${task.id}`)); assert.equal(detail.attachments[0].id, attachment.id);
    task = ok(await api(`/tasks/${task.id}`, 'PATCH', { version: task.version, status_id: waiting.id })).task;
    assert.equal(task.completed_at, null);
  });
  it('preserves history when categories are disabled and rejects completion semantics mutation', async () => {
    ok(await api(`/taxonomies/${categoryA.id}`, 'DELETE'));
    const detail = ok(await api(`/tasks/${task.id}`)); assert.ok(detail.task.category_ids.includes(categoryA.id));
    assert.equal((await api(`/taxonomies/${waiting.id}`, 'PATCH', { is_closed: 1 })).status, 409);
    ok(await api(`/taxonomies/${waiting.id}`, 'PATCH', { name: `${marker}等待新回复` }));
  });
  it('creates followups without copying the original and rejects parent cycles', async () => {
    const followup = ok(await api('/tasks', 'POST', { title: `${marker}后续确认`, parent_id: task.id })).task;
    assert.notEqual(followup.id, task.id);
    assert.ok(ok(await api(`/tasks/${task.id}`)).followups.some(t => t.id === followup.id));
    task = ok(await api(`/tasks/${task.id}`)).task;
    const response = await api(`/tasks/${task.id}`, 'PATCH', { version: task.version, parent_id: followup.id });
    assert.ok([400, 409].includes(response.status), JSON.stringify(response.body));
  });
  it('rejects untrusted or unconfigured push subscriptions without an outbound send', async () => {
    const configured = ok(await api('/bootstrap')).capabilities.push;
    const result = await api('/push/subscribe', 'POST', { endpoint: 'https://127.0.0.1/secret', keys: { p256dh: 'bad', auth: 'bad' } });
    assert.equal(result.status, configured ? 400 : 503);
  });
  it('exports task and activity records, then revokes the session on logout', async () => {
    const exported = ok(await api('/export')); assert.ok(JSON.stringify(exported).includes(task.id));
    ok(await api('/logout', 'POST'));
    assert.equal((await api('/tasks')).status, 401);
  });
});
