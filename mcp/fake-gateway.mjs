#!/usr/bin/env node
// 汐语 fake gateway —— 实现 docs/gateway-contract.md 的 AI 侧接口（M1 联调用）。
//
// 用途：
//   R1 写 tide-mcp.mjs 时不需要真网关；跑这个就能联调十个接口 + 十八条契约测试。
//
// 使用方法：
//   node fake-gateway.mjs --port 7800 --deterministic --seed fixtures/seed.json
//
// 设计约束：
//   - 零依赖，只用 node:http / node:crypto / node:fs。
//   - 数据全内存，重启即丢；种子由 --seed 载入。
//   - --deterministic 时 wait 不真睡，改由 /__ctl/clock 推进逻辑时钟。
//   - 日志里只出现 token 的 sha256 前 4 位，绝不出现完整 token。

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(getArg('port', '7800'));
const DETERMINISTIC = argv.includes('--deterministic');
const SEED_PATH = getArg('seed', '');
const ATT_DIR = getArg('attachments', '');

// ── 时钟 ────────────────────────────────────────────────────────────────
const REAL_START = Date.now();
let clockOffset = 0;
const now = () => (DETERMINISTIC ? REAL_START + clockOffset : Date.now());
const iso = (ms) => new Date(ms).toISOString();

// ── 工具 ────────────────────────────────────────────────────────────────
const fingerprint = (token) =>
  typeof token === 'string' && token.length > 0
    ? crypto.createHash('sha256').update(token).digest('hex').slice(0, 4)
    : '----';

const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

const shortHash = (obj) =>
  crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');

// ── 存储 ────────────────────────────────────────────────────────────────
/** @type {{conversations: Map<string, any>, messages: any[], memories: any[], attachments: Map<string, any>, batches: Map<string, any>, log: any[], inject: any}} */
const db = {
  conversations: new Map(), // conversationId -> conv
  byToken: new Map(),       // token -> conversationId
  messages: [],             // { id, conversationId, seq, role, text, createdAt, attachments, replyToMessageId }
  memories: [],             // { id, conversationId, kind, text, key, createdAt }
  attachments: new Map(),   // id -> { id, conversationId, name, mimeType, size, messageId, body(Buffer)|filePath }
  moments: [],              // { id, conversationId, text, createdAt }
  batches: new Map(),       // clientBatchId -> { conversationId, payloadHash, response }
  log: [],
  inject: { delayMs: 0, failNext: null, busy: false },
  // 「下一次 wait 期间到达」的用户消息：conversationId -> text[]
  // deterministic 模式不真等，靠这个把「wait 途中收到消息」变成可测的
  pendingUser: new Map(),
};

let memIdCounter = 0;

function makeConv({ id, token, userId = 'u_owner', policy = 'restricted', agentReadSeq = 0, baseIso = null }) {
  const conv = {
    id,
    kind: 'direct',
    token,
    userId,
    policy,
    closed: false,
    seq: 0,
    lastUserSeq: 0,
    agentReadSeq,
    userReadSeq: 0,
    lastUserAt: baseIso ? Date.parse(baseIso) : now(),
    waiting: false,
    waitLeaseAt: 0,
    wakeConfig: {
      mode: 'diving',
      infinite: true,
      sleepUntil: null,
      triggers: {
        atMention: true,
        nameMention: true,
        speakerIds: [],
        keywords: ['汐语', '小汐', 'Tide'],
        question: true,
        poke: false,
        anyMessage: false,
        probability: 0.05,
      },
      batchWindowMs: 8000,
      lastWakeAt: 0,
      wakeCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default',
    },
  };
  db.conversations.set(id, conv);
  db.byToken.set(token, id);
  return conv;
}

// ── 种子 ────────────────────────────────────────────────────────────────
function seedDefault() {
  const convA = makeConv({ id: 'c_A', token: 'a'.repeat(48), baseIso: new Date(REAL_START - 120_000).toISOString() });
  const convB = makeConv({ id: 'c_B', token: 'b'.repeat(48), baseIso: new Date(REAL_START - 120_000).toISOString() });
  const convC = makeConv({ id: 'c_C', token: 'c'.repeat(48), baseIso: new Date(REAL_START - 120_000).toISOString() });

  const seedMsg = (conv, role, text, atIso) => {
    conv.seq += 1;
    const m = {
      id: newId('m'),
      conversationId: conv.id,
      seq: conv.seq,
      role,
      text,
      createdAt: atIso,
      attachments: [],
      replyToMessageId: null,
    };
    db.messages.push(m);
    if (role === 'user') {
      conv.lastUserAt = Date.parse(atIso);
      conv.lastUserSeq = conv.seq;
    }
    return m;
  };

  seedMsg(convA, 'user', '今天好累', new Date(REAL_START - 100_000).toISOString());
  seedMsg(convA, 'assistant', '先躺会儿，别硬撑', new Date(REAL_START - 95_000).toISOString());
  seedMsg(convA, 'user', '嗯，等下还要改个方案', new Date(REAL_START - 90_000).toISOString());

  seedMsg(convB, 'user', '这是另一个会话', new Date(REAL_START - 100_000).toISOString());
  seedMsg(convC, 'user', '第三个会话', new Date(REAL_START - 100_000).toISOString());

  // 附件：一条挂在 convA 的已发送消息上，一条是草稿态（messageId 为空），一条属于 convB
  const addAtt = (conv, name, mimeType, content, messageId = null) => {
    const id = newId('a');
    const body = Buffer.from(content, 'utf8');
    db.attachments.set(id, {
      id,
      conversationId: conv.id,
      name,
      mimeType,
      size: body.length,
      messageId,
      body,
    });
    return id;
  };

  const a1 = addAtt(convB, 'secret.md', 'text/markdown', '# B 会话的私有文件\n不要泄露\n');
  const a2 = addAtt(convA, 'notes.md', 'text/markdown', '# 会议记录\n- 方案待改\n- 明天同步\n');
  const a3 = addAtt(convA, 'draft.png', 'image/png', '\x89PNG\r\n\x1a\nfake', null); // 草稿态

  const attachToMsg = (conv, seq, attId) => {
    const m = db.messages.find((x) => x.conversationId === conv.id && x.seq === seq);
    if (!m) return;
    const att = db.attachments.get(attId);
    if (!att) return;
    att.messageId = m.id; // 反向指针也要写，否则「草稿态 vs 已发送」在 state 里分不出来
    m.attachments.push({
      id: attId,
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
    });
  };
  attachToMsg(convA, 1, a2);

  return { a1, a2, a3, convA, convB, convC };
}

function seedFromFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const c of raw.conversations ?? []) {
    const conv = makeConv({
      id: c.id,
      token: c.token,
      userId: c.userId,
      policy: c.policy,
      agentReadSeq: c.agentReadSeq ?? 0,
      baseIso: c.lastUserAt ?? null,
    });
    conv.wakeConfig = { ...conv.wakeConfig, ...(c.wakeConfig ?? {}) };
    for (const m of c.messages ?? []) {
      conv.seq += 1;
      const seq = m.seq ?? conv.seq;
      conv.seq = Math.max(conv.seq, seq);
      db.messages.push({
        id: m.id ?? newId('m'),
        conversationId: conv.id,
        seq,
        role: m.role ?? 'user',
        text: m.text ?? '',
        createdAt: m.createdAt ?? iso(now()),
        attachments: m.attachments ?? [],
        replyToMessageId: m.replyToMessageId ?? null,
      });
      if ((m.role ?? 'user') === 'user' && m.createdAt) conv.lastUserAt = Date.parse(m.createdAt);
    }
    for (const mem of c.memories ?? []) {
      memIdCounter += 1;
      db.memories.push({
        id: memIdCounter,
        conversationId: conv.id,
        kind: mem.kind ?? 'topic',
        text: mem.text ?? '',
        key: mem.key ?? null,
        createdAt: mem.createdAt ?? iso(now()),
      });
    }
  }
}

// ── 鉴权 ────────────────────────────────────────────────────────────────
function resolveConv(req) {
  const token = req.headers['x-agent-token'];
  if (!token || typeof token !== 'string') {
    return { err: { status: 401, code: 'token-missing', message: '缺少 x-agent-token' } };
  }
  if (req.headers['x-agent-call'] !== '1') {
    return { err: { status: 401, code: 'agent-call-missing', message: '缺少 x-agent-call: 1' } };
  }
  const convId = db.byToken.get(token);
  if (!convId) {
    return { err: { status: 401, code: 'token-invalid', message: 'agent token 不存在或已失效' } };
  }
  const conv = db.conversations.get(convId);
  if (!conv) {
    return { err: { status: 401, code: 'token-invalid', message: 'agent token 不存在或已失效' } };
  }
  if (conv.closed) {
    return { err: { status: 403, code: 'conversation-closed', message: '会话已退役' } };
  }
  if (conv.token !== token) {
    // 轮换后旧 token 立刻失效
    return { err: { status: 401, code: 'token-invalid', message: 'agent token 已被轮换' } };
  }
  return { conv, token };
}

// ── 响应 ────────────────────────────────────────────────────────────────
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 0);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendErr(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const messagesOf = (conv) =>
  db.messages.filter((m) => m.conversationId === conv.id).sort((a, b) => a.seq - b.seq);

const publicMessage = (m) => ({
  id: m.id,
  seq: m.seq,
  role: m.role,
  text: m.text,
  createdAt: m.createdAt,
  attachments: m.attachments ?? [],
  replyToMessageId: m.replyToMessageId ?? null,
});

// 落一条用户消息（角色 user），用于 /__ctl/user-message 与 wait 期间的模拟到达。
function pushUserMessage(conv, text) {
  conv.seq += 1;
  const m = {
    id: newId('m'),
    conversationId: conv.id,
    seq: conv.seq,
    role: 'user',
    text: typeof text === 'string' ? text : '（测试消息）',
    createdAt: iso(now()),
    attachments: [],
    replyToMessageId: null,
  };
  db.messages.push(m);
  conv.lastUserAt = now();
  conv.lastUserSeq = conv.seq;
  return m;
}

// ── 业务处理 ────────────────────────────────────────────────────────────
const handlers = {
  'GET /agent/prompt': ({ conv }) => {
    const msgs = messagesOf(conv);
    const unread = msgs.filter((m) => m.role === 'user' && m.seq > conv.agentReadSeq);
    const wake = conv.wakeConfig;
    const nextEligibleAt = wake.enabled
      ? iso(now() + Math.max(0, wake.minIntervalMinutes) * 60_000)
      : null;
    return {
      ok: true,
      kind: conv.kind,
      prompt: [
        conv.kind === 'group'
          ? '你是汐语，正在一个群聊里；不想接可以 [SILENT]。'
          : '你是汐语，一个只和主人一对一聊天的助理。',
        `当前会话：${conv.id}。未读 ${unread.length} 条，已读水位 seq=${conv.agentReadSeq}。`,
      ].join('\n'),
      agentReadThroughSeq: conv.agentReadSeq,
      unread: { count: unread.length, latestSeq: conv.seq },
      wakeConfig: wake,
      wakeSummary: `${wake.mode === 'active' ? '活跃' : '潜水'}，无限`,
      socialState: {
        lastIncomingAt: conv.lastUserAt || 0,
        lastAiReplyAt: 0,
        noActionCount: 0,
        wakeTimes: [],
        sendTimes: [],
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        pendingThoughts: [],
      },
      preSleep: {
        waitMs: 300_000,
        satisfied: false,
        remainingMs: 300_000,
        observedAt: null,
      },
      recommendedWake: { enabled: true, ...wake, nextEligibleAt },
      tokenFingerprint: fingerprint(conv.token),
    };
  },

  'GET /agent/messages': ({ conv, query }) => {
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 30) || 30));
    const afterRaw = query.afterSeq;
    const msgs = messagesOf(conv);

    let picked;
    let hasMore;
    if (afterRaw === undefined || afterRaw === null || afterRaw === '') {
      picked = msgs.slice(-limit);
      hasMore = msgs.length > limit;
    } else {
      const afterSeq = Number(afterRaw) || 0;
      const from = afterSeq === 0 ? 0 : afterSeq;
      const rest = msgs.filter((m) => m.seq > from);
      picked = rest.slice(0, limit);
      hasMore = rest.length > picked.length;
    }

    return {
      ok: true,
      messages: picked.map(publicMessage),
      agentReadThroughSeq: conv.agentReadSeq,
      hasMore,
      latestSeq: conv.seq,
    };
  },

  'POST /agent/messages': ({ conv, body }) => {
    const raw = body.messages;
    const list = Array.isArray(raw) ? raw : [raw];

    // 整批校验：任何一条不合格就整批拒绝
    if (!Array.isArray(raw) && (raw === undefined || raw === null)) {
      return { err: [400, 'bad-request', 'messages 必填'] };
    }
    if (list.length === 0) return { err: [400, 'bad-request', 'messages 不能为空数组'] };
    if (list.length > 8) return { err: [400, 'bad-request', '单次最多 8 条'] };
    for (const [i, item] of list.entries()) {
      if (typeof item !== 'string') return { err: [400, 'bad-request', `messages[${i}] 不是字符串`] };
      if (item.trim().length === 0) return { err: [400, 'bad-request', `messages[${i}] 是空白串`] };
      if (item.length > 500) return { err: [400, 'bad-request', `messages[${i}] 超过 500 字符`] };
    }

    const payloadHash = shortHash({
      messages: list,
      replyToMessageId: body.replyToMessageId ?? null,
    });
    const batchId = body.clientBatchId;

    if (batchId) {
      const prev = db.batches.get(batchId);
      if (prev) {
        if (prev.conversationId !== conv.id || prev.payloadHash !== payloadHash) {
          return { err: [409, 'batch-conflict', 'clientBatchId 已被另一份 payload 使用'] };
        }
        return { ...prev.response, duplicated: true };
      }
    }

    if (body.replyToMessageId) {
      const exists = db.messages.some(
        (m) => m.conversationId === conv.id && m.id === body.replyToMessageId,
      );
      if (!exists) return { err: [400, 'bad-request', 'replyToMessageId 不属于本会话'] };
    }

    const created = [];
    for (const text of list) {
      conv.seq += 1;
      const m = {
        id: newId('m'),
        conversationId: conv.id,
        seq: conv.seq,
        role: 'assistant',
        text,
        createdAt: iso(now()),
        attachments: [],
        replyToMessageId: body.replyToMessageId ?? null,
      };
      db.messages.push(m);
      created.push({ id: m.id, seq: m.seq });
    }

    const response = {
      ok: true,
      silent: false,
      queued: false,
      messages: created,
      clientBatchId: batchId ?? null,
      duplicated: false,
    };
    if (batchId) {
      db.batches.set(batchId, { conversationId: conv.id, payloadHash, response });
    }
    return response;
  },

  'POST /agent/wait': async ({ conv, body }) => {
    const purpose = body.purpose === 'reply' ? 'reply' : 'messages';
    const quietMs = Math.min(60_000, Math.max(1_000, Number(body.quietMs ?? 10_000) || 10_000));
    const timeoutMs = Math.min(600_000, Math.max(1_000, Number(body.timeoutMs ?? 300_000) || 300_000));

    // 租约：同会话只允许一个 wait
    const leaseFresh = conv.waiting && now() - conv.waitLeaseAt < 15 * 60_000;
    if (leaseFresh || db.inject.busy) {
      return { err: [429, 'wait-busy', '同会话已有 wait 在跑'] };
    }

    conv.waiting = true;
    conv.waitLeaseAt = now();
    try {
      const enteredSeq = conv.lastUserSeq;

      // 模拟「等待期间到达」：挂起的用户消息在这里落地，
      // 于是 conv.seq > enteredSeq，arrived 才可能为 true。
      const pending = db.pendingUser.get(conv.id);
      if (pending && pending.length > 0) {
        db.pendingUser.delete(conv.id);
        for (const text of pending) pushUserMessage(conv, text);
      }

      const evaluate = () => {
        const arrived = conv.lastUserSeq > enteredSeq;
        const lastNewAt = purpose === 'reply' ? conv.lastUserAt : arrived ? conv.lastUserAt : now();
        const quiet =
          (purpose === 'reply' || (arrived && quietMs > 0)) && now() - lastNewAt >= quietMs;
        return { arrived, quiet };
      };

      let state;
      let timedOut = false;

      if (DETERMINISTIC) {
        state = evaluate();
        // deterministic 模式下 timeout 由注入决定，不真等；注入只生效一次
        if (db.inject.failNext === 'timeout') {
          db.inject.failNext = null;
          timedOut = true;
          state = { arrived: false, quiet: false };
        }
      } else {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          state = evaluate();
          if (state.arrived || state.quiet) break;
          if (Date.now() >= deadline) {
            timedOut = true;
            state = { arrived: false, quiet: false };
            break;
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      }

      const newMsgs = messagesOf(conv).filter((m) => m.seq > enteredSeq && m.role === 'user');
      return {
        ok: true,
        arrived: state.arrived,
        quiet: state.quiet,
        newMessages: newMsgs.map(publicMessage),
        agentReadThroughSeq: conv.agentReadSeq,
        timeout: timedOut,
        preSleepWaitSatisfied: state.arrived ? true : timedOut,
        preSleepWaitRemainingMs: state.arrived || timedOut ? 0 : 300_000,
        preSleepWaitObservedAt: state.arrived ? iso(now()) : null,
      };
    } finally {
      conv.waiting = false;
      conv.waitLeaseAt = 0;
    }
  },

  'POST /agent/read': ({ conv, body }) => {
    const throughSeq = Number(body.throughSeq);
    if (!Number.isFinite(throughSeq) || throughSeq < 0) {
      return { err: [400, 'bad-request', 'throughSeq 必须是 >= 0 的整数'] };
    }
    if (throughSeq > conv.seq) {
      return { err: [400, 'bad-request', `throughSeq ${throughSeq} 超过最新 seq ${conv.seq}`] };
    }
    if (throughSeq > conv.agentReadSeq) conv.agentReadSeq = throughSeq;
    return {
      ok: true,
      agentReadThroughSeq: conv.agentReadSeq,
      clamped: false,
      seenThroughSeq: conv.seq,
    };
  },

  'POST /agent/wake-config': ({ conv, body }) => {
    const cfg = body.config ?? {};
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      return { err: [400, 'bad-request', 'config 必须是对象'] };
    }
    const base = conv.wakeConfig;
    const next = {
      ...base,
      triggers: { ...base.triggers, ...(cfg.triggers && typeof cfg.triggers === 'object' ? cfg.triggers : {}) },
    };
    if (cfg.mode === 'diving' || cfg.mode === 'active') next.mode = cfg.mode;
    if (cfg.infinite !== undefined) next.infinite = cfg.infinite !== false;
    if (!next.infinite && typeof cfg.sleepUntil === 'string') next.sleepUntil = cfg.sleepUntil;
    if (next.infinite) next.sleepUntil = null;
    if (Number.isFinite(Number(cfg.batchWindowMs))) {
      next.batchWindowMs = Math.max(1000, Math.min(60_000, Number(cfg.batchWindowMs)));
    }
    next.confirmedBy = 'agent';
    next.confirmedAt = now();
    if (next.mode === 'active') next.triggers.anyMessage = true;
    conv.wakeConfig = next;
    if (body.throughSeq !== undefined && body.throughSeq !== null) {
      const ts = Number(body.throughSeq);
      if (Number.isFinite(ts) && ts >= 0 && ts <= conv.seq && ts > conv.agentReadSeq) {
        conv.agentReadSeq = ts;
      }
    }
    return {
      ok: true,
      kind: conv.kind,
      config: conv.wakeConfig,
      wakeSummary: `${conv.wakeConfig.mode === 'active' ? '活跃' : '潜水'}，无限`,
      nextWakeAt: conv.wakeConfig.infinite ? null : conv.wakeConfig.sleepUntil,
      agentReadThroughSeq: conv.agentReadSeq,
    };
  },

  'POST /agent/memory': ({ conv, body }) => {
    const kind = body.kind;
    if (!['topic', 'thought', 'impression'].includes(kind)) {
      return { err: [400, 'bad-request', 'kind 必须是 topic|thought|impression'] };
    }
    if (typeof body.text !== 'string' || !body.text.trim()) {
      return { err: [400, 'bad-request', 'text 必填'] };
    }
    if (body.text.length > 500) return { err: [400, 'bad-request', 'text 超过 500 字符'] };

    const key = typeof body.key === 'string' && body.key ? body.key : null;
    if (key) {
      const prev = db.memories.find(
        (m) => m.conversationId === conv.id && m.kind === kind && m.key === key,
      );
      if (prev) {
        prev.text = body.text;
        prev.createdAt = iso(now());
        return { ok: true, id: prev.id, key, createdAt: prev.createdAt, overwritten: true };
      }
    }
    memIdCounter += 1;
    const mem = {
      id: memIdCounter,
      conversationId: conv.id,
      kind,
      text: body.text,
      key,
      createdAt: iso(now()),
    };
    db.memories.push(mem);
    return { ok: true, id: mem.id, key, createdAt: mem.createdAt };
  },

  'GET /agent/memory': ({ conv, query }) => {
    const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20) || 20));
    let list = db.memories.filter((m) => m.conversationId === conv.id);
    if (query.kind) list = list.filter((m) => m.kind === query.kind);
    if (query.query) {
      const q = String(query.query).toLowerCase();
      list = list.filter((m) => m.text.toLowerCase().includes(q));
    }
    list = list.slice().sort((a, b) => b.id - a.id).slice(0, limit);
    return {
      ok: true,
      items: list.map(({ id, kind, text, key, createdAt }) => ({ id, kind, text, key, createdAt })),
    };
  },

  'DELETE /agent/memory': ({ conv, body }) => {
    const within = (m) => m.conversationId === conv.id;

    if (body.id !== undefined && body.id !== null) {
      const id = Number(body.id);
      const idx = db.memories.findIndex((m) => within(m) && m.id === id);
      if (idx < 0) return { err: [404, 'attachment-not-found', `记忆 ${id} 不存在`] };
      db.memories.splice(idx, 1);
      return { ok: true, removed: 1 };
    }

    if (body.key) {
      const kind = body.kind;
      const idx = db.memories.findIndex(
        (m) => within(m) && m.key === body.key && (!kind || m.kind === kind),
      );
      if (idx < 0) return { err: [404, 'attachment-not-found', '没有匹配的记忆'] };
      db.memories.splice(idx, 1);
      return { ok: true, removed: 1 };
    }

    if (body.kind) {
      if (body.confirm !== true) {
        return { err: [400, 'bad-request', '批量删除必须带 confirm: true'] };
      }
      const before = db.memories.length;
      db.memories = db.memories.filter((m) => !(within(m) && m.kind === body.kind));
      return { ok: true, removed: before - db.memories.length };
    }

    return { err: [400, 'bad-request', '需要 id、key 或 kind 之一'] };
  },

  'POST /agent/moments': ({ conv, body }) => {
    if (conv.kind !== 'direct') {
      return { err: [400, 'not-direct', '只有私聊 bot 能发布动态'] };
    }
    const text = String(body?.text ?? '').trim();
    if (!text) return { err: [400, 'bad-request', 'text 不能为空'] };
    const moment = {
      id: newId('mo'),
      conversationId: conv.id,
      text,
      createdAt: iso(now()),
    };
    db.moments.push(moment);
    return {
      moment: {
        id: moment.id,
        text,
        createdAt: moment.createdAt,
        author: { name: '汐语' },
        likes: 0,
        likedByMe: false,
      },
    };
  },
};

// 附件单独处理（路径带参数）
function handleAttachment(req, res, conv, attachmentId, query) {
  const att = db.attachments.get(attachmentId);
  if (!att) return sendErr(res, 404, 'attachment-not-found', '附件不存在');
  if (att.conversationId !== conv.id) {
    return sendErr(res, 403, 'attachment-forbidden', '附件不属于本会话');
  }

  const offset = Math.max(0, Number(query.offset ?? 0) || 0);
  const limit = Math.min(262_144, Math.max(1, Number(query.limit ?? 65_536) || 65_536));

  const full = att.body ?? Buffer.alloc(0);
  const slice = full.subarray(offset, offset + limit);
  const eof = offset + slice.length >= full.length;

  const isText =
    att.mimeType.startsWith('text/') ||
    /\.(md|json|log|txt|csv|ya?ml|js|ts|py|sh)$/i.test(att.name);

  const payload = {
    ok: true,
    attachmentId: att.id,
    name: att.name,
    mimeType: att.mimeType,
    size: att.size,
    offset,
    truncated: !eof,
    eof,
  };
  if (isText) {
    payload.text = slice.toString('utf8');
  } else {
    payload.data = slice.toString('base64');
  }
  return sendJson(res, 200, payload);
}

// ── 控制面 ──────────────────────────────────────────────────────────────
function handleCtl(req, res, urlPath, rawUrl, query, body) {
  if (urlPath === '/__ctl/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      clock: now(),
      deterministic: DETERMINISTIC,
      conversations: [...db.conversations.values()].map((c) => ({
        id: c.id,
        userId: c.userId,
        policy: c.policy,
        closed: c.closed,
        seq: c.seq,
        agentReadSeq: c.agentReadSeq,
        lastUserAt: iso(c.lastUserAt),
        waiting: c.waiting,
        wakeConfig: c.wakeConfig,
        tokenFingerprint: fingerprint(c.token),
      })),
      messageCount: db.messages.length,
      messages: db.messages.map(publicMessage),
      memories: db.memories,
      attachments: [...db.attachments.values()].map((a) => ({
        id: a.id,
        conversationId: a.conversationId,
        name: a.name,
        mimeType: a.mimeType,
        size: a.size,
        messageId: a.messageId,
      })),
      inject: db.inject,
    });
  }

  if (urlPath === '/__ctl/log' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 200) || 200));
    return sendJson(res, 200, { ok: true, entries: db.log.slice(-limit) });
  }

  if (urlPath === '/__ctl/clock' && req.method === 'POST') {
    const advance = Number(body.advanceMs ?? 0);
    clockOffset += Number.isFinite(advance) ? advance : 0;
    return sendJson(res, 200, { ok: true, clock: now() });
  }

  if (urlPath === '/__ctl/inject' && req.method === 'POST') {
    if (body.delayMs !== undefined) db.inject.delayMs = Number(body.delayMs) || 0;
    if (body.failNext !== undefined) db.inject.failNext = body.failNext;
    if (body.busy !== undefined) db.inject.busy = body.busy === true;
    return sendJson(res, 200, { ok: true, inject: db.inject });
  }

  if (urlPath === '/__ctl/reset' && req.method === 'POST') {
    const tokA = 'a'.repeat(48);
    const tokB = 'b'.repeat(48);
    const tokC = 'c'.repeat(48);
    // 保留 token 映射，清数据
    db.messages = [];
    db.memories = [];
    db.attachments.clear();
    db.batches.clear();
    db.log = [];
    db.inject = { delayMs: 0, failNext: null, busy: false };
    clockOffset = 0;
    memIdCounter = 0;
    db.conversations.clear();
    db.byToken.clear();
    const convA = makeConv({ id: 'c_A', token: tokA });
    makeConv({ id: 'c_B', token: tokB });
    makeConv({ id: 'c_C', token: tokC });
    return sendJson(res, 200, { ok: true, convA: convA.id });
  }

  if (urlPath === '/__ctl/user-message' && req.method === 'POST') {
    // 模拟"用户发了一条消息"。M2 会有真的用户侧接口，M1 联调靠这个造 arrived 场景。
    const conv = db.conversations.get(body.conversationId);
    if (!conv) return sendErr(res, 404, 'attachment-not-found', '会话不存在');

    // duringNextWait=true 时不立即落库，挂到下一次 wait 里"当场到达"，
    // 用来精确构造 arrived=true（本次 wait 期间才有新消息）
    if (body.duringNextWait === true) {
      const q = db.pendingUser.get(conv.id) ?? [];
      q.push(typeof body.text === 'string' ? body.text : '（测试消息）');
      db.pendingUser.set(conv.id, q);
      return sendJson(res, 200, { ok: true, queued: q.length });
    }

    const m = pushUserMessage(conv, body.text);
    return sendJson(res, 200, { ok: true, message: publicMessage(m) });
  }

  if (urlPath === '/__ctl/close' && req.method === 'POST') {
    const conv = db.conversations.get(body.conversationId);
    if (!conv) return sendErr(res, 404, 'attachment-not-found', '会话不存在');
    conv.closed = true;
    return sendJson(res, 200, { ok: true });
  }

  if (urlPath === '/__ctl/rotate' && req.method === 'POST') {
    const conv = db.conversations.get(body.conversationId);
    if (!conv) return sendErr(res, 404, 'attachment-not-found', '会话不存在');
    db.byToken.delete(conv.token);
    conv.token = crypto.randomBytes(24).toString('hex');
    db.byToken.set(conv.token, conv.id);
    return sendJson(res, 200, { ok: true, token: conv.token, fingerprint: fingerprint(conv.token) });
  }

  return sendErr(res, 404, 'bad-request', `未知控制端点 ${req.method} ${urlPath}`);
}

// ── 主循环 ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const urlPath = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  let tokenFp = '----';

  const done = (status, note = '') => {
    db.log.push({
      at: iso(now()),
      method: req.method,
      path: urlPath,
      token: tokenFp,
      status,
      ms: Date.now() - started,
      note,
    });
    if (db.log.length > 2000) db.log.splice(0, db.log.length - 2000);
  };

  try {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      body = await readBody(req);
    } else if (req.method === 'DELETE') {
      body = await readBody(req).catch(() => ({}));
    }

    if (db.inject.delayMs > 0) {
      await new Promise((r) => setTimeout(r, db.inject.delayMs));
    }

    if (urlPath.startsWith('/__ctl/')) {
      handleCtl(req, res, urlPath, url, query, body);
      done(200, 'ctl');
      return;
    }

    if (urlPath === '/health') {
      sendJson(res, 200, { ok: true, deterministic: DETERMINISTIC, clock: now() });
      done(200);
      return;
    }

    tokenFp = fingerprint(req.headers['x-agent-token']);

    // 附件
    const attMatch = urlPath.match(/^\/agent\/attachments\/([^/]+)\/content$/);
    if (attMatch) {
      const resolved = resolveConv(req);
      if (resolved.err) {
        sendErr(res, resolved.err.status, resolved.err.code, resolved.err.message);
        done(resolved.err.status, resolved.err.code);
        return;
      }
      handleAttachment(req, res, resolved.conv, decodeURIComponent(attMatch[1]), query);
      done(200, 'attachment');
      return;
    }

    // 其余接口
    const key = `${req.method} ${urlPath}`;
    const handler = handlers[key];
    if (!handler) {
      sendErr(res, 404, 'bad-request', `未知端点 ${key}`);
      done(404, 'unknown');
      return;
    }

    const resolved = resolveConv(req);
    if (resolved.err) {
      sendErr(res, resolved.err.status, resolved.err.code, resolved.err.message);
      done(resolved.err.status, resolved.err.code);
      return;
    }

    const result = await handler({ conv: resolved.conv, body, query, req });

    if (result && result.err) {
      const [status, code, message] = result.err;
      sendErr(res, status, code, message);
      done(status, code);
      return;
    }

    sendJson(res, 200, result);
    done(200);
  } catch (e) {
    sendErr(res, 500, 'gateway-unavailable', String(e?.message ?? e));
    done(500, 'exception');
  }
});

// ── 启动 ────────────────────────────────────────────────────────────────
if (SEED_PATH) {
  const abs = path.isAbsolute(SEED_PATH) ? SEED_PATH : path.resolve(process.cwd(), SEED_PATH);
  if (!fs.existsSync(abs)) {
    console.error(`[fake-gateway] seed 文件不存在：${abs}`);
    process.exit(1);
  }
  seedFromFile(abs);
  console.log(`[fake-gateway] 从 ${abs} 载入种子`);
} else {
  seedDefault();
  console.log('[fake-gateway] 使用内置种子（3 个会话，token 分别为 a/b/c 各 48 个）');
}

if (ATT_DIR) {
  console.log(`[fake-gateway] 附件目录：${ATT_DIR}（当前实现只返回内存内容，文件不落盘）`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-gateway] listening http://127.0.0.1:${PORT}`);
  console.log(`[fake-gateway] deterministic=${DETERMINISTIC} clock=${iso(now())}`);
  for (const conv of db.conversations.values()) {
    console.log(`[fake-gateway]   ${conv.id}  token=${conv.token}  fp=${fingerprint(conv.token)}`);
  }
});

const shutdown = () => {
  console.log('\n[fake-gateway] 关闭');
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
