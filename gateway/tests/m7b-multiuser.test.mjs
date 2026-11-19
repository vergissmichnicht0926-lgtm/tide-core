/** M7b：member 判权、每成员未读、多人 SSE、附件成员权限与自助退群。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-m7b-'));
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
  const outsider = await gateway.authService.createUser({
    username: 'outsider',
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
    outsider: await login('outsider'),
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
  const db = gateway.dbState.db;
  const agentToken = (conversationId) => db.prepare(
    'SELECT agent_token FROM conversation WHERE id = ?',
  ).get(conversationId).agent_token;
  const agent = (conversationId, p, init = {}) =>
    fetch(`${base}/agent${p}`, {
      ...init,
      headers: {
        'x-agent-secret': 'test-secret',
        'x-agent-token': agentToken(conversationId),
        'x-agent-call': '1',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  return {
    dir,
    gateway,
    db,
    base,
    api,
    agent,
    tokens,
    admin,
    guest,
    outsider,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (res) => res.json();

async function createGroupWithGuest(s) {
  const group = await json(await s.api('/conversations', {
    token: s.tokens.admin,
    method: 'POST',
    body: JSON.stringify({ title: 'M7b 群', kind: 'group' }),
  }));
  const added = await s.api(`/conversations/${group.id}/members`, {
    token: s.tokens.admin,
    method: 'POST',
    body: JSON.stringify({ user_id: s.guest.id }),
  });
  assert.equal(added.status, 201);
  return group;
}

function openSse(base, conversationId, token) {
  const controller = new AbortController();
  const events = [];
  let streamClosed = false;
  const ready = fetch(`${base}/conversations/${conversationId}/stream?since_seq=0`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok) throw new Error(`SSE ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            streamClosed = true;
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const type = chunk.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
            const data = chunk.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
            if (type && data) events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch {
        streamClosed = true;
      }
    })();
    return res;
  });
  const waitFor = async (type, predicate = () => true, timeoutMs = 4_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find((event) => event.type === type && predicate(event));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`等待 SSE ${type} 超时；已收到 ${events.map((event) => event.type).join(',')}`);
  };
  const waitClosed = async (timeoutMs = 2_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (streamClosed) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  return {
    ready,
    events,
    waitFor,
    isClosed: () => streamClosed,
    waitClosed,
    close: () => controller.abort(),
  };
}

test('成员可访问群聊，非成员 404；每成员未读互不影响', async () => {
  const s = await makeServer();
  try {
    const group = await createGroupWithGuest(s);
    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ text: '管理员发言', client_msg_id: 'admin-1' }),
    });
    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.tokens.guest,
      method: 'POST',
      body: JSON.stringify({ text: '旅客发言', client_msg_id: 'guest-1' }),
    });
    const sent = await s.agent(group.id, '/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['助手发言'], clientBatchId: 'm7b-1' }),
    });
    assert.equal(sent.status, 200);

    const guestMessages = await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.guest,
    });
    assert.equal(guestMessages.status, 200);
    assert.equal((await json(guestMessages)).messages.length, 3);

    const outsiderMessages = await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.outsider,
    });
    assert.equal(outsiderMessages.status, 404);

    const adminList = await json(await s.api('/conversations', { token: s.tokens.admin }));
    const guestList = await json(await s.api('/conversations', { token: s.tokens.guest }));
    assert.equal(adminList.conversations.find((c) => c.id === group.id).unread, 2);
    assert.equal(guestList.conversations.find((c) => c.id === group.id).unread, 2);

    const guestRead = await s.api(`/conversations/${group.id}/read`, {
      token: s.tokens.guest,
      method: 'POST',
      body: JSON.stringify({ through_seq: 2 }),
    });
    assert.equal((await json(guestRead)).last_read_seq, 2);
    const guestAfter = await json(await s.api('/conversations', { token: s.tokens.guest }));
    const adminAfter = await json(await s.api('/conversations', { token: s.tokens.admin }));
    assert.equal(guestAfter.conversations.find((c) => c.id === group.id).unread, 1);
    assert.equal(adminAfter.conversations.find((c) => c.id === group.id).unread, 2);
  } finally {
    await s.close();
  }
});

test('多人 SSE：owner 与 member 同时收到助手消息和彼此的发言', async () => {
  const s = await makeServer();
  try {
    const group = await createGroupWithGuest(s);
    const a = openSse(s.base, group.id, s.tokens.admin);
    const g = openSse(s.base, group.id, s.tokens.guest);
    try {
      await a.ready;
      await g.ready;
      await s.api(`/conversations/${group.id}/prompt`, {
        token: s.tokens.guest,
        method: 'POST',
        body: JSON.stringify({ text: '大家晚上好', client_msg_id: 'sse-guest' }),
      });
      await a.waitFor('user_message', (event) => event.data.message?.text === '大家晚上好');
      await g.waitFor('user_message', (event) => event.data.message?.text === '大家晚上好');

      await s.agent(group.id, '/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: ['晚上好'], clientBatchId: 'sse-agent' }),
      });
      await a.waitFor('assistant_message', (event) => event.data.message?.text === '晚上好');
      await g.waitFor('assistant_message', (event) => event.data.message?.text === '晚上好');
    } finally {
      a.close();
      g.close();
    }
  } finally {
    await s.close();
  }
});

test('成员上传附件，其他成员可读，外部用户 404；uploader 已记录', async () => {
  const s = await makeServer();
  try {
    const group = await createGroupWithGuest(s);
    const upload = await s.api(`/conversations/${group.id}/upload`, {
      token: s.tokens.guest,
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': 'note.txt' },
      body: 'hello',
    });
    assert.equal(upload.status, 201);
    const meta = await json(upload);
    const stored = s.db.prepare(
      'SELECT uploader_user_id FROM attachment WHERE id = ?',
    ).get(meta.attachment_id);
    assert.equal(stored.uploader_user_id, s.guest.id);

    const byOwner = await s.api(`/attachments/${meta.attachment_id}`, { token: s.tokens.admin });
    const byGuest = await s.api(`/attachments/${meta.attachment_id}`, { token: s.tokens.guest });
    const byOutsider = await s.api(`/attachments/${meta.attachment_id}`, { token: s.tokens.outsider });
    assert.equal(byOwner.status, 200);
    assert.equal(byGuest.status, 200);
    assert.equal(byOutsider.status, 404);
  } finally {
    await s.close();
  }
});

test('普通成员可以自助退群，退群后立刻失去访问权', async () => {
  const s = await makeServer();
  try {
    const group = await createGroupWithGuest(s);
    const leave = await s.api(
      `/conversations/${group.id}/members/${s.guest.id}`,
      { token: s.tokens.guest, method: 'DELETE' },
    );
    assert.equal(leave.status, 200);
    const after = await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.guest,
    });
    assert.equal(after.status, 404);
    const action = s.db.prepare(
      "SELECT action FROM audit_log WHERE actor_user_id = ? ORDER BY id DESC LIMIT 1",
    ).get(s.guest.id).action;
    assert.equal(action, 'member.leave');
  } finally {
    await s.close();
  }
});

test('新成员看不到入群前历史，last_read_seq 初始化为当前水位', async () => {
  const s = await makeServer();
  try {
    const group = await json(await s.api('/conversations', {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ title: '历史边界', kind: 'group' }),
    }));
    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ text: '入群前的话', client_msg_id: 'before-join' }),
    });
    await s.api(`/conversations/${group.id}/members`, {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ user_id: s.guest.id }),
    });

    const visible = await json(await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.guest,
    }));
    assert.deepEqual(visible.messages, []);
    const member = s.db.prepare(
      'SELECT joined_at, join_seq, last_read_seq FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
    ).get(group.id, s.guest.id);
    assert.equal(member.join_seq, 1);
    assert.equal(member.last_read_seq, 1);

    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.tokens.admin,
      method: 'POST',
      body: JSON.stringify({ text: '入群后的话', client_msg_id: 'after-join' }),
    });
    await s.agent(group.id, '/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['入群后的助手回复'], clientBatchId: 'after-agent' }),
    });
    const list = await json(await s.api('/conversations', { token: s.tokens.guest }));
    assert.equal(list.conversations.find((c) => c.id === group.id).unread, 2);
    const after = await json(await s.api(`/conversations/${group.id}/messages`, {
      token: s.tokens.guest,
    }));
    assert.deepEqual(
      after.messages.map((message) => message.content.text),
      ['入群后的话', '入群后的助手回复'],
    );
  } finally {
    await s.close();
  }
});

test('被拉进群不占 maxConversations，本人才建的会话才计数', async () => {
  const s = await makeServer();
  try {
    s.db.prepare(
      "UPDATE bot_settings SET per_user_limits_json = ? WHERE id = 1",
    ).run(JSON.stringify({ dailyMessages: 500, maxConversations: 1, uploadMb: 100 }));
    await createGroupWithGuest(s);
    const directId = await s.gateway.ctx.createDirectConversation({
      userId: s.guest.id,
      title: '旅客私聊',
    });
    assert.ok(directId);
    await assert.rejects(
      () => s.gateway.ctx.createDirectConversation({
        userId: s.guest.id,
        title: '第二个私聊',
      }),
      (error) => error.status === 429 && error.code === 'quota-exceeded',
    );
  } finally {
    await s.close();
  }
});

test('退群后已建立的 SSE 不再收到新事件', async () => {
  const s = await makeServer();
  try {
    const group = await createGroupWithGuest(s);
    const stream = openSse(s.base, group.id, s.tokens.guest);
    try {
      await stream.ready;
      const leave = await s.api(
        `/conversations/${group.id}/members/${s.guest.id}`,
        { token: s.tokens.guest, method: 'DELETE' },
      );
      assert.equal(leave.status, 200);
      assert.equal(await stream.waitClosed(), true, '退群后旧 SSE 应立即关闭');

      await s.agent(group.id, '/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: ['退群后不该看到'], clientBatchId: 'leave-sse' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(
        stream.events.some(
          (event) =>
            event.type === 'assistant_message'
            && event.data.message?.text === '退群后不该看到',
        ),
        false,
      );
    } finally {
      stream.close();
    }
  } finally {
    await s.close();
  }
});
