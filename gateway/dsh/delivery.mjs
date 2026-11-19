/**
 * 消息/唤醒的统一投递层。
 *
 * 从 routes/conversations.mjs 抽出来，是因为 M4.5 的定时唤醒（replyCheck /
 * proactiveCheck / timeout）也要走同一条 session、turn_end、assistant 回捞与已读水位路径。
 */

import path from 'node:path';
import { nowMs } from '../db/index.mjs';
import {
  advanceReadPrefix,
  markSeen,
  parseContent,
} from '../messages.mjs';
import { buildConversationPrompt, voiceMarker } from '../social/prompt.mjs';
import { normalizeSocialState, normalizeWakeConfig } from '../social/wake.mjs';
import { loadBotSettings } from '../settings.mjs';
import { advanceCursorAfterRecap } from './session-cursor.mjs';
import { admitImage } from './images.mjs';
import { canReadStickerAttachment } from '../stickers.mjs';

const sessionLocks = new Map();

export function conversationRow(ctx, id) {
  return ctx.dbState.db
    .prepare(
      `SELECT id, kind, user_id, title, summary, created_at, updated_at, dsh_session_id,
              dsh_workspace_id, dsh_after_seq, agent_token, policy, agent_read_seq,
              wake_config_json, social_state_json
         FROM conversation WHERE id = ?`,
    )
    .get(id);
}

export async function ensureDshSession(ctx, conversation) {
  if (conversation.dsh_session_id) return conversation.dsh_session_id;
  if (!ctx.dsh) return null;
  if (!conversation.dsh_workspace_id) {
    const error = new Error('会话缺少 dsh_workspace_id，无法投递到 DSH');
    error.status = 503;
    error.code = 'gateway-unavailable';
    throw error;
  }
  let pending = sessionLocks.get(conversation.id);
  if (!pending) {
    pending = (async () => {
      const preset = conversation.policy === 'owner' ? 'tide-owner' : 'tide';
      const created = await ctx.dsh.createSession({
        preset,
        workspaceId: conversation.dsh_workspace_id,
      });
      if (!created?.sessionId) throw new Error('session/create 没有返回 sessionId');
      ctx.dbState.db
        .prepare('UPDATE conversation SET dsh_session_id = ?, recap_at = NULL WHERE id = ?')
        .run(created.sessionId, conversation.id);
      const historyCount = Number(
        ctx.dbState.db
          .prepare('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?')
          .get(conversation.id)?.n ?? 0,
      );
      let recapSent = false;
      if (historyCount > 1) {
        try {
          const recap = await ctx.dsh.recap(created.sessionId);
          recapSent = recap?.sent === true;
          ctx.dbState.db
            .prepare('UPDATE conversation SET recap_at = ? WHERE id = ?')
            .run(nowMs(), conversation.id);
        } catch (error) {
          ctx.logger?.warn?.(`[prompt] recap 失败（不阻塞首条消息）: ${error?.message ?? error}`);
        }
      }
      await advanceCursorAfterRecap({
        dsh: ctx.dsh,
        db: ctx.dbState.db,
        conversationId: conversation.id,
        sessionId: created.sessionId,
        recapSent,
        logger: ctx.logger,
        shouldStop: () => ctx.stopping,
      });
      conversation.dsh_session_id = created.sessionId;
      return created.sessionId;
    })();
    sessionLocks.set(conversation.id, pending);
    try {
      return await pending;
    } finally {
      sessionLocks.delete(conversation.id);
    }
  }
  return pending;
}

function markPromptSeen(ctx, conversation, seqs) {
  if (!Array.isArray(seqs) || seqs.length === 0) return;
  markSeen(ctx.dbState.db, conversation.id, seqs);
  const next = advanceReadPrefix(ctx.dbState.db, conversation.id);
  conversation.agent_read_seq = next;
}

/**
 * turn 结束后只推进 DSH 读游标，不发布 assistant 最终回答。
 *
 * 汐语协议里用户可见内容只有一个出口：`chat_send`。DSH 的 assistant/message
 * 是模型最终回答，常混着「我先等着」「安静收尾」「这条不另外发」这类过程旁白；
 * 把它当兜底正文发布，会把内心独白泄露到聊天里。真实回复在工具调用时已经落库，
 * 这里只需越过本 turn 的记录，避免下次重复读取。
 */
export async function pullAssistantMessages(ctx, conversation, sessionId) {
  if (!sessionId || typeof ctx.dsh?.readMessages !== 'function') return { unsent: [] };
  let rows;
  const watermark = Number(
    ctx.dbState.db
      .prepare('SELECT dsh_after_seq FROM conversation WHERE id = ?')
      .get(conversation.id)?.dsh_after_seq ?? 0,
  ) || 0;
  try {
    rows = await ctx.dsh.readMessages(sessionId, { afterSeq: watermark, maxMessages: 20 });
  } catch (error) {
    ctx.logger?.warn?.(`[tide] 拉取 DSH 消息失败: ${error?.message ?? error}`);
    return { unsent: [] };
  }
  if (rows.length === 0) return { unsent: [] };
  const unsentByTurn = new Map();
  for (const row of rows) {
    if (row.role !== 'assistant' || !row.text || row.chatSent) continue;
    const turn = row.turn ?? 'unknown';
    const text = String(row.text).replace(/\s+/g, ' ').trim();
    const current = unsentByTurn.get(turn);
    if (current) {
      current.count += 1;
      current.body = `${current.body}\n${text}`.slice(0, 4000);
      continue;
    }
    unsentByTurn.set(turn, {
      count: 1,
      sample: text.slice(0, 60),
      body: text.slice(0, 4000),
    });
  }
  for (const [turn, info] of unsentByTurn) {
    ctx.logger?.warn?.(
      `[tide] assistant 文本未经 chat_send 发出: conv=${conversation.id} turn=${turn} count=${info.count} sample=${info.sample}`,
    );
  }
  const newest = rows.reduce((max, row) => (row.seq > max ? row.seq : max), watermark);
  if (newest > watermark) {
    ctx.dbState.db
      .prepare('UPDATE conversation SET dsh_after_seq = ? WHERE id = ?')
      .run(newest, conversation.id);
  }
  return { unsent: [...unsentByTurn.values()] };
}

const INTERNAL_NARRATION_RE =
  /(我先等|安静收尾|不再输出|不另外发|已读水位|不发了|等主人回来|还没接话|这次什么都不写)/;

function shouldRescueUnsent(info) {
  const text = String(info?.body ?? '').trim();
  if (text.length < 2) return false;
  if (/^[。…\.!！?？\s]+$/.test(text)) return false;
  return !INTERNAL_NARRATION_RE.test(text);
}

async function rescueUnsentText(ctx, conversation, sessionId, items) {
  if (ctx.stopping || !ctx.dsh?.prompt) return false;
  const pending = items.map((item) => item.body).join('\n').slice(0, 4000);
  const prompt = [
    '【系统纠错】你上一轮没有调用 chat_send，聊天界面没有收到任何内容。',
    '现在不要用最终回答代替发送。如果你本来想回复，必须调用 mcp__tide__chat_send。',
    `【会话令牌】${conversation.agent_token}`,
    '你上一轮未发送的正文仅供改写参考，不要原样复述这条纠错提示：',
    pending,
  ].join('\n');
  try {
    ctx.logger?.warn?.(
      `[tide] 触发一次 chat_send 纠错: conv=${conversation.id} chars=${pending.length}`,
    );
    await ctx.dsh.prompt(sessionId, [{ type: 'text', text: prompt }], { mode: 'queue' });
    await ctx.dsh.waitTurnEnd(sessionId, 5 * 60 * 1000);
    await pullAssistantMessages(ctx, conversation, sessionId);
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`[tide] chat_send 纠错失败: ${error?.message ?? error}`);
    return false;
  }
}

function gatewayDeliveryError(error, clientMsgId) {
  const wrapped = new Error(`消息已保存，但投递 DSH 失败: ${error?.message ?? error}`);
  wrapped.status = 503;
  wrapped.code = 'gateway-unavailable';
  wrapped.extra = {
    client_msg_id: clientMsgId,
    queued: true,
    turn_started: false,
    delivered: false,
    retryable: true,
  };
  return wrapped;
}

function promptConfig(conversation) {
  return {
    wakeConfig: normalizeWakeConfig(conversation.wake_config_json),
    socialState: normalizeSocialState(conversation.social_state_json),
  };
}

const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_TOTAL_BYTES = 24 * 1024 * 1024;
const IMAGE_MAX_COUNT = 4;

function attachmentPathAllowed(ctx, conversationId, resolved) {
  const root = path.resolve(ctx.workspaceRoot, 'conversations', conversationId, 'attachments');
  const relative = path.relative(root, resolved);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 收集这轮要带给模型的图片块。
 *
 * 返回 { blocks, notes }：blocks 只含 prompt schema 允许的字段
 * （type/mediaType/data/name），失败或超限的写进 notes 由调用方拼到文字块里。
 * 表情包附件属于来源会话，用 canReadStickerAttachment 放行，不按当前会话硬卡。
 */
export function collectImageBlocks(ctx, conversation) {
  const db = ctx.dbState.db;
  const rows = db.prepare(
    `SELECT id, seq, content_json FROM message
      WHERE conversation_id = ? AND role = 'user' AND seq > ?
      ORDER BY seq ASC LIMIT 30`,
  ).all(conversation.id, Number(conversation.agent_read_seq) || 0);
  const ids = [];
  for (const row of rows) {
    const content = parseContent(row.content_json);
    if (!Array.isArray(content?.attachments)) continue;
    for (const id of content.attachments) {
      if (typeof id !== 'string' || !id) continue;
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= IMAGE_MAX_COUNT) break;
    }
    if (ids.length >= IMAGE_MAX_COUNT) break;
  }

  const blocks = [];
  const notes = [];
  let totalBytes = 0;
  for (const id of ids) {
    const row = db.prepare(
      `SELECT id, conversation_id, name, media_type, bytes, local_path
         FROM attachment WHERE id = ?`,
    ).get(String(id));
    if (!row || !/^image\//i.test(row.media_type || '')) continue;
    const allowed = row.conversation_id === conversation.id
      || canReadStickerAttachment(db, conversation.user_id, row.id);
    if (!allowed) continue;
    const resolved = path.resolve(row.local_path);
    if (!attachmentPathAllowed(ctx, row.conversation_id, resolved)) {
      ctx.logger?.warn?.(`[prompt] 图片路径越界 ${row.id}`);
      notes.push(`［图片 ${row.name || row.id} 暂时无法查看］`);
      continue;
    }
    const name = row.name || path.basename(resolved);
    if (Number(row.bytes) > IMAGE_MAX_BYTES) {
      notes.push(`［图片 ${name} 太大，暂时无法查看］`);
      continue;
    }
    if (totalBytes + Number(row.bytes) > IMAGE_TOTAL_BYTES) {
      notes.push(`［图片 ${name} 太多，暂时无法查看］`);
      continue;
    }
    try {
      const prepared = admitImage({
        path: resolved,
        mediaType: row.media_type,
        name,
        maxBytes: IMAGE_MAX_BYTES,
      });
      totalBytes += prepared.bytes;
      blocks.push({
        type: 'image',
        mediaType: prepared.mediaType,
        data: prepared.data,
        ...(prepared.name ? { name: prepared.name } : {}),
      });
      ctx.logger?.info?.(
        `[prompt] 图片就绪 ${name} ${prepared.width}x${prepared.height} ${Math.round(prepared.bytes / 1024)}KB ${prepared.prepareMs}ms`,
      );
    } catch (error) {
      ctx.logger?.warn?.(`[prompt] 图片准备失败 ${row.id}: ${error?.message ?? error}`);
      notes.push(`［图片 ${name} 暂时无法查看］`);
    }
  }
  return { blocks, notes };
}

export function imageBlocksForUnread(ctx, conversation) {
  return collectImageBlocks(ctx, conversation).blocks;
}

async function startTurn(ctx, conversation, text, {
  requestMessageId,
  seenSeqs,
  wakeReason,
  imageBlocks = [],
}) {
  const sessionId = await ensureDshSession(ctx, conversation);
  if (!sessionId) throw new Error('没有可用的 DSH session');
  const content = [{ type: 'text', text }, ...imageBlocks];

  let requestId;
  let activeSessionId = sessionId;
  try {
    ({ requestId } = await ctx.dsh.prompt(
      sessionId,
      content,
      { mode: 'queue' },
    ));
  } catch (error) {
    if (error?.code !== 'session/not-found') throw error;
    const hadSession = Boolean(conversation.dsh_session_id);
    ctx.dbState.db
      .prepare('UPDATE conversation SET dsh_session_id = NULL, recap_at = NULL WHERE id = ?')
      .run(conversation.id);
    conversation.dsh_session_id = null;
    const nextSession = await ensureDshSession(ctx, conversation);
    activeSessionId = nextSession;
    if (hadSession) {
      const epoch = ctx.dbState.db
        .prepare('SELECT epoch FROM conversation WHERE id = ?')
        .get(conversation.id).epoch;
      const latestSeq = ctx.dbState.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?')
        .get(conversation.id).m;
      try {
        ctx.events?.publish?.(conversation.id, {
          v: 1,
          type: 'conversation.rebuilt',
          conversationId: conversation.id,
          epoch,
          seq: latestSeq,
          reason: 'session-not-found',
          createdAt: new Date().toISOString(),
        });
      } catch (publishError) {
        ctx.logger?.warn?.(`[prompt] rebuilt 事件失败: ${publishError?.message ?? publishError}`);
      }
    }
    ({ requestId } = await ctx.dsh.prompt(
      nextSession,
      content,
      { mode: 'queue' },
    ));
  }
  if (requestMessageId) {
    ctx.dbState.db
      .prepare('UPDATE message SET dsh_turn = ? WHERE id = ?')
      .run(requestId, requestMessageId);
  }
  markPromptSeen(ctx, conversation, seenSeqs);
  ctx.social?.clearReminder?.(conversation.id);
  ctx.events?.publish?.(conversation.id, {
    type: 'turn_start',
    at: new Date().toISOString(),
    requestId,
  });

  void ctx.dsh
    .waitTurnEnd(activeSessionId, 15 * 60 * 1000)
    .then(async (ended) => {
      const pulled = await pullAssistantMessages(ctx, conversation, activeSessionId);
      if (
        ctx.config?.sendRescue
        && wakeReason === 'private'
        && conversation.kind !== 'group'
        && pulled.unsent.some(shouldRescueUnsent)
      ) {
        await rescueUnsentText(ctx, conversation, activeSessionId, pulled.unsent);
      }
      await ctx.social?.onTurnEnd?.(conversation.id);
      ctx.events?.publish?.(conversation.id, {
        type: 'turn_end',
        at: new Date().toISOString(),
        requestId,
        reason: ended ? 'completed' : 'timeout',
      });
    })
    .catch(async (error) => {
      await ctx.social?.onTurnEnd?.(conversation.id);
      ctx.events?.publish?.(conversation.id, {
        type: 'turn_end',
        at: new Date().toISOString(),
        requestId,
        reason: 'error',
        error: String(error?.message ?? error),
      });
    });
  return { requestId, wakeReason };
}

export async function deliverPrompt(ctx, conversation, messageRow, { duplicated }) {
  const clientMsgId = messageRow.client_msg_id;
  if (!ctx.dsh) {
    return {
      client_msg_id: clientMsgId,
      queued: true,
      turn_started: false,
      delivered: false,
      duplicated,
    };
  }
  const content = parseContent(messageRow.content_json);
  const text = typeof content?.text === 'string' ? content.text : '';
  const stickerName = typeof content?.sticker?.name === 'string' ? content.sticker.name : '';
  const { wakeConfig, socialState } = promptConfig(conversation);
  const settings = loadBotSettings(ctx.dbState.db);
  const prompt = buildConversationPrompt({
    db: ctx.dbState.db,
    conversation,
    wakeConfig,
    socialState,
    reason: messageRow.wake_reason || (conversation.kind === 'group' ? null : 'private'),
    noActionLimit: ctx.config?.social?.noActionLimit ?? 3,
    personaOverride: settings.personaOverride,
    incoming: {
      text: `${voiceMarker(content)}${stickerName ? `［表情包：${stickerName}］ ` : ''}${text}`,
      senderName: messageRow.sender_name || (conversation.kind === 'group' ? '群成员' : '主人'),
    },
  });
  ctx.social?.beginTurn?.(conversation.id);
  try {
    const images = collectImageBlocks(ctx, conversation);
    const promptText = images.notes.length
      ? `${prompt.text}\n${images.notes.join('\n')}`
      : prompt.text;
    const started = await startTurn(ctx, conversation, promptText, {
      requestMessageId: messageRow.id,
      seenSeqs: prompt.seenSeqs,
      wakeReason: messageRow.wake_reason || 'private',
      imageBlocks: images.blocks,
    });
    return {
      client_msg_id: clientMsgId,
      queued: true,
      turn_started: true,
      delivered: true,
      duplicated,
      wake_reason: started.wakeReason,
    };
  } catch (error) {
    ctx.social?.endTurn?.(conversation.id);
    throw gatewayDeliveryError(error, clientMsgId);
  }
}

/**
 * 定时唤醒（replyCheck / proactiveCheck / timeout）没有对应的新消息行。
 * 失败直接抛给 engine，由它决定是否记录/重试。
 */
export async function deliverWakePrompt(ctx, conversation, reason) {
  if (!ctx.dsh) return { ok: false, reason: 'no-dsh' };
  const { wakeConfig, socialState } = promptConfig(conversation);
  const settings = loadBotSettings(ctx.dbState.db);
  const prompt = buildConversationPrompt({
    db: ctx.dbState.db,
    conversation,
    wakeConfig,
    socialState,
    reason,
    noActionLimit: ctx.config?.social?.noActionLimit ?? 3,
    personaOverride: settings.personaOverride,
    incoming: null,
  });
  ctx.social?.beginTurn?.(conversation.id);
  try {
    const images = collectImageBlocks(ctx, conversation);
    const promptText = images.notes.length
      ? `${prompt.text}\n${images.notes.join('\n')}`
      : prompt.text;
    const started = await startTurn(ctx, conversation, promptText, {
      requestMessageId: null,
      seenSeqs: prompt.seenSeqs,
      wakeReason: reason,
      imageBlocks: images.blocks,
    });
    return { ok: true, requestId: started.requestId };
  } catch (error) {
    ctx.social?.endTurn?.(conversation.id);
    throw error;
  }
}
