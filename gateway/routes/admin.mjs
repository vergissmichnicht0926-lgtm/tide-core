/** /admin/* —— 单 bot 的管理员接口。只认 users.role='admin'。 */

import { nowMs, withTransaction } from '../db/index.mjs';
import { readJson, sendError, sendJson } from '../http.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';
import {
  createConversationForUser,
  emitConversationCreated,
  insertConversationMember,
} from './conversations.mjs';
import {
  audit,
  createInvite,
  httpError,
  inviteView,
  listUsers,
} from './admin-data.mjs';

/**
 * P6 给 loadBotSettings 的 defaultWakeConfig 增加了 limits/hint。
 * /admin/* 是旧的 Bearer 接口，输出必须保持原样，所以这里剥掉新字段再返回。
 */
function legacySettingsView(settings) {
  const wake = settings.defaultWakeConfig && typeof settings.defaultWakeConfig === 'object'
    ? { ...settings.defaultWakeConfig }
    : settings.defaultWakeConfig;
  if (wake && typeof wake === 'object') {
    delete wake.limits;
    delete wake.hint;
  }
  // 这里固定白名单，确保 bot_settings 新增列不会泄漏到旧 Bearer 接口。
  return {
    aiName: settings.aiName,
    aiSignature: settings.aiSignature,
    aiAvatar: settings.aiAvatar,
    personaOverride: settings.personaOverride,
    model: settings.model,
    toolProfile: settings.toolProfile,
    defaultWakeConfig: wake,
    perUserLimits: settings.perUserLimits,
    updatedAt: settings.updatedAt,
  };
}

async function requireAdmin(ctx, req) {
  const auth = await ctx.auth.authenticate(req);
  if (auth.role !== 'admin') {
    throw httpError(403, 'forbidden', '只有管理员能访问这个接口');
  }
  return auth;
}

function listRequests(ctx) {
  const rows = ctx.dbState.db.prepare(
    `SELECT r.*, u.username, u.display_name, c.title AS conversation_title
       FROM join_request r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN conversation c ON c.id = r.conversation_id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC`,
  ).all();
  return {
    ok: true,
    requests: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title ?? null,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

async function approveRequest(ctx, auth, requestId) {
  const row = ctx.dbState.db.prepare(
    "SELECT * FROM join_request WHERE id = ? AND status = 'pending'",
  ).get(requestId);
  if (!row) throw httpError(404, 'request-not-found', '申请不存在或已处理');
  const applicant = ctx.dbState.db.prepare(
    'SELECT id, disabled_at FROM users WHERE id = ?',
  ).get(row.user_id);
  if (!applicant || applicant.disabled_at) {
    withTransaction(ctx.dbState.db, () => {
      ctx.dbState.db.prepare(
        `UPDATE join_request
            SET status = 'rejected', decided_by = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(auth.userId, nowMs(), requestId);
      audit(ctx, auth.userId, 'request.reject', requestId, {
        reason: 'user-disabled',
        userId: row.user_id,
        kind: row.kind,
      });
    });
    throw httpError(409, 'user-disabled', '申请用户不存在或已停用');
  }
  if (row.kind === 'group') {
    if (!row.conversation_id) throw httpError(400, 'group-id-required', '群申请缺少 conversation_id');
    const group = ctx.dbState.db.prepare(
      "SELECT id, title, kind, epoch FROM conversation WHERE id = ? AND kind = 'group'",
    ).get(row.conversation_id);
    if (!group) throw httpError(404, 'group-not-found', '群不存在');
    const profile = ctx.dbState.db.prepare(
      'SELECT username, display_name FROM users WHERE id = ?',
    ).get(row.user_id);
    const existing = ctx.dbState.db.prepare(
      'SELECT 1 AS ok FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
    ).get(group.id, row.user_id);
    withTransaction(ctx.dbState.db, () => {
      if (!existing) {
        insertConversationMember(ctx.dbState.db, group.id, row.user_id, {
          displayName: profile?.display_name || profile?.username || null,
        });
        audit(ctx, auth.userId, 'member.add', group.id, { userId: row.user_id });
      }
      ctx.dbState.db.prepare(
        `UPDATE join_request
            SET status = 'approved', decided_by = ?, decided_at = ?
          WHERE id = ?`,
      ).run(auth.userId, nowMs(), requestId);
      audit(ctx, auth.userId, 'request.approve', requestId, {
        kind: 'group',
        userId: row.user_id,
        conversationId: group.id,
      });
    });
    if (!existing) emitConversationCreated(ctx, row.user_id, group, 'joined');
    return { ok: true, kind: 'group', conversationId: group.id };
  }
  if (row.kind !== 'bot') {
    throw httpError(400, 'request-kind-invalid', '申请类型不合法');
  }
  const existing = ctx.dbState.db.prepare(
    "SELECT id FROM conversation WHERE user_id = ? AND kind = 'direct' LIMIT 1",
  ).get(row.user_id);
  const conversation = existing
    ? { id: existing.id }
    : await createConversationForUser(ctx, {
        userId: row.user_id,
        title: '汐语',
        kind: 'direct',
        enforceQuota: true,
      });
  ctx.dbState.db.prepare(
    `UPDATE join_request
        SET status = 'approved', decided_by = ?, decided_at = ?, conversation_id = ?
      WHERE id = ?`,
  ).run(auth.userId, nowMs(), conversation.id, requestId);
  audit(ctx, auth.userId, 'request.approve', requestId, { userId: row.user_id, conversationId: conversation.id });
  return { ok: true, conversationId: conversation.id };
}

function rejectRequest(ctx, auth, requestId) {
  const info = ctx.dbState.db.prepare(
    `UPDATE join_request
        SET status = 'rejected', decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(auth.userId, nowMs(), requestId);
  if (info.changes !== 1) throw httpError(404, 'request-not-found', '申请不存在或已处理');
  audit(ctx, auth.userId, 'request.reject', requestId, null);
  return { ok: true };
}

function groups(ctx) {
  const rows = ctx.dbState.db.prepare(
    `SELECT id, title, user_id, created_at, updated_at
       FROM conversation WHERE kind = 'group'
      ORDER BY updated_at DESC`,
  ).all();
  return {
    ok: true,
    groups: rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdBy: row.user_id,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
  };
}

export async function handleAdmin(req, res, url, ctx) {
  try {
    const auth = await requireAdmin(ctx, req);
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (parts.length === 0) return sendError(res, 404, 'not-found', 'admin route not found');

    if (parts[0] === 'users' && parts.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, listUsers(ctx));
    }
    if (parts[0] === 'invites' && parts.length === 1 && req.method === 'POST') {
      return sendJson(res, 201, createInvite(ctx, auth, await readJson(req)));
    }
    if (parts[0] === 'invites' && parts.length === 1 && req.method === 'GET') {
      const rows = ctx.dbState.db.prepare('SELECT * FROM invite ORDER BY created_at DESC').all();
      return sendJson(res, 200, {
        ok: true,
        invites: rows.map((row) => inviteView(row, ctx.publicBaseUrl)),
      });
    }
    if (parts[0] === 'invites' && parts[2] === 'revoke' && req.method === 'POST') {
      const info = ctx.dbState.db.prepare(
        'UPDATE invite SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      ).run(nowMs(), parts[1]);
      if (info.changes !== 1) throw httpError(404, 'invite-not-found', '邀请码不存在或已撤销');
      audit(ctx, auth.userId, 'invite.revoke', parts[1], null);
      return sendJson(res, 200, { ok: true });
    }
    if (parts[0] === 'requests' && parts.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, listRequests(ctx));
    }
    if (parts[0] === 'requests' && parts[2] === 'approve' && req.method === 'POST') {
      return sendJson(res, 200, await approveRequest(ctx, auth, parts[1]));
    }
    if (parts[0] === 'requests' && parts[2] === 'reject' && req.method === 'POST') {
      return sendJson(res, 200, rejectRequest(ctx, auth, parts[1]));
    }
    if (parts[0] === 'groups' && parts.length === 1 && req.method === 'GET') {
      return sendJson(res, 200, groups(ctx));
    }
    if (parts[0] === 'settings' && parts.length === 1) {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          settings: legacySettingsView(loadBotSettings(ctx.dbState.db)),
        });
      }
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const settings = saveBotSettings(ctx.dbState.db, body);
        audit(ctx, auth.userId, 'settings.update', 'bot_settings', { keys: Object.keys(body) });
        return sendJson(res, 200, { ok: true, settings: legacySettingsView(settings) });
      }
    }
    return sendError(res, 404, 'not-found', 'admin route not found');
  } catch (error) {
    const status = Number(error?.status) || 500;
    return sendJson(res, status, {
      error: {
        code: error?.code || 'internal',
        message: error?.message || 'internal error',
        ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
      },
    });
  }
}
