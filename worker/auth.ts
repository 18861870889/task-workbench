import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from 'node:crypto';

const cookieName = 'task_session';
const encoder = new TextEncoder();
async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return { bytes, hex: Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('') };
}

async function authenticated(request: Request, db: D1Database): Promise<boolean> {
  const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return false;
  return !!await db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').bind((await digest(cookie)).hex, new Date().toISOString()).first();
}

export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!await authenticated(c.req.raw, c.env.DB)) return c.json({ error: '请先输入访问口令登录' }, 401);
  await next();
});

export const authRoutes = new Hono<{ Bindings: Env }>();
authRoutes.get('/session', async c => c.json({ authenticated: await authenticated(c.req.raw, c.env.DB) }));
authRoutes.post('/login', async c => {
  if (!c.env.APP_PASSWORD || c.env.APP_PASSWORD.length < 24) return c.json({ error: '服务尚未配置安全访问口令' }, 503);
  const payload: unknown = await c.req.json().catch(() => null);
  if (!payload || typeof payload !== 'object' || !('password' in payload) || typeof payload.password !== 'string' || payload.password.length > 256) return c.json({ error: '请输入有效的访问口令' }, 400);
  const now = Date.now();
  const key = (await digest(c.req.header('CF-Connecting-IP') || 'local')).hex;
  const attempt = await c.env.DB.prepare(`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<? THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END RETURNING attempts`)
    .bind(key, now, now - 900000, now - 900000).first<{ attempts: number }>();
  if (!attempt || attempt.attempts > 10) return c.json({ error: '尝试次数较多，请 15 分钟后重试' }, 429);
  const [actual, expected] = await Promise.all([digest(payload.password), digest(c.env.APP_PASSWORD)]);
  if (!timingSafeEqual(new Uint8Array(actual.bytes), new Uint8Array(expected.bytes))) return c.json({ error: '访问口令不正确' }, 401);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(now + 30 * 86400000);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM login_attempts WHERE key=? OR window_start<?').bind(key, now - 86400000),
    c.env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(new Date().toISOString()),
    c.env.DB.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').bind((await digest(token)).hex, expires.toISOString()),
  ]);
  setCookie(c, cookieName, token, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/api', maxAge: 30 * 86400, expires });
  return c.json({ ok: true });
});
authRoutes.post('/logout', async c => {
  const token = getCookie(c, cookieName);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind((await digest(token)).hex).run();
  deleteCookie(c, cookieName, { path: '/api' });
  return c.json({ ok: true });
});
