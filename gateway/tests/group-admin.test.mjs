/** 0.11：群改名、公告、成员角色、解散。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-group-admin-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const owner = await gateway.authService.createUser({
    username: 'owner', password: 'password123', role: 'admin', displayName: '群主',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest', password: 'password123', role: 'guest', displayName: '旅客',
  });
  const other = await gateway.authService.createUser({
    username: 'other', password: 'password123', role: 'guest', displayName: '路人',
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
    owner: await login('owner'),
    guest: await login('guest'),
    other: await login('other'),
  };
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  const created = await (await api('/conversations', {
    token: tokens.owner,
    method: 'POST',
    body: JSON.stringify({ title: '测试群', kind: 'group' }),
  })).json();
  await api(`/conversations/${created.id}/members`, {
    token: tokens.owner,
    method: 'POST',
    body: JSON.stringify({ user_id: guest.id }),
  });
  return {
    gateway, base, tokens, api, groupId: created.id,
    owner, guest, other,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (res) => res.json();

test('群主改名，普通成员不能改；公告 owner 和管理员都能改', async () => {
  const s = await makeServer();
  try {
    const denied = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.guest,
      method: 'PATCH',
      body: JSON.stringify({ title: '旅客改的' }),
    });
    assert.equal(denied.status, 403);

    const renamed = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.owner,
      method: 'PATCH',
      body: JSON.stringify({ title: '新群名' }),
    });
    assert.equal(renamed.status, 200);
    const body = await json(renamed);
    assert.equal(body.conversation.title, '新群名');

    const list = await json(await s.api('/conversations', { token: s.tokens.guest }));
    const row = list.conversations.find((c) => c.id === s.groupId);
    assert.equal(row.title, '新群名');
    assert.equal(row.announcement, null);

    const announcement = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.owner,
      method: 'PATCH',
      body: JSON.stringify({ announcement: '周六聚餐' }),
    });
    assert.equal(announcement.status, 200);
    assert.equal((await json(announcement)).conversation.announcement, '周六聚餐');

    const tooLong = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.owner,
      method: 'PATCH',
      body: JSON.stringify({ announcement: '字'.repeat(501) }),
    });
    assert.equal(tooLong.status, 400);

    const empty = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.owner,
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  } finally {
    await s.close();
  }
});

test('管理员可以改公告、删普通成员，但不能改名或改角色', async () => {
  const s = await makeServer();
  try {
    await s.api(`/conversations/${s.groupId}/members`, {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({ user_id: s.other.id }),
    });
    const promote = await s.api(`/conversations/${s.groupId}/members/${s.guest.id}/role`, {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(promote.status, 200);
    assert.equal((await json(promote)).member.role, 'admin');

    const members = await json(await s.api(`/conversations/${s.groupId}/members`, {
      token: s.tokens.owner,
    }));
    const guestRow = members.members.find((m) => m.user_id === s.guest.id);
    assert.equal(guestRow.role, 'admin');

    const announced = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.guest,
      method: 'PATCH',
      body: JSON.stringify({ announcement: '管理员公告' }),
    });
    assert.equal(announced.status, 200);

    const rename = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.guest,
      method: 'PATCH',
      body: JSON.stringify({ title: '管理员改名' }),
    });
    assert.equal(rename.status, 403);

    const role = await s.api(`/conversations/${s.groupId}/members/${s.other.id}/role`, {
      token: s.tokens.guest,
      method: 'POST',
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(role.status, 403);

    const removed = await s.api(`/conversations/${s.groupId}/members/${s.other.id}`, {
      token: s.tokens.guest,
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);

    const demote = await s.api(`/conversations/${s.groupId}/members/${s.guest.id}/role`, {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(demote.status, 200);
    assert.equal((await json(demote)).member.role, 'member');

    const ownerRole = await s.api(`/conversations/${s.groupId}/members/${s.owner.id}/role`, {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(ownerRole.status, 409);
  } finally {
    await s.close();
  }
});

test('解散群：非 owner 拒绝，解散后列表、消息、agent 都不可见', async () => {
  const s = await makeServer();
  try {
    const denied = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.guest,
      method: 'DELETE',
    });
    assert.equal(denied.status, 403);

    const direct = await (await s.api('/conversations', {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({ title: '私聊不能解散' }),
    })).json();
    const directDelete = await s.api(`/conversations/${direct.id}`, {
      token: s.tokens.owner,
      method: 'DELETE',
    });
    assert.equal(directDelete.status, 400);

    const agentToken = s.gateway.dbState.db.prepare(
      'SELECT agent_token FROM conversation WHERE id = ?',
    ).get(s.groupId).agent_token;
    const dissolved = await s.api(`/conversations/${s.groupId}`, {
      token: s.tokens.owner,
      method: 'DELETE',
    });
    assert.equal(dissolved.status, 200);

    const list = await json(await s.api('/conversations', { token: s.tokens.owner }));
    assert.ok(!list.conversations.some((c) => c.id === s.groupId));

    const messages = await s.api(`/conversations/${s.groupId}/messages`, {
      token: s.tokens.owner,
    });
    assert.equal(messages.status, 404);

    const agentCall = await fetch(`${s.base}/agent/messages`, {
      headers: {
        'x-agent-secret': 'test-secret',
        'x-agent-token': agentToken,
        'x-agent-call': '1',
      },
    });
    assert.equal(agentCall.status, 401);
  } finally {
    await s.close();
  }
});
