/** M7a：conversation_member 表、旧会话回填、创建/已读双写、成员接口与 sender_name。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { closeDatabase, openDatabase } from '../db/index.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-m7a-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
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
  const adminToken = await login('admin');
  const guestToken = await login('guest');
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  return {
    dir,
    gateway,
    db: gateway.dbState.db,
    admin,
    guest,
    adminToken,
    guestToken,
    api,
    async close() {
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (res) => res.json();

test('创建会话同时写入 owner member，客户端 sender_name 不参与落库', async () => {
  const s = await makeServer();
  try {
    const createdEvents = [];
    s.gateway.events.subscribeUser(s.admin.id, (event) => createdEvents.push(event));
    const created = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: 'M7a 私聊', kind: 'direct' }),
    }));
    const owner = s.db.prepare(
      'SELECT user_id, display_name, role, last_read_seq FROM conversation_member WHERE conversation_id = ?',
    ).get(created.id);
    assert.deepEqual(
      { ...owner },
      {
        user_id: s.admin.id,
        display_name: '管理员',
        role: 'owner',
        last_read_seq: 0,
      },
    );
    assert.equal(createdEvents.length, 1);
    assert.equal(createdEvents[0].type, 'conversation.created');
    assert.equal(createdEvents[0].conversationId, created.id);
    assert.equal(createdEvents[0].kind, 'direct');
    assert.equal(createdEvents[0].title, 'M7a 私聊');
    assert.equal(createdEvents[0].epoch, 1);
    assert.equal(createdEvents[0].latestSeq, 0);
    assert.equal(createdEvents[0].reason, 'created');

    const prompted = await s.api(`/conversations/${created.id}/prompt`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ text: '在吗', sender_name: '伪造名字' }),
    });
    assert.equal(prompted.status, 200);
    const msg = s.db.prepare(
      "SELECT sender_user_id, sender_name FROM message WHERE conversation_id = ? AND role = 'user'",
    ).get(created.id);
    assert.equal(msg.sender_user_id, s.admin.id);
    assert.equal(msg.sender_name, '管理员');
  } finally {
    await s.close();
  }
});

test('用户已读只写 member.last_read_seq，旧 conversation 列不再参与读路径', async () => {
  const s = await makeServer();
  try {
    const created = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: '双写', kind: 'direct' }),
    }));
    await s.api(`/conversations/${created.id}/prompt`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ text: '第一条', client_msg_id: 'read-1' }),
    });
    const read = await json(await s.api(`/conversations/${created.id}/read`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ through_seq: 1 }),
    }));
    assert.equal(read.user_read_seq, 1);
    assert.equal(read.last_read_seq, 1);
    const conv = s.db.prepare(
      'SELECT user_read_seq FROM conversation WHERE id = ?',
    ).get(created.id);
    const member = s.db.prepare(
      'SELECT last_read_seq FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
    ).get(created.id, s.admin.id);
    assert.equal(conv.user_read_seq, 0, '旧列只保留兼容，不再作为成员已读来源');
    assert.equal(member.last_read_seq, 1);
  } finally {
    await s.close();
  }
});

test('成员列表、加人、移除成员与 owner 保护', async () => {
  const s = await makeServer();
  try {
    const group = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: 'M7a 群', kind: 'group' }),
    }));
    const joinedEvents = [];
    s.gateway.events.subscribeUser(s.guest.id, (event) => joinedEvents.push(event));
    const added = await s.api(`/conversations/${group.id}/members`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ user_id: s.guest.id }),
    });
    assert.equal(added.status, 201);
    assert.equal((await json(added)).member.display_name, '旅客甲');
    assert.equal(joinedEvents.length, 1);
    assert.equal(joinedEvents[0].type, 'conversation.created');
    assert.equal(joinedEvents[0].conversationId, group.id);
    assert.equal(joinedEvents[0].kind, 'group');
    assert.equal(joinedEvents[0].title, 'M7a 群');
    assert.equal(joinedEvents[0].reason, 'joined');
    assert.equal(joinedEvents[0].latestSeq, 0);

    const list = await json(await s.api(`/conversations/${group.id}/members`, {
      token: s.adminToken,
    }));
    assert.deepEqual(
      list.members.map((m) => [m.user_id, m.role]),
      [[s.admin.id, 'owner'], [s.guest.id, 'member']],
    );

    const removeOwner = await s.api(
      `/conversations/${group.id}/members/${s.admin.id}`,
      { token: s.adminToken, method: 'DELETE' },
    );
    assert.equal(removeOwner.status, 409);
    assert.equal((await json(removeOwner)).error.code, 'cannot-remove-owner');

    const guestEvents = [];
    const adminEvents = [];
    s.gateway.events.subscribeUser(s.guest.id, (event) => guestEvents.push(event));
    s.gateway.events.subscribeUser(s.admin.id, (event) => adminEvents.push(event));
    const removed = await s.api(
      `/conversations/${group.id}/members/${s.guest.id}`,
      { token: s.adminToken, method: 'DELETE' },
    );
    assert.equal(removed.status, 200);
    assert.equal(
      s.db.prepare(
        'SELECT COUNT(*) AS n FROM conversation_member WHERE conversation_id = ?',
      ).get(group.id).n,
      1,
    );
    const audit = s.db.prepare(
      "SELECT action FROM audit_log WHERE target = ? ORDER BY id",
    ).all(group.id).map((row) => row.action);
    assert.deepEqual(audit, ['member.add', 'member.remove']);
    assert.equal(guestEvents.length, 1);
    assert.equal(guestEvents[0].type, 'conversation.deleted');
    assert.equal(guestEvents[0].conversationId, group.id);
    assert.equal(guestEvents[0].reason, 'member-removed');
    assert.equal(guestEvents[0].epoch, 1);
    assert.equal(adminEvents.length, 0);
  } finally {
    await s.close();
  }
});

test('direct 不接受成员管理，避免写幽灵 member', async () => {
  const s = await makeServer();
  try {
    const direct = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: 'direct', kind: 'direct' }),
    }));
    const res = await s.api(`/conversations/${direct.id}/members`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ user_id: s.guest.id }),
    });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).error.code, 'group-only');
  } finally {
    await s.close();
  }
});

test('群聊 sender_name 取自服务端成员显示名', async () => {
  const s = await makeServer();
  try {
    const group = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: '显示名', kind: 'group' }),
    }));
    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ text: '大家好', sender_name: '假名' }),
    });
    const msg = s.db.prepare(
      "SELECT sender_name FROM message WHERE conversation_id = ? AND role = 'user'",
    ).get(group.id);
    assert.equal(msg.sender_name, '管理员');
  } finally {
    await s.close();
  }
});

test('群聊 @ 昵称由服务端解析进 message.mentions', async () => {
  const s = await makeServer();
  try {
    const group = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: 'mentions', kind: 'group' }),
    }));
    await s.api(`/conversations/${group.id}/members`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ user_id: s.guest.id }),
    });
    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ text: '@旅客甲 晚上好，@汐语 你也来' }),
    });
    const msg = s.db.prepare(
      "SELECT mentions FROM message WHERE conversation_id = ? AND role = 'user'",
    ).get(group.id);
    assert.deepEqual(JSON.parse(msg.mentions), [s.guest.id, 'agent']);
    const listed = await json(await s.api(`/conversations/${group.id}/messages`, {
      token: s.adminToken,
    }));
    assert.deepEqual(listed.messages[0].mentions, [s.guest.id, 'agent']);
  } finally {
    await s.close();
  }
});

test('老 conversation_member 行缺失时，重启按 conversation.user_id 回填 owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-m7a-migrate-'));
  const dbPath = path.join(dir, 'gw.db');
  let state = openDatabase(dbPath);
  try {
    const now = Date.now();
    state.db.prepare(
      `INSERT INTO users(id, username, password_hash, role, display_name, created_at)
       VALUES ('u-legacy', 'legacy', 'x', 'admin', '旧管理员', ?)`,
    ).run(new Date(now).toISOString());
    state.db.prepare(
      `INSERT INTO conversation
         (id, user_id, title, created_at, updated_at, agent_token, policy, policy_hash, user_read_seq)
       VALUES ('c-legacy', 'u-legacy', '旧会话', ?, ?, ?, 'restricted', 'h', 7)`,
    ).run(now, now, 't'.repeat(48));
    closeDatabase(state);

    state = openDatabase(dbPath);
    const member = state.db.prepare(
      'SELECT user_id, display_name, role, last_read_seq FROM conversation_member WHERE conversation_id = ?',
    ).get('c-legacy');
    assert.deepEqual(
      { ...member },
      {
        user_id: 'u-legacy',
        display_name: '旧管理员',
        role: 'owner',
        last_read_seq: 7,
      },
    );
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
