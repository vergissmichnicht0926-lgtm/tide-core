/**
 * `/agent/*` —— MCP 进程（tide-mcp.mjs）专用接口。
 *
 * 鉴权只认 `x-agent-token`（按它反查 conversation）+ `x-agent-call: 1`
 * （QQbridge confused deputy 事故的修法：缺这个头就说明不是我们自己的 MCP 在调）。
 * 客户端（App）永远看不到 agent_token，它走 JWT。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nowMs } from '../db/index.mjs';
import { readJson, sendError, sendJson } from '../http.mjs';
import { createMomentForAgent } from './moments.mjs';
import {
  assertReplyTarget,
  contiguousSeenThrough,
  hasSegmentSeparator,
  insertAssistantBatch,
  insertAssistantSticker,
  isSilentMarker,
  lastUserMessageAt,
  latestSeq,
  latestUserSeq,
  MESSAGE_COLUMNS,
  MAX_MESSAGE_CHARS,
  parseContent,
  payloadHashOf,
  publishAssistantMessages,
  publicAgentMessage,
  splitReplyText,
  splitSegmentText,
  textOf,
  validateSendBatch,
  validateSegments,
} from '../messages.mjs';
import { resolveStickerForSend, searchStickersByName } from '../stickers.mjs';
import { buildStatusPrompt } from '../social/prompt.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';
import { storeAgentVoice } from '../voice.mjs';
import { imageSize } from '../dsh/images.mjs';
import {
  hasExplicitEnd,
  isSleepingConfig,
  normalizeSocialState,
  normalizeWakeConfig,
  validateWakeConfigInput,
  wakeConfigSummary,
} from '../social/wake.mjs';

export { publicAgentMessage } from '../messages.mjs';

const MAX_MEMORY_CHARS = 500;
const WAIT_LEASE_MS = 15 * 60 * 1000;
const WAIT_POLL_MS = 120;
const QUIET_MS_MIN = 1_000;
const QUIET_MS_MAX = 60_000;
const TIMEOUT_MS_MIN = 1_000;
const TIMEOUT_MS_MAX = 600_000;
const MEMORY_KINDS = new Set(['topic', 'thought', 'impression']);

const sha256hex = (value) => createHash('sha256').update(String(value)).digest('hex');

/** token 指纹只出前 4 位：够在日志里分清是哪个会话，又不足以反推 token。 */
export const tokenFingerprint = (token) => sha256hex(token).slice(0, 4);

function httpError(status, code, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
}

// ── 鉴权 ────────────────────────────────────────────────────────────────

function resolveConversation(ctx, req) {
  const agentSecret = ctx.config?.agentSecret;
  if (!agentSecret) {
    throw httpError(503, 'agent-secret-unconfigured', '网关未配置 TIDE_AGENT_SECRET，已拒绝所有 agent 调用');
  }
  const provided = req.headers['x-agent-secret'];
  if (typeof provided !== 'string') {
    throw httpError(401, 'agent-secret-invalid', '缺少 x-agent-secret');
  }
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(String(agentSecret)).digest();
  if (!timingSafeEqual(left, right)) {
    throw httpError(401, 'agent-secret-invalid', 'x-agent-secret 不正确');
  }
  const token = req.headers['x-agent-token'];
  if (!token || typeof token !== 'string') {
    throw httpError(401, 'token-missing', '缺少 x-agent-token');
  }
  if (String(req.headers['x-agent-call'] ?? '') !== '1') {
    throw httpError(401, 'agent-call-missing', '缺少 x-agent-call: 1');
  }
  const row = ctx.dbState.db.prepare(
    `SELECT id, kind, user_id, summary, policy, agent_token, agent_read_seq, dsh_session_id,
            wake_config_json, social_state_json
       FROM conversation WHERE agent_token = ? AND deleted_at IS NULL`,
  ).get(token);
  if (!row) {
    // 轮换后旧 token 立刻落空，与「从没存在过」返回同一句话，不给探测空间
    throw httpError(401, 'token-invalid', 'agent token 不存在或已失效');
  }
  const rebuild = ctx.dbState.db.prepare(
    `SELECT state FROM rebuild_queue
      WHERE conversation_id = ? AND state IN ('pending','failed') LIMIT 1`,
  ).get(row.id);
  if (rebuild) {
    throw httpError(403, 'conversation-closed', '会话正在重建，当前 token 即将失效', {
      rebuild_state: rebuild.state,
    });
  }
  return { conversation: row, token };
}

// ── 消息 ────────────────────────────────────────────────────────────────

// ── wait 租约（单进程内存） ──────────────────────────────────────────────

const waitLeases = new Map();

function acquireLease(conversationId) {
  const held = waitLeases.get(conversationId);
  if (held !== undefined && Date.now() - held < WAIT_LEASE_MS) {
    throw httpError(429, 'wait-busy', '同会话已有 wait 在跑');
  }
  waitLeases.set(conversationId, Date.now());
  return () => { waitLeases.delete(conversationId); };
}

// ── handler ─────────────────────────────────────────────────────────────

function getPrompt(ctx, { conversation }) {
  const db = ctx.dbState.db;
  const unread = db.prepare(
    `SELECT COUNT(*) AS n FROM message
      WHERE conversation_id = ? AND role = 'user' AND seq > ?`,
  ).get(conversation.id, conversation.agent_read_seq);
  const latest = latestSeq(db, conversation.id);
  const wakeConfig = normalizeWakeConfig(conversation.wake_config_json);
  const socialState = normalizeSocialState(conversation.social_state_json);
  const preSleepWaitMs = Number(ctx.config?.social?.preSleepWaitMs) || 300_000;
  const lastIncomingAt = Number(socialState.lastIncomingAt) || 0;
  const preSleepSatisfied =
    (lastIncomingAt > 0 && Date.now() - lastIncomingAt >= preSleepWaitMs)
    || (socialState.preSleepWaitSatisfiedAt > 0
      && lastIncomingAt <= socialState.preSleepWaitSatisfiedAt)
    || (socialState.preSleepWaitObservedAt > 0
      && lastIncomingAt <= socialState.preSleepWaitObservedAt);
  const preSleep = {
    waitMs: preSleepWaitMs,
    satisfied: preSleepSatisfied,
    remainingMs: preSleepSatisfied
      ? 0
      : lastIncomingAt
        ? Math.max(0, preSleepWaitMs - (Date.now() - lastIncomingAt))
        : preSleepWaitMs,
    observedAt: socialState.preSleepWaitObservedAt
      ? new Date(socialState.preSleepWaitObservedAt).toISOString()
      : null,
  };
  return {
    ok: true,
    kind: conversation.kind === 'group' ? 'group' : 'direct',
    prompt: buildStatusPrompt({
      conversation,
      wakeConfig,
      socialState,
      unread: unread.n,
      latest,
      preSleep,
    }),
    agentReadThroughSeq: conversation.agent_read_seq,
    unread: { count: unread.n, latestSeq: latest },
    wakeConfig,
    wakeSummary: wakeConfigSummary(wakeConfig),
    socialState,
    preSleep,
    recommendedWake: {
      enabled: true,
      ...wakeConfig,
    },
    tokenFingerprint: tokenFingerprint(conversation.agent_token),
  };
}

function getMessages(ctx, { conversation }, url) {
  const db = ctx.dbState.db;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw === '' ? 30 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw httpError(400, 'bad-request', 'limit 必须是 1~100 的整数');
  }

  const afterRaw = url.searchParams.get('afterSeq');
  // 契约 2.2：空 afterSeq = 取最新 limit 条；0 = 从最早未读开始。
  const tail = afterRaw === null || afterRaw === '';
  const afterSeq = tail ? 0 : Number(afterRaw);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw httpError(400, 'bad-request', 'afterSeq 必须是非负整数');
  }

  const rows = tail
    ? db.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM message
          WHERE conversation_id = ?
          ORDER BY seq DESC LIMIT ?`,
      ).all(conversation.id, limit + 1).reverse()
    : db.prepare(
        `SELECT ${MESSAGE_COLUMNS} FROM message
          WHERE conversation_id = ? AND seq > ?
          ORDER BY seq ASC LIMIT ?`,
      ).all(conversation.id, afterSeq, limit + 1);

  const hasMore = rows.length > limit;
  // 倒序多取的那条是最旧的，只有真的超了才切队头；正序多取的那条是最新的，切队尾。
  const picked = tail
    ? (hasMore ? rows.slice(1) : rows)
    : rows.slice(0, limit);

  return {
    ok: true,
    messages: picked.map((row) => publicAgentMessage(row, db, conversation.id)),
    agentReadThroughSeq: conversation.agent_read_seq,
    hasMore,
    latestSeq: latestSeq(db, conversation.id),
  };
}

function postMessages(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  if (body.stickerId) {
    return postStickerMessage(ctx, conversation, body);
  }
  let list;
  let segmentsMode = false;
  if (body.segments !== undefined) {
    if (body.messages !== undefined) {
      throw httpError(400, 'bad-request', 'messages 与 segments 只能二选一');
    }
    list = validateSegments(body.segments);
    segmentsMode = true;
  } else {
    const rawList = Array.isArray(body.messages) ? body.messages : [body.messages];
    if (rawList.length === 1
      && typeof rawList[0] === 'string'
      && hasSegmentSeparator(rawList[0])) {
      list = validateSegments(splitSegmentText(rawList[0]));
      segmentsMode = true;
    } else {
      const expanded = [];
      for (const item of rawList) {
        if (typeof item !== 'string') {
          expanded.push(item);
          continue;
        }
        const text = item.trim();
        if (text.length <= MAX_MESSAGE_CHARS) {
          expanded.push(text);
          continue;
        }
        expanded.push(...splitReplyText(text, { maxMessages: Number.MAX_SAFE_INTEGER }));
      }
      list = validateSendBatch(expanded);
    }
  }
  const kind = conversation.kind === 'group' ? 'group' : 'direct';
  const spoken = list.filter((text) => !isSilentMarker(text));
  if (spoken.length === 0) {
    if (kind !== 'group') {
      throw httpError(400, 'private_must_reply', '私聊不允许 [SILENT]，必须发一条真实回复');
    }
    ctx.social?.noteAction?.(conversation.id);
    return {
      ok: true,
      silent: true,
      messages: [],
      clientBatchId: body.clientBatchId ? String(body.clientBatchId) : null,
      duplicated: false,
    };
  }
  const replyTo = assertReplyTarget(db, conversation.id, body.replyToMessageId);
  const batchId = body.clientBatchId ? String(body.clientBatchId) : null;
  const hash = payloadHashOf(list, replyTo);

  if (batchId) {
    const bubbles = db.prepare(
      `SELECT id, state, not_before_ms FROM bubble_queue
        WHERE conversation_id = ? AND client_batch_id = ?
        ORDER BY segment_index ASC`,
    ).all(conversation.id, batchId);
    if (bubbles.length > 0) {
      const prev = db.prepare(
        'SELECT payload_hash, message_ids_json FROM message_batch WHERE conversation_id = ? AND client_batch_id = ?',
      ).get(conversation.id, batchId);
      if (prev && prev.payload_hash !== hash) {
        throw httpError(409, 'batch-conflict', 'clientBatchId 已被另一份 payload 使用');
      }
      let ids = [];
      try {
        const parsed = prev ? JSON.parse(prev.message_ids_json) : [];
        if (Array.isArray(parsed)) ids = parsed;
      } catch {
        // 空批次
      }
      if (ids.length > 0) {
        const rows = db.prepare(
          `SELECT id, seq FROM message
            WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        ).all(conversation.id, ...ids);
        return {
          ok: true,
          silent: false,
          queued: false,
          messages: rows.map((r) => ({ id: r.id, seq: r.seq })),
          clientBatchId: batchId,
          duplicated: true,
        };
      }
      return {
        ok: true,
        silent: false,
        queued: true,
        bubbles: true,
        messages: [],
        clientBatchId: batchId,
        duplicated: true,
        scheduledAt: new Date(bubbles[0].not_before_ms).toISOString(),
      };
    }
    const prev = db.prepare(
      'SELECT payload_hash, message_ids_json FROM message_batch WHERE conversation_id = ? AND client_batch_id = ?',
    ).get(conversation.id, batchId);
    if (prev) {
      if (prev.payload_hash !== hash) {
        throw httpError(409, 'batch-conflict', 'clientBatchId 已被另一份 payload 使用');
      }
      const ids = JSON.parse(prev.message_ids_json);
      const rows = ids.length
        ? db.prepare(
            `SELECT id, seq FROM message
              WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
          ).all(conversation.id, ...ids)
        : [];
      return {
        ok: true,
        silent: false,
        messages: rows.map((r) => ({ id: r.id, seq: r.seq })),
        clientBatchId: batchId,
        duplicated: true,
      };
    }
  }

  const now = nowMs();
  if (segmentsMode && spoken.length > 1 && ctx.social?.enqueueBubbles) {
    const queued = ctx.social.enqueueBubbles(conversation.id, {
      list: spoken,
      replyTo,
      batchId,
      hash,
    });
    if (queued) {
      ctx.social.noteAction(conversation.id);
      return {
        ok: true,
        queued: true,
        bubbles: true,
        silent: false,
        messages: [],
        clientBatchId: batchId,
        duplicated: Boolean(queued.duplicated),
        queueIds: queued.queueIds,
        scheduledAt: queued.scheduledAt,
      };
    }
  }
  // 发送节流：8 条/分、60 条/时。超限批次进 send_queue，不丢弃。
  const notBefore = ctx.social?.sendNotBefore?.(conversation.id, spoken.length) ?? now;
  if (notBefore > now + 5) {
    const queued = ctx.social.enqueueSend(conversation.id, {
      list: spoken,
      replyTo,
      batchId,
      hash,
    });
    ctx.social.noteAction(conversation.id);
    return {
      ok: true,
      queued: true,
      silent: false,
      messages: [],
      clientBatchId: batchId,
      duplicated: false,
      queueId: queued.queueId,
      scheduledAt: new Date(queued.notBefore).toISOString(),
    };
  }

  const inserted = insertAssistantBatch(db, conversation.id, spoken, {
    replyTo,
    batchId,
    hash,
    now,
  });
  const created = inserted.created;

  // 事务提交之后才扇出。ctx.events 由 server 侧注入（R1 的共享事件总线）；
  // 还没接的时候静默跳过，不能因为总线没就绪把已经落库的消息变成失败。
  if (!inserted.duplicated) {
    ctx.social?.noteAction?.(conversation.id);
    publishAssistantMessages(ctx, conversation.id, created, {
      onDone: () => ctx.social?.noteSent?.(conversation.id, created.length),
    });
  }

  return {
    ok: true,
    silent: false,
    queued: false,
    messages: created,
    clientBatchId: batchId,
    duplicated: inserted.duplicated,
  };
}

function postStickerMessage(ctx, conversation, body) {
  const db = ctx.dbState.db;
  const resolved = resolveStickerForSend(
    db,
    body.stickerId,
    conversation.user_id,
  );
  const replyTo = assertReplyTarget(db, conversation.id, body.replyToMessageId);
  const batchId = body.clientBatchId ? String(body.clientBatchId) : null;
  const hash = payloadHashOf([`sticker:${resolved.sticker.id}`], replyTo);
  const inserted = insertAssistantSticker(db, conversation.id, {
    sticker: resolved.sticker,
    attachmentId: resolved.attachment.id,
    replyTo,
    batchId,
    hash,
    now: nowMs(),
  });
  if (!inserted.duplicated) {
    ctx.social?.noteAction?.(conversation.id);
    publishAssistantMessages(ctx, conversation.id, inserted.created, {
      onDone: () => ctx.social?.noteSent?.(conversation.id, inserted.created.length),
    });
  }
  return {
    ok: true,
    silent: false,
    queued: false,
    messages: inserted.created,
    clientBatchId: batchId,
    duplicated: inserted.duplicated,
  };
}

function getAgentStickers(ctx, auth, url) {
  const name = url.searchParams.get('name') ?? '';
  const result = searchStickersByName(
    ctx.dbState.db,
    auth.conversation.user_id,
    name,
  );
  return { ok: true, match: result.match, items: result.items };
}

async function postWait(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  const purpose = body.purpose === 'reply' ? 'reply' : 'messages';
  const quietRaw = body.quietMs === undefined || body.quietMs === null ? 10_000 : Number(body.quietMs);
  if (!Number.isSafeInteger(quietRaw) || quietRaw < QUIET_MS_MIN || quietRaw > QUIET_MS_MAX) {
    throw httpError(400, 'bad-request', `quietMs 必须在 ${QUIET_MS_MIN}~${QUIET_MS_MAX} 之间`);
  }
  const timeoutRaw = body.timeoutMs === undefined || body.timeoutMs === null ? 300_000 : Number(body.timeoutMs);
  if (!Number.isSafeInteger(timeoutRaw) || timeoutRaw < TIMEOUT_MS_MIN || timeoutRaw > TIMEOUT_MS_MAX) {
    throw httpError(400, 'bad-request', `timeoutMs 必须在 ${TIMEOUT_MS_MIN}~${TIMEOUT_MS_MAX} 之间`);
  }
  const quietMs = quietRaw;
  const timeoutMs = timeoutRaw;

  ctx.social?.cancelReplyCheck?.(conversation.id);
  const release = acquireLease(conversation.id);
  try {
    const enteredSeq = latestUserSeq(db, conversation.id);
    const enteredAt = Date.now();
    // reply 模式的静默从「最后一条来信」起算；没有来信就从进 wait 起算
    const replyBaseAt = purpose === 'reply'
      ? (lastUserMessageAt(db, conversation.id) ?? enteredAt)
      : enteredAt;

    const evaluate = () => {
      const at = Date.now();
      const latest = latestUserSeq(db, conversation.id);
      const arrived = latest > enteredSeq;
      // messages 模式只在真的收到新消息时才把 lastNewAt 往前推，
      // 于是「一直没来信」表现为 quiet=false，而不是安静 10 秒就算安静。
      const lastNewAt = arrived
        ? (lastUserMessageAt(db, conversation.id, enteredSeq) ?? at)
        : (purpose === 'reply' ? replyBaseAt : enteredAt);
      const quiet = (purpose === 'reply' || (arrived && quietMs > 0))
        && at - lastNewAt >= quietMs;
      return { arrived, quiet };
    };

    const deadline = Date.now() + timeoutMs;
    let state = evaluate();
    while (!state.arrived && !state.quiet && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, WAIT_POLL_MS); });
      state = evaluate();
    }
    const timedOut = !state.arrived && !state.quiet;

    const rows = db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM message
        WHERE conversation_id = ? AND seq > ? AND role = 'user'
        ORDER BY seq ASC LIMIT 100`,
    ).all(conversation.id, enteredSeq);

    const preSleepWaitMs = Number(ctx.config?.social?.preSleepWaitMs) || 300_000;
    const social = normalizeSocialState(conversation.social_state_json);
    let preSleepSatisfied = false;
    if (purpose === 'messages') {
      const now = Date.now();
      if (state.arrived) {
        // 等到了新消息：记录 observedAt，模型看过之后如果判断不参与，可以直接睡。
        social.preSleepWaitObservedAt = now;
        preSleepSatisfied = true;
      } else if (now - enteredAt >= preSleepWaitMs) {
        social.preSleepWaitSatisfiedAt = now;
        preSleepSatisfied = true;
      }
      db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?')
        .run(JSON.stringify(social), conversation.id);
    }
    const lastIncomingAt = Number(social.lastIncomingAt) || 0;
    const remainingMs = preSleepSatisfied
      ? 0
      : Math.max(0, preSleepWaitMs - (Date.now() - enteredAt));

    return {
      ok: true,
      arrived: state.arrived,
      quiet: state.quiet,
      newMessages: rows.map((row) => publicAgentMessage(row, db, conversation.id)),
      agentReadThroughSeq: conversation.agent_read_seq,
      timeout: timedOut,
      preSleepWaitSatisfied: preSleepSatisfied,
      preSleepWaitRemainingMs: remainingMs,
      preSleepWaitObservedAt: social.preSleepWaitObservedAt
        ? new Date(social.preSleepWaitObservedAt).toISOString()
        : null,
    };
  } finally {
    release();
  }
}

function postRead(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  const through = Number(body.throughSeq);
  if (!Number.isSafeInteger(through) || through < 0) {
    throw httpError(400, 'bad-request', 'throughSeq 必须是 >= 0 的整数');
  }
  const max = latestSeq(db, conversation.id);
  if (through > max) {
    throw httpError(400, 'bad-request', `throughSeq ${through} 超过最新 seq ${max}`);
  }
  // 水位只能推进到「真的被模型看过」的连续前缀。离线/测试模式没有 DSH，
  // 没有快照可记，此时保留旧语义：允许推进到最新。
  const ceiling = ctx.dsh ? contiguousSeenThrough(db, conversation.id) : max;
  const clampedThrough = Math.min(through, ceiling);
  // 只前进不后退：已读水位回退会让模型重复处理已经处理过的消息
  const next = Math.max(conversation.agent_read_seq, clampedThrough);
  if (next !== conversation.agent_read_seq) {
    db.prepare('UPDATE conversation SET agent_read_seq = ? WHERE id = ?').run(next, conversation.id);
  }
  ctx.social?.noteAction?.(conversation.id);
  return {
    ok: true,
    agentReadThroughSeq: next,
    clamped: clampedThrough < through,
    seenThroughSeq: ceiling,
  };
}

function postWakeConfig(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  const kind = conversation.kind === 'group' ? 'group' : 'direct';
  const now = Date.now();
  const current = normalizeWakeConfig(conversation.wake_config_json);
  const config = validateWakeConfigInput(body.config, current, { kind, now });

  // 沉睡前观察：群聊把潜水/下一次唤醒设成 sleep-like 之前，必须有一次观察记录。
  const preSleepWaitMs = Number(ctx.config?.social?.preSleepWaitMs) || 300_000;
  if (kind === 'group' && isSleepingConfig(config) && preSleepWaitMs > 0) {
    const social = normalizeSocialState(conversation.social_state_json);
    const last = db
      .prepare(
        `SELECT content_json FROM message
          WHERE conversation_id = ? AND role = 'user'
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(conversation.id);
    const lastText = last ? textOf(parseContent(last.content_json)) : '';
    const explicitEnd = hasExplicitEnd(lastText);
    const lastIncomingAt = Number(social.lastIncomingAt) || 0;
    const satisfied =
      (lastIncomingAt > 0 && now - lastIncomingAt >= preSleepWaitMs)
      || (social.preSleepWaitSatisfiedAt > 0
        && lastIncomingAt <= social.preSleepWaitSatisfiedAt)
      || (social.preSleepWaitObservedAt > 0
        && lastIncomingAt <= social.preSleepWaitObservedAt);
    if (!explicitEnd && !satisfied) {
      const remainingMs = lastIncomingAt
        ? Math.max(0, preSleepWaitMs - (now - lastIncomingAt))
        : preSleepWaitMs;
      const error = httpError(
        409,
        'pre_sleep_wait_required',
        '设置潜水前必须先完成沉睡前观察',
        {
          remainingMs,
          preSleepWaitMs,
          hint: `先调用 chat_wait(purpose="messages", timeoutMs=${preSleepWaitMs})；对方明确说晚安/拜拜/下了可跳过`,
        },
      );
      throw error;
    }
  }

  if (body.throughSeq !== undefined && body.throughSeq !== null) {
    const through = Number(body.throughSeq);
    const max = latestSeq(db, conversation.id);
    if (!Number.isSafeInteger(through) || through < 0 || through > max) {
      throw httpError(400, 'bad-request', 'throughSeq 越界');
    }
    const ceiling = ctx.dsh ? contiguousSeenThrough(db, conversation.id) : max;
    const next = Math.max(conversation.agent_read_seq, Math.min(through, ceiling));
    if (next > conversation.agent_read_seq) {
      db.prepare('UPDATE conversation SET agent_read_seq = ? WHERE id = ?')
        .run(next, conversation.id);
      conversation.agent_read_seq = next;
    }
  }
  // 落库：getPrompt 下一轮必须读到同一份配置，否则 chat_set_wake_config 设了等于没设。
  db.prepare('UPDATE conversation SET wake_config_json = ? WHERE id = ?')
    .run(JSON.stringify(config), conversation.id);
  conversation.wake_config_json = JSON.stringify(config);
  ctx.social?.noteAction?.(conversation.id);
  ctx.social?.ensureTimers?.(conversation.id);
  return {
    ok: true,
    kind,
    config,
    wakeSummary: wakeConfigSummary(config),
    nextWakeAt: config.infinite ? null : config.sleepUntil,
    agentReadThroughSeq: conversation.agent_read_seq,
  };
}

function postMemory(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  const kind = String(body.kind ?? '');
  if (!MEMORY_KINDS.has(kind)) {
    throw httpError(400, 'bad-request', 'kind 必须是 topic|thought|impression');
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw httpError(400, 'bad-request', 'text 必填');
  if (text.length > MAX_MEMORY_CHARS) {
    throw httpError(400, 'bad-request', `text 上限 ${MAX_MEMORY_CHARS} 字符`);
  }
  const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : null;
  const now = nowMs();
  if (key) {
    // 带 key 是覆盖语义：同一个 (kind, key) 只有一条，模型可以反复更新同一条印象
    const prev = db.prepare(
      'SELECT id, created_at FROM agent_memory WHERE conversation_id = ? AND kind = ? AND key = ?',
    ).get(conversation.id, kind, key);
    if (prev) {
      db.prepare('UPDATE agent_memory SET value = ?, updated_at = ? WHERE id = ?')
        .run(text, now, prev.id);
      if (kind === 'thought') ctx.social?.addPendingThought?.(conversation.id, text);
      return {
        ok: true,
        id: prev.id,
        key,
        createdAt: new Date(prev.created_at).toISOString(),
        overwritten: true,
      };
    }
  }
  const info = db.prepare(
    `INSERT INTO agent_memory (conversation_id, kind, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(conversation.id, kind, key, text, now, now);
  if (kind === 'thought') ctx.social?.addPendingThought?.(conversation.id, text);
  return {
    ok: true,
    id: Number(info.lastInsertRowid),
    key,
    createdAt: new Date(now).toISOString(),
  };
}

function getMemory(ctx, { conversation }, url) {
  const db = ctx.dbState.db;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw === '' ? 20 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw httpError(400, 'bad-request', 'limit 必须是 1~50 的整数');
  }
  const clauses = ['conversation_id = ?'];
  const params = [conversation.id];
  const kind = url.searchParams.get('kind');
  if (kind) {
    if (!MEMORY_KINDS.has(kind)) throw httpError(400, 'bad-request', 'kind 不合法');
    clauses.push('kind = ?');
    params.push(kind);
  }
  const q = url.searchParams.get('query');
  if (q) {
    clauses.push('value LIKE ?');
    params.push(`%${q}%`);
  }
  const rows = db.prepare(
    `SELECT id, kind, key, value, created_at, updated_at FROM agent_memory
      WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`,
  ).all(...params, limit);
  return {
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      text: r.value,
      key: r.key,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

function deleteMemory(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  if (body.id !== undefined && body.id !== null) {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id)) throw httpError(400, 'bad-request', 'id 必须是整数');
    const info = db.prepare('DELETE FROM agent_memory WHERE id = ? AND conversation_id = ?')
      .run(id, conversation.id);
    if (info.changes !== 1) throw httpError(404, 'memory-not-found', `记忆 ${id} 不存在`);
    return { ok: true, removed: 1 };
  }
  if (body.key) {
    const kind = body.kind ? String(body.kind) : null;
    if (kind && !MEMORY_KINDS.has(kind)) throw httpError(400, 'bad-request', 'kind 不合法');
    const info = kind
      ? db.prepare('DELETE FROM agent_memory WHERE conversation_id = ? AND key = ? AND kind = ?')
        .run(conversation.id, String(body.key), kind)
      : db.prepare('DELETE FROM agent_memory WHERE conversation_id = ? AND key = ?')
        .run(conversation.id, String(body.key));
    if (info.changes === 0) throw httpError(404, 'memory-not-found', '没有匹配的记忆');
    return { ok: true, removed: Number(info.changes) };
  }
  if (body.kind) {
    if (!MEMORY_KINDS.has(body.kind)) throw httpError(400, 'bad-request', 'kind 不合法');
    // 按 kind 一次抹掉几十条是不可逆的，必须显式确认
    if (body.confirm !== true) {
      throw httpError(400, 'bad-request', '按 kind 批量删除必须带 confirm: true');
    }
    const info = db.prepare('DELETE FROM agent_memory WHERE conversation_id = ? AND kind = ?')
      .run(conversation.id, body.kind);
    return { ok: true, removed: Number(info.changes) };
  }
  throw httpError(400, 'bad-request', '需要 id、key 或 kind 之一');
}

function isTextual(mediaType, localPath) {
  if (/^text\//i.test(mediaType)) return true;
  return /\.(md|json|log|txt|csv|ya?ml|js|mjs|ts|tsx|py|sh|ini|cfg|html?|css)$/i.test(localPath);
}

function getAttachment(ctx, { conversation }, attachmentId, url) {
  const db = ctx.dbState.db;
  const att = db.prepare(
    `SELECT id, conversation_id, kind, name, media_type, bytes, local_path
       FROM attachment WHERE id = ?`,
  ).get(attachmentId);
  if (!att) throw httpError(404, 'attachment-not-found', '附件不存在');
  // 按 attachment.conversation_id 直接判归属，不 join message：
  // 草稿态附件的 message_id 是 NULL，join 会把「还没发出去」判成「不存在」。
  if (att.conversation_id !== conversation.id) {
    throw httpError(403, 'attachment-forbidden', '附件不属于本会话');
  }

  // 附件根跟 workspace 同一个会话目录：<root>/conversations/<id>/attachments/
  // 计划第 937 行规定 local_path 只能是 <root>/conversations/<id>/... 下的路径。
  const root = path.resolve(ctx.workspaceRoot, 'conversations', conversation.id, 'attachments');
  const resolved = path.resolve(att.local_path);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(403, 'attachment-forbidden', '附件路径越界');
  }
  if (!fs.existsSync(resolved)) throw httpError(404, 'attachment-not-found', '附件文件已丢失');

  // 词法检查挡不住 root 里的 symlink 指到外面，realpath 之后再量一次。
  // root 本身也要 realpath——workspace 目录自己可能是软链。
  let realPath;
  let realRoot;
  try {
    realPath = fs.realpathSync(resolved);
    realRoot = fs.realpathSync(root);
  } catch {
    throw httpError(404, 'attachment-not-found', '附件文件已丢失');
  }
  const realRelative = path.relative(realRoot, realPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw httpError(403, 'attachment-forbidden', '附件路径越界（symlink）');
  }

  const offsetRaw = url.searchParams.get('offset');
  const offset = offsetRaw === null || offsetRaw === '' ? 0 : Number(offsetRaw);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw httpError(400, 'bad-request', 'offset 必须是非负整数');
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw === '' ? 65_536 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 262_144) {
    throw httpError(400, 'bad-request', 'limit 必须在 1~262144 之间');
  }

  // 只读需要的那一段，不把整个文件读进内存——手机截屏动辄几 MB，
  // readFileSync 之后 subarray 等于把峰值内存翻倍。
  const fd = fs.openSync(realPath, 'r');
  let size;
  let slice;
  try {
    size = fs.fstatSync(fd).size;
    const want = Math.max(0, Math.min(limit, size - offset));
    slice = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const got = fs.readSync(fd, slice, read, want - read, offset + read);
      if (got === 0) break;
      read += got;
    }
    if (read < want) slice = slice.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }

  const eof = offset + slice.length >= size;
  const payload = {
    ok: true,
    attachmentId: att.id,
    name: att.name || path.basename(resolved),
    mimeType: att.media_type,
    size,
    offset,
    truncated: !eof,
    eof,
  };
  if (isTextual(att.media_type, resolved)) payload.text = slice.toString('utf8');
  else payload.data = slice.toString('base64');
  if (/^image\//i.test(att.media_type || '')) {
    try {
      const headFd = fs.openSync(realPath, 'r');
      let head;
      try {
        const want = Math.min(size, 512 * 1024);
        head = Buffer.allocUnsafe(want);
        const got = fs.readSync(headFd, head, 0, want, 0);
        head = head.subarray(0, got);
      } finally {
        fs.closeSync(headFd);
      }
      const dims = imageSize(head);
      if (dims) {
        payload.width = dims.width;
        payload.height = dims.height;
      }
    } catch {
      // 尺寸只是展示信息，读不到就不带。
    }
  }
  return payload;
}

function botProfileView(ctx) {
  const settings = loadBotSettings(ctx.dbState.db);
  return {
    ok: true,
    profile: {
      name: settings.aiName || '汐语',
      signature: settings.aiSignature || '',
      hasAvatar: Boolean(settings.aiAvatar),
    },
  };
}

function updateBotProfile(ctx, { conversation }, body) {
  const db = ctx.dbState.db;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(conversation.user_id);
  if (!user || user.role !== 'admin') {
    throw httpError(403, 'profile-forbidden', '只有 owner 可以修改汐语的公开资料');
  }
  if (conversation.kind !== 'direct') {
    throw httpError(403, 'profile-forbidden', '群聊不能修改汐语的公开资料');
  }

  const patch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') throw httpError(400, 'bad-request', 'name 必须是字符串');
    const name = body.name.trim();
    if (!name || name.length > 40) throw httpError(400, 'bad-request', 'name 必须是 1~40 字');
    patch.aiName = name;
  }
  if (body.signature !== undefined) {
    if (typeof body.signature !== 'string') {
      throw httpError(400, 'bad-request', 'signature 必须是字符串');
    }
    const signature = body.signature.trim();
    if (signature.length > 200) throw httpError(400, 'bad-request', 'signature 最多 200 字');
    patch.aiSignature = signature;
  }
  if (body.avatar !== undefined) {
    if (typeof body.avatar !== 'string') {
      throw httpError(400, 'bad-request', 'avatar 必须是 data URI 字符串');
    }
    const avatar = body.avatar.trim();
    if (avatar && !avatar.startsWith('data:image/')) {
      throw httpError(400, 'bad-request', 'avatar 必须是 data:image/... base64 URI');
    }
    if (avatar.length > 500_000) {
      throw httpError(400, 'bad-request', 'avatar data URI 最多 500000 字符');
    }
    if (avatar) {
      const comma = avatar.indexOf(',');
      if (comma < 0 || avatar.length - comma < 8) {
        throw httpError(400, 'bad-request', 'avatar data URI 缺少 base64 内容');
      }
      try {
        const bytes = Buffer.from(avatar.slice(comma + 1), 'base64');
        if (bytes.length < 16) throw new Error('empty');
      } catch {
        throw httpError(400, 'bad-request', 'avatar base64 内容不合法');
      }
    }
    patch.aiAvatar = avatar;
  }
  if (Object.keys(patch).length === 0) {
    throw httpError(400, 'bad-request', '至少要改 name、signature 或 avatar 之一');
  }
  saveBotSettings(db, patch);
  return botProfileView(ctx);
}

// ── 路由 ────────────────────────────────────────────────────────────────

export async function handleAgent(req, res, url, ctx) {
  const rest = url.pathname.split('/').filter(Boolean).slice(1);
  if (rest.length === 1 && rest[0] === 'voice' && req.method === 'POST') {
    return sendJson(res, 200, await postAgentVoice(ctx, req));
  }
  // 先鉴权再读 body：未授权的请求不该先把 1MB 打进来
  const auth = resolveConversation(ctx, req);

  if (rest.length === 1) {
    const name = rest[0];
    if (req.method === 'GET' && name === 'prompt') {
      return sendJson(res, 200, getPrompt(ctx, auth));
    }
    if (req.method === 'GET' && name === 'messages') {
      return sendJson(res, 200, getMessages(ctx, auth, url));
    }
    if (req.method === 'GET' && name === 'stickers') {
      return sendJson(res, 200, getAgentStickers(ctx, auth, url));
    }
    if (req.method === 'POST' && name === 'messages') {
      return sendJson(res, 200, postMessages(ctx, auth, await readJson(req)));
    }
    if (req.method === 'POST' && name === 'wait') {
      return sendJson(res, 200, await postWait(ctx, auth, await readJson(req)));
    }
    if (req.method === 'POST' && name === 'read') {
      return sendJson(res, 200, postRead(ctx, auth, await readJson(req)));
    }
    if (req.method === 'POST' && name === 'moments') {
      return sendJson(res, 201, createMomentForAgent(ctx, auth.conversation, await readJson(req)));
    }
    if (req.method === 'POST' && name === 'wake-config') {
      return sendJson(res, 200, postWakeConfig(ctx, auth, await readJson(req)));
    }
    if (name === 'memory') {
      if (req.method === 'POST') {
        return sendJson(res, 200, postMemory(ctx, auth, await readJson(req)));
      }
      if (req.method === 'GET') return sendJson(res, 200, getMemory(ctx, auth, url));
      if (req.method === 'DELETE') {
        return sendJson(res, 200, deleteMemory(ctx, auth, await readJson(req)));
      }
    }
    if (name === 'profile') {
      if (req.method === 'GET') return sendJson(res, 200, botProfileView(ctx));
      if (req.method === 'POST') {
        return sendJson(res, 200, updateBotProfile(ctx, auth, await readJson(req)));
      }
    }
    return sendError(res, 404, 'not-found', 'agent route not found');
  }

  if (rest.length === 3 && rest[0] === 'attachments' && rest[2] === 'content' && req.method === 'GET') {
    return sendJson(res, 200, getAttachment(ctx, auth, rest[1], url));
  }

  return sendError(res, 404, 'not-found', 'agent route not found');
}

function resolveVoiceConversation(ctx, req) {
  if (req.headers['x-agent-token']) return resolveConversation(ctx, req).conversation;
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw httpError(401, 'token-missing', '缺少 Bearer agent token');
  const token = match[1].trim();
  const row = ctx.dbState.db.prepare(
    `SELECT id, kind, user_id, summary, policy, agent_token, agent_read_seq, dsh_session_id,
            wake_config_json, social_state_json
       FROM conversation WHERE agent_token = ? AND deleted_at IS NULL`,
  ).get(token);
  if (!row) throw httpError(401, 'token-invalid', 'agent token 不存在或已失效');
  const rebuild = ctx.dbState.db.prepare(
    `SELECT state FROM rebuild_queue
      WHERE conversation_id = ? AND state IN ('pending','failed') LIMIT 1`,
  ).get(row.id);
  if (rebuild) {
    throw httpError(403, 'conversation-closed', '会话正在重建，当前 token 即将失效', {
      rebuild_state: rebuild.state,
    });
  }
  return row;
}

async function postAgentVoice(ctx, req) {
  const conversation = resolveVoiceConversation(ctx, req);
  const body = await readJson(req, 5_000_000);
  const requested = body.conversationId ? String(body.conversationId) : conversation.id;
  if (requested !== conversation.id) {
    throw httpError(403, 'conversation-mismatch', 'conversationId 不属于这个 agent token');
  }
  return storeAgentVoice(ctx, conversation, body);
}
