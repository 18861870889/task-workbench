import { createECDH, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const projectFile = name => new URL(`../${name}`, import.meta.url);

try {
  await copyFile(projectFile('wrangler.example.jsonc'), projectFile('wrangler.jsonc'), constants.COPYFILE_EXCL);
  console.log('已复制 wrangler.example.jsonc → wrangler.jsonc（仅本地占位配置）。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('wrangler.jsonc 已存在，保留现有配置。');
}

let existing;
try { existing = await readFile(projectFile('.dev.vars'), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

if (existing !== undefined) {
  console.log('.dev.vars 已存在，保留现有口令与密钥。');
  const password = existing.match(/^\s*APP_PASSWORD\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
  if (!password || password.length < 24 || /^(replace-with|change-?me|your-password)/i.test(password)) {
    console.error('现有 .dev.vars 的 APP_PASSWORD 为空、过短或仍为示例占位符。请设为至少 24 个随机字符；如该文件只是刚复制的空白模板，可删除模板后重新运行 npm run setup。现有文件未被覆盖。');
    process.exitCode = 1;
  }
} else {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  const password = randomBytes(24).toString('base64url');
  await mkdir(projectFile('.local/'), { recursive: true, mode: 0o700 });
  await writeFile(projectFile('.dev.vars'), `APP_PASSWORD=${password}\nVAPID_PUBLIC_KEY=${pair.getPublicKey().toString('base64url')}\nVAPID_PRIVATE_KEY=${pair.getPrivateKey().toString('base64url')}\nVAPID_SUBJECT=\nAPP_ORIGIN=http://localhost:8787\n`, { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(projectFile('.local/access.txt'), `任务工作台访问口令（不要提交到 Git）\n\n${password}\n`, { mode: 0o600, flag: 'wx' });
    console.log('已生成 .dev.vars 与 .local/access.txt。请在本机打开 .local/access.txt 查看登录口令。');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('已生成 .dev.vars；.local/access.txt 已存在而未覆盖，本次新口令请以 .dev.vars 的 APP_PASSWORD 为准。');
  }
  console.log('本地 VAPID_SUBJECT 留空，默认不会发送真实推送。');
}
