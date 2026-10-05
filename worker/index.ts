import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { authRoutes, requireAuth } from './auth';
import { taskRoutes } from './tasks';
import { notificationsRoutes, runReminders } from './notifications';

const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
});
const smallBodyLimit = bodyLimit({ maxSize: 1200000, onError: (c) => c.json({ error: '请求内容过大；请使用文件上传接口提交附件' }, 413) });
app.use('/api/*', async (c, next) => {
  // Raw uploads are authenticated first, then their actual bytes are bounded
  // by the attachment handler before one atomic D1 write.
  const rawUpload = c.req.method === 'POST' && /^\/api\/tasks\/[^/]+\/attachments$/.test(c.req.path)
    && !c.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data');
  if (rawUpload) return next();
  return smallBodyLimit(c, next);
});
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('Sec-Fetch-Site') === 'cross-site') return c.json({ error: '请求来源不匹配' }, 403);
  }
  await next();
});
app.get('/api/health', c => c.json({ ok: true, version: '0.1.0' }));
app.route('/api', authRoutes);
app.use('/api/*', requireAuth);
app.route('/api', taskRoutes);
app.route('/api', notificationsRoutes);
app.all('/api/*', c => c.json({ error: '接口不存在' }, 404));
app.all('*', c => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error instanceof SyntaxError) return c.json({ error: '请求格式不正确' }, 400);
  // Do not log payloads, file bodies, access tokens or subscriptions.
  console.error(JSON.stringify({ event: 'request_failed', path: c.req.path, name: error.name }));
  return c.json({ error: '服务暂时无法完成请求，请重试' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminders(env).catch(error => {
      console.error(JSON.stringify({ event: 'reminder_run_failed', name: error instanceof Error ? error.name : 'unknown' }));
      throw error;
    }));
  },
} satisfies ExportedHandler<Env>;
