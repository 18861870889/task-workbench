import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Only this verifier's login/logout writes are allowed. Never log credentials,
// session headers, task contents, subscriptions, or complete API responses.
let origin;
let cookie;
let checks = 0;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function sameOrigin(reference) {
  const url = new URL(reference, origin);
  requireValue(url.origin === origin && !url.username && !url.password, 'Unexpected cross-origin asset reference');
  return url;
}

async function request(path, options = {}) {
  const { authenticated = false, method = 'GET', body } = options;
  const headers = {};
  if (authenticated) headers.Cookie = cookie;
  if (method === 'POST') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return await fetch(sameOrigin(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
}

async function json(response, status, label) {
  requireValue(response.status === status, `${label}: expected HTTP ${status}, received ${response.status}`);
  requireValue(response.headers.get('content-type')?.includes('application/json'), `${label}: expected JSON`);
  try { return await response.json(); } catch { throw new Error(`${label}: invalid JSON`); }
}

function passed(label, detail = '') {
  checks += 1;
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
}

async function logout() {
  await json(await request('/api/logout', { method: 'POST', authenticated: true }), 200, 'Logout');
  const revoked = await request('/api/bootstrap', { authenticated: true });
  requireValue(revoked.status === 401, `Revoked session: expected HTTP 401, received ${revoked.status}`);
  cookie = undefined;
}

try {
  requireValue(process.argv.length === 3, 'Usage: node scripts/verify-deployment.mjs https://your-worker.workers.dev');
  const input = new URL(process.argv[2]);
  requireValue(input.protocol === 'https:' && !input.username && !input.password && input.pathname === '/' && !input.search && !input.hash, 'Provide an explicit HTTPS origin without credentials, path, query, or fragment');
  origin = input.origin;
  const vars = parseEnv(await readFile(new URL('../.dev.vars', import.meta.url), 'utf8'));
  requireValue(typeof vars.APP_PASSWORD === 'string' && vars.APP_PASSWORD.length >= 24, 'APP_PASSWORD is missing or invalid in .dev.vars');

  const health = await json(await request('/api/health'), 200, 'Health');
  requireValue(health.ok === true, 'Health did not report success');
  passed('Health');

  const anonymous = await json(await request('/api/session'), 200, 'Anonymous session');
  requireValue(anonymous.authenticated === false, 'Anonymous session unexpectedly authenticated');
  const denied = await request('/api/bootstrap');
  requireValue(denied.status === 401, `Unauthenticated API: expected HTTP 401, received ${denied.status}`);
  passed('Private API rejects anonymous requests');

  const login = await request('/api/login', { method: 'POST', body: { password: vars.APP_PASSWORD } });
  await json(login, 200, 'Login');
  const setCookie = login.headers.getSetCookie().find(value => value.startsWith('task_session='));
  requireValue(Boolean(setCookie), 'Login session cookie missing');
  cookie = setCookie.split(';', 1)[0];
  requireValue(/(?:^|;)\s*Secure(?:;|$)/i.test(setCookie), 'Session cookie missing Secure');
  requireValue(/(?:^|;)\s*HttpOnly(?:;|$)/i.test(setCookie), 'Session cookie missing HttpOnly');
  requireValue(/(?:^|;)\s*SameSite=Strict(?:;|$)/i.test(setCookie), 'Session cookie missing SameSite=Strict');
  requireValue(/(?:^|;)\s*Path=\/api(?:;|$)/i.test(setCookie), 'Session cookie has unexpected path');
  passed('Login and secure session cookie');

  const session = await json(await request('/api/session', { authenticated: true }), 200, 'Authenticated session');
  requireValue(session.authenticated === true, 'Authenticated session not recognized');
  passed('Authenticated session');

  const bootstrapResponse = await request('/api/bootstrap', { authenticated: true });
  requireValue(bootstrapResponse.headers.get('cache-control')?.includes('no-store'), 'Private API missing no-store');
  const bootstrap = await json(bootstrapResponse, 200, 'Bootstrap');
  const capabilities = bootstrap.capabilities;
  requireValue(capabilities && ['push', 'email', 'attachments'].every(key => typeof capabilities[key] === 'boolean'), 'Invalid capability flags');
  requireValue(capabilities.attachments === true, 'Attachment storage unavailable');
  requireValue(capabilities.max_attachment_bytes === 1_990_000, 'Expected 1.99 MB attachment size limit');
  requireValue(capabilities.max_database_bytes === 500_000_000, 'Expected 500 MB shared database limit');
  requireValue(Number.isInteger(capabilities.used_attachment_bytes) && capabilities.used_attachment_bytes >= 0, 'Invalid attachment storage usage');
  requireValue(Number.isInteger(capabilities.used_database_bytes) && capabilities.used_database_bytes >= capabilities.used_attachment_bytes, 'Invalid database storage usage');
  requireValue(capabilities.reserved_database_bytes === 2_000_000, 'Expected task/history storage reserve');
  requireValue(Number.isInteger(capabilities.available_attachment_bytes) && capabilities.available_attachment_bytes >= 0, 'Invalid remaining attachment capacity');
  requireValue(Array.isArray(bootstrap.taxonomies), 'Invalid taxonomy collection');
  if (capabilities.push) requireValue(typeof bootstrap.vapid_public_key === 'string' && bootstrap.vapid_public_key.length > 0, 'Push enabled without public key');
  passed('Bootstrap and private response caching', JSON.stringify({ push: capabilities.push, email: capabilities.email, attachments: capabilities.attachments, max_attachment_bytes: capabilities.max_attachment_bytes }));

  const counts = {};
  for (const view of ['active', 'archive', 'all', 'trash']) {
    const result = await json(await request(`/api/tasks?view=${view}`, { authenticated: true }), 200, `Tasks ${view}`);
    requireValue(Array.isArray(result.tasks), `Invalid ${view} task collection`);
    counts[view] = result.tasks.length;
  }
  passed('Task list views (no task contents printed)', JSON.stringify(counts));

  const htmlResponse = await request('/');
  requireValue(htmlResponse.status === 200 && htmlResponse.headers.get('content-type')?.includes('text/html'), 'App shell unavailable');
  const html = await htmlResponse.text();
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]);
  const manifestLink = links.find(link => /\brel=["']manifest["']/i.test(link));
  const manifestPath = manifestLink?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  requireValue(Boolean(manifestPath), 'App shell missing manifest reference');
  const manifestResponse = await request(manifestPath);
  requireValue(manifestResponse.status === 200 && /application\/(?:manifest\+json|json)/i.test(manifestResponse.headers.get('content-type') || ''), 'PWA manifest unavailable');
  const manifest = await manifestResponse.json();
  requireValue(manifest.display === 'standalone' && Array.isArray(manifest.icons) && manifest.icons.length > 0, 'PWA manifest missing standalone display or icons');
  sameOrigin(manifest.start_url);
  for (const icon of manifest.icons) {
    requireValue(typeof icon.src === 'string', 'Invalid icon reference');
    const response = await request(icon.src);
    requireValue(response.status === 200 && response.headers.get('content-type')?.startsWith('image/'), 'Manifest icon unavailable');
    requireValue((await response.arrayBuffer()).byteLength > 0, 'Manifest icon empty');
  }
  passed('App shell, PWA manifest, and icons');

  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]);
  requireValue(scripts.length > 0, 'App shell missing JavaScript entry');
  let registersWorker = false;
  for (const script of scripts) {
    const response = await request(script);
    requireValue(response.status === 200 && /(?:javascript|ecmascript)/i.test(response.headers.get('content-type') || ''), 'JavaScript entry unavailable');
    if ((await response.text()).includes('/sw.js')) registersWorker = true;
  }
  requireValue(registersWorker, 'JavaScript entry missing service worker reference');
  const workerResponse = await request('/sw.js');
  requireValue(workerResponse.status === 200 && /(?:javascript|ecmascript)/i.test(workerResponse.headers.get('content-type') || ''), 'Service worker unavailable');
  const worker = await workerResponse.text();
  requireValue(worker.includes('notificationclick') && /addEventListener\(\s*["']push["']/.test(worker), 'Service worker missing notification handlers');
  passed('JavaScript entry and push service worker');

  await logout();
  passed('Logout revokes this session');
  console.log(`Deployment verification passed: ${checks} checks. No task edits or notifications sent.`);
} catch (error) {
  // Controlled messages do not include request payloads or response bodies.
  console.error(`Deployment verification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  if (cookie) {
    try { await logout(); console.log('Cleanup: verification session revoked.'); }
    catch { console.error('Cleanup could not confirm session revocation; the verifier session may remain valid.'); process.exitCode = 1; }
  }
}
