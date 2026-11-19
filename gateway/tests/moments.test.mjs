/** M9：动态列表、私聊可见性、点赞开关与 agent 发布。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-moments-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
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
    displayName: '旅客',
  });
  const loner = await gateway.authService.createUser({
    username: 'loner',
    password: 'password123',
    role: 'guest',
    displayName: '没有私聊的人',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123', device_name: 'test' }),
    });
    return res.json();
  };
  const sessions = {
    admin: await login('admin'),
    guest: await login('guest'),
    loner: await login('loner'),
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
  const adminDirect = await gateway.ctx.createDirectConversation({
    userId: admin.id,
    title: '汐语',
  });
  const guestDirect = await gateway.ctx.createDirectConversation({
    userId: guest.id,
    title: '汐语',
  });
  const group = await (
    await api('/conversations', {
      token: sessions.admin.accessToken,
      method: 'POST',
      body: JSON.stringify({ title: '动态测试群', kind: 'group' }),
    })
  ).json();
  const agentHeaders = (conversationId) => ({
    'content-type': 'application/json',
    'x-agent-secret': 'test-secret',
    'x-agent-token': gateway.dbState.db.prepare(
      'SELECT agent_token FROM conversation WHERE id = ?',
    ).get(conversationId).agent_token,
    'x-agent-call': '1',
  });
  const publish = (conversationId, text) =>
    fetch(`${base}/agent/moments`, {
      method: 'POST',
      headers: agentHeaders(conversationId),
      body: JSON.stringify({ text }),
    });
  return {
    gateway,
    admin,
    guest,
    loner,
    sessions,
    api,
    adminDirect,
    guestDirect,
    group,
    publish,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('agent 发布的动态按时间倒序出现在已添加私聊的用户面前', async () => {
  const s = await makeServer();
  try {
    const first = await s.publish(s.adminDirect, '今晚的月亮很圆。');
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.moment.text, '今晚的月亮很圆。');
    assert.equal(firstBody.moment.author.name, '汐语');
    assert.equal(firstBody.moment.likes, 0);

    await s.publish(s.adminDirect, '第二行动态');

    const list = await (await s.api('/moments', {
      token: s.sessions.admin.accessToken,
    })).json();
    assert.equal(list.moments.length, 2);
    assert.equal(list.moments[0].text, '第二行动态');
    assert.equal(list.moments[1].text, '今晚的月亮很圆。');

    // 另一个用户也添加了同一个 bot 的私聊，看到同一条时间线。
    const guestList = await (await s.api('/moments', {
      token: s.sessions.guest.accessToken,
    })).json();
    assert.equal(guestList.moments.length, 2);
    assert.equal(guestList.moments[0].likedByMe, false);
  } finally {
    await s.close();
  }
});

test('没有私聊的用户看不到动态，也不能点赞', async () => {
  const s = await makeServer();
  try {
    const created = await (await s.publish(s.adminDirect, '只给好友看')).json();
    const list = await (await s.api('/moments', {
      token: s.sessions.loner.accessToken,
    })).json();
    assert.deepEqual(list.moments, []);

    const like = await s.api(`/moments/${created.moment.id}/like`, {
      token: s.sessions.loner.accessToken,
      method: 'POST',
    });
    assert.equal(like.status, 404);
  } finally {
    await s.close();
  }
});

test('点赞幂等，计数跨用户累计，取消后回落', async () => {
  const s = await makeServer();
  try {
    const created = await (await s.publish(s.adminDirect, '点赞测试')).json();
    const id = created.moment.id;

    const first = await (await s.api(`/moments/${id}/like`, {
      token: s.sessions.admin.accessToken,
      method: 'POST',
    })).json();
    assert.deepEqual(first, { liked: true, likes: 1 });
    const again = await (await s.api(`/moments/${id}/like`, {
      token: s.sessions.admin.accessToken,
      method: 'POST',
    })).json();
    assert.deepEqual(again, { liked: true, likes: 1 });

    const guest = await (await s.api(`/moments/${id}/like`, {
      token: s.sessions.guest.accessToken,
      method: 'POST',
    })).json();
    assert.deepEqual(guest, { liked: true, likes: 2 });

    const guestList = await (await s.api('/moments', {
      token: s.sessions.guest.accessToken,
    })).json();
    assert.equal(guestList.moments[0].likes, 2);
    assert.equal(guestList.moments[0].likedByMe, true);

    const adminList = await (await s.api('/moments', {
      token: s.sessions.admin.accessToken,
    })).json();
    assert.equal(adminList.moments[0].likes, 2);
    assert.equal(adminList.moments[0].likedByMe, true);

    const removed = await (await s.api(`/moments/${id}/like`, {
      token: s.sessions.admin.accessToken,
      method: 'DELETE',
    })).json();
    assert.deepEqual(removed, { liked: false, likes: 1 });

    const missing = await s.api('/moments/not-a-moment/like', {
      token: s.sessions.admin.accessToken,
      method: 'POST',
    });
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('群聊 agent 不能发布动态，空的或超长正文被拒绝', async () => {
  const s = await makeServer();
  try {
    const groupPost = await s.publish(s.group.id, '群聊不该出现在动态里');
    assert.equal(groupPost.status, 400);
    assert.equal((await groupPost.json()).error.code, 'not-direct');

    const empty = await s.publish(s.adminDirect, '   ');
    assert.equal(empty.status, 400);

    const tooLong = await s.publish(s.adminDirect, '字'.repeat(2001));
    assert.equal(tooLong.status, 400);

    const anonymous = await s.api('/moments');
    assert.equal(anonymous.status, 401);

    const badLimit = await s.api('/moments?limit=0', {
      token: s.sessions.admin.accessToken,
    });
    assert.equal(badLimit.status, 400);
  } finally {
    await s.close();
  }
});
