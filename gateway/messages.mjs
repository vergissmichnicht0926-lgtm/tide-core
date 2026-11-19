/**
 * message 的共享读写：公开形状、批量校验/落库、已读水位。
 *
 * 之前这些函数散在 routes/agent.mjs 与 routes/conversations.mjs 里，M4.5 的
 * social engine 还要用一次发送队列，所以抽成不依赖路由的模块，避免循环引用。
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { nextSeq, nowMs, withTransaction } from './db/index.mjs';
import { bumpUsageAssistant, localDay } from './settings.mjs';

export const MAX_BATCH_MESSAGES = 8;
export const MAX_MESSAGE_CHARS = 500;
export const MAX_SEGMENTS = 4;
export const MAX_SEGMENT_CHARS = 2000;
export const MAX_SEND_PER_MINUTE = 8;
export const MAX_SEND_PER_HOUR = 60;

export const DEFAULT_SEND_PACING = Object.freeze({
  minMs: 1000,
  maxMs: 3000,
  longMinMs: 5000,
  longMaxMs: 10_000,
  longProbability: 0.2,
});

export const MESSAGE_COLUMNS =
  'id, seq, role, content_json, created_at, client_msg_id, wake_reason, sender_user_id, sender_name, mentions, recalled_at';

/** 引用条需要的原消息摘要；原消息被撤回时只留「消息已撤回」。 */
export function replyPreview(db, conversationId, messageId) {
  const row = db
    .prepare(
      `SELECT id, role, content_json, sender_name, sender_user_id, recalled_at
         FROM message WHERE id = ? AND conversation_id = ?`,
    )
    .get(messageId, conversationId);
  if (!row) return null;
  const recalled = Boolean(row.recalled_at);
  const text = recalled ? '' : textOf(parseContent(row.content_json));
  return {
    id: row.id,
    role: row.role,
    senderName: row.sender_name ?? null,
    senderUserId: row.sender_user_id ?? null,
    text: text.length > 60 ? `${text.slice(0, 60)}…` : text,
    recalled,
  };
}

export function parseContent(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { type: 'text', text };
  }
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (Array.isArray(content.content)) {
    return content.content
      .map((block) => (block?.type === 'text' ? String(block.text ?? '') : '[图片]'))
      .join('');
  }
  return '';
}

/**
 * 对外消息形状。`content_json.attachments` 存的是附件 id 数组，
 * 这里展开成 {id, name, mimeType, size}。
 */
export function publicAgentMessage(row, db, conversationId) {
  const content = parseContent(row.content_json);
  const recalled = Boolean(row.recalled_at);
  const ids = Array.isArray(content?.attachments)
    ? content.attachments.filter((id) => typeof id === 'string' && id)
    : [];
  const attachments = ids.length
    ? db
        .prepare(
          `SELECT id, COALESCE(name, '') AS name, media_type AS mimeType, bytes AS size, local_path
             FROM attachment
            WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})
            ORDER BY rowid`,
        )
        .all(conversationId, ...ids)
        .map((a) => ({
          id: a.id,
          name: a.name || path.basename(a.local_path),
          mimeType: a.mimeType,
          size: a.size,
        }))
    : [];
  if (content?.sticker?.id) {
    const stickerAttachment = db.prepare(
      `SELECT a.id, COALESCE(a.name, '') AS name, a.media_type AS mimeType,
              a.bytes AS size, a.local_path
         FROM sticker s
         JOIN attachment a ON a.id = s.attachment_id
        WHERE s.id = ?`,
    ).get(content.sticker.id);
    if (stickerAttachment && !attachments.some((item) => item.id === stickerAttachment.id)) {
      attachments.push({
        id: stickerAttachment.id,
        name: stickerAttachment.name || path.basename(stickerAttachment.local_path),
        mimeType: stickerAttachment.mimeType,
        size: stickerAttachment.size,
      });
    }
  }
  return {
    id: row.id,
    clientMsgId: row.client_msg_id ?? null,
    seq: row.seq,
    role: row.role,
    text: recalled ? '' : textOf(content),
    createdAt: new Date(row.created_at).toISOString(),
    attachments,
    sticker: content?.sticker ?? null,
    voice: content?.voice ?? null,
    replyToMessageId: content?.replyToMessageId ?? null,
    replyTo: content?.replyToMessageId
      ? replyPreview(db, conversationId, content.replyToMessageId)
      : null,
    recalled,
    wakeReason: row.wake_reason ?? null,
    senderUserId: row.sender_user_id ?? null,
    senderName: row.sender_name ?? null,
    mentions: parseMentions(row.mentions),
  };
}

function parseMentions(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item).slice(0, 50)
      : [];
  } catch {
    return [];
  }
}

/** 按 id 取一条完整公开消息；SSE 事件体统一走这里。 */
export function eventMessage(db, conversationId, messageId) {
  const row = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM message
        WHERE id = ? AND conversation_id = ?`,
    )
    .get(messageId, conversationId);
  return row ? publicAgentMessage(row, db, conversationId) : null;
}

/**
 * 条间节奏：第一条立即发，之后每条 1~3 秒；20% 走 5~10 秒长间隔。
 * 返回数组的第 i 项是「第 i 条之前要等多久」。
 */
export function planSendDelays(count, options = {}) {
  const pacing = { ...DEFAULT_SEND_PACING, ...(options || {}) };
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const minMs = Math.max(0, Number(pacing.minMs) || 0);
  const maxMs = Math.max(minMs, Number(pacing.maxMs) || minMs);
  const longMinMs = Math.max(maxMs, Number(pacing.longMinMs) || maxMs);
  const longMaxMs = Math.max(longMinMs, Number(pacing.longMaxMs) || longMinMs);
  const longProbability = Math.min(1, Math.max(0, Number(pacing.longProbability) || 0));
  const delays = [0];
  for (let i = 1; i < count; i += 1) {
    delays.push(
      random() < longProbability
        ? Math.round(longMinMs + random() * (longMaxMs - longMinMs))
        : Math.round(minMs + random() * (maxMs - minMs)),
    );
  }
  return delays;
}

// 每个 conversation 一条推送链：新批次接在链尾，避免两条 setTimeout 链交叉造成 seq 乱序。
const assistantPublishChains = new Map();

function drainPublishChain(ctx, conversationId, chain) {
  if (ctx.stopping) {
    for (const item of chain.queue) {
      try {
        item.onDone?.();
      } catch (error) {
        ctx.logger?.warn?.(`[messages] 停机时 onDone 失败: ${error?.message ?? error}`);
      }
    }
    chain.queue.length = 0;
    assistantPublishChains.delete(conversationId);
    return;
  }
  const item = chain.queue.shift();
  if (!item) {
    assistantPublishChains.delete(conversationId);
    return;
  }
  try {
    const message = eventMessage(ctx.dbState.db, conversationId, item.id);
    if (message) {
      ctx.events?.publish?.(conversationId, {
        type: 'assistant_message',
        seq: item.seq,
        at: new Date().toISOString(),
        message,
      });
    }
  } catch (error) {
    // DB 关闭/服务退出后残留的定时器：吞掉，但不能吞掉 onDone。
    ctx.logger?.warn?.(`[messages] 延迟推送失败: ${error?.message ?? error}`);
  }
  try {
    item.onDone?.();
  } catch (error) {
    ctx.logger?.warn?.(`[messages] onDone 失败: ${error?.message ?? error}`);
  }
  if (chain.queue.length === 0) assistantPublishChains.delete(conversationId);
  else schedulePublishChain(ctx, conversationId, chain);
}

function schedulePublishChain(ctx, conversationId, chain) {
  if (chain.timer || chain.queue.length === 0) return;
  if (ctx.stopping) {
    drainPublishChain(ctx, conversationId, chain);
    return;
  }
  const next = chain.queue[0];
  const delay = Math.max(0, Number(next.at) - Date.now());
  chain.timer = setTimeout(() => {
    chain.timer = null;
    drainPublishChain(ctx, conversationId, chain);
  }, delay);
  chain.timer.unref?.();
}

/**
 * 逐条推送 assistant_message。消息已经落库，这里只控制「什么时候让 App 看到」。
 * 同一 conversation 只有一条链：新批次接在链尾，第一条不会抢跑。
 */
export function publishAssistantMessages(ctx, conversationId, created, options = {}) {
  const list = Array.isArray(created) ? created : [];
  if (list.length === 0) {
    options.onDone?.();
    return;
  }
  const delays = Array.isArray(options.delays)
    ? options.delays
    : planSendDelays(list.length, ctx.config?.social?.sendPacing || {});
  let chain = assistantPublishChains.get(conversationId);
  if (!chain) {
    chain = { queue: [], timer: null, tailAt: 0 };
    assistantPublishChains.set(conversationId, chain);
  }
  const now = Date.now();
  let at = Math.max(
    Number(chain.tailAt) || 0,
    now + Math.max(0, Number(options.initialDelayMs) || 0),
  );
  for (let index = 0; index < list.length; index += 1) {
    if (index > 0) at += Math.max(0, Number(delays[index]) || 0);
    chain.queue.push({
      ...list[index],
      at,
      onDone: index === list.length - 1 ? options.onDone : null,
    });
    chain.tailAt = at;
  }
  schedulePublishChain(ctx, conversationId, chain);
}

function textAtoms(text) {
  const source = String(text ?? '');
  const out = [];
  let last = 0;
  for (const match of source.matchAll(/https?:\/\/[^\s]+/g)) {
    if (match.index > last) out.push(...Array.from(source.slice(last, match.index)));
    out.push(match[0]);
    last = match.index + match[0].length;
  }
  if (last < source.length) out.push(...Array.from(source.slice(last)));
  return out;
}

function hardSplitText(text, maxChars) {
  const chunks = [];
  let buffer = '';
  const breakChars = ['。', '！', '？', '；', '…', '\n', '，', '、', '.', '!', '?', ';'];
  for (const atom of textAtoms(text)) {
    if (atom.length > maxChars) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      for (let i = 0; i < atom.length; i += maxChars) {
        chunks.push(atom.slice(i, i + maxChars));
      }
      continue;
    }
    if ((buffer + atom).length <= maxChars) {
      buffer += atom;
      continue;
    }
    let cut = -1;
    for (const ch of breakChars) cut = Math.max(cut, buffer.lastIndexOf(ch));
    if (cut >= Math.floor(maxChars * 0.5)) {
      chunks.push(buffer.slice(0, cut + 1));
      buffer = buffer.slice(cut + 1) + atom;
    } else {
      chunks.push(buffer);
      buffer = atom;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * 把一段模型正文拆成 chat_send 能接受的条数与单条长度。
 * URL 作为原子；代理对按 code point 切；优先在句末/逗号断。
 */
export function splitReplyText(
  text,
  { maxChars = MAX_MESSAGE_CHARS, maxMessages = MAX_BATCH_MESSAGES, onTruncate = null } = {},
) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  const parts = source
    .split(/(?<=[。！？!?；;…\n])/u)
    .flatMap((part) => (part.length > maxChars ? hardSplitText(part, maxChars) : [part]))
    .filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const part of parts) {
    if ((buffer + part).length <= maxChars) {
      buffer += part;
    } else {
      if (buffer) chunks.push(buffer);
      buffer = part;
    }
  }
  if (buffer) chunks.push(buffer);
  const cleaned = chunks.map((chunk) => chunk.trim()).filter(Boolean);
  if (cleaned.length <= maxMessages) return cleaned;
  onTruncate?.({ originalMessages: cleaned.length, keptMessages: maxMessages });
  const kept = cleaned.slice(0, maxMessages);
  kept[maxMessages - 1] = `${kept[maxMessages - 1].slice(0, Math.max(0, maxChars - 1))}…`;
  return kept;
}

export function latestSeq(db, conversationId) {
  return db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?')
    .get(conversationId).m;
}

export function latestUserSeq(db, conversationId) {
  return db
    .prepare(
      "SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ? AND role = 'user'",
    )
    .get(conversationId).m;
}

export function lastUserMessageAt(db, conversationId, afterSeq = 0) {
  return db
    .prepare(
      `SELECT MAX(created_at) AS at FROM message
        WHERE conversation_id = ? AND role = 'user' AND seq > ?`,
    )
    .get(conversationId, afterSeq).at;
}

/** 固定字段顺序 —— hash 要能跨进程复现，不能受对象键序影响。 */
export function payloadHashOf(messages, replyToMessageId) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        messages,
        replyToMessageId: replyToMessageId ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

export function isSilentMarker(text) {
  return String(text ?? '').trim() === '[SILENT]';
}

const SEGMENT_SEPARATOR = /(?:^|\r?\n)[ \t]*---[ \t]*(?=\r?\n|$)/;

export function hasSegmentSeparator(text) {
  return SEGMENT_SEPARATOR.test(String(text ?? ''));
}

export function splitSegmentText(text) {
  return String(text ?? '')
    .split(/\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/)
    .map((item) => item.trim());
}

/** `segments` / `---` 的专用校验：1~4 段，单段最多 2000 字。 */
export function validateSegments(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length < 1 || list.length > MAX_SEGMENTS) {
    const error = new Error(`segments 最多 ${MAX_SEGMENTS} 段`);
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  return list.map((item) => {
    if (typeof item !== 'string') {
      const error = new Error('segments 每一项必须是字符串');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const text = item.trim();
    if (!text) {
      const error = new Error('segments 不能有空白段');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    if (text.length > MAX_SEGMENT_CHARS) {
      const error = new Error(`单段最多 ${MAX_SEGMENT_CHARS} 字`);
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    return text;
  });
}

/**
 * 第三层：拟人分条。
 * 数组即条数（不解析空格），单批最多 8 条，单条 500 字。
 */
export function validateSendBatch(raw) {
  if (raw === undefined || raw === null) {
    const error = new Error('messages 必填');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const list = (Array.isArray(raw) ? raw : [raw]).map((item) => {
    if (typeof item !== 'string') {
      const error = new Error('messages 每一项必须是字符串');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const text = item.trim();
    if (!text) {
      const error = new Error('messages 不能有空白项');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    if (text.length > MAX_MESSAGE_CHARS) {
      const error = new Error(`单条消息上限 ${MAX_MESSAGE_CHARS} 字符`);
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    return text;
  });
  if (list.length === 0) {
    const error = new Error('messages 不能为空');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  if (list.length > MAX_BATCH_MESSAGES) {
    const error = new Error(`单次最多 ${MAX_BATCH_MESSAGES} 条`);
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  return list;
}

export function assertReplyTarget(db, conversationId, replyToMessageId) {
  if (!replyToMessageId) return null;
  const exists = db
    .prepare('SELECT 1 AS ok FROM message WHERE id = ? AND conversation_id = ?')
    .get(replyToMessageId, conversationId);
  if (!exists) {
    const error = new Error('replyToMessageId 不属于本会话');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  return replyToMessageId;
}

/**
 * 整批原子落库。clientBatchId 幂等由 message_batch 保证；重放返回原来的 id/seq。
 */
export function insertAssistantBatch(
  db,
  conversationId,
  list,
  { replyTo = null, batchId = null, hash = null, now = nowMs() } = {},
) {
  const payloadHash = hash || payloadHashOf(list, replyTo);
  return withTransaction(db, () => {
    if (batchId) {
      const prev = db
        .prepare(
          'SELECT payload_hash, message_ids_json FROM message_batch WHERE conversation_id = ? AND client_batch_id = ?',
        )
        .get(conversationId, batchId);
      if (prev) {
        if (prev.payload_hash !== payloadHash) {
          const error = new Error('clientBatchId 已被另一份 payload 使用');
          error.status = 409;
          error.code = 'batch-conflict';
          throw error;
        }
        const ids = JSON.parse(prev.message_ids_json);
        const rows = ids.length
          ? db
              .prepare(
                `SELECT id, seq FROM message
                  WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
              )
              .all(conversationId, ...ids)
          : [];
        return { created: rows, duplicated: true, hash: payloadHash };
      }
    }
    const created = [];
    for (const text of list) {
      const id = randomUUID();
      const seq = nextSeq(db, conversationId);
      const content = JSON.stringify({
        type: 'text',
        text,
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
      });
      db.prepare(
        `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
      ).run(id, conversationId, content, now, seq);
      bumpUsageAssistant(db, conversationId, text.length, localDay(new Date(now)));
      created.push({ id, seq });
    }
    if (batchId) {
      db.prepare(
        `INSERT INTO message_batch
           (conversation_id, client_batch_id, payload_hash, message_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(conversationId, batchId, payloadHash, JSON.stringify(created.map((m) => m.id)), now);
    }
    const lastText = list.length ? String(list[list.length - 1]).trim() : '';
    db.prepare('UPDATE conversation SET updated_at = ?, summary = ? WHERE id = ?')
      .run(now, lastText ? lastText.slice(0, 80) : null, conversationId);
    return { created, duplicated: false, hash: payloadHash };
  });
}

/**
 * 助手发一张表情：单条 assistant 消息，附件用表情的来源附件，
 * content_json 里带 sticker，客户端据此只显示图。
 */
export function insertAssistantSticker(
  db,
  conversationId,
  { sticker, attachmentId, replyTo = null, batchId = null, hash = null, now = nowMs() },
) {
  const payloadHash = hash || payloadHashOf([`sticker:${sticker.id}`], replyTo);
  return withTransaction(db, () => {
    if (batchId) {
      const prev = db
        .prepare(
          'SELECT payload_hash, message_ids_json FROM message_batch WHERE conversation_id = ? AND client_batch_id = ?',
        )
        .get(conversationId, batchId);
      if (prev) {
        if (prev.payload_hash !== payloadHash) {
          const error = new Error('clientBatchId 已被另一份 payload 使用');
          error.status = 409;
          error.code = 'batch-conflict';
          throw error;
        }
        const ids = JSON.parse(prev.message_ids_json);
        const rows = ids.length
          ? db
              .prepare(
                `SELECT id, seq FROM message
                  WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
              )
              .all(conversationId, ...ids)
          : [];
        return { created: rows, duplicated: true, hash: payloadHash };
      }
    }
    const id = randomUUID();
    const seq = nextSeq(db, conversationId);
    const content = JSON.stringify({
      type: 'text',
      text: '',
      attachments: [attachmentId],
      sticker: { id: sticker.id, name: sticker.name },
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
    });
    db.prepare(
      `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
       VALUES (?, ?, 'assistant', ?, ?, ?)`,
    ).run(id, conversationId, content, now, seq);
    bumpUsageAssistant(db, conversationId, 0, localDay(new Date(now)));
    db.prepare('UPDATE conversation SET updated_at = ?, summary = ? WHERE id = ?')
      .run(now, '[表情]', conversationId);
    db.prepare(
      'UPDATE sticker SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
    ).run(new Date(now).toISOString(), sticker.id);
    if (batchId) {
      db.prepare(
        `INSERT INTO message_batch
           (conversation_id, client_batch_id, payload_hash, message_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(conversationId, batchId, payloadHash, JSON.stringify([id]), now);
    }
    return { created: [{ id, seq }], duplicated: false, hash: payloadHash };
  });
}

/**
 * 单条 assistant 消息插入，调用方负责事务。气泡队列逐条发送时复用。
 */
export function insertAssistantMessageTx(
  db,
  conversationId,
  text,
  { replyTo = null, now = nowMs() } = {},
) {
  const id = randomUUID();
  const seq = nextSeq(db, conversationId);
  const content = JSON.stringify({
    type: 'text',
    text,
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  });
  db.prepare(
    `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(id, conversationId, content, now, seq);
  bumpUsageAssistant(db, conversationId, text.length, localDay(new Date(now)));
  const lastText = String(text ?? '').trim();
  db.prepare('UPDATE conversation SET updated_at = ?, summary = ? WHERE id = ?')
    .run(now, lastText ? lastText.slice(0, 80) : null, conversationId);
  return { id, seq };
}

/** 气泡逐条落库时，把消息 id 追加到同一 clientBatchId 的批次记录。 */
export function appendBatchMessageId(db, conversationId, batchId, messageId) {
  if (!batchId) return;
  const row = db.prepare(
    'SELECT message_ids_json FROM message_batch WHERE conversation_id = ? AND client_batch_id = ?',
  ).get(conversationId, batchId);
  if (!row) return;
  let ids = [];
  try {
    const parsed = JSON.parse(row.message_ids_json);
    if (Array.isArray(parsed)) ids = parsed;
  } catch {
    // 坏 JSON 当空批次处理
  }
  if (!ids.includes(messageId)) ids.push(messageId);
  db.prepare(
    'UPDATE message_batch SET message_ids_json = ? WHERE conversation_id = ? AND client_batch_id = ?',
  ).run(JSON.stringify(ids), conversationId, batchId);
}

export function markSeen(db, conversationId, seqs) {
  if (!Array.isArray(seqs) || seqs.length === 0) return;
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO seen_seq (conversation_id, viewer, seq) VALUES (?, 'agent', ?)",
  );
  for (const seq of seqs) {
    const n = Number(seq);
    if (Number.isSafeInteger(n) && n > 0) stmt.run(conversationId, n);
  }
}

/**
 * agent_read_seq 只在「seq 连续且都被看过」时前进。
 * 这里不按 role 过滤：watermark 是消息序号水位，中间夹一条 assistant 也必须算在内。
 */
export function contiguousSeenThrough(db, conversationId) {
  const row = db
    .prepare('SELECT agent_read_seq FROM conversation WHERE id = ?')
    .get(conversationId);
  let read = Number(row?.agent_read_seq) || 0;
  const rows = db
    .prepare(
      `SELECT seq FROM seen_seq
        WHERE conversation_id = ? AND viewer = 'agent' AND seq > ?
        ORDER BY seq ASC`,
    )
    .all(conversationId, read);
  for (const item of rows) {
    if (item.seq === read + 1) read += 1;
    else if (item.seq > read + 1) break;
  }
  return read;
}

export function advanceReadPrefix(db, conversationId) {
  const next = contiguousSeenThrough(db, conversationId);
  db.prepare('UPDATE conversation SET agent_read_seq = ? WHERE id = ?').run(next, conversationId);
  return next;
}
