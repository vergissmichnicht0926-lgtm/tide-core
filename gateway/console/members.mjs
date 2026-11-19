/** 0.26 控制台群成员管理：只复用 conversation 路由的业务函数。 */

import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import {
  addMember,
  listMembers,
  removeMember,
  setMemberRole,
} from '../routes/conversations.mjs';
import { writeConsoleChange } from './http.mjs';

function groupOnly() {
  return new ApiError(400, 'group-only', '单聊没有成员管理');
}

function assertGroup(ctx, conversationId) {
  const row = ctx.dbState.db.prepare(
    'SELECT kind FROM conversation WHERE id = ? AND deleted_at IS NULL',
  ).get(conversationId);
  if (!row) throw new ApiError(404, 'not-found', '会话不存在');
  if (row.kind !== 'group') throw groupOnly();
}

export function getMembers(ctx, session, conversationId) {
  const result = listMembers(ctx, session.user.userId, conversationId);
  assertGroup(ctx, conversationId);
  return { ok: true, members: result.members };
}

export async function addConversationMember(ctx, req, session, conversationId) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'bad-request', 'body 必须是 JSON 对象');
  }
  const result = addMember(ctx, session.user.userId, conversationId, body);
  writeConsoleChange(ctx, 'conversation.member', conversationId, {
    op: 'add',
    userId: result.member.user_id,
  });
  return result;
}

export function removeConversationMember(ctx, session, conversationId, targetId) {
  const result = removeMember(ctx, session.user.userId, conversationId, targetId);
  writeConsoleChange(ctx, 'conversation.member', conversationId, {
    op: 'remove',
    userId: targetId,
  });
  return result;
}

export async function changeConversationMemberRole(ctx, req, session, conversationId, targetId) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'bad-request', 'body 必须是 JSON 对象');
  }
  const result = setMemberRole(
    ctx,
    session.user.userId,
    conversationId,
    targetId,
    body,
  );
  writeConsoleChange(ctx, 'conversation.member', conversationId, {
    op: 'role',
    userId: targetId,
    role: body?.role ?? null,
  });
  return result;
}
