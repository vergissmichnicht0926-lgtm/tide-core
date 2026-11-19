# Tide Gateway — M2a 骨架

> R1 的 M2a 部分：`node:sqlite` schema/迁移、DB 访问、`/health`、`/conversations/*` 骨架。
> 樱的 auth 模块按下面接口接，不阻塞。

## 运行

```powershell
$env:TIDE_DB_PATH = "<repo>\gateway\data\gateway.db"
$env:TIDE_GATEWAY_PORT = "8080"
$env:TIDE_DSH_BASE_URL = "http://127.0.0.1:3081"
$env:TIDE_JWT_SECRET = "<至少 32 字节的随机串>"   # 生产必须固定；不设会每次重启失效
node scripts/seed-user.mjs owner password123       # 首次建用户
node server.mjs
```

测试：

```powershell
npm test
```

## M2a 已实现

- `db/schema.sql`：conversation / message / attachment / seen_seq / message_batch / agent_memory / pending_wake。
- `auth/schema.sql`：users / devices / login_attempts（migrate 时排在 db/schema.sql 之后）。
- `db/index.mjs`：`node:sqlite` `DatabaseSync`，WAL、FK、busy_timeout、`integrity_check` 失败只读、事务、seq 分配。
- `GET /health`：`{ ok, db, dsh, version }`。
- `GET/POST /conversations`、`GET /conversations/:id/messages`、`POST /conversations/:id/prompt`、`POST /conversations/:id/read`、`POST /conversations/:id/policy` 的 DB 骨架。
- 樱的 `auth/service.mjs` + `routes/auth.mjs` 已接入：`/auth/login`、`/auth/refresh`、`/auth/logout`、`/auth/devices`、`/auth/me`。
- `/agent/*` 仍是 501，M2b 接 inbox/wait/SSE；`POST /prompt` 目前只落库，不投 DSH。

## auth 接口

- `auth/service.mjs` 导出 `createAuthService({db, secret})`，提供 `login/refresh/logout/authenticate/listDevices/revokeDevice/createUser`。
- `routes/auth.mjs` 导出 `createAuthRoutes({service})`，返回路由数组；`server.mjs` 负责匹配/分发。
- 密码：`node:crypto.scrypt`，存储格式带算法前缀；JWT：`auth/jwt.mjs` 的 HS256。

## 边界

- 用户的 `agent_token` 不返回给 App；`/conversations` 只返回公开字段。
- `policy` 现在只改 DB 行，不重建 DSH session；M2b 接 `/policy` 的 session 重建。
- `seen_seq` / `message_batch` 已建表，M2b 的 `chat_mark_read` / `chat_send` 会用到。

## M4.5 v2 唤醒与发言

- `conversation.kind` / `wake_config_json` / `social_state_json` 已落库；
  老库打开时自动补列并把 `{}` / 坏 JSON 回填成完整默认。
- 群聊 8 触发、`[SILENT]`、`replyCheck`、`proactiveCheck`、沉睡前观察、
  唤醒限频与发送节流在 `social/` 下实现。
- 群聊 prompt 覆盖 `tide.patch.yml` 的三段私聊口径，并声明本会话没有 MCP resource 工具。
- 详细口径与接口变化见 `docs/M4.5-WAKE.md`。

## M6.5a 单 bot 多用户

- `users.role`（admin/guest）、邀请码注册、`/auth/me` capabilities；
- `/admin/*` 管理员接口、`/requests` guest 申请；
- guest direct conversation、`usage_daily` 消息/上传配额；
- `persona_override`、`TIDE_AGENT_SECRET` fail-closed、`/health.agentSecret`。
- 细节与上线顺序见 `docs/M6.5-ADMIN.md`。

## P0 多会话保活：用户级 SSE

P0 只复用现有 SSE，不引入 Centrifugo / MQTT，也不合并 DSH session。
一个 DSH session 仍然只对应一个 conversation；传输层只负责把同一用户的多条
conversation 事件复用到一条 `/stream` 上。

### 开关与默认值

默认始终是 legacy。只有显式设置 `TIDE_REALTIME_STREAM_ENABLED=1`，并且
`/realtime/config` 对该用户返回 `mode=user` 时，新客户端才会建立用户级流。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TIDE_REALTIME` | `legacy` | `legacy` / `user` / `auto` |
| `TIDE_REALTIME_STREAM_ENABLED` | 未启用 | 必须显式为 `1`，`/stream` 才可能切到 user |
| `TIDE_REALTIME_USER_IDS` | 空 | `auto` 模式的 allowlist，逗号分隔 |
| `TIDE_REALTIME_PERCENT` | `0` | `auto` 模式按用户 id 哈希分配的百分比 |
| `TIDE_STREAM_REPLAY_LIMIT` | `200` | 每个 conversation 的 SSE 回放上限 |
| `TIDE_STREAM_REPLAY_TOTAL_LIMIT` | `3000` | 一次连接内所有 conversation 的回放总上限 |
| `TIDE_STREAM_MAX_BUFFER_BYTES` | `1048576` | 慢客户端断开阈值 |

`TIDE_REALTIME=legacy` 时 `/stream` 返回 `409 realtime-legacy`，旧的
`/conversations/:id/stream` 始终保留。新客户端收到 404 / 409 / 426 会回退到
当前会话的 legacy 流；401 先走 refresh，5xx 和断网继续用户流退避重连。

### 接口

`GET /realtime/config`（需要 Bearer）：

```json
{
  "mode": "user",
  "streamEnabled": true,
  "streamPath": "/stream",
  "fallbackPath": "/conversations/:id/stream",
  "contractVersion": 1,
  "replayLimit": 200
}
```

`GET /stream?since=<cursors>`：

- `since` 为空：只返回 `ready` 快照，不回放。
- 单个非负整数：对所有会话回放 `seq > since`，仅用于兼容。
- 精确列表：`cid:epoch:seq,cid:epoch:seq`。最多 100 条，query 最长 8192 字符。
- 非法格式返回 `400 bad-request`；非成员或未知 conversation 的游标忽略。
- 服务端先订阅并缓冲，再查询快照、发 `ready`、回放，最后 flush 缓冲，避免
  回放与实时订阅之间的丢事件窗口。

`ready` 快照示例：

```json
{
  "v": 1,
  "type": "ready",
  "latestSeq": 120,
  "serverTime": "2026-11-13T10:00:00.000Z",
  "conversations": [{
    "conversationId": "9c0332da-...",
    "title": "汐语",
    "kind": "direct",
    "epoch": 2,
    "latestSeq": 120,
    "lastSentSeq": 100,
    "lastReadSeq": 100,
    "joinSeq": 0,
    "unread": 3,
    "replaySkipped": false,
    "epochChanged": false,
    "cursorAhead": false
  }]
}
```

事件信封固定包含 `v / type / conversationId / epoch / seq / messageId /
createdAt / at`，其中非消息事件可以没有 `seq` 或 `messageId`。

| type | 关键字段 | 说明 |
|---|---|---|
| `user_message` / `assistant_message` | `message` | 消息正文与现有公开消息结构一致 |
| `turn_start` / `turn_end` | `requestId`、`reason` | 仅用于当前会话的输入状态 |
| `conversation.rebuilt` | `epoch`、`seq`、`reason` | 只在 DSH session 真正替换时递增 epoch |
| `conversation.read` | `lastReadSeq` | 同一用户多设备已读同步，不带消息 seq |
| `conversation.created` | `epoch`、`latestSeq` | 新会话或被拉进群 |
| `conversation.deleted` | `reason` | 被移出会话或会话删除 |

内部字段 `agent_token / dsh_session_id / dsh_workspace_id / prompt / policy hash`
不会出现在任何 SSE 事件里。

### 重连与对账

客户端按 conversation 分别持久化 `epoch/lastSeq`，切会话只切 UI 过滤，不重开流。
重连时发送精确游标；服务端每会话超过 200 条时返回 `replaySkipped=true`，
客户端用 `GET /conversations/:id/messages?after_seq=` 分页补齐。

- `serverEpoch > localEpoch`：接受新代次，保留 `min(localSeq, serverLatest)`，
  再从该水位 REST catch-up。
- `serverEpoch == localEpoch && serverLatest < localSeq` 或 `cursorAhead`：
  把本地游标夹到 `serverLatest`，按 `after_seq` 补，不从头重拉。
- `serverEpoch < localEpoch`：服务端快照权威，只降 epoch，seq 尽量保留。
- `conversation.rebuilt` 且 `seq == localSeq`：只换 epoch，不重载 UI。
- 超过客户端 2000 条 catch-up 上限时跳到最新水位，并提示“历史消息过多，已跳到最新”。

### 灰度与回退

推荐顺序：

1. staging 设置 `TIDE_REALTIME=user`、`TIDE_REALTIME_STREAM_ENABLED=1`，先验一条流承载 3 个会话。
2. 生产设置 `TIDE_REALTIME=auto`、显式启用 stream，并用 `TIDE_REALTIME_USER_IDS=usr_...` 只放 owner。
3. 观察 24 小时，再看 `TIDE_REALTIME_PERCENT` 从 10% → 50% → 100%。
4. 旧 App 始终走 `/conversations/:id/stream`，不需要同步升级。

回退只需去掉 `TIDE_REALTIME_STREAM_ENABLED`，或把 `TIDE_REALTIME` 改回 `legacy`，
然后重启网关。新客户端收到 409 后用当前会话的 legacy 流保证实时，
恢复用户流后由 `ready` + REST 补齐其他会话。数据库里的 additive `epoch` 列不需要回滚。

### 灰度指标

`GET /health.realtime` 暴露进程内累计和当前值：

```json
{
  "activeUserConnections": 42,
  "connectionsOpened": 137,
  "connectionsClosed": 95,
  "catchUpRequests": 18,
  "replayEvents": 860,
  "replaySkipped": 3,
  "epochChanged": 1,
  "cursorAhead": 0
}
```

- `activeUserConnections` 是当前尚未关闭的用户级 SSE 数。
- `connectionsOpened - connectionsClosed` 应约等于 `activeUserConnections`。
- `(connectionsOpened - activeUserConnections) / connectionsOpened` 是累计重连率。
- `replaySkipped` 持续增长说明回放上限偏低或客户端离线过久，应结合 `catchUpRequests` 看 REST 压力。
- `cursorAhead` 持续增长说明 DB 恢复或清理导致客户端游标超前；需要检查客户端夹水位逻辑。
- `epochChanged` 应与 rebuild 次数同量级；远高于 rebuild 次数通常意味着客户端 epoch 持久化异常。

这些值在进程重启后归零，生产环境应定期抓取 `/health` 并保留时序数据。

### 验收命令

```powershell
cd <repo>\gateway
npm test
node --test tests/p0-6-recovery-metrics.test.mjs

cd tide-android
.\gradlew.bat :app:testDebugUnitTest
.\gradlew.bat :app:assembleDebug
```

当前 P0-6 自动化覆盖：用户级 ready / 三会话分发 / since 精确回放 /
replaySkipped / epochChanged / 多设备已读 / rebuild 单会话 epoch /
网关重启后 SSE replay 与 REST `after_seq` 同水位续上 / health 灰度指标。

## P0-6 运维

### 每日数据库备份

计划任务 `TideBackup` 每天 03:00 执行：

```powershell
node <repo>\gateway\scripts\backup-daily.mjs
```

- 输出目录：`<repo>\data\backups\daily`
- 压缩格式：`tide-<ISO>.db.gz`
- 保留：最近 7 份
- 校验：源库和备份库都执行 `PRAGMA integrity_check`，并比对会话数、消息数、附件数
- 日志：`<repo>\data\backup.log`，每行一条 JSON
- 失败时进程退出码为 1，计划任务会按 5 分钟间隔重试，最多 3 次
- 离机副本：同一份 `.db.gz` 通过 `scp` 推到
  `<user@host:/path>`，上传后做远端 `sha256sum`
  比对；远端同样保留最近 7 份

离机参数可用环境变量覆盖：

```text
TIDE_BACKUP_OFFSITE=0                 # 临时关闭离机上传
TIDE_BACKUP_SCP_KEY=<path>            # 默认 %USERPROFILE%\.ssh\bot_key
TIDE_BACKUP_REMOTE=<user@host:/dir>   # 默认 <user@host:/path/>
```

手工试跑：

```powershell
$env:TIDE_DB_PATH = '<repo>\data\gateway.db'
node <repo>\gateway\scripts\backup-daily.mjs
```

### 守护任务

- `TideGateway`：登录时拉起网关；失败后 5 分钟重试，最多 3 次。
- `TideTunnel`：登录时拉起公网反隧道；失败后 5 分钟重试，最多 3 次。
- `TideBackup`：每日备份；失败重试规则相同。

网关的 `start-gateway.bat` 会在每次重启子进程前重读
`data/realtime.env`。灰度时写：

```text
TIDE_REALTIME=user
TIDE_REALTIME_STREAM_ENABLED=1
TIDE_REALTIME_USER_IDS=usr_...
```

回退时删除该文件并重启网关即可。

`start-gateway.ps1` 自带端口守卫：7800 已占用时直接以 0 退出，避免计划任务
制造 `EADDRINUSE` 假故障；正常持有时 node 退出后 5 秒自动重启，`PT5M/3`
只作为脚本自身崩溃的兜底。

### 一键真机验收

脚本：`tools/verify-p0.6.ps1`

```powershell
pwsh -NoProfile -File <repo>\tools\verify-p0.6.ps1 `
  -ApkPath <apk>
```

无手机时可先验证发布包、user 配置和 legacy 回退：

```powershell
pwsh -NoProfile -File <repo>\tools\verify-p0.6.ps1 -SkipDevice
```

完整流程会：

1. 安装 APK 并核对手机上的 `versionCode=905`；
2. 写 staging `realtime.env` 并重启网关；
3. 用本地签发的 5 分钟 access token 检查 `/realtime/config`；
4. 抓 `TideSSE` logcat，确认 `/stream` 建立；
5. 向 3 个会话各发一条并核对落库；
6. `force-stop` 后投递探针消息，重开确认 `since` replay；
7. 删除 `realtime.env`，确认客户端自动落回 legacy；
8. 在 `data/verify` 输出带证据的 Markdown 报告。

`gateway/scripts/mint-access-token.mjs` 是 ops-only 工具：需要本机
`data/jwt-secret.txt` 和数据库，只用于命令行验收。不要把它挂到任何 HTTP
路由，也不要把生成的 token 写进日志或提交到仓库。

## M9 动态

- `GET /moments?limit=30&before=<ms>`：已添加私聊 bot 的用户可见，按发布时间倒序；每条带 `likes` / `likedByMe`。
- `POST /moments/:id/like`、`DELETE /moments/:id/like`：点赞开关，按用户唯一，返回 `{ liked, likes }`。
- `POST /agent/moments`（agent 三件套头）：私聊 bot 发布动态，`text` 1~2000 字，单会话每天 20 条。
- 可见性：当前是单 bot 单人格，时间线对所有添加了私聊的用户共享；群聊不能发布。没私聊的用户拿到空列表，点赞返回 404。

## 0.11 聊天补完

- `PATCH /conversations/:id` `{ title?, announcement? }`：群名仅群主，1~30 字；公告群主或管理员，≤500 字。发 `conversation.updated`。
- `POST /conversations/:id/members/:uid/role` `{ role: 'admin'|'member' }`：仅群主；DB 里用 `is_admin` 标记（历史 CHECK 仍是 member），API 映射成 `admin`。
- `DELETE /conversations/:id`：仅群主、仅群聊，软删 `deleted_at`；列表、消息、`/agent/*`、用户流都会过滤掉。
- `POST /conversations/:id/messages/:mid/recall`：本人 2 分钟内，或群主随时；清空正文、落 `recalled_at`，发 `message.recalled`。
- `GET /conversations/:id/messages?q=<kw>`：会话内搜索，`LIKE` 已转义 `%`/`_`，最多 100 字；`?around=<mid>` 返回该消息附近的窗口。
- 引用：`POST /prompt` 的 `reply_to_message_id` 现在会写进 `content_json`，消息返回 `replyTo`（sender/text/recalled）。
- @：`extractMentions` 改为按最长名字匹配，支持名字里带空格和标点；`@小汐` 仍映射到 `agent`。
- 迁移：`conversation.announcement/deleted_at`、`message.recalled_at`、`conversation_member.is_admin` 都是 additive，无表重建。

## 0.12 资料同步

- `PATCH /auth/me` `{ display_name?, avatar? }`：昵称 1~30 字；头像 `data:image/(png|jpeg|webp);base64,...`，最多 600000 字符（客户端先压到 256px）。改名会同步该用户所有 `conversation_member.display_name`。
- `GET /users/:id/avatar`：本人或同群成员可读，其余一律 404；响应带 `private, max-age=86400`。
- `GET /conversations/:id/members/:uid`：单个成员，头像点击时不再拉整份名单。
- `listMembers` 与单成员接口都返回 `username`、`has_avatar`、`avatar_version`（头像内容哈希前 12 位，用于缓存失效）。
- **可见面说明**：`username` 现在对同群成员可见（此前只有管理员能看到）。这是加人/辨认用的账号名，不含密码或设备信息。

## 0.14 管理台 P0

- `GET /console`：浏览器入口（nginx 下是 `/tide/console`），静态三文件 `index.html` / `admin.css` / `admin.js`，`script-src 'self'`，无内联脚本和样式。
- `POST /console/api/session` `{username,password}`：只认 `users.role='admin'`；限流键是 `username + 客户端 IP`，5 次失败锁 15 分钟（陌生人锁不住同账号的其它 IP）；成功下发 `tide_admin` cookie（`HttpOnly; Secure; SameSite=Strict; Path=/tide/console`，24 小时）并返回独立 `csrfToken`。
- `GET /console/api/session` 刷新 CSRF；`DELETE /console/api/session` 需要 `X-Tide-CSRF`。
- `GET /console/api/overview`：六盏灯（网关 / 数据库 / DSH / 公网隧道 / 证书 / 备份）+ 六个指标 + 最近 50 条事件。`version` 是 `gateway/package.json` 的应用版本，`dbVersion` 才是数据库 schema 版本。隧道和证书由网关反向探测 `TIDE_PUBLIC_BASE_URL`；读不到就显示「—」，不画假绿灯。
- `GET /console/api/conversations`：只读会话表，含 `dsh_session_id` 去掉 `session-` 前缀后的 8 位诊断列。
- `/admin/*` 仍只认 Bearer，与 cookie 完全隔离；`tide_admin` 不能授权 `/admin/*`。
- 回退：`TIDE_CONSOLE=0` 关闭 `/console*`，表保留，无副作用。
- cookie 的 `Path=/tide/console` 依赖 nginx 的 `/tide` 前缀；直连网关调试 `/console` 时浏览器不会带回 cookie，这是预期行为。
- `x-real-ip` 只在连接来自本机回环（nginx 同机）时采信；局域网直连 7800 时按 socket 地址记录，头伪造无效。

### 事件表 `event_log`

`writeEvent` 永不抛；`detail` 只放元数据，不含消息正文、密码、token、cookie。

| kind | level | 触发 |
|---|---|---|
| `gateway.start` | info | 网关开始监听 |
| `sse.open` | info | 用户级 / 单会话 SSE 发出 ready |
| `session.rebuild` | info/error | 重建队列每次结束 |
| `backup.ok` | info | 每日备份成功 |
| `message.failed` | error | 服务端投递 DSH 失败（含 send_queue） |
| `console.login` | info/warn | 管理台登录成功/失败 |

保留 30 天 / 最多 10 万条，由每日备份入口调用；也可手动 `node gateway/scripts/prune-events.mjs`。

## 0.15 管理台 P1

- `GET /console/api/bot`：机器人只读状态（运行模式、唤醒默认配置、静默、模型）。`model` / `toolProfile` 目前只落库、未透传给 DSH，接口用 `modelWired=false` 明确标注。
- `PATCH /console/api/bot` `{name?, signature?, personaOverride?, avatar?}`：人格卡。昵称 1~40、签名 ≤200、提示词 ≤4000、头像 data URI ≤500000；未知字段直接 400，不静默截断。改完下一轮投递生效，不用重启。
- `GET /console/api/bot/avatar`：返回头像字节（无头像 404）。
- `GET/POST /console/api/invites`、`POST /console/api/invites/:id/revoke`：邀请码四态 `active / expired / used-up / revoked`，只有 active 可分享；写操作要 CSRF。
- `GET /console/api/users`、`GET /console/api/users/:id/devices`、`POST /console/api/users/:uid/devices/:did/revoke`：设备列表带原始 `trustedDeviceId`；吊销会级联受信组，并断开该设备的活动 SSE（返回 `closedStreams`）。
- 吊销语义：`authenticate` 每次请求查设备撤销，access token 下一次请求即 401 `token-revoked`；其它设备不受影响。
- 所有控制台 API 响应带 `no-store` 与 `nosniff`；写操作统一写 `audit_log` 与 `event_log(kind='console.change')`。

### TideGatewayProbe（0.15.1）

- 计划任务每 5 分钟跑一次 `gateway/scripts/probe-gateway.ps1`：7800 没监听就 `Start-ScheduledTask TideGateway`，有监听直接退出。
- `ExecutionTimeLimit=PT1M`、`MultipleInstances=IgnoreNew`、`StartWhenAvailable=true`。
- 这是 TideGateway 自身循环之外的兜底：整棵进程树被杀、脚本崩、休眠后任务丢失，都能在 5 分钟内自愈。

## 0.16.0 管理台 P2：UI 重排

- 侧栏三组七页：工作空间（总览、会话）· 智能体（仿真、人格）· 安全与系统（邀请与设备、访问与安全、工具参考），`#/overview` … `#/tools` hash 路由。
- 总览指标四格（模式 / 实时连接 / 会话数 / 今日消息）；会话搜索、类型筛选、分页、详情抽屉（成员 + 最近 5 条事件）。
- 仿真只读，五个状态角标；人格卡带底部保存条；邀请与设备合并用户列表与邀请码四态分组；审计与登录历史各自分页；工具参考读取 `public/console/tools.json`。
- 只增字段/只读端点：`overview` 增 `conversationCount / replaySkipped / epochChanged`，`conversations` 增 `membersDetail`；新增 `GET /console/api/conversations/:id/events`、`/audit`、`/login-attempts`。`/admin/*` 未改。
- 前端零依赖、零构建链；`index.html + css + js + views + tools.json` 合计 < 200 KB。

## 0.17.0 管理台 P3：仿真配置面

- `GET/PATCH /console/api/bot/wake`：写 `bot_settings.default_wake_config_json`；校验复用 `validateWakeConfigInput`，`active` 强制 `anyMessage`，默认配置不暴露 `sleepUntil`。只影响新会话，已有会话不动。
- `PATCH /console/api/bot/limits` `{limits:{dailyMessages,maxConversations,uploadMb}}`：范围 1~100000 / 1~1000 / 1~1024，写 `per_user_limits_json`，立即对所有用户生效。
- `GET /console/api/tools`：读 `public/console/tools.json`；生成脚本 `gateway/scripts/gen-console-tools.mjs` 从 `mcp/tide-mcp.mjs` 的 `tools` 定义生成，运行时不解析源码。
- 仿真页四张卡、四个状态角标；唤醒配置与配额共用底部保存条，配额保存前弹确认。
- `/admin/*` 未改；Bearer 侧响应保持原样。

## 0.19.0 管理台 P5：运维块

- `gateway/scripts/probe-gateway.ps1` 每次运行都原子写 `data/probe-status.json`（`lastCheckAt / lastResult / lastRestartAt / restartMs / targetPid / reason / error`），原有 `probe.log` 保留。
- `GET /console/api/ops`（只读、需登录 cookie）：返回 `probe / gateway / db / backup` 四块；探活文件超过 10 分钟未更新为 `stale`，JSON 坏了按 `missing`，接口不 500。
- 总览新增「运维」卡：探活 / 备份 / 网关三盏灯 + 最近自愈、WAL、版本明细；数据来自 `ops`，不改 `overview` 契约。
- 人格页移除 F-03 贴纸、F-04 语音占位卡。

## 0.20.0 管理台 P6：唤醒参数可配

- `wake_config_json` 新增 `limits`（`maxWakePerMinute / maxWakePerHour / preSleepWaitMs / noActionLimit / maxWakeConfigReminders`）与 `hint`；老配置缺失时读时补默认，不写回。
- 引擎按会话读取 `wake.limits`，优先级 `wake.limits > ctx.config.social > DEFAULT_SOCIAL_CONFIG`；连续无行动重置保留 limits 与 hint。
- 提示词注入实际的 `preSleepWaitMs`；`wakeConfigSummary` 追加限制行与管理员建议。
- 仿真页 G5 变为「唤醒硬限制（新会话默认）」五个数字输入，G4 增加 200 字 `hint` 文本域；只影响新会话默认值，会话级编辑留给 P6.1。
- `chat_set_wake_config` schema 接受 `limits` / `hint`，返回体回显。

## 0.21.0 管理台 P6.1：会话级唤醒

- 新增 `GET/PATCH /console/api/conversations/:id/wake` 与 `POST .../wake/reset`；直接读写该会话的 `wake_config_json`，保存后引擎下一次唤醒即生效。
- `sleepUntil / lastWakeAt / wakeCount / confirmedAt / confirmedBy` 由网关维护，写接口出现即 400；`sleepUntil` 在读取接口里换算成毫秒数，0 表示无。
- `matchesDefaults` 按归一化后的会话配置与当前 `bot_settings.defaultWakeConfig` 深比较，忽略网关自管的时间/计数/确认字段。
- 「恢复为默认」复制当前默认配置，而不是产品内置常量。
- 会话详情抽屉新增「本会话唤醒」：模式、五个触发、关键词、概率、批窗、五个 limits 与 hint；不展示未实现的 `speakerIds`。保存只刷新本区块摘要，不重载整页。
- `/admin/*`、`/console/api/bot/wake`、MCP 工具均未改；无新依赖、无数据库变更。

## 0.22.0 管理台 F-09：全局静默

- `bot_settings.silent_until_ms`（默认 0，老库启动自动补列）；`silentUntil` 为绝对毫秒，静默到期自动失效。
- 静默期间 `deliverWake / scheduleWake / enqueuePendingWake / scheduleReplyCheck / scheduleProactiveCheck` 全部跳过并写 `silent` 日志；消息落库、未读、SSE 与显式 `chat_send` 不受影响。
- `GET /console/api/bot` 增 `silentUntil`；新增 `GET/PATCH /console/api/bot/silence`，支持 `minutes`（1~10080）、未来 `until`（最长 7 天）或 `{off:true}`。
- 审计 `bot.silence` 双写 `audit_log` / `event_log`，detail 含 `until` 与 `source`。
- 总览顶部静默状态条；人格页新增静默卡：开关、30 分钟 / 1 小时 / 8 小时 / 到明早 8 点 / 解除，剩余时间每 30 秒本地刷新。
- `/admin/settings` 改为固定白名单输出，新增列不会泄漏到旧 Bearer 接口。

## 0.23.0 管理台 F-01：多气泡间隔

- `chat_send` 新增 `segments`（1~4 段，单段 ≤2000 字），也接受单条文本中用独立 `---` 行分隔；`messages` 旧数组路径保持原语义。
- `bot_settings.bubble_delay_ms`（默认 1200，范围 0~3000）；`0` 关闭，回到 `insertAssistantBatch` 整批插入。
- 新增 `bubble_queue`：每段独立 `not_before_ms`，相邻间隔为设定值 ±300ms 抖动；逐条落库、逐条 `assistant_message` 推送。
- `clientBatchId` 通过 `message_batch` 占位 + `bubble_queue` 唯一键幂等；重启时 `social.start()` 重新挂 pending 气泡，出错标 `failed` 并写 `message.failed`。
- 仿真页「分条发送」新增气泡间隔输入与保存按钮；控制台 `PATCH /console/api/bot/send` 审计 `bot.send`。

## 0.24.0 管理台 F-08：用量与花费

- `usage_daily` 新增 `turns / chars_in / chars_out`（老库自动补列，老行为 0）。
- 用户消息写 `chars_in`，assistant 消息写 `chars_out`，`onTurnEnd` 写 `turns`；`messages` 为收发合计，每日配额仍按用户消息数从 `message` 表单独计数，不受助手消息影响。
- `bot_settings` 新增 `price_in_per_1k / price_out_per_1k`；新增 `GET /console/api/usage?days=7|30` 与 `PATCH /console/api/bot/price`（审计 `bot.price`）。
- 新增「用量」页：今日消息/轮次/字符、7 日合计、估算金额、30 天纯 CSS 柱状图、按会话 Top 10、单价设置；固定标注「金额为估算，按字符折算，不是账单」。
- 金额口径：`chars_in / 2 / 1000 * price_in + chars_out / 2 / 1000 * price_out`；单价为 0 显示「未配置单价」。

## 0.25.0 语音收发（只做通道）

- 消息 `content_json.voice.durationMs` 为 1000~60000；附件 `kind='audio'`，mime 保留真实 `audio/*`。用户语音允许 `text` 为空。
- 上传接口按 mime 把音频标成 `kind='audio'`；没有新增附件表或依赖。
- 新增 `POST /agent/voice`：支持 `Authorization: Bearer <agent token>` 或既有 `x-agent-token/x-agent-call/x-agent-secret`；校验 `text`、`audio/*`、base64、2 MB 上限，用 `ffprobe` 量时长，失败时回退调用方 `durationMs`。
- 外部语音附件 `uploader_user_id=NULL`，`text` 存原文；同一个 `clientBatchId` 复用 `message_batch` 幂等；失败不落半成品附件。
- MCP 新增 `chat_send_voice`，与 HTTP 入口共用同一段落库逻辑，失败不自动降级成文字。
- `formatSnapshot` 渲染 `［语音 3.2 秒］`，AI 语音保留原文；快照含语音时注入「语音消息你听不到内容，不要编造」提示。
- 语音接口不接 TTS / ASR / 流式；nginx 的 `/tide/agent/voice` 精确放行由樱处理。

## 0.26.0 管理台收尾：成员管理与测试发送

- 新增控制台接口：`GET/POST /console/api/conversations/:id/members`、`DELETE .../members/:userId`、`PATCH .../members/:userId/role`，复用 `addMember/listMembers/removeMember/setMemberRole` 业务函数。
- 成员写操作要求 CSRF，额外写 `event_log` 的 `conversation.member`；原有 `audit_log` 仍由业务函数负责，不重复造表。
- 新增 `POST /console/api/conversations/:id/test-message`，直接调用 `postPrompt`：走额度、唤醒判定、SSE 与 usage；静默时 `wakeReason=null`。
- 用户搜索 `GET /console/api/users?q=` 只按 username 过滤，不支持昵称模糊匹配。
- 会话抽屉群聊新增成员管理（添加/设管理员/移出/退出），底部新增测试发送；单聊不显示成员区块。
- 全局静默现在也覆盖 direct 的真实发消息入口，静默期不会直接投递 AI。

## 0.31.0 表情包 P0：库、发送与 AI 使用

- 新增 `sticker` 表（`owner_user_id` 为 NULL 表示全局）与 `ensureStickerTable()`；`md5` 用部分唯一索引去重，`sticker` 只引用 `attachment_id`，不复制文件。
- 新增 `GET/POST /stickers`、`PATCH/DELETE /stickers/:id`：列表按 `last_used_at DESC NULLS LAST, created_at DESC`；`GET` 返回 `{stickers:[...]}`，每条带相对 `attachmentUrl`；入库只收 `kind='image'`，单用户上限 300；重复 sha256 返回 `existing:true` 且不新增。
- `POST /conversations/:id/prompt` 接受可选 `stickerId`：`content_json` 写 `sticker:{id,name}` 并把表情附件并入 `attachments`；同事务累加 `use_count`、写 `last_used_at`；停用/不存在分别返回 400 `sticker-disabled` / `sticker-not-found`。
- 附件下载授权放宽为「目标会话成员 **或** 可读该表情」，支持表情跨会话使用，同时不暴露别人的附件。
- Agent 侧：`POST /agent/messages` 支持 `stickerId`；新增 `GET /agent/stickers?name=`，精确匹配优先、其次包含匹配，命中多条最多列 10 条。
- MCP 新增 `chat_send_sticker`（`stickerId` / `name` 二选一），`tools.json` 重新生成，工具数 14 → 15。
- 提示词在历史快照之前注入【可用表情包】：只取未停用、按 `use_count DESC` 取前 20，条目单行化（压掉换行/控制/零宽字符），总长 2000 字按条截断。
- Android 0.31.0 / 3100：输入栏加表情按钮，底部面板「最近/全部」四列网格，点一下即发；表情气泡固定 160dp，只显示图，不显示文件名与尺寸。

## 0.34.0 附件可见：图片与表情包进入 prompt

- `gateway/dsh/images.mjs`：PNG/JPEG/GIF/WebP 头部尺寸解析、README 数据转 base64、48 MB 进程内 LRU；单图 12 MB、单轮 24 MB、最多 4 张。
- `collectImageBlocks` 按未读消息收集图片块：文字块在前、图片按消息顺序；表情包附件跨会话时用 `canReadStickerAttachment` 放行，不再被当前会话过滤掉。
- 入库失败/超限不阻塞消息：文字块后补 `［图片 x 暂时无法查看］`，并写 `logger.warn`；成功时记录 `[prompt] 图片就绪 name WxH KB ms`。
- DSH 的 `session/prompt` wire 格式是内联 `{ type:'image', mediaType, data(base64), name? }`，由 DSH 归一化后落成 `sha256:` 附件；聊天记录里的 attachment 块是落库形态，不是发送格式。
- 表情消息在文字块前置 `［表情包：name］`，帮助模型把图片和语义对上。
- `chat_read_attachment`：文本照旧；图片返回 `[图片 name · WxH · 大小]\n我暂时看不到图片内容。`；其它二进制返回 `[文件 name · mime · 大小]\n这类文件我读不了内容…`；不再出现 `undefined` 或裸 base64。
- `/agent/attachments/:id/content` 对图片附带 `width/height`；提示词新增「读不出来就说读不出来，不许按文件名/大小/类型猜」。
