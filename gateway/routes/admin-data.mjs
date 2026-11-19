/** `/admin/*` 与 `/console/api/*` 共用的只读/管理数据逻辑。 */

import { randomBytes, randomUUID } from 'node:crypto';
import { nowMs } from '../db/index.mjs';
import { localDay } from '../settings.mjs';

export function httpError(status, code, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
}

export function audit(ctx, actorUserId, action, target, detail) {
  try {
    ctx.dbState.db.prepare(
      `INSERT INTO audit_log(actor_user_id, action, target, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      actorUserId,
      action,
      target == null ? null : String(target),
      detail === undefined ? null : JSON.stringify(detail),
      nowMs(),
    );
  } catch (error) {
    ctx.logger?.warn?.(`[admin] audit 写入失败: ${error?.message ?? error}`);
  }
}

export function inviteView(row, publicBaseUrl = '') {
  let joinUrl = null;
  if (publicBaseUrl) {
    const url = new URL('tide://join');
    url.searchParams.set('server', publicBaseUrl);
    url.searchParams.set('code', row.code);
    url.searchParams.set('kind', row.kind);
    if (row.group_id) url.searchParams.set('group', row.group_id);
    joinUrl = url.toString();
  }
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    role: row.role,
    expiresAt: new Date(row.expires_at).toISOString(),
    maxUses: row.max_uses,
    usedCount: row.used_count,
    groupId: row.group_id ?? null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    joinUrl,
    webUrl: publicBaseUrl
      ? `${publicBaseUrl}/j/${encodeURIComponent(row.code)}?k=${encodeURIComponent(row.kind)}${
        row.group_id ? `&g=${encodeURIComponent(row.group_id)}` : ''
      }`
      : null,
  };
}

export function listUsers(ctx) {
  const day = localDay();
  const rows = ctx.dbState.db.prepare(
    `SELECT u.id, u.username, u.role, u.display_name, u.created_at, u.disabled_at,
            (SELECT COUNT(*) FROM conversation c WHERE c.user_id = u.id) AS conversation_count,
            (SELECT COUNT(*) FROM message m
               JOIN conversation c ON c.id = m.conversation_id
              WHERE COALESCE(m.sender_user_id,
                             CASE WHEN m.role = 'user' THEN c.user_id END) = u.id) AS message_count,
            (SELECT MAX(m.created_at) FROM message m
               JOIN conversation c ON c.id = m.conversation_id
              WHERE COALESCE(m.sender_user_id,
                             CASE WHEN m.role = 'user' THEN c.user_id END) = u.id) AS last_active_at,
            COALESCE((SELECT messages FROM usage_daily
                       WHERE user_id = u.id AND day = ?), 0) AS today_messages
       FROM users u
      ORDER BY u.created_at ASC`,
  ).all(day);
  return {
    ok: true,
    day,
    users: rows.map((row) => ({
      userId: row.id,
      username: row.username,
      role: row.role,
      displayName: row.display_name || row.username,
      disabled: Boolean(row.disabled_at),
      conversationCount: row.conversation_count,
      messageCount: row.message_count,
      todayMessages: row.today_messages,
      lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
      createdAt: row.created_at,
    })),
  };
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 邀请码：32 字符表（去掉 0/O/1/I 与 -/_），12 位。 */
export function newInviteCode() {
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return out;
}

export function createInvite(ctx, auth, body) {
  const kind = body.kind === undefined ? 'bot' : String(body.kind);
  const role = body.role === undefined ? 'guest' : String(body.role);
  if (kind !== 'bot' && kind !== 'group') {
    throw httpError(400, 'invite-kind-invalid', 'kind 必须是 bot 或 group');
  }
  if (role !== 'guest') {
    throw httpError(400, 'invite-role-invalid', '邀请码只能创建 guest');
  }
  const expiresInMinutes = Number(body.expiresInMinutes ?? body.expires_in_minutes ?? 1440);
  if (!Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 5 || expiresInMinutes > 43_200) {
    throw httpError(400, 'bad-request', 'expiresInMinutes 必须在 5~43200 之间');
  }
  const maxUses = Number(body.maxUses ?? body.max_uses ?? 1);
  if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 100) {
    throw httpError(400, 'bad-request', 'maxUses 必须在 1~100 之间');
  }
  const now = nowMs();
  const groupIdRaw = body.groupId ?? body.group_id ?? body.conversationId ?? body.conversation_id;
  const groupId = groupIdRaw == null || groupIdRaw === '' ? null : String(groupIdRaw);
  if (kind === 'group') {
    if (!groupId) throw httpError(400, 'group-id-required', '群邀请码必须指定群 ID');
    const group = ctx.dbState.db.prepare(
      "SELECT id FROM conversation WHERE id = ? AND kind = 'group'",
    ).get(groupId);
    if (!group) throw httpError(404, 'group-not-found', '群不存在');
  } else if (groupId) {
    throw httpError(400, 'group-id-not-allowed', 'bot 邀请码不能指定群');
  }
  const id = randomUUID();
  const code = newInviteCode();
  ctx.dbState.db.prepare(
    `INSERT INTO invite
       (id, code, kind, role, expires_at, max_uses, used_count, created_by, group_id,
        revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
  ).run(
    id,
    code,
    kind,
    role,
    now + expiresInMinutes * 60_000,
    maxUses,
    auth.userId,
    groupId,
    now,
  );
  audit(ctx, auth.userId, 'invite.create', id, {
    kind,
    role,
    maxUses,
    expiresInMinutes,
    groupId,
  });
  const row = ctx.dbState.db.prepare('SELECT * FROM invite WHERE id = ?').get(id);
  const result = { ok: true, invite: inviteView(row, ctx.publicBaseUrl) };
  if (!ctx.publicBaseUrl) result.warnings = ['public-base-url-missing'];
  return result;
}
