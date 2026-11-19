/** 管理台邀请码：列表 / 创建 / 撤销。 */

import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { audit, createInvite as createInviteRow, inviteView } from '../routes/admin-data.mjs';
import { writeConsoleChange } from './http.mjs';

function inviteStatus(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked';
  if (Number(row.expires_at) <= now) return 'expired';
  if (Number(row.used_count) >= Number(row.max_uses)) return 'used-up';
  return 'active';
}

export function listInvites(ctx) {
  const rows = ctx.dbState.db.prepare(
    `SELECT i.*, c.title AS group_title
       FROM invite i
       LEFT JOIN conversation c ON c.id = i.group_id
      ORDER BY i.created_at DESC`,
  ).all();
  const now = Date.now();
  return {
    invites: rows.map((row) => {
      const view = inviteView(row, ctx.publicBaseUrl);
      const status = inviteStatus(row, now);
      return {
        ...view,
        status,
        groupTitle: row.group_title ?? null,
        shareable: status === 'active' && Boolean(view.joinUrl || view.webUrl),
      };
    }),
  };
}

export async function postInvite(ctx, req, session) {
  const body = await readJson(req);
  const result = createInviteRow(ctx, { userId: session.user.userId }, body ?? {});
  const invite = result.invite;
  writeConsoleChange(ctx, 'invite.create', invite.id, {
    kind: invite.kind,
    maxUses: invite.maxUses,
    groupId: invite.groupId,
  });
  return result;
}

export function revokeInvite(ctx, session, inviteId) {
  const info = ctx.dbState.db.prepare(
    'UPDATE invite SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  ).run(Date.now(), inviteId);
  if (info.changes !== 1) {
    throw new ApiError(404, 'invite-not-found', '邀请码不存在或已撤销');
  }
  audit(ctx, session.user.userId, 'invite.revoke', inviteId, null);
  writeConsoleChange(ctx, 'invite.revoke', inviteId);
  return { ok: true };
}
