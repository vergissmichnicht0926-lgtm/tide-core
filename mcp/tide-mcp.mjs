#!/usr/bin/env node
// 汐语（Tide）AI 侧 MCP server —— stdio，零依赖。
//
// 设计要点：
//   1. 每个工具都必须带 token；会话由网关按 token 反查，工具签名里没有 conversationId。
//   2. 所有请求带 x-agent-call: 1。这是 QQbridge confused deputy 事故的修法：
//      「头缺失」本身就是模型漏传 token 的自然结果，不能拿头缺失当免检条件。
//   3. 网关错误码翻成人话返回，不抛异常 —— 抛了模型只会看到 stack，看不懂该干什么。
//   4. 文本输出只是思考：发进聊天只有 chat_send，发到公开时间线只有 chat_publish_moment。

import { createInterface } from 'node:readline';
import { formatAttachmentContent } from './format-attachment.mjs';

const GATEWAY = (process.env.TIDE_GATEWAY_URL || 'http://127.0.0.1:7800').replace(/\/+$/, '');
const AGENT_SECRET = process.env.TIDE_AGENT_SECRET;
if (!AGENT_SECRET) {
  console.error('[tide-mcp] TIDE_AGENT_SECRET 未配置，拒绝启动');
  process.exit(1);
}
const DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_CAP_MS = 600_000;

// ── 网关调用 ────────────────────────────────────────────────────────────

const ERROR_TEXT = {
  'bad-request': '参数不合法',
  'token-missing': '缺少 token 参数。每个 chat_* 工具都必须把会话令牌作为 token 参数传入。',
  'token-invalid': 'token 无效或已失效。这个令牌是网关在每轮对话开始时分给你的，请原样使用。',
  'agent-call-missing': '内部错误：缺少 x-agent-call 头。',
  'conversation-closed': '这个对话已经关闭，不能再收发了。',
  'profile-forbidden': '只有 owner 的私聊可以修改汐语的公开资料。',
  'attachment-forbidden': '这个附件不属于当前对话，无权读取。',
  'attachment-not-found': '附件不存在，或已被清理。',
  'batch-conflict': '同一个 clientBatchId 被用于不同的消息内容。换一个新的 clientBatchId。',
  'batch-in-flight': '同一个 clientBatchId 的上一批还在处理中，稍等再试。',
  'wait-busy': '这个对话已经有一个 wait 在等了，等它返回再来。',
  private_must_reply: '私聊不允许 [SILENT]，必须发一条真实回复。',
  pre_sleep_wait_required: '设置潜水前必须先完成沉睡前观察，先调用 chat_wait(purpose="messages")。',
  'wake-config-never-wakes': '这份唤醒配置没有任何触发条件，会变成永眠。',
  'agent-secret-unconfigured': '网关没有配置 TIDE_AGENT_SECRET，agent 接口已关闭。',
  'agent-secret-invalid': 'MCP 与网关的 TIDE_AGENT_SECRET 不一致。',
  'not-direct': '只有私聊会话能发布动态，群聊不可以。',
  'moment-rate-limited': '今天发布的动态已经到上限（20 条），明天再来。',
  'gateway-unavailable': '网关暂时不可用，稍后重试。',
};

async function callGateway(path, { method = 'GET', token, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const headers = { 'x-agent-call': '1', 'x-agent-secret': AGENT_SECRET };
  if (token) headers['x-agent-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, text: `网关 ${Math.round(timeoutMs / 1000)} 秒没有响应。稍后重试或换个方式。` };
    }
    return { ok: false, text: `连不上网关（${GATEWAY}）：${err.message}` };
  }
  clearTimeout(timer);

  let json;
  const raw = await res.text();
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, text: `网关返回了非 JSON 内容（HTTP ${res.status}）：${raw.slice(0, 200)}` };
  }

  if (res.ok) return { ok: true, json };
  const error = json?.error ?? {};
  const code = error.code ?? '';
  const msg = error.message ?? '';
  const human = ERROR_TEXT[code];
  const extra = [];
  if (Number(error.remainingMs) > 0) {
    extra.push(`还需约 ${Math.ceil(Number(error.remainingMs) / 1000)} 秒`);
  }
  if (Number(error.preSleepWaitMs) > 0) {
    extra.push(`观察窗口 ${Math.round(Number(error.preSleepWaitMs) / 1000)} 秒`);
  }
  if (typeof error.hint === 'string' && error.hint) extra.push(error.hint);
  const extraText = extra.length ? `；${extra.join('；')}` : '';
  return {
    ok: false,
    text: human
      ? `${human}${msg ? `（${msg}）` : ''}${extraText}`
      : `网关错误 HTTP ${res.status}：${code || msg || raw.slice(0, 200)}${extraText}`,
  };
}

// 把结果压成模型好读的文本，别把整个 JSON 原样丢回去
function fmtMessages(messages) {
  if (!messages || messages.length === 0) return '（没有消息）';
  return messages
    .map((m) => {
      const who = m.role === 'user' ? '主人' : '你';
      const sender = m.role === 'user' && m.senderName
        ? `${m.senderName}${m.wakeReason ? `（${m.wakeReason}）` : ''}`
        : who;
      const atts =
        m.attachments && m.attachments.length
          ? `［附件 ${m.attachments.length} 个：${m.attachments.map((a) => `${a.id} ${a.name || a.mediaType || ''}`.trim()).join('、')}］`
          : '';
      return `#${m.seq} ${sender}：${m.text ?? ''}${atts}`;
    })
    .join('\n');
}

// ── 工具实现 ────────────────────────────────────────────────────────────

const handlers = {
  async chat_get_recent({ token, limit = 20, afterSeq }) {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (afterSeq !== undefined && afterSeq !== null) qs.set('afterSeq', String(afterSeq));
    const r = await callGateway(`/agent/messages?${qs}`, { token });
    if (!r.ok) return r.text;
    const j = r.json;
    return [
      `已读到 seq ${j.agentReadThroughSeq ?? '?'}，最新 seq ${j.latestSeq ?? '?'}${j.hasMore ? '（还有更早的）' : ''}`,
      fmtMessages(j.messages),
    ].join('\n');
  },

  async chat_send({ token, messages, segments, replyToMessageId, clientBatchId }) {
    const r = await callGateway('/agent/messages', {
      method: 'POST',
      token,
      body: { messages, segments, replyToMessageId, clientBatchId },
    });
    if (!r.ok) return r.text;
    const j = r.json;
    if (j.silent) return '已沉默（[SILENT]）：这轮不发言，没有写入消息。';
    if (j.bubbles) {
      const when = j.scheduledAt ? `，首条约 ${j.scheduledAt}` : '';
      return j.duplicated
        ? `这批气泡已经排过队（幂等命中），没有重复发送${when}。`
        : `已排入气泡队列，共 ${segments?.length ?? j.queueIds?.length ?? '?'} 段${when}。`;
    }
    if (j.queued) {
      return `发送节流：这批已排队，最早 ${j.scheduledAt || '稍后'} 发出（不丢弃）。`;
    }
    const seqs = (j.messages ?? []).map((m) => `#${m.seq}`).join(' ');
    if (j.duplicated) return `这批已经发过了（幂等命中），没有重复发送。seq ${seqs}`;
    return `已发出 ${j.messages?.length ?? 0} 条，seq ${seqs}`;
  },

  async chat_send_voice({
    token, text, audioBase64, mimeType, conversationId, replyToMessageId, clientBatchId,
  }) {
    const r = await callGateway('/agent/voice', {
      method: 'POST',
      token,
      body: {
        text,
        audioBase64,
        mimeType,
        conversationId,
        replyToMessageId,
        clientBatchId,
      },
      timeoutMs: 30_000,
    });
    if (!r.ok) return r.text;
    const j = r.json;
    return `语音已发送，seq #${j.seq}，时长 ${(Number(j.durationMs || 0) / 1000).toFixed(1)} 秒。`;
  },

  async chat_send_sticker({
    token, stickerId, name, replyToMessageId, clientBatchId,
  }) {
    let id = stickerId ? String(stickerId).trim() : '';
    if (!id) {
      if (!name) return 'stickerId 与 name 至少给一个。';
      const qs = new URLSearchParams();
      qs.set('name', String(name));
      const lookup = await callGateway(`/agent/stickers?${qs}`, { token });
      if (!lookup.ok) return lookup.text;
      const items = Array.isArray(lookup.json.items) ? lookup.json.items : [];
      if (items.length === 0) return `没有找到名字包含「${name}」的表情包。`;
      if (items.length > 1) {
        const list = items
          .slice(0, 10)
          .map((item) => `- ${item.id} ${item.name}`)
          .join('\n');
        return `「${name}」匹配到多个表情包，请改用 stickerId：\n${list}`;
      }
      id = items[0].id;
    }
    const r = await callGateway('/agent/messages', {
      method: 'POST',
      token,
      body: { stickerId: id, replyToMessageId, clientBatchId },
    });
    if (!r.ok) return r.text;
    const j = r.json;
    const seqs = (j.messages ?? []).map((m) => `#${m.seq}`).join(' ');
    return j.duplicated
      ? `这张表情已经发过了（幂等命中），seq ${seqs}`
      : `表情已发出，seq ${seqs}`;
  },

  async chat_wait({ token, quietMs = 800, timeoutMs = 60_000, purpose = 'reply' }) {
    const capped = Math.min(Math.max(Number(timeoutMs) || 60_000, 1000), WAIT_TIMEOUT_CAP_MS);
    const r = await callGateway('/agent/wait', {
      method: 'POST',
      token,
      body: { purpose, quietMs, timeoutMs: capped },
      timeoutMs: capped + 15_000,
    });
    if (!r.ok) return r.text;
    const j = r.json;
    const head = [
      `arrived=${j.arrived ? 'true' : 'false'}`,
      `quiet=${j.quiet ? 'true' : 'false'}`,
      `timeout=${j.timeout ? 'true' : 'false'}`,
      ...(j.preSleepWaitSatisfied ? ['preSleepWaitSatisfied=true'] : []),
      ...(Number(j.preSleepWaitRemainingMs) > 0
        ? [`preSleepWaitRemainingMs=${j.preSleepWaitRemainingMs}`]
        : []),
    ].join(' ');
    const tail =
      j.newMessages && j.newMessages.length
        ? fmtMessages(j.newMessages)
        : '（没有新消息）';
    return `${head}\n${tail}`;
  },

  async chat_mark_read({ token, throughSeq }) {
    const r = await callGateway('/agent/read', { method: 'POST', token, body: { throughSeq } });
    if (!r.ok) return r.text;
    return `已读水位推进到 seq ${r.json.agentReadThroughSeq}${r.json.clamped ? `（只到看过的 seq ${r.json.seenThroughSeq}）` : ''}`;
  },

  async chat_set_wake_config({ token, config, throughSeq }) {
    const r = await callGateway('/agent/wake-config', {
      method: 'POST',
      token,
      body: { config, throughSeq },
    });
    if (!r.ok) return r.text;
    const j = r.json;
    const cfg = j.config || {};
    const details = [];
    if (cfg.limits) details.push(`限制 ${JSON.stringify(cfg.limits)}`);
    if (typeof cfg.hint === 'string' && cfg.hint.trim()) details.push(`建议 ${cfg.hint.trim()}`);
    return `唤醒配置已更新：${j.wakeSummary || JSON.stringify(cfg)}${details.length ? `；${details.join('；')}` : ''}${j.nextWakeAt ? `，定时唤醒 ${j.nextWakeAt}` : ''}`;
  },

  async chat_memory_append({ token, kind, text }) {
    const r = await callGateway('/agent/memory', { method: 'POST', token, body: { kind, text } });
    if (!r.ok) return r.text;
    return `已记下（${r.json.kind} #${r.json.id}）：${r.json.text}`;
  },

  async chat_memory_query({ token, kind, limit = 20 }) {
    const qs = new URLSearchParams();
    if (kind) qs.set('kind', kind);
    qs.set('limit', String(limit));
    const r = await callGateway(`/agent/memory?${qs}`, { token });
    if (!r.ok) return r.text;
    const items = r.json.items ?? r.json.memory ?? [];
    if (items.length === 0) return '（没有记过这类事）';
    return items
      .map((m) => `#${m.id} [${m.kind}] ${m.text}${m.key ? `（key: ${m.key}）` : ''}`)
      .join('\n');
  },

  async chat_memory_remove({ token, id, confirm }) {
    if (confirm !== true) return '删除是破坏性的，必须显式传 confirm: true 才会执行。';
    const r = await callGateway('/agent/memory', {
      method: 'DELETE',
      token,
      body: { id, confirm: true },
    });
    if (!r.ok) return r.text;
    return `已删除 #${r.json.id ?? id}`;
  },

  async chat_get_prompt({ token }) {
    const r = await callGateway('/agent/prompt', { token });
    if (!r.ok) return r.text;
    const j = r.json;
    const unread = j.unread?.count ? `未读 ${j.unread.count} 条（最新 #${j.unread.latestSeq}）` : '没有未读';
    const fp = j.tokenFingerprint ? `；令牌指纹 ${j.tokenFingerprint}` : '';
    const wake = j.wakeSummary || (j.recommendedWake?.enabled ? '已启用' : '未启用');
    const kind = j.kind === 'group' ? '群聊' : '私聊';
    const preSleep = j.preSleep
      ? (j.preSleep.satisfied
        ? '沉睡前观察已满足'
        : `沉睡前观察还差约 ${Math.ceil(Number(j.preSleep.remainingMs || 0) / 1000)} 秒`)
      : '';
    return [
      j.prompt,
      '---',
      `${kind}；已读水位 #${j.agentReadThroughSeq}；${unread}；唤醒：${wake}${preSleep ? `；${preSleep}` : ''}${fp}。`,
    ].join('\n');
  },

  async chat_get_profile({ token }) {
    const r = await callGateway('/agent/profile', { token });
    if (!r.ok) return r.text;
    const p = r.json.profile ?? {};
    return [
      `名字：${p.name || '汐语'}`,
      `个签：${p.signature || '（空）'}`,
      `头像：${p.hasAvatar ? '已设置' : '未设置'}`,
    ].join('\n');
  },

  async chat_set_profile({ token, name, signature, avatar }) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (signature !== undefined) body.signature = signature;
    if (avatar !== undefined) body.avatar = avatar;
    const r = await callGateway('/agent/profile', {
      method: 'POST',
      token,
      body,
    });
    if (!r.ok) return r.text;
    const p = r.json.profile ?? {};
    return [
      '公开资料已更新。',
      `名字：${p.name || '汐语'}`,
      `个签：${p.signature || '（空）'}`,
      `头像：${p.hasAvatar ? '已设置' : '未设置'}`,
    ].join('\n');
  },

  async chat_read_attachment({ token, attachmentId, offset = 0, limit = 8192 }) {
    const qs = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const r = await callGateway(
      `/agent/attachments/${encodeURIComponent(attachmentId)}/content?${qs}`,
      { token },
    );
    if (!r.ok) return r.text;
    return formatAttachmentContent(r.json, attachmentId);
  },

  async chat_publish_moment({ token, text }) {
    const r = await callGateway('/agent/moments', {
      method: 'POST',
      token,
      body: { text },
    });
    if (!r.ok) return r.text;
    const moment = r.json.moment ?? {};
    return `动态已发布：${moment.text || text}`;
  },
};

// ── 工具定义 ────────────────────────────────────────────────────────────

const T = {
  type: 'object',
  properties: {
    token: {
      type: 'string',
      description: '当前对话的会话令牌。每轮开头网关会把它给你，原样传进来，不要改写。',
    },
  },
  required: ['token'],
};

const tools = [
  {
    name: 'chat_get_recent',
    description:
      '读取这个对话最近的消息。默认从最新往回取 limit 条；给了 afterSeq 就取它之后的消息。用来在回复前确认上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        limit: { type: 'number', description: '取多少条，默认 20，上限 50。' },
        afterSeq: { type: 'number', description: '只取 seq 大于它的消息。' },
      },
      required: ['token'],
    },
  },
  {
    name: 'chat_send',
    description:
      '把消息发出去。这是唯一会真正发出去的工具——正文里的文字只是思考。普通 messages 数组即条数，不解析空格；一批最多 8 条。另可用 segments 传 1~4 段（每段最多 2000 字），按 Gateway 配置的气泡间隔逐条发送；也可以把 messages 传成一条用独立一行 --- 分隔的文本。群聊里整批传 ["[SILENT]"] 表示这轮不发言（合法沉默，不写消息、不占 seq）；私聊不允许 [SILENT]。发送频率超限会排队，不会丢。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        messages: {
          type: 'array',
          items: { type: 'string' },
          description: '要发出去的文本，每条一段。1~8 条；超长单条会自动拆分，拆分后仍须不超过 8 条。也可用一条文本里的独立 --- 行声明 1~4 段气泡。与 segments 二选一。',
        },
        segments: {
          type: 'array',
          items: { type: 'string' },
          description: '多气泡分段，1~4 段，每段最多 2000 字；按设置的气泡间隔逐条发送。与 messages 二选一。',
        },
        replyToMessageId: { type: 'string', description: '要回复的那条消息 id（可选）。' },
        clientBatchId: {
          type: 'string',
          description:
            '这一批的幂等键（可选但建议给）。同样的 id 配同样的内容重放不会重复发送；换内容会 409。',
        },
      },
      required: ['token'],
    },
  },
  {
    name: 'chat_send_voice',
    description:
      '发送一条语音消息。audioBase64 是音频文件的 base64（解码后最多 2 MB），mimeType 必须是 audio/*；text 是原文，必填。conversationId 省略时使用当前 token 对应的会话。失败直接返回错误，不会自动降级成文字。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        text: { type: 'string', description: '语音对应的原文，1~500 字。' },
        audioBase64: { type: 'string', description: '音频文件的 base64，解码后最多 2 MB。' },
        mimeType: { type: 'string', description: 'audio/mpeg、audio/wav、audio/mp4 等 audio/*。' },
        conversationId: { type: 'string', description: '目标会话 id；省略时用当前 token 的会话。' },
        replyToMessageId: { type: 'string', description: '要回复的消息 id（可选）。' },
        clientBatchId: { type: 'string', description: '幂等键（可选）。' },
      },
      required: ['token', 'text', 'audioBase64', 'mimeType'],
    },
  },
  {
    name: 'chat_send_sticker',
    description:
      '发送一张表情包。stickerId 与 name 二选一；name 走精确匹配，找不到再做包含匹配，命中多条会返回候选 id + name 列表。一轮最多一张。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        stickerId: { type: 'string', description: '表情包 id（与 name 二选一）。' },
        name: { type: 'string', description: '表情包名字；精确优先，其次包含匹配。' },
        replyToMessageId: { type: 'string', description: '要回复的消息 id（可选）。' },
        clientBatchId: { type: 'string', description: '幂等键（可选）。' },
      },
      required: ['token'],
    },
  },
  {
    name: 'chat_wait',
    description:
      '等消息。purpose="reply" 表示等对方这一轮说完（按最后一条来信补足静默）；purpose="messages" 表示等下一批消息或做沉睡前观察。返回 arrived / quiet / timeout，以及 preSleepWaitSatisfied / preSleepWaitRemainingMs；群聊设置潜水前必须用 messages 模式等够观察窗口。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        quietMs: { type: 'number', description: '判定"说完了"的静默毫秒数，默认 800。' },
        timeoutMs: { type: 'number', description: '最多等多久，默认 60000，上限 600000。' },
        purpose: { type: 'string', enum: ['reply', 'messages'], description: '等待的目的。' },
      },
      required: ['token'],
    },
  },
  {
    name: 'chat_mark_read',
    description: '把"已读到"的水位推进到 throughSeq。只前进不后退。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        throughSeq: { type: 'number', description: '读到的消息 seq。' },
      },
      required: ['token', 'throughSeq'],
    },
  },
  {
    name: 'chat_set_wake_config',
    description:
      '设置群聊的唤醒条件。v2 配置：mode=diving|active，infinite，sleepUntil，triggers（atMention / nameMention / speakerIds / keywords / question / poke / anyMessage / probability 0~1），batchWindowMs，limits（maxWakePerMinute 1~60 / maxWakePerHour 1~240 / preSleepWaitMs 60000~1800000 步进 1000 / noActionLimit 1~20 / maxWakeConfigReminders 0~10），hint（≤200 字）。默认限制：1/分、12/时、300000ms、3 轮、2 次。至少保留一个触发条件，否则会变成永眠，网关会拒绝。群聊设 diving 前必须先完成沉睡前观察（chat_wait purpose="messages"），否则 409 pre_sleep_wait_required；对方明确说晚安/拜拜/下了可跳过。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        config: {
          type: 'object',
          description:
            '完整或部分 v2 配置。示例：{mode:"diving",infinite:true,triggers:{atMention:true,nameMention:true,keywords:["汐语"],question:true,probability:0.05},batchWindowMs:8000,limits:{maxWakePerMinute:1,maxWakePerHour:12,preSleepWaitMs:300000,noActionLimit:3,maxWakeConfigReminders:2},hint:"可以在群里主动一点"}。limits 子键只接受这五个数字；hint ≤200 字；越界/未知子键会 400。confirmedBy 由网关写，不要传。',
        },
        throughSeq: { type: 'number', description: '顺带把已读水位推进到这里（可选）。' },
      },
      required: ['token', 'config'],
    },
  },
  {
    name: 'chat_memory_append',
    description:
      '往长期记忆里记一条。kind 分三类：topic（聊过什么）、thought（你自己的念头）、impression（对主人的观察）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        kind: {
          type: 'string',
          enum: ['topic', 'thought', 'impression'],
          description: '记忆种类：topic / thought / impression。',
        },
        text: { type: 'string', description: '记的内容，一条一件事。' },
      },
      required: ['token', 'kind', 'text'],
    },
  },
  {
    name: 'chat_memory_query',
    description: '按种类查长期记忆。不传 kind 就是查全部。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        kind: {
          type: 'string',
          enum: ['topic', 'thought', 'impression'],
          description: '只查这一类。',
        },
        limit: { type: 'number', description: '最多返回多少条，默认 20。' },
      },
      required: ['token'],
    },
  },
  {
    name: 'chat_memory_remove',
    description: '删一条长期记忆。破坏性操作，必须显式传 confirm: true。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        id: { type: 'number', description: '要删的记忆 id。' },
        confirm: { type: 'boolean', description: '必须为 true 才会真的删。' },
      },
      required: ['token', 'id', 'confirm'],
    },
  },
  {
    name: 'chat_get_prompt',
    description:
      '拿当前会话状态：私聊/群聊、未读计数、已读水位、wake_config 摘要、沉睡前观察状态。群聊第一次进入或改配置前先看这个。',
    inputSchema: T,
  },
  {
    name: 'chat_get_profile',
    description:
      '读取汐语自己的公开资料：名字、个签、是否已设置头像。不会返回头像二进制。',
    inputSchema: T,
  },
  {
    name: 'chat_set_profile',
    description:
      '修改汐语自己的公开资料。只有 owner 的私聊可用；群聊和 guest 会被拒绝。name 1~40 字，signature 最多 200 字，avatar 必须是 data:image/...;base64,... 且不超过 500000 字符；只传要改的字段，传空字符串可清空个签/头像。不能修改人格覆盖、模型、权限或配额。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        name: { type: 'string', description: '新名字，1~40 字；不传则不改。' },
        signature: { type: 'string', description: '新个签，最多 200 字；传空字符串清空；不传则不改。' },
        avatar: {
          type: 'string',
          description:
            '新头像 data URI，格式 data:image/jpeg;base64,... 或 data:image/png;base64,...，最多 500000 字符；传空字符串清空；不传则不改。没有现成图片时不要编造。',
        },
      },
      required: ['token'],
    },
  },
  {
    name: 'chat_read_attachment',
    description:
      '读取一个附件的内容。这是读文件的唯一途径——没有本地文件系统可用。文本按 offset/limit 分片读，二进制只能拿到元信息。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        attachmentId: { type: 'string', description: '附件 id，来自消息里的 attachments。' },
        offset: { type: 'number', description: '从第几个字符开始，默认 0。' },
        limit: { type: 'number', description: '读多少字符，默认 8192。' },
      },
      required: ['token', 'attachmentId'],
    },
  },
  {
    name: 'chat_publish_moment',
    description:
      '发布一条动态（类似朋友圈），会出现在已经添加你的用户的时间线里。只有私聊会话能发；1~2000 字；每个会话每天最多 20 条。只发真正想留下的内容，不要为了刷存在感硬发。',
    inputSchema: {
      type: 'object',
      properties: {
        ...T.properties,
        text: { type: 'string', description: '动态正文，1~2000 字。' },
      },
      required: ['token', 'text'],
    },
  },
];

const TOOL_NAMES = new Set(tools.map((t) => t.name));

// ── MCP stdio 主循环 ────────────────────────────────────────────────────

const SERVER_INFO = { name: 'tide', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function dispatch(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'tools/list') {
    return { tools };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOL_NAMES.has(name)) {
      return {
        content: [{ type: 'text', text: `没有这个工具：${name}` }],
        isError: true,
      };
    }
    const args = params?.arguments ?? {};
    let text;
    try {
      text = await handlers[name](args);
    } catch (err) {
      text = `工具执行出错：${err.message}`;
    }
    return { content: [{ type: 'text', text }] };
  }
  if (method === 'ping') return {};
  throw Object.assign(new Error(`不认识的方法：${method}`), { code: -32601 });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 坏行直接丢，别把 stdout 弄脏
  }

  // 通知没有 id，不用回
  if (msg.id === undefined || msg.id === null) return;

  dispatch(msg.method, msg.params)
    .then((result) => send({ jsonrpc: '2.0', id: msg.id, result }))
    .catch((err) =>
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: err.code ?? -32603, message: err.message },
      }),
    );
});

rl.on('close', () => process.exit(0));
