# 汐语 Tide

自托管的私人 AI 聊天后端。Node.js 单进程，零第三方依赖：HTTP/JSON 接口、SSE 实时推送、
MCP 工具、管理控制台。

- **一条连接收全部会话**：用户级单流 + `epoch`/`cursor` 续传，切会话不断线
- **设备信任**：密码 + 每台设备独立 P-256 密钥 + 新设备六位码审批
- **消息形态**：文本、图片、文件、语音、表情包、动态
- **管理台**：会话、成员、邀请码、唤醒参数、用量统计，一个网页里

```
Android / Windows 客户端
        │  HTTP/JSON + SSE
        ▼
   tide-core（本仓库）  ──── ACP（子进程协议）────▶  DSH 宿主（AI 运行时）
        │  控制台静态页                                    │
        └── 管理台 /console                                 └── 模型与工具
```

## 目录结构

```
gateway/                 服务端（入口 server.mjs）
gateway/tests/           测试（node --test）
gateway/public/console/  管理台前端（无构建链）
mcp/                     MCP 工具，供 AI 侧调用
plugins/                 DSH 插件（工具白名单）
tools/                   运维脚本（探活、备份校验、开发期探针）
```

## 运行前提

- **Node.js 22 或以上**（用到 `node:sqlite`、`--env-file`）
- **一个可用的 DSH 宿主**：本项目不内置模型，AI 能力由 DSH 提供。
  网关通过 `TIDE_DSH_BASE_URL` 连它，并读写 `DSH_HOME`。
  没有 DSH 时网关能启动、能建库，但发出去的消息不会有回复。

## 快速开始

```bash
# 1. 准备环境变量
cp gateway/.env.example gateway/.env
#   至少填：TIDE_JWT_SECRET、TIDE_AGENT_SECRET、DSH_HOME

# 2. 生成两个密钥
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 3. 启动（--env-file 由 Node 自己读，不需要 dotenv）
node --env-file=gateway/.env gateway/server.mjs

# 4. 探活
curl http://127.0.0.1:7800/health
# → {"ok":true,"db":"ok","dsh":"configured","agentSecret":true,...}
```

首次启动会自动建库、跑迁移。管理台在 `http://127.0.0.1:7800/console/`，
用 `TIDE_OWNER_IDS` 里的账号登录。

## 环境变量

完整清单见 [`gateway/.env.example`](gateway/.env.example)，最常用的几个：

| 变量 | 说明 |
|---|---|
| `TIDE_JWT_SECRET` | JWT 签名密钥；换掉 = 所有已发 token 失效 |
| `TIDE_AGENT_SECRET` | AI 侧调 `/agent/*` 的共享密钥 |
| `TIDE_DSH_BASE_URL` | DSH 宿主地址，默认 `http://127.0.0.1:3081` |
| `DSH_HOME` | DSH 家目录，网关读写其中的会话与附件 |
| `TIDE_DB_PATH` | SQLite 库路径，默认 `./data/gateway.db` |
| `TIDE_OWNER_IDS` | 管理员 user id，逗号分隔 |
| `TIDE_PUBLIC_BASE_URL` | 对外地址，用于邀请链接 / 落地页 |
| `TIDE_DEVICE_TRUST_REQUIRED` | `1` 时要求设备密钥（推荐） |

## 接口概览

| 分组 | 路径 |
|---|---|
| 认证 | `POST /auth/register`、`/auth/login`、`/auth/refresh`、`/auth/device/challenge` |
| 会话 | `GET /conversations`、`GET /conversations/:id/messages`、`POST /conversations/:id/prompt` |
| 实时 | `GET /stream?since=cid:epoch:seq,...`（SSE）、`GET /realtime/config` |
| 附件 | `POST /conversations/:id/upload`、`GET /attachments/:id` |
| 表情 | `GET /stickers`、`POST /stickers`（管理员） |
| 动态 | `GET /moments`、`POST /moments/:id/like`、`POST /agent/moments` |
| Agent | `POST /agent/messages`、`/agent/voice`、`/agent/moments`（需 agent 密钥） |
| 管理 | `/admin/*`（Bearer token）、`/console/api/*`（会话 cookie + CSRF） |

SSE 事件信封与续传规则写在 `gateway/README.md` 的「事件契约」一节。

## 测试

```bash
npm --prefix gateway test        # 272 pass / 2 skip
```

测试会起真实的 SQLite 临时库，不需要 DSH；涉及模型的用例会跳过。

## 安全约定

- 设备私钥由客户端生成并持有，服务端只存公钥指纹
- token 不进日志；`/agent/*` 需要独立密钥，且默认在反向代理层不可达
- 控制台 cookie 是 `HttpOnly; Secure; SameSite=Strict`，写接口校验 CSRF
- 上传文件名做 CRLF 清洗，路径做 lexical + realpath 双重越界检查

## 相关仓库

- `tide-desktop`：Windows 客户端（Avalonia / .NET 8）
- `tide-android`：Android 客户端（Java，零第三方依赖）

仓库：

- https://github.com/vergissmichnicht0926-lgtm/tide-core
- https://github.com/vergissmichnicht0926-lgtm/tide-desktop
- https://github.com/vergissmichnicht0926-lgtm/tide-android


## 许可证

MIT，© 2026 树云铃。全文见 [LICENSE](LICENSE)。
