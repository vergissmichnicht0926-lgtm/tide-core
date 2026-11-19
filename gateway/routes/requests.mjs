/** /requests 与 /invites —— guest 申请私聊/入群、兑换群邀请码。 */

import { randomUUID } from 'node:crypto';
import { nowMs, withTransaction } from '../db/index.mjs';
import { readJson, sendJson } from '../http.mjs';
import { emitConversationCreated, insertConversationMember } from './conversations.mjs';

function httpError(status, code, message, extra) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (extra) error.extra = extra;
  return error;
}

function audit(ctx, actorUserId, action, target, detail) {
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
}

function dailyRequestCount(ctx, userId) {
  return ctx.dbState.db.prepare(
    'SELECT COUNT(*) AS n FROM join_request WHERE user_id = ? AND created_at >= ?',
  ).get(userId, nowMs() - 24 * 60 * 60 * 1000).n;
}

function listMyRequests(ctx, userId) {
  const rows = ctx.dbState.db.prepare(
    `SELECT id, kind, status, conversation_id, created_at, decided_at
       FROM join_request WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
  ).all(userId);
  return {
    ok: true,
    requests: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      conversationId: row.conversation_id,
      createdAt: new Date(row.created_at).toISOString(),
      decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    })),
  };
}

export async function handleRequests(req, res, url, ctx) {
  try {
    const auth = await ctx.auth.authenticate(req);
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (parts.length === 0 && req.method === 'POST') {
      const body = await readJson(req);
      const kind = body.kind === undefined ? 'bot' : String(body.kind);
      if (kind === 'group') {
        const conversationId = String(
          body.conversation_id ?? body.conversationId ?? '',
        ).trim();
        if (!conversationId) throw httpError(400, 'group-id-required', 'conversation_id 必填');
        const group = ctx.dbState.db.prepare(
          "SELECT id FROM conversation WHERE id = ? AND kind = 'group'",
        ).get(conversationId);
        if (!group) throw httpError(404, 'group-not-found', '群不存在');
        const member = ctx.dbState.db.prepare(
          'SELECT 1 AS ok FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
        ).get(conversationId, auth.userId);
        if (member) throw httpError(409, 'already-member', '你已经在这个群里');
        const pending = ctx.dbState.db.prepare(
          `SELECT id FROM join_request
            WHERE user_id = ? AND kind = 'group' AND conversation_id = ? AND status = 'pending'
            LIMIT 1`,
        ).get(auth.userId, conversationId);
        if (pending) {
          return sendJson(res, 200, {
            ok: true,
            requestId: pending.id,
            status: 'pending',
            conversationId,
          });
        }
        if (dailyRequestCount(ctx, auth.userId) >= 5) {
          throw httpError(429, 'too-many-requests', '今天申请次数过多');
        }
        const id = randomUUID();
        ctx.dbState.db.prepare(
          `INSERT INTO join_request(id, kind, user_id, conversation_id, status, created_at)
           VALUES (?, 'group', ?, ?, 'pending', ?)`,
        ).run(id, auth.userId, conversationId, nowMs());
        return sendJson(res, 201, {
          ok: true,
          requestId: id,
          status: 'pending',
          conversationId,
        });
      }
      if (kind !== 'bot') {
        throw httpError(400, 'request-kind-invalid', 'kind 必须是 bot 或 group');
      }
      const existing = ctx.dbState.db.prepare(
        "SELECT id FROM conversation WHERE user_id = ? AND kind = 'direct' LIMIT 1",
      ).get(auth.userId);
      if (existing) {
        throw httpError(409, 'already-has-chat', '你已经有一条和汐语的私聊了', {
          conversationId: existing.id,
        });
      }
      const pending = ctx.dbState.db.prepare(
        "SELECT id FROM join_request WHERE user_id = ? AND kind = 'bot' AND status = 'pending' LIMIT 1",
      ).get(auth.userId);
      if (pending) {
        return sendJson(res, 200, { ok: true, requestId: pending.id, status: 'pending' });
      }
      if (dailyRequestCount(ctx, auth.userId) >= 5) {
        throw httpError(429, 'too-many-requests', '今天申请次数过多');
      }
      const id = randomUUID();
      ctx.dbState.db.prepare(
        `INSERT INTO join_request(id, kind, user_id, conversation_id, status, created_at)
         VALUES (?, 'bot', ?, NULL, 'pending', ?)`,
      ).run(id, auth.userId, nowMs());
      return sendJson(res, 201, { ok: true, requestId: id, status: 'pending' });
    }
    if (
      req.method === 'GET'
      && (parts.length === 0 || (parts.length === 1 && parts[0] === 'mine'))
    ) {
      return sendJson(res, 200, listMyRequests(ctx, auth.userId));
    }
    return sendJson(res, 404, { error: { code: 'not-found', message: 'request route not found' } });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return sendJson(res, status, {
      error: {
        code: error?.code || 'internal',
        message: status >= 500 ? 'internal error' : (error?.message || 'request failed'),
        ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
      },
    });
  }
}

export async function handleInvites(req, res, url, ctx) {
  try {
    const auth = await ctx.auth.authenticate(req);
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (parts.length !== 2 || parts[1] !== 'accept' || req.method !== 'POST') {
      return sendJson(res, 404, {
        error: { code: 'not-found', message: 'invite route not found' },
      });
    }
    const code = decodeURIComponent(parts[0]);
    const invite = ctx.dbState.db.prepare('SELECT * FROM invite WHERE code = ?').get(code);
    if (!invite) throw httpError(400, 'invite-invalid', '邀请码不存在');
    if (invite.revoked_at) throw httpError(400, 'invite-revoked', '邀请码已撤销');
    if (Number(invite.expires_at) <= nowMs()) throw httpError(400, 'invite-expired', '邀请码已过期');
    if (invite.kind !== 'group') {
      throw httpError(400, 'group-invite-required', '这个邀请码不是群邀请码');
    }
    if (!invite.group_id) throw httpError(400, 'group-id-required', '群邀请码缺少群 ID');
    const group = ctx.dbState.db.prepare(
      "SELECT id, title, kind, epoch FROM conversation WHERE id = ? AND kind = 'group'",
    ).get(invite.group_id);
    if (!group) throw httpError(404, 'group-not-found', '群不存在');
    const existing = ctx.dbState.db.prepare(
      'SELECT * FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
    ).get(group.id, auth.userId);
    if (existing) {
      return sendJson(res, 200, {
        ok: true,
        alreadyMember: true,
        conversationId: group.id,
        member: existing,
      });
    }
    const profile = ctx.dbState.db.prepare(
      'SELECT username, display_name FROM users WHERE id = ?',
    ).get(auth.userId);
    let member;
    withTransaction(ctx.dbState.db, () => {
      const used = ctx.dbState.db.prepare(
        `UPDATE invite SET used_count = used_count + 1
          WHERE id = ? AND revoked_at IS NULL AND used_count < max_uses`,
      ).run(invite.id);
      if (used.changes !== 1) {
        throw httpError(400, 'invite-exhausted', '邀请码使用次数已满');
      }
      member = insertConversationMember(ctx.dbState.db, group.id, auth.userId, {
        displayName: profile?.display_name || profile?.username || null,
      });
      audit(ctx, auth.userId, 'invite.accept.group', invite.id, {
        conversationId: group.id,
      });
    });
    emitConversationCreated(ctx, auth.userId, group, 'joined');
    return sendJson(res, 200, {
      ok: true,
      alreadyMember: false,
      conversationId: group.id,
      member,
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return sendJson(res, status, {
      error: {
        code: error?.code || 'internal',
        message: status >= 500 ? 'internal error' : (error?.message || 'request failed'),
        ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
      },
    });
  }
}

export async function handleGroups(req, res, url, ctx) {
  try {
    const auth = await ctx.auth.authenticate(req);
    if (url.pathname !== '/groups/joinable' || req.method !== 'GET') {
      return sendJson(res, 404, {
        error: { code: 'not-found', message: 'group route not found' },
      });
    }
    const rows = ctx.dbState.db.prepare(
      `SELECT c.id, c.title, c.created_at,
              (SELECT COUNT(*) FROM conversation_member m2
                WHERE m2.conversation_id = c.id) AS member_count
         FROM conversation c
        WHERE c.kind = 'group'
          AND NOT EXISTS (
            SELECT 1 FROM conversation_member m
             WHERE m.conversation_id = c.id AND m.user_id = ?
          )
        ORDER BY c.updated_at DESC`,
    ).all(auth.userId);
    return sendJson(res, 200, {
      ok: true,
      groups: rows.map((row) => ({
        id: row.id,
        title: row.title,
        memberCount: row.member_count,
        createdAt: new Date(row.created_at).toISOString(),
      })),
    });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return sendJson(res, status, {
      error: {
        code: error?.code || 'internal',
        message: status >= 500 ? 'internal error' : (error?.message || 'request failed'),
      },
    });
  }
}
