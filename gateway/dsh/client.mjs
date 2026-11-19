/**
 * DSH Web API 客户端（0.2.1-rc.2）。
 *
 * 协议事实（`dsh-lab` 实例实测）：
 * - 鉴权：本地铸造 browser-session cookie，不需要 launch token。
 *   cookie 名 = `dsh-auth-` + base64url(sha256(authority))，
 *   值 = `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, body))>`，
 *   payload = `{version:1, authority, issuedAt, expiresAt}`。
 *   secret 来自 `<dshHome>/.credentials.yaml` 的
 *   `client-connection/browser-session.payload.secret`（base64url，32 字节）。
 * - RPC：`POST /api/<method>`，body `{type:'client-request', rpcId, method, payload}`，
 *   响应 `{type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error}}`。
 *   payload 必须恰好一个 `args` 字段：`{args:{request:{...}}}`，`session/list` 用 `{args:{_request:{}}}`。
 *
 * 这里只做网关需要的六个动作，不试图覆盖完整 API。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const RPC_TIMEOUT_MS = 15_000;
const TURN_POLL_INTERVAL_MS = 500;
const COOKIE_SAFETY_MS = 60_000;
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** DSH 侧返回的业务错误。`code` 保留原始错误码，供调用方区分 not-found 与其他失败。 */
export class DshError extends Error {
  constructor(message, { code, details } = {}) {
    super(message);
    this.name = 'DshError';
    this.code = code;
    this.details = details;
  }
}

const base64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const decodeBase64url = (value) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从一个 content 块数组里挑出可显示的正文。
 *
 * DSH 的消息 content 混着 `reasoning`（模型内心独白）和 `tool-call`（参数里可能带完整文件内容），
 * 全都塞进聊天记录等于把思考过程和工具载荷一起泄露给用户。只取 `text`。
 */
function extractTextBlocks(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content.trim() : '';
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text.trim()) parts.push(block.text.trim());
  }
  return parts.join('\n\n');
}

/**
 * 从 credentials.yaml 读会话签名密钥。文件格式固定，不做通用 YAML 解析。
 *
 * 按缩进切出 `client-connection/browser-session` 这一块，而不是用非贪婪正则一路吃到
 * 下一个键 —— 后者只在「这条记录恰好排在第一条」时正确，DSH 换一种写法就会读到别的
 * 记录里的 secret，而且读出来的长度也可能刚好是 32 字节，坏得很安静。
 */
function readBrowserSecret(credentialsPath) {
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath, 'utf8');
  } catch (error) {
    throw new DshError(`读不到 DSH 凭据文件: ${credentialsPath}`, {
      code: 'dsh/credentials-unreadable',
      details: { cause: String(error?.message ?? error) },
    });
  }
  const lines = raw.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => /^\s*client-connection\/browser-session:\s*$/.test(line));
  if (startIdx < 0) {
    throw new DshError(`凭据文件里没有 client-connection/browser-session 记录: ${credentialsPath}`, {
      code: 'dsh/credentials-missing-record',
    });
  }
  const indent = lines[startIdx].match(/^\s*/)[0].length;
  const block = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) { block.push(line); continue; }
    if (line.match(/^\s*/)[0].length <= indent) break; // 回到同级或更外层，块结束
    block.push(line);
  }
  const secret = /^\s*secret:\s*(\S+)\s*$/m.exec(block.join('\n'))?.[1];
  if (!secret) {
    throw new DshError('browser-session 记录里没有 secret', {
      code: 'dsh/credentials-missing-secret',
    });
  }
  const bytes = decodeBase64url(secret);
  if (bytes.byteLength !== 32) {
    throw new DshError(`browser-session secret 长度应为 32 字节，实际 ${bytes.byteLength}`, {
      code: 'dsh/credentials-bad-secret',
    });
  }
  return bytes;
}

/** 按 authority 铸造会话 cookie，返回 `name=value`。 */
export function mintBrowserCookie(authority, secret) {
  const name = `dsh-auth-${base64url(crypto.createHash('sha256').update(authority).digest())}`;
  const issuedAt = Date.now();
  const payload = {
    version: 1,
    authority,
    issuedAt,
    expiresAt: issuedAt + COOKIE_MAX_AGE_MS,
  };
  const body = base64url(JSON.stringify(payload));
  const signature = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  return { cookie: `${name}=v1.${body}.${signature}`, expiresAt: payload.expiresAt };
}

/**
 * @typedef {object} DshClient
 * @property {(input: { conversationId: string, path: string }) => Promise<{ workspaceId: string }>} createWorkspace
 * @property {(sessionId: string) => Promise<{ agentPreset?: string } | null>} getSession
 * @property {(sessionId: string) => Promise<void>} cancel
 * @property {(sessionId: string, timeoutMs: number) => Promise<boolean>} waitTurnEnd
 * @property {(input: { preset: string, workspaceId: string }) => Promise<{ sessionId: string }>} createSession
 * @property {(sessionId: string) => Promise<void>} recap
 */

/**
 * @param {object} options
 * @param {string} options.baseUrl DSH 实例地址，例如 `http://127.0.0.1:3081`
 * @param {string} [options.dshHome] DSH_HOME，默认 `~/.dsh`
 * @param {string} [options.credentialsPath] 直接指定 `.credentials.yaml`
 * @param {(sessionId: string) => Promise<string | null>} [options.buildRecap] 返回注入新会话的恢复文本
 * @param {Pick<Console, 'log' | 'warn' | 'error'>} [options.logger]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {DshClient & { rpc: Function, ping: () => Promise<boolean> }}
 */
export function createDsh(options = {}) {
  const baseUrl = String(options.baseUrl ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const url = new URL(baseUrl);
  const authority = url.host;
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const credentialsPath = options.credentialsPath ?? path.join(dshHome, '.credentials.yaml');
  const buildRecap = options.buildRecap;
  const logger = options.logger ?? console;
  const doFetch = options.fetchImpl ?? fetch;

  let secret;
  let cachedCookie;
  let counter = 0;

  function authHeader() {
    if (cachedCookie && cachedCookie.expiresAt - COOKIE_SAFETY_MS > Date.now()) {
      return cachedCookie.cookie;
    }
    secret ??= readBrowserSecret(credentialsPath);
    cachedCookie = mintBrowserCookie(authority, secret);
    return cachedCookie.cookie;
  }

  /** 发一次 RPC。业务错误抛 DshError，带上 DSH 原始 code。 */
  async function rpcOnce(method, args, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
    counter += 1;
    const rpcId = `${Date.now().toString(36)}-${counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(`${baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: authHeader() },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DshError) throw error; // 凭据缺失等前置失败不该被写成"连接失败"
      if (error?.name === 'AbortError') {
        throw new DshError(`DSH ${method} 超时（${timeoutMs}ms）`, { code: 'dsh/timeout' });
      }
      throw new DshError(`DSH ${method} 连接失败: ${error?.message ?? error}`, {
        code: 'dsh/unreachable',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new DshError(`DSH ${method} HTTP ${response.status}`, {
        code: response.status === 401 ? 'dsh/unauthorized' : 'dsh/http-error',
        details: { status: response.status },
      });
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch (error) {
      throw new DshError(`DSH ${method} 响应不是 JSON`, {
        code: 'dsh/bad-response',
        details: { cause: String(error?.message ?? error) },
      });
    }
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new DshError(`DSH ${method} 响应信封不匹配`, { code: 'dsh/bad-response' });
    }

    const result = envelope.result;
    if (!result || result.ok !== true) {
      const error = result?.error ?? {};
      throw new DshError(`DSH ${method} 失败: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim(), {
        code: error.code ?? 'dsh/rpc-error',
        details: error.details,
      });
    }
    return result.value;
  }

  /**
   * 401 时丢掉缓存的 secret / cookie 重读一次凭据再试。
   *
   * 缓存的 secret 只在进程内 `??=` 一次。DSH 重装或轮换 `.credentials.yaml` 之后，
   * 旧 secret 签出来的 cookie 会一直 401，而 worker 重试 5 次就把队列行标成 failed ——
   * 一个凭据轮换能变成一次「权限切换失败」。这里重读一次就能自愈。
   */
  async function rpc(method, args, opts) {
    let retried = false;
    for (;;) {
      try {
        return await rpcOnce(method, args, opts);
      } catch (error) {
        if (retried || error?.code !== 'dsh/unauthorized') throw error;
        retried = true;
        secret = undefined;
        cachedCookie = undefined;
        logger.warn?.(`[tide-dsh] ${method} 收到 401，清掉缓存的凭据后重试一次`);
      }
    }
  }

  // session/list 一次可能上千行；worker 只需要一行，但仍然只有这一个查询入口。
  async function listSessions() {
    const value = await rpc('session/list', { _request: {} });
    return Array.isArray(value?.items) ? value.items : [];
  }

  async function findSession(sessionId) {
    const items = await listSessions();
    return items.find((item) => item?.sessionId === sessionId) ?? null;
  }

  return {
    rpc,

    /** 建 Workspace。DSH 只接受真实存在的目录路径。 */
    async createWorkspace({ conversationId, path: workspacePath }) {
      if (!workspacePath) {
        throw new DshError('createWorkspace 需要 path', { code: 'dsh/bad-request' });
      }
      const value = await rpc('workspace/create', { request: { path: workspacePath } });
      const workspaceId = value?.workspace?.workspaceId ?? value?.workspaceId;
      if (!workspaceId) {
        throw new DshError(`workspace/create 没返回 workspaceId（conversation ${conversationId}）`, {
          code: 'dsh/bad-response',
        });
      }
      return { workspaceId };
    },

    /** 会话不存在返回 null；DSH 不可达等错误照原样抛。`asOfSeq` 是 `session/page` 的游标。 */
    async getSession(sessionId) {
      const row = await findSession(sessionId);
      if (!row) return null;
      return {
        agentPreset: row?.projections?.values?.agentPreset,
        asOfSeq: Number(row?.projections?.asOfSeq ?? 0),
      };
    },

    /**
     * 读会话里已经落库的消息（`user/message` + `assistant/message`）。
     *
     * 走 `session/page`，`throughSeq` 取 `session/list` 的 `projections.asOfSeq`。
     * 不用 `session/follow`：那是 stream 方法，只能经 `/api/remote.mux` 这个 WebSocket
     * 流载体开（直连 `POST /api/session/follow` 会被 gateway 拒成
     * `gateway/signature-invalid: stream Remote methods must be opened through the stream carrier`），
     * 为了读一次消息维持一条 WS 不划算。
     *
     * `content` 里含 `reasoning` 与 `tool-call` 块，只取 `text`，否则助手内心独白会进聊天记录。
     */
    async readMessages(sessionId, { afterSeq = 0, maxMessages = 20 } = {}) {
      const row = await findSession(sessionId);
      if (!row) {
        throw new DshError(`读消息时会话不存在: ${sessionId}`, { code: 'dsh/session-not-found' });
      }
      const throughSeq = Number(row?.projections?.asOfSeq ?? 0);
      if (!Number.isFinite(throughSeq) || throughSeq <= afterSeq) return [];
      const value = await rpc('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq,
          maxMessages: Math.max(1, Math.min(200, Number(maxMessages) || 20)),
        },
      });
      const records = Array.isArray(value?.records) ? value.records : [];

      // 哪些 turn 里 chat_send 真的发出去了。turn 里有成功发送时，该 turn 的 assistant
      // 文本只是模型的收尾旁白（「已回复。」这类），不是要说给用户的话 —— 调用方要跳过它。
      // 只认真正走通 chat_send 的结果：立即发出、排队、幂等命中或显式沉默都算，
      // 只有 400/401 这类失败才归入「未发送」告警。
      const sendCallTurns = new Map();
      const sentTurns = new Set();
      for (const record of records) {
        const event = record?.event ?? record;
        if (event?.type === 'tool/call') {
          const name = String(event?.data?.name ?? '');
          if (/(?:^|__|_)chat_send$/.test(name)) {
            sendCallTurns.set(String(event?.data?.callId ?? ''), Number(event?.data?.turn));
          }
        } else if (event?.type === 'tool/result') {
          const callId = String(
            event?.data?.message?.toolCallId ?? event?.data?.toolCallId ?? '',
          );
          const turn = sendCallTurns.get(callId);
          if (turn === undefined) continue;
          const resultText = extractTextBlocks(event?.data?.message?.content);
          if (/^(已发出|发送节流|这批已经发过|已沉默)/.test(resultText)) {
            sentTurns.add(turn);
          }
        }
      }

      const out = [];
      for (const record of records) {
        const event = record?.event ?? record;
        const type = event?.type;
        if (type !== 'assistant/message' && type !== 'user/message') continue;
        const seq = Number(event?.seq);
        if (!Number.isFinite(seq) || seq <= afterSeq) continue;
        const data = event?.data ?? {};
        const message = type === 'assistant/message' ? data.message : data;
        const text = extractTextBlocks(message?.content);
        if (!text) continue;
        const turn = type === 'assistant/message' ? Number(data.turn) : null;
        out.push({
          seq,
          role: type === 'assistant/message' ? 'assistant' : 'user',
          id: typeof message?.id === 'string' ? message.id : null,
          text,
          turn: Number.isFinite(turn) ? turn : null,
          chatSent: Number.isFinite(turn) ? sentTurns.has(turn) : false,
        });
      }
      out.sort((a, b) => a.seq - b.seq);
      return out;
    },

    async cancel(sessionId) {
      await rpc('session/cancel', { request: { sessionId } });
    },

    /**
     * 轮询 `session/list` 的 `running` 直到该会话空闲。
     * 返回 true 表示已停下；超时返回 false（调用方应继续往下走，不要卡在 draining）。
     */
    async waitTurnEnd(sessionId, timeoutMs) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      for (;;) {
        const row = await findSession(sessionId);
        if (!row) return true; // 会话都没了，谈不上有 turn 在跑
        if (!row.running) return true;
        const left = deadline - Date.now();
        if (left <= 0) return false;
        await sleep(Math.min(TURN_POLL_INTERVAL_MS, left));
      }
    },

    async createSession({ preset, workspaceId }) {
      if (!workspaceId) {
        throw new DshError('createSession 需要 workspaceId', { code: 'dsh/bad-request' });
      }
      const request = { workspaceId };
      if (preset) request.agentPreset = preset;
      const value = await rpc('session/create', { request });
      if (!value?.sessionId) {
        throw new DshError('session/create 没返回 sessionId', { code: 'dsh/bad-response' });
      }
      return { sessionId: value.sessionId };
    },

    /**
     * 给新会话注入恢复上下文。内容由网关提供（只有它知道 message 表），
     * 这里只负责把文本作为一条 queue 模式的 prompt 送进去。
     *
     * 返回 `{ sent }`：`sent=false` 表示没有历史可恢复（新对话首条消息的情况），
     * 调用方据此跳过「等 recap 回复落地」这一步，否则会白等一轮。
     */
    async recap(sessionId) {
      if (buildRecap === undefined) {
        logger.warn?.(`[dsh] recap 未配置 buildRecap，跳过 ${sessionId}`);
        return { sent: false };
      }
      const text = await buildRecap(sessionId);
      if (!text) return { sent: false };
      await rpc(
        'session/prompt',
        {
          request: {
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
        },
        { timeoutMs: 60_000 },
      );
      return { sent: true };
    },

    /**
     * 把一条用户消息投给 DSH 会话。`mode: 'queue'` 表示排在当前 turn 之后，
     * `'steer'` 是在跑的时候改方向——M2b 只用 queue。
     *
     * 和 recap 的区别：recap 的内容是网关自己拼的历史上下文，prompt 是用户真说的话。
     * 两者都走 `session/prompt`，但 prompt 的超时更短（60s 是等 DSH 受理，不是等 turn 结束）。
     */
    async prompt(sessionId, content, { mode = 'queue', timeoutMs = 60_000 } = {}) {
      if (!sessionId) {
        throw new DshError('prompt 需要 sessionId', { code: 'dsh/bad-request' });
      }
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
      if (blocks.length === 0) {
        throw new DshError('prompt 内容为空', { code: 'dsh/bad-request' });
      }
      const requestId = crypto.randomUUID();
      await rpc(
        'session/prompt',
        { request: { requestId, sessionId, mode, content: blocks } },
        { timeoutMs },
      );
      return { requestId };
    },

    /** 探活：能列会话就算通。 */
    async ping() {
      try {
        await listSessions();
        return true;
      } catch {
        return false;
      }
    },
  };
}
