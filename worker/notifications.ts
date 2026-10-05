import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { buildPushPayload } from '@block65/webcrypto-web-push';

export type NotificationEnv = Env & {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  APP_ORIGIN?: string;
};

const MAX_SUBSCRIPTIONS = 10;
const MAX_SENDS_PER_RUN = 2;
const MAX_ATTEMPTS = 5;
const SEND_TIMEOUT_MS = 8_000;
const LEASE_MS = 120_000;

interface SubscriptionRow {
  id: string; endpoint: string; p256dh: string; auth: string; created_at: string;
}
interface ReminderTask {
  id: string; title: string; due_at: string | null; created_at: string;
  completed_at: string | null; deleted_at: string | null; is_closed: number; reminder_offsets: string;
  overdue_interval: number;
}
interface NotificationRow {
  id: string; task_id: string | null; title: string; body: string; channel: string;
  status: string; scheduled_at: string; created_at: string; sent_at: string | null;
  attempts: number; next_attempt_at: string | null; lease_until: string | null;
  last_error: string | null; reminder_key: string; subscription_id: string | null;
}
interface Occurrence { key: string; scheduledAt: string }

/** Only known browser push services may receive an authenticated outbound request. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return false;
    const host = url.hostname;
    return host.endsWith('.push.apple.com') || host === 'fcm.googleapis.com'
      || host === 'updates.push.services.mozilla.com' || host.endsWith('.updates.push.services.mozilla.com');
  } catch { return false; }
}

function validKey(value: string, length: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return bytes.length === length && (length !== 65 || bytes.charCodeAt(0) === 4);
  } catch { return false; }
}

const endpointSchema = z.string().max(2048).refine(isAllowedPushEndpoint, '不支持的推送服务地址');
const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  keys: z.object({
    p256dh: z.string().max(100).refine(value => validKey(value, 65)),
    auth: z.string().max(40).refine(value => validKey(value, 16)),
  }),
  expirationTime: z.number().finite().nullable().optional(),
});
const endpointBodySchema = z.object({ endpoint: endpointSchema });

export function pushConfigured(env: NotificationEnv): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/** Coalesce downtime into the latest relevant occurrence; never replay pre-enrolment reminders. */
export function latestReminder(task: ReminderTask, subscription: Pick<SubscriptionRow, 'id' | 'created_at'>, now: number): Occurrence | null {
  if (!task.due_at || task.completed_at || task.deleted_at || task.is_closed) return null;
  const due = Date.parse(task.due_at);
  const notBefore = Math.max(Date.parse(task.created_at), Date.parse(subscription.created_at));
  if (!Number.isFinite(due) || !Number.isFinite(notBefore)) return null;
  let latest: Occurrence | null = null;
  let latestTime = -Infinity;
  const consider = (kind: string, value: number, iteration: number, when: number) => {
    if (when < notBefore || when > now || when <= latestTime) return;
    latestTime = when;
    latest = { key: JSON.stringify([task.id, task.due_at, kind, value, iteration, subscription.id]), scheduledAt: new Date(when).toISOString() };
  };
  let offsets: unknown;
  try { offsets = JSON.parse(task.reminder_offsets); } catch { offsets = []; }
  if (Array.isArray(offsets)) for (const offset of offsets) {
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 && offset <= 525600) {
      consider('offset', offset, 0, due - offset * 60_000);
    }
  }
  const interval = task.overdue_interval;
  if (Number.isInteger(interval) && interval >= 1 && interval <= 525600) {
    const iteration = Math.floor((now - due) / (interval * 60_000));
    if (iteration >= 1) consider('overdue', interval, iteration, due + iteration * interval * 60_000);
  }
  return latest;
}

/* SQL does the candidate scan, so runtime memory and created jobs stay bounded even with
 * a large archive. Stable keys deliberately exclude task.version: notes must not resend.
 * The latest occurrence is selected BEFORE excluding existing jobs, preventing an old
 * reminder from being replayed on the next cron after the newest one was already sent. */
const ENQUEUE_SQL = `
WITH eligible AS (
  SELECT t.*, p.id AS subscription_id,
    CAST(round((julianday(t.due_at)-2440587.5)*86400000) AS INTEGER) AS due_ms,
    max(CAST(round((julianday(t.created_at)-2440587.5)*86400000) AS INTEGER),
        CAST(round((julianday(p.created_at)-2440587.5)*86400000) AS INTEGER)) AS not_before
  FROM tasks t JOIN taxonomies s ON s.id=t.status_id
  CROSS JOIN push_subscriptions p
  WHERE t.due_at IS NOT NULL AND t.completed_at IS NULL AND t.deleted_at IS NULL AND s.is_closed=0
), occurrences AS (
  SELECT e.id AS task_id,e.title,e.due_at,e.subscription_id,e.not_before,
    'offset' AS kind,CAST(j.value AS INTEGER) AS value,0 AS iteration,
    e.due_ms-CAST(j.value AS INTEGER)*60000 AS scheduled_ms
  FROM eligible e JOIN json_each(CASE WHEN json_valid(e.reminder_offsets) THEN e.reminder_offsets ELSE '[]' END) j
  WHERE j.type='integer' AND j.value BETWEEN 0 AND 525600
  UNION ALL
  SELECT id,title,due_at,subscription_id,not_before,'overdue',overdue_interval,
    CAST((?1-due_ms)/(overdue_interval*60000) AS INTEGER),
    due_ms+CAST((?1-due_ms)/(overdue_interval*60000) AS INTEGER)*overdue_interval*60000
  FROM eligible WHERE overdue_interval BETWEEN 1 AND 525600 AND ?1>=due_ms+overdue_interval*60000
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY task_id,subscription_id ORDER BY scheduled_ms DESC) AS rank
  FROM occurrences WHERE scheduled_ms>=not_before AND scheduled_ms<=?1
), candidates AS (
  SELECT *,json_array(task_id,due_at,kind,value,iteration,subscription_id) AS reminder_key
  FROM ranked WHERE rank=1
)
INSERT OR IGNORE INTO notifications
  (id,task_id,title,body,channel,status,scheduled_at,created_at,reminder_key,subscription_id,next_attempt_at)
SELECT lower(hex(randomblob(16))),task_id,substr(title,1,120),'任务即将到期或已逾期，请打开工作台查看。',
  'push','pending',strftime('%Y-%m-%dT%H:%M:%fZ',scheduled_ms/1000.0,'unixepoch'),?2,
  reminder_key,subscription_id,?2
FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.reminder_key=c.reminder_key)
ORDER BY scheduled_ms,task_id LIMIT 20`;

async function enqueueReminders(env: NotificationEnv, now: number): Promise<void> {
  await env.DB.prepare(ENQUEUE_SQL).bind(now, new Date(now).toISOString()).run();
}

async function claim(env: NotificationEnv, id?: string): Promise<NotificationRow | null> {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  // A single conditional UPDATE is the lock, including recovery after Worker termination.
  return env.DB.prepare(`UPDATE notifications SET status='processing',lease_until=?1,attempts=attempts+1
    WHERE id=(SELECT id FROM notifications WHERE channel='push' AND (?2 IS NULL OR id=?2)
      AND scheduled_at<=?3 AND attempts<?4
      AND (task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id=notifications.task_id AND tasks.deleted_at IS NULL))
      AND ((status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?3))
        OR (status='processing' AND lease_until<=?3))
      ORDER BY scheduled_at,created_at LIMIT 1)
    RETURNING *`).bind(until, id ?? null, now, MAX_ATTEMPTS).first<NotificationRow>();
}

async function setResult(env: NotificationEnv, job: NotificationRow, status: string, error: string | null, delayMs = 0): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE notifications SET status=?,last_error=?,lease_until=NULL,
      sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,next_attempt_at=?
    WHERE id=? AND status='processing' AND lease_until=?`)
    .bind(status, error, status, now, delayMs ? new Date(Date.now() + delayMs).toISOString() : null, job.id, job.lease_until).run();
}

async function contextForJob(env: NotificationEnv, job: NotificationRow): Promise<SubscriptionRow | null> {
  if (!job.subscription_id) return null;
  const subscription = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE id=?').bind(job.subscription_id).first<SubscriptionRow>();
  if (!subscription || !isAllowedPushEndpoint(subscription.endpoint)) return null;
  if (job.task_id) {
    const task = await env.DB.prepare(`SELECT t.*,s.is_closed FROM tasks t JOIN taxonomies s ON s.id=t.status_id WHERE t.id=?`)
      .bind(job.task_id).first<ReminderTask>();
    if (!task || latestReminder(task, subscription, Date.now())?.key !== job.reminder_key) return null;
  }
  return subscription;
}

function notificationData(job: NotificationRow, env: NotificationEnv) {
  const url = job.task_id ? `/?task=${encodeURIComponent(job.task_id)}` : '/';
  const title = job.title.slice(0, 120);
  const body = job.body.slice(0, 240);
  const base = { title, body, url, tag: job.id };
  if (env.APP_ORIGIN) {
    try {
      const origin = new URL(env.APP_ORIGIN);
      if (origin.protocol === 'https:' && !origin.username && !origin.password) {
        return { ...base, web_push: 8030, notification: { title, body, tag: job.id, navigate: new URL(url, origin.origin).href, silent: false } };
      }
    } catch { /* Local preview uses the standard Service Worker payload. */ }
  }
  return base;
}

async function processClaimed(env: NotificationEnv, job: NotificationRow): Promise<boolean> {
  const subscription = await contextForJob(env, job);
  if (!subscription) {
    await setResult(env, job, 'cancelled', '任务、提醒规则或设备订阅已变化，已取消旧提醒');
    return false;
  }
  if (!pushConfigured(env)) {
    await setResult(env, job, 'failed', '推送服务尚未配置');
    return false;
  }
  try {
    const payload = await buildPushPayload({ data: notificationData(job, env), options: { ttl: 3600, urgency: 'high', topic: job.id.slice(0, 32) } }, {
      endpoint: subscription.endpoint, expirationTime: null,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }, { subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY! });

    // Encryption may take time: re-read due/status/rules/subscription immediately before I/O.
    const fresh = await contextForJob(env, job);
    if (!fresh || fresh.endpoint !== subscription.endpoint || fresh.p256dh !== subscription.p256dh || fresh.auth !== subscription.auth) {
      await setResult(env, job, 'cancelled', '发送前检测到任务或设备订阅变化，已取消');
      return false;
    }
    const response = await fetch(subscription.endpoint, { ...payload, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    const code = response.status;
    await response.body?.cancel();
    if (response.ok) {
      // "sent" means accepted by the push service, never proof of delivery/read on a phone.
      await setResult(env, job, 'sent', null);
    } else if (code === 404 || code === 410) {
      await setResult(env, job, 'failed', `设备订阅失效（HTTP ${code}），请在该设备重新开启提醒`);
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id=?').bind(subscription.id).run();
    } else {
      const retryable = code === 429 || code >= 500;
      await setResult(env, job, retryable && job.attempts < MAX_ATTEMPTS ? 'retry' : 'failed',
        `推送服务未接受请求（HTTP ${code}）`, retryable ? retryDelay(job.attempts) : 0);
    }
    return true;
  } catch (error) {
    const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
    await setResult(env, job, job.attempts < MAX_ATTEMPTS ? 'retry' : 'failed',
      timedOut ? '推送请求超时，等待重试' : '推送发送失败，请检查网络和推送配置', retryDelay(job.attempts));
    return true;
  }
}

function retryDelay(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/** Call from scheduled() with ctx.waitUntil(runReminders(env)). No request-scoped globals. */
export async function runReminders(env: NotificationEnv): Promise<void> {
  await env.DB.prepare(`UPDATE notifications SET status='cancelled',lease_until=NULL,next_attempt_at=NULL,last_error='任务已移入回收站，提醒已取消'
    WHERE status IN ('pending','retry','processing') AND EXISTS
      (SELECT 1 FROM tasks WHERE tasks.id=notifications.task_id AND tasks.deleted_at IS NOT NULL)`).run();
  if (!pushConfigured(env)) return;
  await env.DB.prepare(`UPDATE notifications SET status='failed',lease_until=NULL,last_error='发送中断且已达重试上限，请手动重试'
    WHERE status='processing' AND lease_until<=? AND attempts>=?`).bind(new Date().toISOString(), MAX_ATTEMPTS).run();
  await enqueueReminders(env, Date.now());
  let sends = 0;
  // Cancel stale jobs without allowing a long obsolete queue to consume every run.
  for (let checked = 0; checked < 6 && sends < MAX_SENDS_PER_RUN; checked++) {
    const job = await claim(env);
    if (!job) break;
    if (await processClaimed(env, job)) sends++;
  }
}

export const notificationsRoutes = new Hono<{ Bindings: NotificationEnv }>();
notificationsRoutes.use('*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: '请求内容过大' }, 413) }));

notificationsRoutes.post('/push/subscribe', async c => {
  if (!pushConfigured(c.env)) return c.json({ error: '推送服务尚未配置' }, 503);
  const parsed = subscriptionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '设备订阅格式无效或推送服务不受支持' }, 400);
  const { endpoint, keys, expirationTime } = parsed.data;
  if (expirationTime != null && expirationTime <= Date.now()) return c.json({ error: '设备订阅已过期，请重新开启提醒' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?').bind(endpoint).first<{ id: string }>();
  if (!existing) {
    const count = await c.env.DB.prepare('SELECT count(*) AS count FROM push_subscriptions').first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_SUBSCRIPTIONS) return c.json({ error: '最多启用 10 台设备，请先关闭旧设备提醒' }, 409);
  }
  const id = existing?.id ?? crypto.randomUUID();
  await c.env.DB.prepare(`INSERT INTO push_subscriptions(id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth`)
    .bind(id, endpoint, keys.p256dh, keys.auth, new Date().toISOString()).run();
  return c.json({ ok: true });
});

notificationsRoutes.post('/push/unsubscribe', async c => {
  const parsed = endpointBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '设备订阅地址无效' }, 400);
  const endpoint = parsed.data.endpoint;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE notifications SET status='cancelled',lease_until=NULL,last_error='设备已关闭提醒'
      WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE endpoint=?) AND status IN ('pending','retry','processing')`).bind(endpoint),
    c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').bind(endpoint),
  ]);
  return c.json({ ok: true });
});

notificationsRoutes.post('/push/test', async c => {
  if (!pushConfigured(c.env)) return c.json({ error: '推送服务尚未配置' }, 503);
  const parsed = endpointBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '请明确选择当前设备的订阅地址' }, 400);
  const subscription = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?')
    .bind(parsed.data.endpoint).first<{ id: string }>();
  if (!subscription) return c.json({ error: '该设备尚未开启提醒' }, 404);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(`INSERT INTO notifications(id,title,body,scheduled_at,created_at,reminder_key,subscription_id)
    VALUES(?,?,?,?,?,?,?)`).bind(id, '工作台提醒测试', '这是一条由你主动发送的测试通知。', now, now, `test:${id}`, subscription.id).run();
  const job = await claim(c.env, id);
  if (job) await processClaimed(c.env, job);
  const result = await c.env.DB.prepare('SELECT status,last_error FROM notifications WHERE id=?').bind(id).first<{ status: string; last_error: string | null }>();
  if (result?.status !== 'sent') return c.json({ error: result?.last_error ?? '通知等待发送', notification_id: id, status: result?.status }, 502);
  return c.json({ ok: true, notification_id: id, message: '推送服务已接受，请检查设备是否收到' });
});

notificationsRoutes.get('/notifications', async c => {
  const rows = await c.env.DB.prepare(`SELECT id,task_id,title,status,channel,last_error,created_at,sent_at,scheduled_at,attempts
    FROM notifications ORDER BY created_at DESC LIMIT 200`).all();
  return c.json({ notifications: rows.results });
});

notificationsRoutes.post('/notifications/:id/retry', async c => {
  if (!pushConfigured(c.env)) return c.json({ error: '推送服务尚未配置' }, 503);
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(`UPDATE notifications SET status='pending',attempts=0,next_attempt_at=?,lease_until=NULL,last_error=NULL
    WHERE id=? AND status IN ('failed','retry') AND subscription_id IN (SELECT id FROM push_subscriptions)
      AND (task_id IS NULL OR EXISTS (SELECT 1 FROM tasks WHERE tasks.id=notifications.task_id AND tasks.deleted_at IS NULL)) RETURNING id`)
    .bind(now, c.req.param('id')).first<{ id: string }>();
  if (!result) return c.json({ error: '该通知无法重试；可能已发送、已取消或设备订阅已失效' }, 409);
  return c.json({ ok: true, message: '已加入重试队列；过期规则会在发送前重新检查' }, 202);
});
