# 任务工作台 · Task Workbench

一个可以自行部署的个人任务管理 PWA。电脑通过浏览器使用，iPhone 可以添加到主屏幕并接收 Web Push 通知，无需上架 App Store。任务、历史和小附件保存在 Cloudflare D1，**不需要 R2**。

A self-hosted personal task manager built with React, Cloudflare Workers and D1. Includes a calendar, customizable categories and statuses, attachments, a recycle bin, and Web Push reminders.

**系统提供功能，不规定你的工作方式。** 分类、标签、状态和提醒规则都可以按自己的习惯调整。

## 功能

- 快速创建任务，自动记录接收时间，支持无截止日期、优先级、进度、备注和后续跟进。
- 自定义分类、标签与状态；一个任务可同时属于多个分类，完成状态自动归档。
- 月历与周日程按截止日期展示任务，无截止日期单独列出；支持搜索、筛选与排序。
- 保留任务修改、进展、沟通、附件及删除恢复记录。
- 多附件逐个上传，显示进度，支持失败重试；单附件上限 **1.99 MB**。
- 单项删除、每批最多 100 项的批量删除，以及回收站恢复。
- 按截止日期与自定义偏移发送通知，支持逾期提醒。
- 适配电脑与手机的界面，包含容量显示与 JSON 数据导出。

这是**单用户应用**，使用一个访问口令，没有多用户权限或团队隔离。任务保存需要联网；邮件发送尚未接入，也没有离线编辑同步。

## 本地运行

需要 Git、**Node.js 24.13.0 或更新版本**和 npm，`.nvmrc` 固定了已验证的 24.13.1。依赖版本由 `package-lock.json` 固定。纯本地运行不需要 Cloudflare 账号。

```sh
git clone https://github.com/18861870889/task-workbench.git
cd task-workbench
npm ci
npm run setup
npm run types
npm run db:local
npm run build
npm run dev
```

打开 <http://localhost:8787>，使用 `.local/access.txt` 中生成的访问口令登录。

`npm run setup` 只创建缺失的文件，不覆盖已有配置或密钥：

| 文件 | 用途 |
| --- | --- |
| `wrangler.example.jsonc` | 可提交的通用 Cloudflare 配置模板 |
| `wrangler.jsonc` | 根据模板生成的个人部署配置，已被 Git 忽略 |
| `.dev.vars` | 本地口令、VAPID 密钥与本地地址，已被 Git 忽略 |
| `.local/access.txt` | 本地访问口令，已被 Git 忽略 |

本地数据库保存在 `.wrangler/state`，与云端数据库独立，不会自动同步。更改数据库标识或删除这个目录可能导致本地服务读取不同的数据库，请先备份自己的数据。

修改前端后，重新运行 `npm run build` 即可更新 Wrangler 提供的页面。开发界面时也可以保留 Wrangler，再在第二个终端运行 `npm run dev:ui`，使用 Vite 输出的本地地址；它把 `/api` 代理到端口 8787。

## 部署到自己的 Cloudflare

先完成本地初始化。只需要 Workers 和 D1，不需要开通 R2 或 Apple Developer 付费会员。Cloudflare 的免费额度不是无限额度，请查看其 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)与 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)。

### 1. 登录并创建数据库

```sh
npx wrangler login
npx wrangler whoami
npx wrangler d1 create task-workbench
```

如果账号已经有同名数据库，请选择新名称；同时更新配置及 `package.json` 中的数据库命令。创建数据库时若询问自动添加绑定，可选择手动填写，避免生成重复绑定。

编辑本地 `wrangler.jsonc`：

- `account_id`：添加自己的 Cloudflare 账号 ID。
- `name`：模板默认为 `personal-task-workbench`，可改为自己的 Worker 名称，决定网站地址的前半部分。
- `d1_databases[0].database_id`：把示例 ID 替换为刚创建数据库的真实 ID。
- `d1_databases[0].binding`：保留为 `DB`；`database_name` 与创建的数据库名称一致。
- 保留 `main`、`assets`、`migrations_dir`、兼容性设置和 Cron 配置。

然后初始化远程数据库并首次部署：

```sh
npm run db:remote
npm run deploy
```

Wrangler 会输出 HTTPS 网站地址。首次未设置访问口令时，登录接口会拒绝登录，这是正常的初始化状态。

### 2. 设置站点地址与密钥

将 `wrangler.jsonc` 中的 `vars.APP_ORIGIN` 和 `vars.VAPID_SUBJECT` 都改为刚获得的 HTTPS 网站源地址，例如 `https://your-worker.your-subdomain.workers.dev`，末尾不加路径或斜杠。

执行下面三个命令，在交互提示中分别输入 `.dev.vars` 中的同名值。密钥值不要作为命令行参数，也不要放进 Git：

```sh
npx wrangler secret put APP_PASSWORD
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npm run deploy
```

访问口令要求至少 24 个字符；初始化脚本已生成随机口令。VAPID 公钥与私钥必须是一对。不要直接把整个 `.dev.vars` 上传到云端，否则其中的本地地址与空通知配置可能覆盖正式配置。更多说明见 [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

### 3. 验证和后续更新

使用自己的地址执行：

```sh
node scripts/verify-deployment.mjs https://your-worker.your-subdomain.workers.dev
```

脚本使用本地 `.dev.vars` 的口令验证网站，检查登录、会话、任务列表、容量、静态资源与 PWA 配置。它只创建并撤销自己的登录会话，不编辑任务、不发送通知。

以后更新代码时，先备份数据库，再运行：

```sh
npm ci
npm run db:remote
npm run deploy
```

同一个 Worker 的密钥会保留；更换账号或新建 Worker 时需要重新设置密钥。新版本若修改通用配置，请对照 `wrangler.example.jsonc` 更新自己的 `wrangler.jsonc`，不要用模板覆盖真实配置。

## iPhone 与通知

1. 用 Safari 打开自己的 HTTPS 地址，选择“分享 → 添加到主屏幕”。
2. 从主屏幕图标打开工作台并登录。
3. 进入“分类与设置”，点击“启用此设备通知”，允许系统通知。
4. 使用测试通知核实接收，再用一个测试任务检查锁屏提醒及点击跳转。

iOS / iPadOS 16.4 及以后支持主屏幕 Web App 的 Web Push，不需要 App Store 上架或 Apple Developer 会员，参见 [WebKit 官方说明](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。换域名、换设备或重新安装后，应重新授权并订阅；更换 VAPID 密钥也需要重新订阅。

云端 Cron 每分钟检查提醒。推送依赖设备授权、系统通知设置及到推送服务的网络连通性，不保证精确到秒或每个地区都可达。发送成功表示推送服务接受，不能证明用户已经看到。纯本地 Wrangler 默认不运行 Cron，初始化配置也关闭了真实推送。

## 容量与使用边界

| 项目 | 当前实现 |
| --- | --- |
| 单个附件 | 最多 **1,990,000 字节（1.99 MB）**；不接受空文件 |
| 数据库总量 | 按免费版 **500,000,000 字节（500 MB）**设计，任务、历史、索引和附件共用 |
| 上传保护 | 为后续任务与历史预留 **2 MB**，另计文件记录及数据库页余量 |
| 删除 | 移入回收站，可恢复；目前没有永久清空功能，附件仍占容量 |
| 批量删除 | 每次最多 100 项，任一版本冲突则整批不变；不级联删除跟进任务 |
| 离线使用 | 只有离线提示页，不缓存私人任务，不支持离线编辑 |
| 邮件 | 仅预留设置字段，尚未接入邮件服务 |
| 导出 | 页面 JSON 导出含任务、历史及附件元数据，**不含附件文件本体** |

这里的 MB 使用十进制：1 MB = 1,000,000 字节。D1 免费版的单库限制是 500 MB，单个 BLOB 或整行最多 2 MB，因此应用为文件元数据预留空间；当前数字依据 [D1 官方限制](https://developers.cloudflare.com/d1/platform/limits/)。设置页的“预计可再存附件量”是估算，Cloudflare 的数据库写入限制仍是最终约束。容量不按月清零，归档或移入回收站也不会释放附件空间。

日期以 UTC 保存，按设备本地时区显示。日程中的日期表示截止时间，不表示任务持续时间；修改日期请打开详情，目前不支持拖拽改期。提醒按自然时间计算，不排除周末。删除会停止未发送的提醒，恢复不会重放已经发送或取消的同一条提醒。

## 备份

页面 JSON 导出适合查看和处理记录，不能代替完整备份。D1 SQL 导出包括文件 BLOB，也可能含会话和推送订阅，必须私密保管：

```sh
npx wrangler d1 export task-workbench --remote --output .local/task-backup.sql
```

**大附件的导出再导入恢复尚未完成验证。** BLOB 转成 SQL 文本后会膨胀，而 D1 对单条 SQL 长度有限制；不能假设任意导出文件都能直接恢复。请在替换现有数据库前，先在隔离数据库中演练恢复并校验附件内容。D1 的 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 可以作为补充恢复手段。

更换站点地址时，除了迁移业务数据，还需要重新建立登录会话和设备推送订阅。不要把真实数据库导出、密钥或用户附件提交到本仓库。

## 开发与验证

```sh
npm run test:local
```

这个命令完成类型生成、类型检查、前端构建、隔离数据库迁移与测试，并在结束后停止测试服务、删除临时数据。它需要本机端口 **8788** 空闲，使用临时本地口令，不连接正式数据库，不向真实设备发送通知。自动测试覆盖日程与时区、任务与分类、鉴权、附件长度和容量、上传重试、原子批量删除、恢复以及通知逻辑。

GitHub Actions 使用相同的本地验证流程，不需要 Cloudflare 账号或部署密钥。iPhone 安装、实际网络下的锁屏推送和系统文件选择器仍需要实机验收。

项目结构与修改建议见 [架构说明](docs/ARCHITECTURE.md)，参与开发见 [贡献指南](CONTRIBUTING.md)。`scripts/verify-migration.mjs` 是额外的运维核验工具，不是本地启动或部署的必需步骤。

## 开源组件与许可

主要组件包括 [React](https://react.dev/)、[Hono](https://hono.dev/)、[FullCalendar](https://fullcalendar.io/docs/react)、[WebCrypto Web Push](https://github.com/block65/webcrypto-web-push) 和 [Cloudflare Workers / D1](https://developers.cloudflare.com/)。前端资源随项目构建，不依赖第三方 CDN。

开发参考了 [Cloudflare 官方 skills](https://github.com/cloudflare/skills) 与 [Workers 最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。使用和修改本项目不需要安装 AI 开发工具或 skills。

本项目采用 [MIT License](LICENSE)，允许使用、修改和再分发。第三方依赖保留各自的许可证。
