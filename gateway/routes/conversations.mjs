import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nextSeq, nowMs, withTransaction } from '../db/index.mjs';
import { deliverPrompt } from '../dsh/delivery.mjs';
import { parseMultipart, readBuffer, readJson, sendError, sendJson } from '../http.mjs';
import { STREAM_REPLAY_LIMIT } from '../realtime-config.mjs';
import {
  AI_NAMES,
  defaultWakeConfig,
  evaluateWakeTrigger,
  normalizeWakeConfig,
} from '../social/wake.mjs';
import {
  bumpUsageMessages,
  loadBotSettings,
  localDay,
  userMessagesToday,
} from '../settings.mjs';
import { publicAgentMessage } from './agent.mjs';
import { replyPreview } from '../messages.mjs';
import { canReadStickerAttachment, resolveStickerForSend } from '../stickers.mjs';
import { writeEvent } from '../events-store.mjs';
import { normalizeVoice } from '../voice.mjs';

function policyHash(policy, userId) {
  return JSON.stringify({
    preset: policy === 'owner' ? 'tide-owner' : 'tide',
    permissionLevel: policy,
    ownerId: userId,
  });
}

function assertOwnerAllowed(ctx, userId, policy) {
  if (policy !== 'owner') return;
  const owners = ctx.config?.ownerIds ?? [];
  if (!owners.includes(userId)) {
    const error = new Error('owner 权限只对白名单内的用户开放');
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  }
}

async function ensureWorkspace(ctx, conversationId) {
  if (typeof ctx.ensureWorkspace === 'function') {
    return ctx.ensureWorkspace({ conversationId });
  }
  if (typeof ctx.dsh?.createWorkspace !== 'function') return null;
  // DSH 的 workspace/create 只接受已存在的目录，先建出来
  const dir = path.join(ctx.workspaceRoot, 'conversations', conversationId);
  fs.mkdirSync(dir, { recursive: true });
  const workspace = await ctx.dsh.createWorkspace({ conversationId, path: dir });
  return workspace?.workspaceId ?? null;
}

function ownedConversation(ctx, id, userId) {
  const row = ctx.dbState.db.prepare(
    `SELECT c.id, c.kind, c.title, c.user_id, c.user_read_seq, c.policy, c.dsh_session_id,
            c.dsh_workspace_id, c.agent_token, c.summary, c.agent_read_seq,
            c.wake_config_json, c.social_state_json, c.epoch, c.announcement,
            m.role AS member_role, m.display_name AS member_display_name,
            m.joined_at, m.join_seq, m.last_read_seq, m.is_admin
       FROM conversation c
       JOIN conversation_member m ON m.conversation_id = c.id
      WHERE c.id = ? AND m.user_id = ? AND c.deleted_at IS NULL`,
  ).get(id, userId);
  if (!row) {
    const error = new Error('conversation not found');
    error.status = 404;
    error.code = 'not-found';
    throw error;
  }
  return row;
}

function conversationMember(db, conversationId, userId) {
  return db.prepare(
    `SELECT m.conversation_id, m.user_id, m.display_name, m.role, m.is_admin,
            m.joined_at, m.join_seq, m.last_read_seq,
            u.username, u.display_name AS user_display_name, u.avatar
       FROM conversation_member m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.user_id = ?`,
  ).get(conversationId, userId);
}

function memberDisplayName(member) {
  return member?.display_name
    || member?.user_display_name
    || member?.username
    || null;
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

function extractMentions(db, conversationId, text) {
  const source = String(text ?? '');
  if (!source.includes('@')) return [];
  const names = [];
  for (const name of AI_NAMES) {
    const value = String(name ?? '').trim();
    if (value) names.push({ lower: value.toLowerCase(), target: 'agent' });
  }
  const members = db.prepare(
    `SELECT m.user_id, m.display_name, u.username, u.display_name AS user_display_name
       FROM conversation_member m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ?`,
  ).all(conversationId);
  for (const row of members) {
    for (const name of [row.display_name, row.user_display_name, row.username]) {
      const value = String(name ?? '').trim();
      if (value) names.push({ lower: value.toLowerCase(), target: row.user_id });
    }
  }
  // 长名字优先：这样 @张 三 不会被 @张 抢先匹配，名字里的空格/标点也照常算。
  names.sort((a, b) => b.lower.length - a.lower.length);
  const lower = source.toLowerCase();
  const found = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '@') continue;
    const rest = lower.slice(i + 1);
    const hit = names.find((item) => rest.startsWith(item.lower));
    if (hit && !found.includes(hit.target)) found.push(hit.target);
    if (found.length >= 50) break;
  }
  return found;
}

function parseContent(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { type: 'text', text };
  }
}

function resolveAttachments(db, conversationId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const rows = db.prepare(
    `SELECT id, COALESCE(name, '') AS name, media_type, bytes, local_path
       FROM attachment
      WHERE conversation_id = ? AND id IN (${ids.map(() => '?').join(',')})
      ORDER BY rowid`,
  ).all(conversationId, ...ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((row) => ({
      id: row.id,
      name: row.name || path.basename(row.local_path),
      mimeType: row.media_type,
      size: row.bytes,
    }));
}

function publicMessage(row, db, conversationId) {
  const content = parseContent(row.content_json);
  const recalled = Boolean(row.recalled_at);
  if (Array.isArray(content?.attachments)) {
    content.attachments = resolveAttachments(db, conversationId, content.attachments);
  }
  if (content?.sticker?.id) {
    const stickerAttachment = db.prepare(
      `SELECT a.id, COALESCE(a.name, '') AS name, a.media_type, a.bytes, a.local_path
         FROM sticker s
         JOIN attachment a ON a.id = s.attachment_id
        WHERE s.id = ?`,
    ).get(content.sticker.id);
    if (stickerAttachment) {
      if (!Array.isArray(content.attachments)) content.attachments = [];
      if (!content.attachments.some((item) => item.id === stickerAttachment.id)) {
        content.attachments.push({
          id: stickerAttachment.id,
          name: stickerAttachment.name || path.basename(stickerAttachment.local_path),
          mimeType: stickerAttachment.media_type,
          size: stickerAttachment.bytes,
        });
      }
    }
  }
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    content,
    sticker: content?.sticker ?? null,
    voice: content?.voice ?? null,
    clientMsgId: row.client_msg_id,
    wakeReason: row.wake_reason ?? null,
    senderUserId: row.sender_user_id ?? null,
    senderName: row.sender_name ?? null,
    mentions: parseMentions(row.mentions),
    recalled,
    replyTo: content?.replyToMessageId
      ? replyPreview(db, conversationId, content.replyToMessageId)
      : null,
  };
}

function sanitizeFilename(value) {
  const base = path.basename(String(value || '').replaceAll('\\', '/'));
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean && clean !== '.' && clean !== '..' ? clean.slice(0, 200) : 'attachment.bin';
}

function contentDisposition(value) {
  const filename = sanitizeFilename(value);
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 200) || 'attachment.bin';
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function normalizeMediaType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(type)
    ? type
    : 'application/octet-stream';
}

function uploadError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function uploadAttachment(ctx, userId, conversationId, req) {
  ownedConversation(ctx, conversationId, userId);
  const contentType = String(req.headers['content-type'] || '');
  const maxBytes = ctx.uploadMaxBytes;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes + 1_000_000) {
    throw uploadError(413, 'attachment-too-large', '上传文件超过大小限制');
  }

  let raw;
  try {
    raw = await readBuffer(req, maxBytes + 1_000_000);
  } catch (error) {
    if (error?.code === 'payload-too-large') {
      throw uploadError(413, 'attachment-too-large', '上传文件超过大小限制');
    }
    throw error;
  }

  let file;
  if (/^multipart\/form-data/i.test(contentType)) {
    file = parseMultipart(raw, contentType);
  } else {
    file = {
      filename: req.headers['x-file-name'] || 'attachment.bin',
      contentType: contentType.split(';')[0] || 'application/octet-stream',
      data: raw,
    };
  }
  if (!file.data || file.data.length === 0) {
    throw uploadError(400, 'bad-request', '上传文件为空');
  }
  if (file.data.length > maxBytes) {
    throw uploadError(413, 'attachment-too-large', '上传文件超过大小限制');
  }

  const used = ctx.dbState.db.prepare(
    'SELECT COALESCE(SUM(bytes), 0) AS n FROM attachment WHERE conversation_id = ?',
  ).get(conversationId).n;
  if (used + file.data.length > ctx.conversationMaxBytes) {
    throw uploadError(413, 'attachment-quota-exceeded', '这个会话的附件空间已满');
  }
  const limits = loadBotSettings(ctx.dbState.db).perUserLimits;
  const userUsed = ctx.dbState.db.prepare(
    `SELECT COALESCE(SUM(a.bytes), 0) AS n
       FROM attachment a
      WHERE a.uploader_user_id = ?`,
  ).get(userId).n;
  if (userUsed + file.data.length > limits.uploadMb * 1024 * 1024) {
    throw uploadError(
      413,
      'quota-exceeded',
      `每个用户最多上传 ${limits.uploadMb} MB`,
    );
  }

  const id = randomUUID();
  const name = sanitizeFilename(file.filename);
  const mediaType = normalizeMediaType(file.contentType);
  const kind = /^image\//i.test(mediaType)
    ? 'image'
    : (/^audio\//i.test(mediaType) ? 'audio' : 'file');
  const dir = path.join(ctx.workspaceRoot, 'conversations', conversationId, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const localPath = path.join(dir, id);
  fs.writeFileSync(localPath, file.data, { flag: 'wx' });
  const sha256 = createHash('sha256').update(file.data).digest('hex');
  try {
    ctx.dbState.db.prepare(
      `INSERT INTO attachment
         (id, conversation_id, message_id, kind, name, media_type, bytes, sha256,
          local_path, remote_path, uploader_user_id, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      id,
      conversationId,
      kind,
      name,
      mediaType,
      file.data.length,
      sha256,
      localPath,
      userId,
      nowMs(),
    );
  } catch (error) {
    try { fs.rmSync(localPath, { force: true }); } catch {}
    throw error;
  }
  return {
    attachment_id: id,
    name,
    kind,
    media_type: mediaType,
    bytes: file.data.length,
  };
}

export async function handleAttachmentDownload(req, res, url, ctx) {
  if (req.method !== 'GET') return sendError(res, 404, 'not-found', 'route not found');
  const auth = await ctx.auth.authenticate(req);
  const id = url.pathname.split('/').filter(Boolean)[1];
  const row = ctx.dbState.db.prepare(
    `SELECT id, conversation_id, name, media_type, local_path
       FROM attachment WHERE id = ?`,
  ).get(id);
  if (!row) {
    return sendError(res, 404, 'not-found', 'attachment not found');
  }
  const member = conversationMember(ctx.dbState.db, row.conversation_id, auth.userId);
  if (!member && !canReadStickerAttachment(ctx.dbState.db, auth.userId, row.id)) {
    return sendError(res, 404, 'not-found', 'attachment not found');
  }

  let resolved;
  let root;
  try {
    root = fs.realpathSync(
      path.resolve(ctx.workspaceRoot, 'conversations', row.conversation_id, 'attachments'),
    );
    resolved = fs.realpathSync(row.local_path);
  } catch {
    return sendError(res, 404, 'not-found', 'attachment file missing');
  }
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return sendError(res, 403, 'forbidden', 'attachment path escape');
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return sendError(res, 404, 'not-found', 'attachment file missing');
  }
  if (!stat.isFile()) return sendError(res, 404, 'not-found', 'attachment file missing');

  res.writeHead(200, {
    'content-type': row.media_type || 'application/octet-stream',
    'content-length': stat.size,
    'content-disposition': contentDisposition(row.name || path.basename(resolved)),
    'cache-control': 'private, max-age=0, must-revalidate',
  });
  fs.createReadStream(resolved).pipe(res);
}

async function listConversations(ctx, userId) {
  const rows = ctx.dbState.db.prepare(
    `SELECT c.id, c.kind, c.title, c.avatar, c.summary, c.updated_at, c.policy, c.epoch,
            c.announcement, m.last_read_seq, m.role AS member_role, m.is_admin,
            (SELECT r.state FROM rebuild_queue r
              WHERE r.conversation_id = c.id
              ORDER BY CASE r.state WHEN 'pending' THEN 0 ELSE 1 END
              LIMIT 1) AS rebuild_state
       FROM conversation c
       JOIN conversation_member m ON m.conversation_id = c.id
      WHERE m.user_id = ? AND c.deleted_at IS NULL
      ORDER BY c.updated_at DESC`,
  ).all(userId);
  // 统一信封：列表也包一层对象，和 /messages、/agent/messages 一致。
  // 裸数组会让只支持 JSONObject 的客户端直接解析失败（Android 那边就踩了）。
  return {
    conversations: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      avatar: row.avatar,
      summary: row.summary,
      announcement: row.announcement ?? null,
      updatedAt: new Date(row.updated_at).toISOString(),
      policy: row.policy ?? 'restricted',
      epoch: row.epoch,
      last_read_seq: row.last_read_seq,
      role: row.member_role,
      is_admin: Boolean(row.is_admin),
      unread: ctx.dbState.db.prepare(
        `SELECT COUNT(*) AS n FROM message
          WHERE conversation_id = ? AND seq > ?
            AND NOT (role = 'user' AND sender_user_id = ?)`,
      ).get(row.id, row.last_read_seq, userId).n,
      rebuild_pending: row.rebuild_state !== null,
      rebuild_state: row.rebuild_state ?? null,
    })),
  };
}

function requireAdmin(auth) {
  if (auth?.role !== 'admin') {
    const error = new Error('只有管理员能直接创建会话/群聊');
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  }
}

/**
 * 内部建会话：admin 建群/建私聊、guest 邀请码开通私聊、审批开私聊都走这里。
 * `enforceQuota` 对 admin 默认关闭；guest 的直接会话打开。
 */
export async function createConversationForUser(ctx, {
  userId,
  title = '新的对话',
  kind = 'direct',
  legacyKey = null,
  policy = 'restricted',
  wakeConfig = null,
  enforceQuota = true,
} = {}) {
  if (policy !== 'restricted') {
    const error = new Error('新建会话只能使用 restricted；提权走 /policy 且需要 owner 校验');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  if (kind !== 'direct' && kind !== 'group') {
    const error = new Error('kind 必须是 direct 或 group');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const db = ctx.dbState.db;
  const limits = loadBotSettings(db).perUserLimits;
  if (enforceQuota) {
    const count = db.prepare(
      "SELECT COUNT(*) AS n FROM conversation_member WHERE user_id = ? AND role = 'owner'",
    ).get(userId).n;
    if (count >= limits.maxConversations) {
      const error = new Error(`每个用户最多 ${limits.maxConversations} 个会话`);
      error.status = 429;
      error.code = 'quota-exceeded';
      error.extra = { limit: limits.maxConversations, current: count };
      throw error;
    }
  }
  const now = nowMs();
  const id = randomUUID();
  const workspaceId = await ensureWorkspace(ctx, id);
  if (ctx.dsh && !workspaceId) {
    const error = new Error('workspace/create 没有返回 workspaceId');
    error.status = 502;
    error.code = 'upstream-error';
    throw error;
  }
  const cleanTitle = String(title || '新的对话').trim() || '新的对话';
  const token = randomBytes(24).toString('hex');
  const effectiveWake = wakeConfig || loadBotSettings(db).defaultWakeConfig || defaultWakeConfig();
  const profile = db.prepare(
    'SELECT username, display_name FROM users WHERE id = ?',
  ).get(userId);
  const displayName = profile?.display_name || profile?.username || null;
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO conversation
         (id, legacy_key, user_id, kind, title, created_at, updated_at, agent_token, policy,
          policy_hash, dsh_workspace_id, wake_config_json, social_state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      legacyKey ? String(legacyKey) : null,
      userId,
      kind,
      cleanTitle,
      now,
      now,
      token,
      policy,
      policyHash(policy, userId),
      workspaceId,
      JSON.stringify(effectiveWake),
      '{}',
    );
    db.prepare(
      `INSERT INTO conversation_member
         (conversation_id, user_id, display_name, role, joined_at, last_read_seq)
       VALUES (?, ?, ?, 'owner', ?, 0)`,
    ).run(id, userId, displayName, now);
  });
  ctx.social?.ensureTimers?.(id);
  emitConversationCreated(ctx, userId, {
    id,
    kind,
    title: cleanTitle,
    epoch: 1,
  }, 'created');
  return {
    id,
    kind,
    title: cleanTitle,
    epoch: 1,
    dsh_session_id: null,
    dsh_workspace_id: workspaceId,
    policy,
  };
}

async function createConversation(ctx, auth, body) {
  requireAdmin(auth);
  return createConversationForUser(ctx, {
    userId: auth.userId,
    title: body.title,
    kind: body.kind === undefined ? 'direct' : String(body.kind),
    legacyKey: body.legacy_key,
    enforceQuota: false,
  });
}

async function listMessages(ctx, userId, conversationId, url) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw === ''
    ? 30
    : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    const error = new Error('limit 必须是 1~100 的整数');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const beforeRaw = url.searchParams.get('before');
  const afterRaw = url.searchParams.get('after_seq') ?? url.searchParams.get('since_seq');
  const before = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw);
  const afterSeq = afterRaw === null || afterRaw === '' ? null : Number(afterRaw);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    const error = new Error('before 必须是正整数');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  if (afterSeq !== null && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
    const error = new Error('after_seq 必须是非负整数');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const query = String(url.searchParams.get('q') ?? '').trim();
  if (query) {
    if (query.length > 100) {
      const error = new Error('搜索关键词最多 100 字');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = ctx.dbState.db.prepare(
      `SELECT * FROM message
        WHERE conversation_id = ? AND seq > ? AND recalled_at IS NULL
          AND json_extract(content_json, '$.text') LIKE ? ESCAPE '\\'
        ORDER BY seq DESC LIMIT ?`,
    ).all(conversationId, Number(conversation.join_seq) || 0, `%${escaped}%`, limit + 1);
    const hasMore = rows.length > limit;
    return {
      conversation_id: conversationId,
      epoch: conversation.epoch,
      query,
      messages: rows.slice(0, limit)
        .map((row) => publicMessage(row, ctx.dbState.db, conversationId)),
      has_more: hasMore,
    };
  }
  const around = String(url.searchParams.get('around') ?? '').trim();
  if (around) {
    const target = ctx.dbState.db.prepare(
      'SELECT seq FROM message WHERE id = ? AND conversation_id = ?',
    ).get(around, conversationId);
    if (!target) {
      const error = new Error('消息不存在');
      error.status = 404;
      error.code = 'message-not-found';
      throw error;
    }
    const half = Math.max(1, Math.floor(limit / 2));
    const rows = ctx.dbState.db.prepare(
      `SELECT * FROM message
        WHERE conversation_id = ? AND seq > ? AND seq <= ?
        ORDER BY seq DESC LIMIT ?`,
    ).all(
      conversationId,
      Number(conversation.join_seq) || 0,
      Number(target.seq) + half,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    return {
      conversation_id: conversationId,
      epoch: conversation.epoch,
      around,
      messages: rows.slice(0, limit).reverse()
        .map((row) => publicMessage(row, ctx.dbState.db, conversationId)),
      has_more: hasMore,
    };
  }
  const clauses = ['conversation_id = ?', 'seq > ?'];
  const params = [conversationId, Number(conversation.join_seq) || 0];
  if (before !== null) {
    clauses.push('seq < ?');
    params.push(before);
  }
  if (afterSeq !== null) {
    clauses.push('seq > ?');
    params.push(afterSeq);
    if (ctx.realtimeStats) ctx.realtimeStats.catchUpRequests += 1;
  }
  const ascending = afterSeq !== null;
  const order = ascending ? 'ASC' : 'DESC';
  const rows = ctx.dbState.db.prepare(
    `SELECT * FROM message WHERE ${clauses.join(' AND ')} ORDER BY seq ${order} LIMIT ?`,
  ).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const page = ascending ? rows.slice(0, limit) : rows.slice(0, limit).reverse();
  const latestSeq = ctx.dbState.db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?',
  ).get(conversationId).m;
  return {
    conversation_id: conversationId,
    epoch: conversation.epoch,
    latest_seq: latestSeq,
    messages: page.map((row) => publicMessage(row, ctx.dbState.db, conversationId)),
    has_more: hasMore,
  };
}

/** 投递失败写一条事件，再原样抛出；事件写失败不影响发送错误本身。 */
async function deliverWithEvent(ctx, conversation, messageRow, options) {
  try {
    return await deliverPrompt(ctx, conversation, messageRow, options);
  } catch (error) {
    writeEvent(ctx.dbState.db, {
      level: 'error',
      kind: 'message.failed',
      conversationId: conversation.id,
      detail: {
        seq: messageRow?.seq ?? null,
        code: error?.code ?? 'deliver-failed',
        message: String(error?.message ?? error).slice(0, 200),
      },
    });
    throw error;
  }
}

async function postPrompt(ctx, userId, conversationId, body) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  const kind = conversation.kind === 'group' ? 'group' : 'direct';
  const text = String(body.text || '');
  const attachments = Array.isArray(body.attachments)
    ? [...new Set(body.attachments.map(String).filter(Boolean))]
    : [];
  const stickerId = body.stickerId ?? body.sticker_id ?? null;
  const sticker = stickerId
    ? resolveStickerForSend(ctx.dbState.db, String(stickerId), userId)
    : null;
  const stickerAttachmentId = sticker ? sticker.sticker.attachment_id : null;
  if (stickerAttachmentId && !attachments.includes(stickerAttachmentId)) {
    attachments.push(stickerAttachmentId);
  }
  // 表情的附件属于来源会话，不能按目标会话校验/挂载；只处理本地附件。
  const localAttachments = stickerAttachmentId
    ? attachments.filter((id) => id !== stickerAttachmentId)
    : attachments;
  const voice = normalizeVoice(body.voice);
  if (voice) {
    if (localAttachments.length !== 1) {
      const error = new Error('语音消息必须恰好带一个音频附件');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const audio = ctx.dbState.db.prepare(
      `SELECT kind, media_type FROM attachment
        WHERE id = ? AND conversation_id = ?`,
    ).get(localAttachments[0], conversationId);
    if (!audio || audio.kind !== 'audio' || !/^audio\//i.test(audio.media_type || '')) {
      const error = new Error('语音消息的附件不是音频');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
  }
  if (!text.trim() && attachments.length === 0) {
    const error = new Error('text or attachments required');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const replyToRaw = body.reply_to_message_id ?? body.replyToMessageId ?? null;
  const replyTo = replyToRaw ? String(replyToRaw) : null;
  let quoteTargetIsSelf = false;
  if (replyTo) {
    const target = ctx.dbState.db
      .prepare('SELECT role FROM message WHERE id = ? AND conversation_id = ?')
      .get(replyTo, conversationId);
    if (!target) {
      const error = new Error('reply_to_message_id 不属于本对话');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    quoteTargetIsSelf = target.role === 'assistant';
  }
  const member = conversationMember(ctx.dbState.db, conversationId, userId);
  // 显示名只由服务端成员资料决定，客户端的 sender_name 不再参与落库。
  const senderName = kind === 'direct'
    ? (memberDisplayName(member) || '你')
    : (memberDisplayName(member) || `成员-${String(userId).slice(0, 6)}`);
  const mentions = extractMentions(ctx.dbState.db, conversationId, text);
  const wakeConfig = normalizeWakeConfig(conversation.wake_config_json);
  const silent = Date.now() < (Number(loadBotSettings(ctx.dbState.db).silentUntil) || 0);
  const wakeReason = silent ? null : evaluateWakeTrigger({
    kind,
    config: wakeConfig,
    text,
    senderId: userId,
    senderLabel: senderName,
    quoteTargetIsSelf,
  });
  const clientMsgId = body.client_msg_id ? String(body.client_msg_id) : randomUUID();
  const existing = ctx.dbState.db.prepare(
    `SELECT id, seq, role, content_json, created_at, client_msg_id, dsh_turn,
            wake_reason, sender_user_id, sender_name, mentions, recalled_at
       FROM message WHERE conversation_id = ? AND client_msg_id = ?`,
  ).get(conversationId, clientMsgId);
  if (existing) {
    const userMessage = publicAgentMessage(existing, ctx.dbState.db, conversationId);
    if (existing.dsh_turn) {
      return {
        client_msg_id: clientMsgId,
        queued: false,
        turn_started: false,
        delivered: true,
        duplicated: true,
        message: userMessage,
      };
    }
    if (kind === 'group') {
      if (!silent && existing.wake_reason && ctx.social) {
        ctx.social.scheduleWake(conversationId, existing.wake_reason, existing.seq);
        return {
          client_msg_id: clientMsgId,
          queued: true,
          turn_started: false,
          delivered: false,
          duplicated: true,
          wake_scheduled: true,
          wake_reason: existing.wake_reason,
          message: userMessage,
        };
      }
      return {
        client_msg_id: clientMsgId,
        queued: true,
        turn_started: false,
        delivered: false,
        duplicated: true,
        wake_scheduled: false,
        wake_reason: silent ? null : (existing.wake_reason ?? null),
        message: userMessage,
      };
    }
    if (silent) {
      return {
        client_msg_id: clientMsgId,
        queued: true,
        turn_started: false,
        delivered: false,
        duplicated: true,
        wake_scheduled: false,
        wake_reason: null,
        message: userMessage,
      };
    }
    return {
      ...(await deliverWithEvent(ctx, conversation, existing, { duplicated: true })),
      message: userMessage,
    };
  }
  const rebuild = ctx.dbState.db.prepare(
    `SELECT state FROM rebuild_queue
      WHERE conversation_id = ? AND state IN ('pending','failed')
      LIMIT 1`,
  ).get(conversationId);
  if (rebuild) {
    const error = new Error(
      rebuild.state === 'failed'
        ? '权限重建失败，需人工处理'
        : '权限切换中，暂不接受新消息',
    );
    error.status = 409;
    error.code = 'rebuild-in-progress';
    error.extra = { rebuild_state: rebuild.state };
    throw error;
  }
  const limits = loadBotSettings(ctx.dbState.db).perUserLimits;
  const day = localDay();
  const now = nowMs();
  const id = randomUUID();
  const content = JSON.stringify({
    type: 'text',
    text,
    attachments,
    ...(sticker ? { sticker: { id: sticker.sticker.id, name: sticker.sticker.name } } : {}),
    ...(voice ? { voice } : {}),
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  });
  let seq;
  withTransaction(ctx.dbState.db, () => {
    const usedToday = userMessagesToday(ctx.dbState.db, userId, day);
    if (usedToday >= limits.dailyMessages) {
      const error = new Error(`今天的消息额度已用完（${limits.dailyMessages} 条）`);
      error.status = 429;
      error.code = 'quota-exceeded';
      error.extra = { limit: limits.dailyMessages, used: usedToday, day };
      throw error;
    }
    if (localAttachments.length > 0) {
      const placeholders = localAttachments.map(() => '?').join(',');
      const found = ctx.dbState.db.prepare(
        `SELECT id FROM attachment
          WHERE conversation_id = ? AND id IN (${placeholders})`,
      ).all(conversationId, ...localAttachments);
      if (found.length !== localAttachments.length) {
        const error = new Error('有附件不属于这个对话');
        error.status = 400;
        error.code = 'bad-request';
        throw error;
      }
    }
    seq = nextSeq(ctx.dbState.db, conversationId);
    ctx.dbState.db.prepare(
      `INSERT INTO message
         (id, conversation_id, role, content_json, created_at, seq, client_msg_id,
          wake_reason, sender_user_id, sender_name, mentions)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      conversationId,
      content,
      now,
      seq,
      clientMsgId,
      wakeReason,
      userId,
      senderName,
      mentions.length ? JSON.stringify(mentions) : null,
    );
    bumpUsageMessages(ctx.dbState.db, userId, 1, day, text.length);
    for (const attachmentId of localAttachments) {
      const result = ctx.dbState.db.prepare(
        'UPDATE attachment SET message_id = ? WHERE id = ? AND conversation_id = ?',
      ).run(id, attachmentId, conversationId);
      if (result.changes !== 1) {
        const error = new Error('附件挂载失败');
        error.status = 400;
        error.code = 'bad-request';
        throw error;
      }
    }
    if (sticker) {
      ctx.dbState.db.prepare(
        'UPDATE sticker SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
      ).run(new Date(now).toISOString(), sticker.sticker.id);
    }
    const previewSource = text.trim()
      || (sticker ? '[表情]' : (attachments.length ? '[附件]' : ''));
    const preview = (kind === 'group' && senderName && previewSource
      ? `${senderName}：` : '') + previewSource;
    ctx.dbState.db.prepare(
      'UPDATE conversation SET updated_at = ?, summary = ? WHERE id = ?',
    ).run(now, preview.slice(0, 80) || null, conversationId);
  });
  const row = ctx.dbState.db.prepare(
    `SELECT id, seq, role, content_json, created_at, client_msg_id, dsh_turn,
            wake_reason, sender_user_id, sender_name, mentions, recalled_at
       FROM message WHERE id = ?`,
  ).get(id);
  const userMessage = publicAgentMessage(row, ctx.dbState.db, conversationId);
  ctx.events?.publish?.(conversationId, {
    type: 'user_message',
    seq,
    at: new Date(now).toISOString(),
    message: userMessage,
  });
  ctx.social?.noteIncoming?.(conversationId);
  if (kind === 'group') {
    if (wakeReason && ctx.social) {
      ctx.social.scheduleWake(conversationId, wakeReason, seq);
      return {
        client_msg_id: clientMsgId,
        queued: true,
        turn_started: false,
        delivered: false,
        duplicated: false,
        wake_scheduled: true,
        wake_reason: wakeReason,
        message: userMessage,
      };
    }
    if (!wakeReason && ctx.social) {
      return {
        client_msg_id: clientMsgId,
        queued: true,
        turn_started: false,
        delivered: false,
        duplicated: false,
        wake_scheduled: false,
        wake_reason: null,
        message: userMessage,
      };
    }
  }
  if (silent) {
    return {
      client_msg_id: clientMsgId,
      queued: true,
      turn_started: false,
      delivered: false,
      duplicated: false,
      wake_scheduled: false,
      wake_reason: null,
      message: userMessage,
    };
  }
  return {
    ...(await deliverWithEvent(ctx, conversation, row, { duplicated: false })),
    message: userMessage,
  };
}

async function postRead(ctx, userId, conversationId, body) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  const through = Number(body.through_seq);
  if (!Number.isSafeInteger(through) || through < 0) {
    const error = new Error('through_seq must be a non-negative integer');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const maxSeq = ctx.dbState.db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?',
  ).get(conversationId).m;
  if (through > maxSeq) {
    const error = new Error(`through_seq 超过最新 seq（${maxSeq}）`);
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const next = Math.max(Number(conversation.last_read_seq) || 0, through);
  ctx.dbState.db.prepare(
    `UPDATE conversation_member
        SET last_read_seq = ?
      WHERE conversation_id = ? AND user_id = ?`,
  ).run(next, conversationId, userId);
  if (next > (Number(conversation.last_read_seq) || 0)) {
    try {
      ctx.events?.publishUser?.(userId, {
        v: 1,
        type: 'conversation.read',
        conversationId,
        epoch: conversation.epoch,
        lastReadSeq: next,
        userId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      ctx.logger?.warn?.(`[read] publish 失败: ${error?.message ?? error}`);
    }
  }
  return {
    conversation_id: conversationId,
    epoch: conversation.epoch,
    user_read_seq: next,
    last_read_seq: next,
  };
}

async function postPolicy(ctx, auth, conversationId, body) {
  requireAdmin(auth);
  const userId = auth.userId;
  const conversation = ownedConversation(ctx, conversationId, userId);
  const policy = String(body.policy || '');
  if (policy !== 'restricted' && policy !== 'owner') {
    const error = new Error('policy must be restricted or owner');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  assertOwnerAllowed(ctx, userId, policy);
  if (conversation.policy === policy) {
    const queued = ctx.dbState.db.prepare(
      'SELECT state FROM rebuild_queue WHERE conversation_id = ?',
    ).get(conversationId);
    return {
      policy,
      dsh_session_id: null,
      agent_token_rotated: false,
      rebuilt: false,
      rebuild_pending: Boolean(queued),
      rebuild_state: queued?.state ?? null,
    };
  }
  const now = nowMs();
  withTransaction(ctx.dbState.db, () => {
    ctx.dbState.db.prepare(
      'UPDATE conversation SET policy = ?, policy_hash = ?, updated_at = ? WHERE id = ?',
    ).run(policy, policyHash(policy, conversation.user_id), now, conversationId);
    ctx.dbState.db.prepare('DELETE FROM rebuild_queue WHERE conversation_id = ?').run(conversationId);
    ctx.dbState.db.prepare(
      'INSERT INTO rebuild_queue(conversation_id, reason, next_attempt_at, created_at) VALUES (?, ?, ?, ?)',
    ).run(conversationId, `policy:${policy}`, now, now);
  });
  return {
    policy,
    dsh_session_id: null,
    agent_token_rotated: false,
    rebuilt: false,
    rebuild_pending: true,
    rebuild_state: 'pending',
  };
}

function listMembers(ctx, userId, conversationId) {
  ownedConversation(ctx, conversationId, userId);
  const rows = ctx.dbState.db.prepare(
    `SELECT m.user_id, m.display_name, m.role, m.is_admin, m.joined_at, m.last_read_seq,
            m.join_seq,
            u.username, u.display_name AS user_display_name, u.avatar
       FROM conversation_member m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at ASC`,
  ).all(conversationId);
  return {
    members: rows.map((row) => ({
      user_id: row.user_id,
      display_name: memberDisplayName(row) || row.user_id,
      username: row.username ?? null,
      has_avatar: Boolean(row.avatar),
      avatar_version: avatarVersion(row.avatar),
      role: row.role === 'member' && row.is_admin ? 'admin' : row.role,
      is_admin: Boolean(row.is_admin),
      joined_at: row.joined_at,
      join_seq: row.join_seq,
      last_read_seq: row.last_read_seq,
    })),
  };
}

function avatarVersion(value) {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null;
}

/** 单个成员：头像点击后只取这一个人，不再拉整份名单。 */
function getMember(ctx, userId, conversationId, targetId) {
  ownedConversation(ctx, conversationId, userId);
  const row = conversationMember(ctx.dbState.db, conversationId, targetId);
  if (!row) {
    const error = new Error('成员不存在');
    error.status = 404;
    error.code = 'member-not-found';
    throw error;
  }
  return {
    member: {
      user_id: row.user_id,
      display_name: memberDisplayName(row) || row.user_id,
      username: row.username ?? null,
      has_avatar: Boolean(row.avatar),
      avatar_version: avatarVersion(row.avatar),
      role: row.role === 'member' && row.is_admin ? 'admin' : row.role,
      is_admin: Boolean(row.is_admin),
      joined_at: row.joined_at,
      join_seq: row.join_seq,
      last_read_seq: row.last_read_seq,
    },
  };
}

function auditMember(ctx, actorUserId, action, conversationId, targetUserId) {
  ctx.dbState.db.prepare(
    `INSERT INTO audit_log(actor_user_id, action, target, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    actorUserId,
    action,
    conversationId,
    JSON.stringify({ userId: targetUserId }),
    nowMs(),
  );
}

export function insertConversationMember(
  db,
  conversationId,
  userId,
  { role = 'member', displayName = null, joinedAt = nowMs() } = {},
) {
  const joinSeq = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM message WHERE conversation_id = ?',
  ).get(conversationId).seq;
  db.prepare(
    `INSERT INTO conversation_member
       (conversation_id, user_id, display_name, role, joined_at, join_seq, last_read_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conversationId,
    userId,
    displayName,
    role,
    joinedAt,
    joinSeq,
    joinSeq,
  );
  return {
    user_id: userId,
    display_name: displayName,
    role,
    joined_at: joinedAt,
    join_seq: joinSeq,
    last_read_seq: joinSeq,
  };
}

export function emitConversationCreated(ctx, userId, conversation, reason = 'created') {
  if (!ctx?.events?.publishUser) return;
  try {
    ctx.events.publishUser(userId, {
      v: 1,
      type: 'conversation.created',
      conversationId: conversation.id,
      kind: conversation.kind || 'direct',
      title: conversation.title || '新的对话',
      epoch: Number(conversation.epoch) || 1,
      latestSeq: 0,
      reason,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger?.warn?.(`[conversation] created 事件失败: ${error?.message ?? error}`);
  }
}

function closeMemberStreams(ctx, conversationId, userId) {
  const key = `${conversationId}:${userId}`;
  const connections = ctx.sseMemberConnections?.get(key);
  if (!connections) return;
  for (const cleanup of [...connections]) cleanup();
  ctx.sseMemberConnections.delete(key);
}

/**
 * 吊销设备时断开该设备的流。cleanup 会从全局 Set 和按用户 Map 里删自己，
 * 所以先拷贝再遍历，避免边遍历边改集合；两个容器都清，健康计数才会回落。
 */
export function closeStreamsForDevice(ctx, userId, deviceId) {
  let closed = 0;
  for (const cleanup of [...(ctx.sseConnections ?? [])]) {
    if (cleanup.userId !== userId || cleanup.deviceId !== deviceId) continue;
    cleanup();
    closed += 1;
  }
  const remaining = ctx.sseUserConnections?.get(userId);
  if (remaining) {
    for (const cleanup of [...remaining]) {
      if (cleanup.userId === userId && cleanup.deviceId === deviceId) {
        cleanup();
        closed += 1;
      }
    }
    if (remaining.size === 0) ctx.sseUserConnections.delete(userId);
  }
  return closed;
}

function addMember(ctx, userId, conversationId, body) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  const caller = conversationMember(ctx.dbState.db, conversationId, userId);
  if (conversation.user_id !== userId || caller?.role !== 'owner') {
    const error = new Error('只有会话 owner 能添加成员');
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  }
  if (conversation.kind !== 'group') {
    const error = new Error('成员管理只对群聊开放（M7b）');
    error.status = 400;
    error.code = 'group-only';
    throw error;
  }
  const targetId = String(body.user_id ?? body.userId ?? '').trim();
  if (!targetId) {
    const error = new Error('user_id 必填');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const target = ctx.dbState.db.prepare(
    'SELECT id, username, display_name, disabled_at FROM users WHERE id = ?',
  ).get(targetId);
  if (!target || target.disabled_at) {
    const error = new Error('用户不存在或已停用');
    error.status = 404;
    error.code = 'user-not-found';
    throw error;
  }
  const existing = conversationMember(ctx.dbState.db, conversationId, targetId);
  if (existing) {
    const error = new Error('该用户已经是会话成员');
    error.status = 409;
    error.code = 'member-exists';
    throw error;
  }
  const now = nowMs();
  let insertedMember;
  withTransaction(ctx.dbState.db, () => {
    insertedMember = insertConversationMember(
      ctx.dbState.db,
      conversationId,
      targetId,
      {
        displayName: target.display_name || target.username || null,
        joinedAt: now,
      },
    );
    auditMember(ctx, userId, 'member.add', conversationId, targetId);
  });
  emitConversationCreated(ctx, targetId, {
    id: conversationId,
    kind: conversation.kind,
    title: conversation.title,
    epoch: conversation.epoch,
  }, 'joined');
  return {
    ok: true,
    member: {
      ...insertedMember,
      display_name: insertedMember.display_name || targetId,
    },
  };
}

function removeMember(ctx, userId, conversationId, targetId) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  const caller = conversationMember(ctx.dbState.db, conversationId, userId);
  const removingSelf = String(targetId) === String(userId);
  const isOwner = caller?.role === 'owner';
  const isAdmin = caller?.role === 'member' && Boolean(caller?.is_admin);
  if (conversation.kind !== 'group') {
    const error = new Error('成员管理只对群聊开放（M7b）');
    error.status = 400;
    error.code = 'group-only';
    throw error;
  }
  const target = conversationMember(ctx.dbState.db, conversationId, targetId);
  if (!target) {
    const error = new Error('成员不存在');
    error.status = 404;
    error.code = 'member-not-found';
    throw error;
  }
  if (target.role === 'owner') {
    const error = new Error('owner 不能退群，请先转让或解散');
    error.status = 409;
    error.code = 'cannot-remove-owner';
    throw error;
  }
  if (!removingSelf && !isOwner) {
    if (!isAdmin || target.is_admin) {
      const error = new Error('只有 owner 能移除管理员');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
  }
  withTransaction(ctx.dbState.db, () => {
    ctx.dbState.db.prepare(
      'DELETE FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
    ).run(conversationId, targetId);
    auditMember(ctx, userId, removingSelf ? 'member.leave' : 'member.remove', conversationId, targetId);
  });
  try {
    ctx.events?.publishUser?.(targetId, {
      v: 1,
      type: 'conversation.deleted',
      conversationId,
      epoch: conversation.epoch,
      reason: removingSelf ? 'left' : 'member-removed',
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger?.warn?.(`[member] publish deletion 失败: ${error?.message ?? error}`);
  }
  closeMemberStreams(ctx, conversationId, targetId);
  return { ok: true, removed: targetId };
}

/** 群改名 / 群公告。owner 改名字，owner 或 admin 改公告。 */
function updateConversation(ctx, userId, conversationId, body) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  if (conversation.kind !== 'group') {
    const error = new Error('只有群聊能改名或设置公告');
    error.status = 400;
    error.code = 'group-only';
    throw error;
  }
  const caller = conversationMember(ctx.dbState.db, conversationId, userId);
  const isOwner = caller?.role === 'owner';
  const isAdmin = caller?.role === 'member' && Boolean(caller?.is_admin);
  const patch = {};
  if (body.title !== undefined) {
    if (!isOwner) {
      const error = new Error('只有群主能改群名');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
    const title = String(body.title ?? '').trim();
    if (!title || title.length > 30) {
      const error = new Error('群名称必须是 1~30 字');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    patch.title = title;
  }
  if (body.announcement !== undefined) {
    if (!isOwner && !isAdmin) {
      const error = new Error('只有群主或管理员能改公告');
      error.status = 403;
      error.code = 'forbidden';
      throw error;
    }
    const announcement = String(body.announcement ?? '').trim();
    if (announcement.length > 500) {
      const error = new Error('群公告最多 500 字');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    patch.announcement = announcement || null;
  }
  if (Object.keys(patch).length === 0) {
    const error = new Error('至少要改 title 或 announcement 之一');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const now = nowMs();
  const columns = Object.keys(patch);
  ctx.dbState.db.prepare(
    `UPDATE conversation SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
      WHERE id = ?`,
  ).run(...columns.map((c) => patch[c]), now, conversationId);
  const nextTitle = patch.title ?? conversation.title;
  const nextAnnouncement = patch.announcement !== undefined
    ? patch.announcement
    : conversation.announcement ?? null;
  try {
    ctx.events?.publish?.(conversationId, {
      v: 1,
      type: 'conversation.updated',
      conversationId,
      title: nextTitle,
      announcement: nextAnnouncement,
      at: new Date(now).toISOString(),
    });
  } catch (error) {
    ctx.logger?.warn?.(`[conversation] updated 事件失败: ${error?.message ?? error}`);
  }
  return {
    ok: true,
    conversation: {
      id: conversationId,
      title: nextTitle,
      announcement: nextAnnouncement,
    },
  };
}

function setMemberRole(ctx, userId, conversationId, targetId, body) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  if (conversation.kind !== 'group') {
    const error = new Error('成员角色只对群聊开放');
    error.status = 400;
    error.code = 'group-only';
    throw error;
  }
  const caller = conversationMember(ctx.dbState.db, conversationId, userId);
  if (caller?.role !== 'owner') {
    const error = new Error('只有群主能设置管理员');
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  }
  const role = String(body.role ?? '').trim();
  if (role !== 'admin' && role !== 'member') {
    const error = new Error('role 必须是 admin 或 member');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const target = conversationMember(ctx.dbState.db, conversationId, targetId);
  if (!target) {
    const error = new Error('成员不存在');
    error.status = 404;
    error.code = 'member-not-found';
    throw error;
  }
  if (target.role === 'owner') {
    const error = new Error('群主角色不能被修改');
    error.status = 409;
    error.code = 'cannot-change-owner';
    throw error;
  }
  ctx.dbState.db.prepare(
    'UPDATE conversation_member SET is_admin = ? WHERE conversation_id = ? AND user_id = ?',
  ).run(role === 'admin' ? 1 : 0, conversationId, targetId);
  auditMember(ctx, userId, 'member.role', conversationId, targetId);
  return {
    ok: true,
    member: {
      user_id: targetId,
      display_name: memberDisplayName(target) || targetId,
      role,
      is_admin: role === 'admin',
    },
  };
}

/** 解散群：软删，列表和所有按会话鉴权的入口都看不到。 */
function deleteConversation(ctx, userId, conversationId) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  if (conversation.kind !== 'group') {
    const error = new Error('只有群聊能解散');
    error.status = 400;
    error.code = 'group-only';
    throw error;
  }
  const caller = conversationMember(ctx.dbState.db, conversationId, userId);
  if (caller?.role !== 'owner') {
    const error = new Error('只有群主能解散群聊');
    error.status = 403;
    error.code = 'forbidden';
    throw error;
  }
  const now = nowMs();
  ctx.dbState.db.prepare(
    'UPDATE conversation SET deleted_at = ?, updated_at = ? WHERE id = ?',
  ).run(now, now, conversationId);
  const members = ctx.dbState.db.prepare(
    'SELECT user_id FROM conversation_member WHERE conversation_id = ?',
  ).all(conversationId);
  try {
    ctx.events?.publish?.(conversationId, {
      v: 1,
      type: 'conversation.deleted',
      conversationId,
      reason: 'dissolved',
      at: new Date(now).toISOString(),
    });
  } catch (error) {
    ctx.logger?.warn?.(`[conversation] dissolve 事件失败: ${error?.message ?? error}`);
  }
  for (const member of members) {
    closeMemberStreams(ctx, conversationId, member.user_id);
  }
  return { ok: true, deleted: conversationId };
}

/** 撤回：本人 2 分钟内；群主在群里随时可以撤回别人的消息。 */
function recallMessage(ctx, userId, conversationId, messageId) {
  const conversation = ownedConversation(ctx, conversationId, userId);
  const row = ctx.dbState.db.prepare(
    `SELECT id, seq, role, created_at, sender_user_id, recalled_at
       FROM message WHERE id = ? AND conversation_id = ?`,
  ).get(messageId, conversationId);
  if (!row) {
    const error = new Error('消息不存在');
    error.status = 404;
    error.code = 'message-not-found';
    throw error;
  }
  if (row.recalled_at) {
    return { ok: true, already: true, messageId, seq: row.seq };
  }
  if (row.role !== 'user') {
    const error = new Error('只能撤回用户消息');
    error.status = 403;
    error.code = 'recall-forbidden';
    throw error;
  }
  const caller = conversationMember(ctx.dbState.db, conversationId, userId);
  const isGroupOwner = conversation.kind === 'group' && caller?.role === 'owner';
  const withinWindow = row.sender_user_id === userId
    && nowMs() - Number(row.created_at) <= 120_000;
  if (!withinWindow && !isGroupOwner) {
    const error = new Error('只能在 2 分钟内撤回自己的消息');
    error.status = 403;
    error.code = 'recall-forbidden';
    throw error;
  }
  const now = nowMs();
  withTransaction(ctx.dbState.db, () => {
    ctx.dbState.db.prepare(
      `UPDATE message
          SET recalled_at = ?, content_json = '{"type":"text","text":""}'
        WHERE id = ?`,
    ).run(now, messageId);
    ctx.dbState.db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?')
      .run(now, conversationId);
  });
  try {
    ctx.events?.publish?.(conversationId, {
      v: 1,
      type: 'message.recalled',
      conversationId,
      messageId,
      seq: row.seq,
      at: new Date(now).toISOString(),
    });
  } catch (error) {
    ctx.logger?.warn?.(`[message] recalled 事件失败: ${error?.message ?? error}`);
  }
  return { ok: true, messageId, seq: row.seq };
}

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return null;
  try {
    return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    return null;
  }
}

const STREAM_MAX_BUFFER_BYTES = (() => {
  const value = Number(process.env.TIDE_STREAM_MAX_BUFFER_BYTES ?? 1024 * 1024);
  return Number.isSafeInteger(value) && value > 0 ? value : 1024 * 1024;
})();
const STREAM_REPLAY_TOTAL_LIMIT = (() => {
  const value = Number(process.env.TIDE_STREAM_REPLAY_TOTAL_LIMIT ?? 3000);
  return Number.isSafeInteger(value) && value > 0 ? value : 3000;
})();
const MAX_SINCE_ENTRIES = 100;

function streamBadRequest(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'bad-request';
  return error;
}

function parseSince(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { globalSeq: null, byConversation: new Map() };
  }
  if (raw.length > 8192) throw streamBadRequest('since 过长');
  if (/^\d+$/.test(raw)) {
    const seq = Number(raw);
    if (!Number.isSafeInteger(seq)) throw streamBadRequest('since 必须是非负整数');
    return { globalSeq: seq, byConversation: new Map() };
  }
  const byConversation = new Map();
  for (const part of raw.split(',')) {
    const fields = part.split(':');
    if (fields.length !== 3) throw streamBadRequest('since 必须是 cid:epoch:seq 列表');
    const [conversationId, epochRaw, seqRaw] = fields;
    const epoch = Number(epochRaw);
    const seq = Number(seqRaw);
    if (!conversationId
      || !Number.isSafeInteger(epoch) || epoch < 0
      || !Number.isSafeInteger(seq) || seq < 0) {
      throw streamBadRequest('since 必须是 cid:epoch:seq 列表');
    }
    const previous = byConversation.get(conversationId);
    if (!previous
      || epoch > previous.epoch
      || (epoch === previous.epoch && seq > previous.seq)) {
      byConversation.set(conversationId, { epoch, seq });
    }
  }
  if (byConversation.size > MAX_SINCE_ENTRIES) throw streamBadRequest('since cursor 过多');
  return { globalSeq: null, byConversation };
}

function listUserConversations(ctx, userId) {
  return ctx.dbState.db.prepare(
    `SELECT c.id, c.kind, c.title, c.epoch,
            m.join_seq, m.last_read_seq,
            (SELECT COALESCE(MAX(msg.seq), 0)
               FROM message msg
              WHERE msg.conversation_id = c.id) AS latest_seq,
            (SELECT COUNT(*)
               FROM message msg
              WHERE msg.conversation_id = c.id
                AND msg.seq > m.last_read_seq
                AND NOT (msg.role = 'user' AND msg.sender_user_id = m.user_id)) AS unread
       FROM conversation c
       JOIN conversation_member m ON m.conversation_id = c.id
      WHERE m.user_id = ? AND c.deleted_at IS NULL
      ORDER BY c.updated_at DESC`,
  ).all(userId);
}

function buildReplayPlan(ctx, row, since, remainingReplay) {
  const cursor = since.byConversation.get(row.id)
    ?? (since.globalSeq !== null ? { epoch: row.epoch, seq: since.globalSeq } : null);
  if (!cursor) {
    return { skip: false, rows: [], baselineSeq: Number(row.latest_seq) || 0 };
  }
  if (cursor.epoch !== row.epoch) {
    return {
      skip: true,
      rows: [],
      baselineSeq: Number(row.latest_seq) || 0,
      epochChanged: true,
    };
  }
  if (cursor.seq > row.latest_seq) {
    return {
      skip: true,
      rows: [],
      baselineSeq: Number(row.latest_seq) || 0,
      cursorAhead: true,
    };
  }
  const queryLimit = Math.min(
    STREAM_REPLAY_LIMIT + 1,
    Math.max(0, remainingReplay) + 1,
  );
  const rows = ctx.dbState.db.prepare(
    `SELECT id, seq, role, content_json, created_at, client_msg_id,
            wake_reason, sender_user_id, sender_name, mentions, recalled_at
       FROM message
      WHERE conversation_id = ? AND seq > ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
  ).all(row.id, cursor.seq, Number(row.join_seq) || 0, queryLimit);
  if (rows.length > STREAM_REPLAY_LIMIT || rows.length > remainingReplay) {
    return {
      skip: true,
      rows: [],
      baselineSeq: Number(row.latest_seq) || 0,
      replaySkipped: true,
    };
  }
  return { skip: false, rows, baselineSeq: cursor.seq };
}

function userMessageEvent(ctx, row, message) {
  const createdAt = new Date(message.created_at).toISOString();
  return {
    v: 1,
    type: message.role === 'user' ? 'user_message' : 'assistant_message',
    conversationId: row.id,
    epoch: row.epoch,
    seq: message.seq,
    messageId: message.id,
    createdAt,
    at: createdAt,
    message: publicAgentMessage(message, ctx.dbState.db, row.id),
  };
}

function isMessageEvent(event) {
  return event.type === 'user_message' || event.type === 'assistant_message';
}

export function flushBuffered(buffered, lastSentSeq, send) {
  let sent = 0;
  let dropped = 0;
  for (const event of buffered) {
    if (event.conversationId
      && isMessageEvent(event)
      && Number.isSafeInteger(event.seq)
      && event.seq <= (lastSentSeq.get(event.conversationId) ?? 0)) {
      dropped += 1;
      continue;
    }
    if (send(event) === false) break;
    sent += 1;
  }
  buffered.length = 0;
  return { sent, dropped };
}

export async function handleUserStream(req, res, url, ctx) {
  const auth = await ctx.auth.authenticate(req);
  if ((ctx.realtimeModeForUser?.(auth.userId) ?? 'legacy') !== 'user') {
    const error = new Error('用户级流未启用');
    error.status = 409;
    error.code = 'realtime-legacy';
    throw error;
  }
  const since = parseSince(url.searchParams.get('since') ?? url.searchParams.get('since_seq'));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let closed = false;
  let replaying = true;
  let blocked = false;
  let strikes = 0;
  let unsubscribe = () => {};
  let heartbeat = null;
  let pressureTimer = null;
  const buffered = [];
  const lastSentSeq = new Map();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (ctx.realtimeStats) ctx.realtimeStats.connectionsClosed += 1;
    if (heartbeat) clearInterval(heartbeat);
    if (pressureTimer) clearInterval(pressureTimer);
    unsubscribe();
    ctx.sseConnections?.delete(cleanup);
    const connections = ctx.sseUserConnections?.get(auth.userId);
    connections?.delete(cleanup);
    if (connections?.size === 0) ctx.sseUserConnections.delete(auth.userId);
    try { res.end(); } catch {}
  };
  cleanup.userId = auth.userId;
  cleanup.deviceId = auth.deviceId;

  const send = (event) => {
    if (closed) return false;
    const type = event.type ?? 'message';
    const result = sseWrite(res, type, event);
    if (result === null) {
      cleanup();
      return false;
    }
    if (!result) blocked = true;
    if (event.conversationId && isMessageEvent(event) && Number.isSafeInteger(event.seq)) {
      lastSentSeq.set(
        event.conversationId,
        Math.max(lastSentSeq.get(event.conversationId) ?? 0, event.seq),
      );
    }
    return true;
  };

  unsubscribe = ctx.events?.subscribeUser?.(auth.userId, (event) => {
    if (closed) return;
    if (replaying) {
      buffered.push(event);
      return;
    }
    send(event);
  }) ?? (() => {});
  ctx.sseConnections?.add(cleanup);
  let connections = ctx.sseUserConnections?.get(auth.userId);
  if (!connections) {
    connections = new Set();
    ctx.sseUserConnections?.set(auth.userId, connections);
  }
  connections.add(cleanup);
  if (ctx.realtimeStats) ctx.realtimeStats.connectionsOpened += 1;

  const rows = listUserConversations(ctx, auth.userId);
  let remainingReplay = STREAM_REPLAY_TOTAL_LIMIT;
  const entries = rows.map((row) => {
    const plan = buildReplayPlan(ctx, row, since, remainingReplay);
    if (!plan.skip) remainingReplay -= plan.rows.length;
    return { row, plan };
  });
  for (const { row, plan } of entries) {
    lastSentSeq.set(row.id, Number(plan.baselineSeq) || 0);
    if (ctx.realtimeStats) ctx.realtimeStats.replayEvents += plan.rows.length;
    if (plan.replaySkipped) ctx.realtimeStats.replaySkipped += 1;
    if (plan.epochChanged) ctx.realtimeStats.epochChanged += 1;
    if (plan.cursorAhead) ctx.realtimeStats.cursorAhead += 1;
  }

  const ready = {
    v: 1,
    type: 'ready',
    latestSeq: rows.reduce(
      (max, row) => Math.max(max, Number(row.latest_seq) || 0),
      0,
    ),
    serverTime: new Date().toISOString(),
    conversations: entries.map(({ row, plan }) => ({
      conversationId: row.id,
      title: row.title,
      kind: row.kind,
      epoch: row.epoch,
      latestSeq: Number(row.latest_seq) || 0,
      lastSentSeq: Number(plan.baselineSeq) || 0,
      lastReadSeq: Number(row.last_read_seq) || 0,
      joinSeq: Number(row.join_seq) || 0,
      unread: Number(row.unread) || 0,
      replaySkipped: Boolean(plan.replaySkipped),
      epochChanged: Boolean(plan.epochChanged),
      cursorAhead: Boolean(plan.cursorAhead),
    })),
  };
  send(ready);
  writeEvent(ctx.dbState.db, {
    kind: 'sse.open',
    detail: { mode: 'user', userId: auth.userId },
  });

  for (const { row, plan } of entries) {
    if (closed) return;
    if (!plan.epochChanged) continue;
    send({
      v: 1,
      type: 'conversation.rebuilt',
      conversationId: row.id,
      epoch: row.epoch,
      seq: Number(row.latest_seq) || 0,
      reason: 'epoch-mismatch',
      createdAt: new Date().toISOString(),
    });
  }

  // 本段必须保持同步：一旦出现 await，buffered 与 flushBuffered 就会成为真实主路径。
  const memberExists = ctx.dbState.db.prepare(
    'SELECT 1 AS ok FROM conversation_member WHERE conversation_id = ? AND user_id = ? LIMIT 1',
  );
  for (const { row, plan } of entries) {
    if (closed) return;
    if (!memberExists.get(row.id, auth.userId)) continue;
    for (const message of plan.rows) {
      if (closed) return;
      send(userMessageEvent(ctx, row, message));
    }
  }

  replaying = false;
  flushBuffered(buffered, lastSentSeq, send);

  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref?.();
  pressureTimer = setInterval(() => {
    if (!blocked || res.writableLength <= STREAM_MAX_BUFFER_BYTES) {
      strikes = 0;
      return;
    }
    strikes += 1;
    if (strikes >= 2) cleanup();
  }, 5_000);
  pressureTimer.unref?.();

  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function streamConversation(req, res, url, ctx, userId, conversationId, deviceId) {
  const member = ownedConversation(ctx, conversationId, userId);
  const joinSeq = Number(member.join_seq) || 0;
  const sinceRaw = url.searchParams.get('since_seq');
  const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw);
  if (since !== null && (!Number.isSafeInteger(since) || since < 0)) {
    const error = new Error('since_seq 必须是非负整数');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const latest = ctx.dbState.db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ? AND seq > ?',
  ).get(conversationId, joinSeq).m;
  sseWrite(res, 'ready', {
    // type 与 SSE 的 event 名重复一次：客户端既有只读 `event:` 行的实现，也有只读 data.type 的，
    // 少一份就有一边收不到（Android 侧目前读 data.type）。
    v: 1,
    type: 'ready',
    conversationId,
    epoch: member.epoch,
    latestSeq: latest,
    at: new Date().toISOString(),
  });
  writeEvent(ctx.dbState.db, {
    kind: 'sse.open',
    detail: { mode: 'legacy', userId, conversationId },
  });

  if (since !== null) {
    const replayAfter = Math.max(Number(since) || 0, joinSeq);
    const rows = ctx.dbState.db.prepare(
      `SELECT id, seq, role, content_json, created_at, client_msg_id,
              wake_reason, sender_user_id, sender_name, mentions, recalled_at
         FROM message WHERE conversation_id = ? AND seq > ?
        ORDER BY seq ASC`,
    ).all(conversationId, replayAfter);
    for (const row of rows) {
      sseWrite(res, row.role === 'user' ? 'user_message' : 'assistant_message', {
        message: publicAgentMessage(row, ctx.dbState.db, conversationId),
      });
    }
  }

  let closed = false;
  let unsubscribe = () => {};
  const memberKey = `${conversationId}:${userId}`;
  const memberExists = ctx.dbState.db.prepare(
    'SELECT 1 AS ok FROM conversation_member WHERE conversation_id = ? AND user_id = ? LIMIT 1',
  );
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n');
  }, 20_000);
  heartbeat.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    ctx.sseConnections?.delete(cleanup);
    const connections = ctx.sseMemberConnections?.get(memberKey);
    connections?.delete(cleanup);
    if (connections?.size === 0) ctx.sseMemberConnections.delete(memberKey);
    try { res.end(); } catch {}
  };
  cleanup.userId = userId;
  cleanup.deviceId = deviceId;
  ctx.sseConnections?.add(cleanup);
  let memberConnections = ctx.sseMemberConnections?.get(memberKey);
  if (!memberConnections) {
    memberConnections = new Set();
    ctx.sseMemberConnections?.set(memberKey, memberConnections);
  }
  memberConnections.add(cleanup);
  unsubscribe = ctx.events?.subscribe?.(conversationId, (event) => {
    if (closed) return;
    // SSE 是长连接：建流时鉴权一次不够。成员被踢或退群后，下一条事件到达时
    // 必须重新验 member，否则旧连接还能继续看直播。
    if (!memberExists.get(conversationId, userId)) {
      cleanup();
      return;
    }
    const payload = { ...event };
    if (!payload.message && payload.seq) {
      const row = ctx.dbState.db.prepare(
        `SELECT id, seq, role, content_json, created_at, client_msg_id,
                wake_reason, sender_user_id, sender_name, mentions, recalled_at
           FROM message WHERE conversation_id = ? AND seq = ?`,
      ).get(conversationId, payload.seq);
      if (row) payload.message = publicAgentMessage(row, ctx.dbState.db, conversationId);
    }
    sseWrite(res, payload.type ?? 'message', payload);
  }) ?? (() => {});
  req.on('close', cleanup);
  res.on('close', cleanup);
}

export async function handleConversations(req, res, url, ctx) {
  const auth = await ctx.auth.authenticate(req);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, await listConversations(ctx, auth.userId));
  }
  if (parts.length === 1 && req.method === 'POST') {
    return sendJson(res, 201, await createConversation(ctx, auth, await readJson(req)));
  }
  if (parts.length < 2) return sendError(res, 404, 'not-found', 'route not found');

  if (parts.length === 2 && parts[1] === 'stream' && req.method === 'GET') {
    await handleUserStream(req, res, url, ctx);
    return;
  }

  const conversationId = parts[1];
  if (parts.length === 2 && req.method === 'PATCH') {
    return sendJson(res, 200, updateConversation(
      ctx, auth.userId, conversationId, await readJson(req)));
  }
  if (parts.length === 2 && req.method === 'DELETE') {
    return sendJson(res, 200, deleteConversation(ctx, auth.userId, conversationId));
  }
  if (parts.length === 3 && parts[2] === 'messages' && req.method === 'GET') {
    return sendJson(res, 200, await listMessages(ctx, auth.userId, conversationId, url));
  }
  if (parts.length === 3 && parts[2] === 'upload' && req.method === 'POST') {
    return sendJson(res, 201, await uploadAttachment(ctx, auth.userId, conversationId, req));
  }
  if (parts.length === 3 && parts[2] === 'prompt' && req.method === 'POST') {
    return sendJson(res, 200, await postPrompt(ctx, auth.userId, conversationId, await readJson(req)));
  }
  if (parts.length === 3 && parts[2] === 'read' && req.method === 'POST') {
    return sendJson(res, 200, await postRead(ctx, auth.userId, conversationId, await readJson(req)));
  }
  if (parts.length === 3 && parts[2] === 'policy' && req.method === 'POST') {
    return sendJson(res, 200, await postPolicy(ctx, auth, conversationId, await readJson(req)));
  }
  if (parts.length === 3 && parts[2] === 'members' && req.method === 'GET') {
    return sendJson(res, 200, listMembers(ctx, auth.userId, conversationId));
  }
  if (parts.length === 4 && parts[2] === 'members' && req.method === 'GET') {
    return sendJson(res, 200, getMember(ctx, auth.userId, conversationId, parts[3]));
  }
  if (parts.length === 3 && parts[2] === 'members' && req.method === 'POST') {
    return sendJson(res, 201, addMember(ctx, auth.userId, conversationId, await readJson(req)));
  }
  if (parts.length === 4 && parts[2] === 'members' && req.method === 'DELETE') {
    return sendJson(res, 200, removeMember(ctx, auth.userId, conversationId, parts[3]));
  }
  if (parts.length === 5 && parts[2] === 'members' && parts[4] === 'role'
      && req.method === 'POST') {
    return sendJson(res, 200, setMemberRole(
      ctx, auth.userId, conversationId, parts[3], await readJson(req)));
  }
  if (parts.length === 5 && parts[2] === 'messages' && parts[4] === 'recall'
      && req.method === 'POST') {
    return sendJson(res, 200, recallMessage(
      ctx, auth.userId, conversationId, parts[3]));
  }
  if (parts.length === 3 && parts[2] === 'stream' && req.method === 'GET') {
    await streamConversation(req, res, url, ctx, auth.userId, conversationId, auth.deviceId);
    return;
  }
  return sendError(res, 404, 'not-found', 'route not found');
}

export {
  addMember,
  listMembers,
  postPrompt,
  removeMember,
  setMemberRole,
};
