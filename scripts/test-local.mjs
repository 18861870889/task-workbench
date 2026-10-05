// Real Wrangler/D1 integration tests, always against a new disposable local DB.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = join(root, 'node_modules/wrangler/bin/wrangler.js');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const port = 8788;
const base = `http://127.0.0.1:${port}`;
const children = new Set();
let interrupted = false;
let testDirectory;
let reservation;

// Deliberately exclude Cloudflare credentials, inherited Worker secrets and
// any test URL supplied by the caller. No account or production config is used.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(CLOUDFLARE_|CF_|WRANGLER_|VAPID_|APP_PASSWORD$|APP_ORIGIN$|TEST_)/.test(key)));
Object.assign(env, {
  CI: 'true', WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
});

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32', ...options,
  });
  children.add(child);
  // Install handlers immediately, including for the long-lived dev server.
  child.finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${command.split(/[\\/]/).at(-1)} ${args[0]} failed (${signal || code})`));
    });
  });
  child.finished.catch(() => {});
  return child;
}

async function run(command, args) {
  if (interrupted) throw new Error('Test run interrupted');
  await start(command, args).finished;
}

async function runNpm(args) {
  // npm supplies its JS entry point to npm run scripts. Invoking it through
  // Node also works on Windows without shell quoting or spawning npm.cmd.
  if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args]);
  if (process.platform === 'win32') throw new Error('On Windows, start this runner with npm run test:local.');
  return run(npm, args);
}

async function stop(child) {
  if (!child.pid || (child.exitCode !== null || child.signalCode !== null)) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await new Promise(resolve => { killer.once('error', resolve); killer.once('close', resolve); });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const force = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5_000);
    force.unref();
    await child.finished.catch(() => {});
    clearTimeout(force);
  }
}

const interrupt = () => {
  interrupted = true;
  process.exitCode = 130;
  for (const child of children) void stop(child);
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 13)) throw new Error('Node.js >= 24.13.0 is required (including node:sqlite).');

  // Fail before any build/database work if another local server owns this port.
  reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', error => reject(new Error(`Cannot reserve ${base}: ${error.code}. Stop the server on port ${port} and retry. No tests were sent to it.`)));
    reservation.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });

  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  testDirectory = await mkdtemp(join(root, '.local', 'ci-test-'));
  env.WRANGLER_LOG_PATH = join(testDirectory, 'wrangler.log');
  env.TEST_APP_PASSWORD = randomBytes(32).toString('base64url');
  env.TEST_BASE_URL = base;
  const config = join(testDirectory, 'wrangler.jsonc');
  const state = join(testDirectory, 'state');
  await writeFile(config, JSON.stringify({
    name: 'task-workbench-local-tests',
    main: join(root, 'worker/index.ts'),
    compatibility_date: '2026-10-04',
    compatibility_flags: ['nodejs_compat'],
    assets: {
      directory: join(root, 'dist'), binding: 'ASSETS',
      not_found_handling: 'single-page-application', run_worker_first: ['/api/*'],
    },
    d1_databases: [{
      binding: 'DB', database_name: 'task-workbench-local-tests',
      database_id: '00000000-0000-0000-0000-000000000001',
      migrations_dir: join(root, 'migrations'), remote: false,
    }],
    vars: { APP_ORIGIN: base, VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' },
  }, null, 2), { mode: 0o600 });
  // Adjacent secrets file prevents Wrangler from reading the developer's file.
  await writeFile(join(testDirectory, '.dev.vars'), `APP_PASSWORD=${env.TEST_APP_PASSWORD}\nVAPID_SUBJECT=\nVAPID_PUBLIC_KEY=\nVAPID_PRIVATE_KEY=\nAPP_ORIGIN=${base}\n`, { mode: 0o600 });
  console.log('Running types, typecheck, build and tests against a disposable local D1 database.');
  await run(process.execPath, [wrangler, 'types', join(root, 'worker-configuration.d.ts'), '--config', config, '--strict-vars=false']);
  await runNpm(['run', 'typecheck']);
  await runNpm(['run', 'build']);
  await run(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--config', config, '--local', '--persist-to', state]);

  await new Promise(resolve => reservation.close(resolve));
  reservation = undefined;
  const server = start(process.execPath, [wrangler, 'dev', '--config', config, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', state, '--test-scheduled', '--show-interactive-dev-session=false']);
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !interrupted) {
    if (server.exitCode !== null || server.signalCode !== null) await server.finished;
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  if (!ready) throw new Error('Disposable local server did not become ready within 60 seconds.');

  // A unique password confirms we reached this run's Worker before mutation tests.
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: env.TEST_APP_PASSWORD }), signal: AbortSignal.timeout(5_000),
  });
  if (!login.ok) throw new Error('Local server identity check failed; integration tests were not run.');
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: login.headers.get('set-cookie').split(';')[0] }, signal: AbortSignal.timeout(5_000) });
  await runNpm(['test']);
} catch (error) {
  console.error(error.message);
  process.exitCode ||= 1;
} finally {
  if (reservation?.listening) await new Promise(resolve => reservation.close(resolve));
  await Promise.all([...children].map(stop));
  if (testDirectory) {
    await rm(testDirectory, { recursive: true, force: true });
    console.log('Stopped the test server and removed its temporary database and secrets.');
  }
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
