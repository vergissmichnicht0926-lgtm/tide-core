import { randomUUID } from 'node:crypto';
import { nowMs } from '../db/index.mjs';
import { sendError, sendJson } from '../http.mjs';
import { loadBotSettings } from '../settings.mjs';

const MAX_TEXT_LENGTH = 2000;
const MAX_PER_DAY = 20;
const DAY = 24 * 60 * 60 * 1000;

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/** 私聊 = 已经添加这个 bot；没有私聊的用户看不到动态。 */
function hasDirectConversation(db, userId) {
  return Boolean(db.prepare(
    `SELECT 1 AS ok
       FROM conversation c
       JOIN conversation_member m ON m.conversation_id = c.id
      WHERE m.user_id = ? AND c.kind = 'direct'
      LIMIT 1`,
  ).get(userId));
}

function botName(ctx) {
  return loadBotSettings(ctx.dbState.db).aiName || '汐语';
}

function momentView(row, name) {
  return {
    id: row.id,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
    author: { name },
    likes: Number(row.likes) || 0,
    likedByMe: Boolean(row.liked),
  };
}

export function listMoments(ctx, userId, url) {
  const db = ctx.dbState.db;
  if (!hasDirectConversation(db, userId)) {
    return { moments: [] };
  }
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw === null || limitRaw === '' ? 30 : Number(limitRaw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw httpError(400, 'bad-request', 'limit 必须是 1~50 的整数');
  }
  const beforeRaw = url.searchParams.get('before');
  const before = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw);
  if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
    throw httpError(400, 'bad-request', 'before 必须是正整数毫秒时间戳');
  }
  const rows = db.prepare(
    `SELECT m.id, m.text, m.created_at,
            (SELECT COUNT(*) FROM moment_like l WHERE l.moment_id = m.id) AS likes,
            EXISTS(SELECT 1 FROM moment_like l2
                    WHERE l2.moment_id = m.id AND l2.user_id = ?) AS liked
       FROM moment m
      WHERE (? IS NULL OR m.created_at < ?)
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
  ).all(userId, before, before, limit);
  const name = botName(ctx);
  return { moments: rows.map((row) => momentView(row, name)) };
}

export function setMomentLike(ctx, userId, momentId, liked) {
  const db = ctx.dbState.db;
  if (!hasDirectConversation(db, userId)
      || !db.prepare('SELECT 1 AS ok FROM moment WHERE id = ?').get(momentId)) {
    throw httpError(404, 'not-found', '动态不存在');
  }
  if (liked) {
    db.prepare(
      `INSERT OR IGNORE INTO moment_like (moment_id, user_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(momentId, userId, nowMs());
  } else {
    db.prepare('DELETE FROM moment_like WHERE moment_id = ? AND user_id = ?')
      .run(momentId, userId);
  }
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM moment_like WHERE moment_id = ?',
  ).get(momentId).n;
  return { liked, likes: Number(count) || 0 };
}

/** agent 侧发布：只有私聊 session 能发，单会话每天最多 20 条。 */
export function createMomentForAgent(ctx, conversation, body) {
  if (conversation.kind !== 'direct') {
    throw httpError(400, 'not-direct', '只有私聊 bot 能发布动态');
  }
  const text = String(body?.text ?? '').trim();
  if (!text) throw httpError(400, 'bad-request', 'text 不能为空');
  if (text.length > MAX_TEXT_LENGTH) {
    throw httpError(400, 'bad-request', `text 最多 ${MAX_TEXT_LENGTH} 字`);
  }
  const db = ctx.dbState.db;
  const recent = db.prepare(
    'SELECT COUNT(*) AS n FROM moment WHERE conversation_id = ? AND created_at > ?',
  ).get(conversation.id, nowMs() - DAY).n;
  if (Number(recent) >= MAX_PER_DAY) {
    throw httpError(429, 'moment-rate-limited', '今天发布的动态太多了，明天再来');
  }
  const id = randomUUID();
  const createdAt = nowMs();
  db.prepare(
    'INSERT INTO moment (id, conversation_id, text, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, conversation.id, text, createdAt);
  return {
    moment: momentView(
      { id, text, created_at: createdAt, likes: 0, liked: 0 },
      botName(ctx),
    ),
  };
}

export async function handleMoments(req, res, url, ctx) {
  const auth = await ctx.auth.authenticate(req);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 1 && req.method === 'GET') {
    return sendJson(res, 200, listMoments(ctx, auth.userId, url));
  }
  if (parts.length === 3 && parts[2] === 'like') {
    if (req.method === 'POST') {
      return sendJson(res, 200, setMomentLike(ctx, auth.userId, parts[1], true));
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, setMomentLike(ctx, auth.userId, parts[1], false));
    }
  }
  return sendError(res, 404, 'not-found', 'route not found');
}
