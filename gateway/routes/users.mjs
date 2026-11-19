import { sendError } from '../http.mjs';

const AVATAR_RE = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/**
 * 用户头像。只有本人和「同群成员」能取；不存在一律 404，不给探测空间。
 */
export async function handleUserAvatar(req, res, url, ctx) {
  if (req.method !== 'GET') return sendError(res, 404, 'not-found', 'route not found');
  const auth = await ctx.auth.authenticate(req);
  const parts = url.pathname.split('/').filter(Boolean);
  const targetId = parts[1];
  if (!targetId) return sendError(res, 404, 'not-found', '头像不存在');

  const db = ctx.dbState.db;
  const user = db.prepare(
    'SELECT id, avatar, disabled_at FROM users WHERE id = ?',
  ).get(targetId);
  if (!user || user.disabled_at || !user.avatar) {
    return sendError(res, 404, 'not-found', '头像不存在');
  }
  if (targetId !== auth.userId) {
    const shared = db.prepare(
      `SELECT 1 AS ok
         FROM conversation_member a
         JOIN conversation_member b ON b.conversation_id = a.conversation_id
        WHERE a.user_id = ? AND b.user_id = ?
        LIMIT 1`,
    ).get(auth.userId, targetId);
    if (!shared) return sendError(res, 404, 'not-found', '头像不存在');
  }
  const match = AVATAR_RE.exec(user.avatar);
  if (!match) return sendError(res, 404, 'not-found', '头像不存在');
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  res.writeHead(200, {
    'content-type': match[1],
    'content-length': bytes.length,
    'cache-control': 'private, max-age=86400',
  });
  res.end(bytes);
}
