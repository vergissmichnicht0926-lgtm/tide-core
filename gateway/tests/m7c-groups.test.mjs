/** M7c：群邀请码、群申请与审批。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-m7c-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    publicBaseUrl: 'https://tide.example/tide',
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin',
    password: 'password123',
    role: 'admin',
    displayName: '管理员',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest',
    password: 'password123',
    role: 'guest',
    displayName: '旅客甲',
  });
  const guest2 = await gateway.authService.createUser({
    username: 'guest2',
    password: 'password123',
    role: 'guest',
    displayName: '旅客乙',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123', device_name: 'test' }),
    });
    return (await res.json()).accessToken;
  };
  const tokens = {
    admin: await login('admin'),
    guest: await login('guest'),
    guest2: await login('guest2'),
  };
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body && typeof init.body === 'string' && !init.headers?.['content-type']
          ? { 'content-type': 'application/json' }
          : {}),
      },
    });
  return {
    dir,
    gateway,
    db: gateway.dbState.db,
    api,
    tokens,
    admin,
    guest,
    guest2,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (res) => res.json();

async function createGroup(s, title = 'M7c 群') {
  return json(await s.api('/conversations', {
    token: s.tokens.admin,
    method: 'POST',
    body: JSON.stringify({ title, kind: 'group' }),
  }));
}

test('群邀请码：已登录用户兑换入群，重复兑换不重复消费', async () => {
  const s = await makeServer();
  try {
    const group = await createGroup(s);
    const created = await s.api('/admin/invites', {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({
        kind: 'group',
        groupId: group.id,
        expiresInMinutes: 60,
        maxUses: 1,
      }),
    });
    assert.equal(created.status, 201);
    const invite = (await json(created)).invite;
    assert.equal(invite.kind, 'group');
    assert.equal(invite.groupId, group.id);
    assert.equal(
      new URL(invite.joinUrl).searchParams.get('group'),
      group.id,
    );

    const joinEvents = [];
    s.gateway.events.subscribeUser(s.guest.id, (event) => joinEvents.push(event));
    const accepted = await s.api(`/invites/${invite.code}/accept`, {
      token: s.tokens.guest,
      method: 'POST',
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = await json(accepted);
    assert.equal(acceptedBody.conversationId, group.id);
    assert.equal(acceptedBody.member.role, 'member');
    assert.equal(joinEvents.length, 1);
    assert.equal(joinEvents[0].type, 'conversation.created');
    assert.equal(joinEvents[0].conversationId, group.id);
    assert.equal(joinEvents[0].kind, 'group');
    assert.equal(joinEvents[0].title, group.title);
    assert.equal(joinEvents[0].reason, 'joined');
    assert.equal(joinEvents[0].latestSeq, 0);
    const access = await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.guest,
    });
    assert.equal(access.status, 200);

    const again = await s.api(`/invites/${invite.code}/accept`, {
      token: s.tokens.guest,
      method: 'POST',
    });
    assert.equal(again.status, 200);
    assert.equal((await json(again)).alreadyMember, true);
    assert.equal(
      s.db.prepare('SELECT used_count FROM invite WHERE id = ?').get(invite.id).used_count,
      1,
    );
    const exhausted = await s.api(`/invites/${invite.code}/accept`, {
      token: s.tokens.guest2,
      method: 'POST',
    });
    assert.equal(exhausted.status, 400);
    assert.equal((await json(exhausted)).error.code, 'invite-exhausted');
    const audit = s.db.prepare(
      "SELECT action FROM audit_log WHERE actor_user_id = ? AND action = 'invite.accept.group'",
    ).get(s.guest.id);
    assert.ok(audit);
  } finally {
    await s.close();
  }
});

test('群申请：guest 提交，管理员审批后入群；重复申请被拒', async () => {
  const s = await makeServer();
  try {
    const group = await createGroup(s);
    const directory = await json(await s.api('/groups/joinable', {
      token: s.tokens.guest,
    }));
    const listed = directory.groups.find((item) => item.id === group.id);
    assert.equal(listed.title, group.title);
    assert.equal(listed.memberCount, 1);
    const requested = await s.api('/requests', {
      token: s.tokens.guest,
      method: 'POST',
      body: JSON.stringify({ kind: 'group', conversation_id: group.id }),
    });
    assert.equal(requested.status, 201);
    const requestId = (await json(requested)).requestId;
    const mine = await json(await s.api('/requests', { token: s.tokens.guest }));
    assert.equal(mine.requests.some((item) => item.id === requestId), true);

    const pending = await json(await s.api('/admin/requests', { token: s.tokens.admin }));
    const row = pending.requests.find((item) => item.id === requestId);
    assert.equal(row.kind, 'group');
    assert.equal(row.conversationTitle, group.title);

    const joinEvents = [];
    s.gateway.events.subscribeUser(s.guest.id, (event) => joinEvents.push(event));
    const approved = await s.api(`/admin/requests/${requestId}/approve`, {
      token: s.tokens.admin,
      method: 'POST',
    });
    assert.equal(approved.status, 200);
    assert.equal((await json(approved)).conversationId, group.id);
    assert.equal(joinEvents.length, 1);
    assert.equal(joinEvents[0].type, 'conversation.created');
    assert.equal(joinEvents[0].conversationId, group.id);
    assert.equal(joinEvents[0].reason, 'joined');
    const access = await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.guest,
    });
    assert.equal(access.status, 200);
    const afterDirectory = await json(await s.api('/groups/joinable', {
      token: s.tokens.guest,
    }));
    assert.equal(afterDirectory.groups.some((item) => item.id === group.id), false);
    const actions = s.db.prepare(
      "SELECT action FROM audit_log WHERE target IN (?, ?) ORDER BY id",
    ).all(group.id, requestId).map((content) => content.action);
    assert.ok(actions.includes('member.add'));
    assert.ok(actions.includes('request.approve'));

    const duplicate = await s.api('/requests', {
      token: s.tokens.guest,
      method: 'POST',
      body: JSON.stringify({ kind: 'group', conversation_id: group.id }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await json(duplicate)).error.code, 'already-member');
  } finally {
    await s.close();
  }
});

test('群申请可拒绝；bot 邀请码不能走入群兑换；无效群邀请被拒', async () => {
  const s = await makeServer();
  try {
    const group = await createGroup(s);
    const requested = await json(await s.api('/requests', {
      token: s.tokens.guest2,
      method: 'POST',
      body: JSON.stringify({ kind: 'group', conversation_id: group.id }),
    }));
    const rejected = await s.api(`/admin/requests/${requested.requestId}/reject`, {
      token: s.tokens.admin,
      method: 'POST',
    });
    assert.equal(rejected.status, 200);
    assert.equal(
      s.db.prepare('SELECT status FROM join_request WHERE id = ?').get(requested.requestId).status,
      'rejected',
    );

    const botInvite = await json(await s.api('/admin/invites', {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', maxUses: 1 }),
    }));
    const wrongKind = await s.api(`/invites/${botInvite.invite.code}/accept`, {
      token: s.tokens.guest2,
      method: 'POST',
    });
    assert.equal(wrongKind.status, 400);
    assert.equal((await json(wrongKind)).error.code, 'group-invite-required');

    const groupInvite = await json(await s.api('/admin/invites', {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ kind: 'group', groupId: group.id, maxUses: 1 }),
    }));
    const registerWithGroupCode = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: groupInvite.invite.code,
        username: 'wrong-register',
        password: 'password123',
      }),
    });
    assert.equal(registerWithGroupCode.status, 400);
    assert.equal(
      (await json(registerWithGroupCode)).error.code,
      'group-invite-login-required',
    );

    const missingGroup = await s.api('/admin/invites', {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ kind: 'group', groupId: 'missing', maxUses: 1 }),
    });
    assert.equal(missingGroup.status, 404);
    assert.equal((await json(missingGroup)).error.code, 'group-not-found');
  } finally {
    await s.close();
  }
});

test('停用用户的 pending 群申请不能审批入群', async () => {
  const s = await makeServer();
  try {
    const group = await createGroup(s);
    const requested = await json(await s.api('/requests', {
      token: s.tokens.guest2,
      method: 'POST',
      body: JSON.stringify({ kind: 'group', conversation_id: group.id }),
    }));
    s.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?')
      .run(new Date().toISOString(), s.guest2.id);
    const approved = await s.api(`/admin/requests/${requested.requestId}/approve`, {
      token: s.tokens.admin,
      method: 'POST',
    });
    assert.equal(approved.status, 409);
    assert.equal((await json(approved)).error.code, 'user-disabled');
    assert.equal(
      s.db.prepare('SELECT status FROM join_request WHERE id = ?').get(requested.requestId).status,
      'rejected',
    );
    const audit = s.db.prepare(
      "SELECT detail_json FROM audit_log WHERE action = 'request.reject' AND target = ? ORDER BY id DESC LIMIT 1",
    ).get(requested.requestId);
    assert.equal(JSON.parse(audit.detail_json).reason, 'user-disabled');
    assert.equal(
      s.db.prepare(
        'SELECT COUNT(*) AS n FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
      ).get(group.id, s.guest2.id).n,
      0,
    );
  } finally {
    await s.close();
  }
});
