/** 0.26 控制台收尾：群成员管理与测试发送。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-console-members-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'owner', password: 'password123', role: 'admin', displayName: '群主',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest', password: 'password123', role: 'guest', displayName: '旅客',
  });
  const guest2 = await gateway.authService.createUser({
    username: 'guest2', password: 'password123', role: 'guest', displayName: '旅客二',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const app = await gateway.authService.login({
    username: 'owner', password: 'password123', deviceName: 'console-members',
  });
  const group = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${app.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title: '成员测试群', kind: 'group' }),
  }).then((r) => r.json());
  const direct = await gateway.ctx.createDirectConversation({
    userId: admin.id,
    title: '测试发送私聊',
  });

  const loginRes = await fetch(`${base}/console/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'owner', password: 'password123' }),
  });
  const loginBody = await loginRes.json();
  const cookieMatch = (loginRes.headers.get('set-cookie') || '').match(/tide_admin=([^;]+)/);
  const cookie = cookieMatch ? `tide_admin=${cookieMatch[1]}` : '';
  const api = (p, { csrf, ...init } = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-tide-csrf': csrf } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return {
    gateway,
    base,
    db: gateway.dbState.db,
    admin,
    guest,
    guest2,
    app,
    groupId: group.id,
    directId: direct,
    login: { cookie, csrf: loginBody.csrfToken },
    api,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function membersPath(id) {
  return `/console/api/conversations/${encodeURIComponent(id)}/members`;
}

test('0.26 成员：列表、添加、角色、移出与 owner 保护', async () => {
  const s = await makeServer();
  try {
    const listed = await s.api(membersPath(s.groupId), { cookie: s.login.cookie });
    assert.equal(listed.status, 200);
    const initial = await listed.json();
    assert.equal(initial.members.length, 1);
    assert.equal(initial.members[0].role, 'owner');
    assert.equal(initial.members[0].user_id, s.admin.id);

    const direct = await s.api(membersPath(s.directId), { cookie: s.login.cookie });
    assert.equal(direct.status, 400);
    assert.equal((await direct.json()).error.code, 'group-only');

    const joined = [];
    s.gateway.events.subscribeUser(s.guest.id, (event) => joined.push(event));
    const add = await s.api(membersPath(s.groupId), {
      cookie: s.login.cookie,
      csrf: s.login.csrf,
      method: 'POST',
      body: JSON.stringify({ userId: s.guest.id }),
    });
    assert.equal(add.status, 200);
    assert.equal((await add.json()).member.user_id, s.guest.id);
    assert.equal(joined[0]?.type, 'conversation.created');
    assert.equal(joined[0]?.reason, 'joined');

    const duplicate = await s.api(membersPath(s.groupId), {
      cookie: s.login.cookie,
      csrf: s.login.csrf,
      method: 'POST',
      body: JSON.stringify({ userId: s.guest.id }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error.code, 'member-exists');

    const missing = await s.api(membersPath(s.groupId), {
      cookie: s.login.cookie,
      csrf: s.login.csrf,
      method: 'POST',
      body: JSON.stringify({ userId: 'usr_missing' }),
    });
    assert.equal(missing.status, 404);

    const promote = await s.api(
      `${membersPath(s.groupId)}/${encodeURIComponent(s.guest.id)}/role`,
      {
        cookie: s.login.cookie,
        csrf: s.login.csrf,
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      },
    );
    assert.equal(promote.status, 200);
    assert.equal(
      s.db.prepare(
        'SELECT is_admin FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
      ).get(s.groupId, s.guest.id).is_admin,
      1,
    );

    const ownerRole = await s.api(
      `${membersPath(s.groupId)}/${encodeURIComponent(s.admin.id)}/role`,
      {
        cookie: s.login.cookie,
        csrf: s.login.csrf,
        method: 'PATCH',
        body: JSON.stringify({ role: 'member' }),
      },
    );
    assert.equal(ownerRole.status, 409);
    assert.equal((await ownerRole.json()).error.code, 'cannot-change-owner');

    const removeOwner = await s.api(
      `${membersPath(s.groupId)}/${encodeURIComponent(s.admin.id)}`,
      { cookie: s.login.cookie, csrf: s.login.csrf, method: 'DELETE' },
    );
    assert.equal(removeOwner.status, 409);
    assert.equal((await removeOwner.json()).error.code, 'cannot-remove-owner');

    s.db.prepare(
      `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq,
                            sender_user_id, sender_name)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
    ).run(
      'member-history',
      s.groupId,
      JSON.stringify({ type: 'text', text: '移出后仍保留' }),
      Date.now(),
      1,
      s.guest.id,
      '旅客',
    );
    const remove = await s.api(
      `${membersPath(s.groupId)}/${encodeURIComponent(s.guest.id)}`,
      { cookie: s.login.cookie, csrf: s.login.csrf, method: 'DELETE' },
    );
    assert.equal(remove.status, 200);
    assert.equal(
      s.db.prepare(
        'SELECT COUNT(*) AS n FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
      ).get(s.groupId, s.guest.id).n,
      0,
    );
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM message WHERE id = ?').get('member-history').n,
      1,
    );
    const memberChanges = s.db.prepare(
      "SELECT detail FROM event_log WHERE kind = 'console.change'",
    ).all().filter((row) => String(row.detail || '').includes('conversation.member'));
    assert.ok(memberChanges.length >= 3, JSON.stringify(memberChanges));
    assert.deepEqual(
      s.db.prepare(
        `SELECT action FROM audit_log
          WHERE action IN ('member.add','member.role','member.remove')
          ORDER BY id`,
      ).all().map((row) => row.action),
      ['member.add', 'member.role', 'member.remove'],
    );
  } finally {
    await s.close();
  }
});

test('0.26 成员：无 CSRF / 无 session 与测试发送、静默', async () => {
  const s = await makeServer();
  try {
    const writes = [
      s.api(membersPath(s.groupId), {
        cookie: s.login.cookie,
        method: 'POST',
        body: JSON.stringify({ userId: s.guest2.id }),
      }),
      s.api(`${membersPath(s.groupId)}/${s.guest2.id}`, {
        cookie: s.login.cookie,
        method: 'DELETE',
      }),
      s.api(`${membersPath(s.groupId)}/${s.guest2.id}/role`, {
        cookie: s.login.cookie,
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      }),
      s.api(`/console/api/conversations/${s.directId}/test-message`, {
        cookie: s.login.cookie,
        method: 'POST',
        body: JSON.stringify({ text: 'x' }),
      }),
    ];
    for (const response of writes) {
      assert.equal((await response).status, 403);
    }
    const noSession = await fetch(
      `${s.base}/console/api/conversations/${s.groupId}/members`,
    );
    assert.equal(noSession.status, 401);

    for (const text of ['', '   ', 'x'.repeat(501)]) {
      const bad = await s.api(`/console/api/conversations/${s.directId}/test-message`, {
        cookie: s.login.cookie,
        csrf: s.login.csrf,
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      assert.equal(bad.status, 400);
    }

    const events = [];
    s.gateway.events.subscribe(s.directId, (event) => events.push(event));
    const before = s.db.prepare(
      "SELECT COALESCE((SELECT COUNT(*) FROM message WHERE conversation_id = ? AND role = 'user'), 0) AS n",
    ).get(s.directId).n;
    const usageBefore = s.db.prepare(
      'SELECT COALESCE(SUM(messages), 0) AS n FROM usage_daily WHERE user_id = ?',
    ).get(s.admin.id).n;
    const sent = await s.api(`/console/api/conversations/${s.directId}/test-message`, {
      cookie: s.login.cookie,
      csrf: s.login.csrf,
      method: 'POST',
      body: JSON.stringify({ text: '测试发送' }),
    });
    assert.equal(sent.status, 200);
    const result = await sent.json();
    assert.equal(typeof result.seq, 'number');
    assert.equal(result.wakeReason, 'private');
    assert.ok(events.some((event) => event.type === 'user_message'));
    assert.equal(
      s.db.prepare(
        "SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND role = 'user'",
      ).get(s.directId).n,
      before + 1,
    );
    assert.equal(
      s.db.prepare(
        'SELECT COALESCE(SUM(messages), 0) AS n FROM usage_daily WHERE user_id = ?',
      ).get(s.admin.id).n,
      usageBefore + 1,
    );

    saveBotSettings(s.db, { silentUntil: Date.now() + 60_000 });
    const silentSend = await s.api(`/console/api/conversations/${s.directId}/test-message`, {
      cookie: s.login.cookie,
      csrf: s.login.csrf,
      method: 'POST',
      body: JSON.stringify({ text: '静默测试' }),
    });
    assert.equal(silentSend.status, 200);
    assert.equal((await silentSend.json()).wakeReason, null);

    saveBotSettings(s.db, { silentUntil: 0 });
    const after = await s.api(`/console/api/conversations/${s.directId}/test-message`, {
      cookie: s.login.cookie,
      csrf: s.login.csrf,
      method: 'POST',
      body: JSON.stringify({ text: '解除后测试' }),
    });
    assert.equal((await after.json()).wakeReason, 'private');
    const sendChanges = s.db.prepare(
      "SELECT detail FROM event_log WHERE kind = 'console.change'",
    ).all().filter((row) => String(row.detail || '').includes('conversation.test.send'));
    assert.ok(sendChanges.length >= 3, JSON.stringify(sendChanges));

    const settings = await fetch(`${s.base}/admin/settings`, {
      headers: { authorization: `Bearer ${s.app.accessToken}` },
    }).then((r) => r.json());
    assert.deepEqual(
      Object.keys(settings.settings),
      ['aiName', 'aiSignature', 'aiAvatar', 'personaOverride', 'model',
        'toolProfile', 'defaultWakeConfig', 'perUserLimits', 'updatedAt'],
    );
    const users = await fetch(`${s.base}/admin/users`, {
      headers: { authorization: `Bearer ${s.app.accessToken}` },
    }).then((r) => r.json());
    assert.ok(Array.isArray(users.users));
  } finally {
    await s.close();
  }
});
