/** 表情包库：列表、入库、改名/停用、软删。 */

import { randomUUID } from 'node:crypto';
import { readJson, sendError, sendJson } from '../http.mjs';
import {
  findSticker,
  isStickerVisible,
  parseStickerTags,
  readStickerName,
  readStickerTags,
  readStickerUsage,
  sanitizeStickerText,
  stickerView,
  STICKER_LIMITS,
  httpError,
} from '../stickers.mjs';

function roleOf(ctx, userId) {
  return ctx.dbState.db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role
    || 'guest';
}

function canEdit(row, userId, admin) {
  if (row.owner_user_id == null) return admin;
  return row.owner_user_id === userId;
}

function listStickers(ctx, userId, url) {
  const scope = url.searchParams.get('scope') === 'mine' ? 'mine' : 'all';
  const includeDisabled = url.searchParams.get('includeDisabled') === '1';
  const clauses = [];
  if (scope === 'mine') {
    clauses.push('owner_user_id = ?');
  } else {
    clauses.push('(owner_user_id IS NULL OR owner_user_id = ?)');
  }
  if (!includeDisabled) clauses.push('disabled_at IS NULL');
  const rows = ctx.dbState.db.prepare(
    `SELECT * FROM sticker
      WHERE ${clauses.join(' AND ')}
      ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, created_at DESC`,
  ).all(userId);
  return rows.map((row) => stickerView(row, ctx.publicBaseUrl, userId));
}

function createSticker(ctx, userId, body) {
  const attachmentId = String(body?.attachmentId ?? body?.attachment_id ?? '').trim();
  if (!attachmentId) throw httpError(400, 'bad-request', 'attachmentId 必填');
  const attachment = ctx.dbState.db.prepare(
    `SELECT a.id, a.conversation_id, a.kind, a.media_type, a.sha256, a.name
       FROM attachment a
      WHERE a.id = ?`,
  ).get(attachmentId);
  if (!attachment) throw httpError(400, 'bad-request', '附件不存在');
  const member = ctx.dbState.db.prepare(
    'SELECT 1 AS ok FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
  ).get(attachment.conversation_id, userId);
  if (!member) throw httpError(403, 'forbidden', '这个附件不在你可访问的会话里');
  if (attachment.kind !== 'image' || !/^image\//i.test(attachment.media_type || '')) {
    throw httpError(400, 'bad-request', '只有图片能做成表情');
  }

  const name = readStickerName(body);
  const usage = readStickerUsage(body);
  const tags = readStickerTags(body);

  const md5 = String(attachment.sha256 || '');
  if (md5) {
    const existing = ctx.dbState.db.prepare(
      'SELECT * FROM sticker WHERE md5 = ? LIMIT 1',
    ).get(md5);
    if (existing) {
      if (!isStickerVisible(existing, userId)) {
        throw httpError(409, 'sticker-exists', '这张图已经被别人收录');
      }
      return {
        ...stickerView(existing, ctx.publicBaseUrl, userId),
        existing: true,
      };
    }
  }

  const count = ctx.dbState.db.prepare(
    'SELECT COUNT(*) AS n FROM sticker WHERE owner_user_id = ?',
  ).get(userId).n;
  if (count >= STICKER_LIMITS.perUserMax) {
    throw httpError(
      400,
      'sticker-limit',
      `每人最多 ${STICKER_LIMITS.perUserMax} 个表情包`,
    );
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  ctx.dbState.db.prepare(
    `INSERT INTO sticker
       (id, owner_user_id, name, tags_json, usage_note, attachment_id, md5,
        use_count, last_used_at, disabled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
  ).run(
    id,
    userId,
    name,
    JSON.stringify(tags),
    usage,
    attachmentId,
    md5,
    createdAt,
  );
  const row = findSticker(ctx.dbState.db, id);
  return { ...stickerView(row, ctx.publicBaseUrl, userId), existing: false };
}

function updateSticker(ctx, userId, stickerId, body) {
  const row = findSticker(ctx.dbState.db, stickerId);
  if (!row) throw httpError(404, 'not-found', '表情包不存在');
  const admin = roleOf(ctx, userId) === 'admin';
  if (!canEdit(row, userId, admin)) {
    throw httpError(403, 'forbidden', '只能修改自己的表情包');
  }

  const name = body?.name === undefined ? row.name : readStickerName(body);
  const usage = body?.usage === undefined && body?.usage_note === undefined
    && body?.usageNote === undefined
    ? row.usage_note
    : readStickerUsage(body);
  const tags = body?.tags === undefined && body?.tags_json === undefined
    ? row.tags_json
    : JSON.stringify(parseStickerTags(body?.tags ?? body?.tags_json));

  let disabledAt = row.disabled_at;
  if (body?.disabled_at !== undefined) {
    disabledAt = body.disabled_at == null || body.disabled_at === ''
      ? null
      : sanitizeStickerText(body.disabled_at);
  } else if (body?.disabled !== undefined) {
    disabledAt = body.disabled ? new Date().toISOString() : null;
  }

  ctx.dbState.db.prepare(
    `UPDATE sticker
        SET name = ?, tags_json = ?, usage_note = ?, disabled_at = ?
      WHERE id = ?`,
  ).run(name, tags, usage, disabledAt, stickerId);
  return stickerView(findSticker(ctx.dbState.db, stickerId), ctx.publicBaseUrl, userId);
}

function deleteSticker(ctx, userId, stickerId) {
  const row = findSticker(ctx.dbState.db, stickerId);
  if (!row) throw httpError(404, 'not-found', '表情包不存在');
  const admin = roleOf(ctx, userId) === 'admin';
  if (!canEdit(row, userId, admin)) {
    throw httpError(403, 'forbidden', '只能删除自己的表情包');
  }
  if (!row.disabled_at) {
    ctx.dbState.db.prepare(
      'UPDATE sticker SET disabled_at = ? WHERE id = ?',
    ).run(new Date().toISOString(), stickerId);
  }
  return stickerView(findSticker(ctx.dbState.db, stickerId), ctx.publicBaseUrl, userId);
}

export async function handleStickers(req, res, url, ctx) {
  const auth = await ctx.auth.authenticate(req);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, { stickers: listStickers(ctx, auth.userId, url) });
  }
  if (parts.length === 1 && req.method === 'POST') {
    return sendJson(res, 200, createSticker(ctx, auth.userId, await readJson(req)));
  }
  if (parts.length === 2 && req.method === 'PATCH') {
    return sendJson(
      res,
      200,
      updateSticker(ctx, auth.userId, parts[1], await readJson(req)),
    );
  }
  if (parts.length === 2 && req.method === 'DELETE') {
    return sendJson(res, 200, deleteSticker(ctx, auth.userId, parts[1]));
  }
  return sendError(res, 404, 'not-found', 'route not found');
}
