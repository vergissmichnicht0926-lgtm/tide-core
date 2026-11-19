/** 0.11：引用持久化、@ 识别（含空格/标点）、会话内搜索。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-chat-extras-'));
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
    username: 'guest', password: 'password123', role: 'guest', displayName: '张 三',
  });
  const punctuation = await gateway.authService.createUser({
    username: 'pun', password: 'password123', role: 'guest', displayName: '阿.Li!',
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
    punctuation: await login('pun'),
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
  const group = await (await api('/conversations', {
    token: tokens.owner,
    method: 'POST',
    body: JSON.stringify({ title: '聊天测试群', kind: 'group' }),
  })).json();
  for (const member of [guest, punctuation]) {
    await api(`/conversations/${group.id}/members`, {
      token: tokens.owner,
      method: 'POST',
      body: JSON.stringify({ user_id: member.id }),
    });
  }
  return {
    gateway, base, api, tokens, groupId: group.id, owner, guest, punctuation,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;
async function send(s, token, text, extra = {}) {
  counter += 1;
  const res = await s.api(`/conversations/${s.groupId}/prompt`, {
    token,
    method: 'POST',
    body: JSON.stringify({
      text,
      client_msg_id: `m-${Date.now()}-${counter}`,
      ...extra,
    }),
  });
  return (await res.json()).message;
}

test('引用回复落库，列表带 replyTo 摘要；跨会话引用 400', async () => {
  const s = await makeServer();
  try {
    const original = await send(s, s.tokens.owner, '原来那句话');
    const reply = await send(s, s.tokens.guest, '我回你', {
      reply_to_message_id: original.id,
    });
    assert.equal(reply.replyToMessageId, original.id);

    const page = await (await s.api(`/conversations/${s.groupId}/messages`, {
      token: s.tokens.owner,
    })).json();
    const row = page.messages.find((m) => m.id === reply.id);
    assert.equal(row.replyTo.id, original.id);
    assert.equal(row.replyTo.senderName, '群主');
    assert.equal(row.replyTo.text, '原来那句话');

    const otherGroup = await (await s.api('/conversations', {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({ title: '别的群', kind: 'group' }),
    })).json();
    const cross = await s.api(`/conversations/${otherGroup.id}/prompt`, {
      token: s.tokens.owner,
      method: 'POST',
      body: JSON.stringify({
        text: '跨群引用',
        client_msg_id: `x-${Date.now()}`,
        reply_to_message_id: original.id,
      }),
    });
    assert.equal(cross.status, 400);
  } finally {
    await s.close();
  }
});

test('@ 名字含空格和标点都能识别，@小汐 指向 agent', async () => {
  const s = await makeServer();
  try {
    const spaced = await send(s, s.tokens.owner, '@张 三 你看这条');
    const punctuated = await send(s, s.tokens.owner, '@阿.Li! 来一下');
    const bot = await send(s, s.tokens.owner, '@小汐 在吗');
    const page = await (await s.api(`/conversations/${s.groupId}/messages`, {
      token: s.tokens.owner,
    })).json();
    const byId = new Map(page.messages.map((m) => [m.id, m]));
    assert.deepEqual(byId.get(spaced.id).mentions, [s.guest.id]);
    assert.deepEqual(byId.get(punctuated.id).mentions, [s.punctuation.id]);
    assert.deepEqual(byId.get(bot.id).mentions, ['agent']);
  } finally {
    await s.close();
  }
});

test('会话内搜索：大小写、通配符转义、撤回消息排除', async () => {
  const s = await makeServer();
  try {
    const a = await send(s, s.tokens.owner, 'hello world');
    const b = await send(s, s.tokens.guest, 'HELLO again');
    await send(s, s.tokens.owner, '完全无关');
    const wildcard = await send(s, s.tokens.owner, '100% 完成');

    const hit = await (await s.api(
      `/conversations/${s.groupId}/messages?q=hello`,
      { token: s.tokens.owner },
    )).json();
    assert.equal(hit.query, 'hello');
    assert.deepEqual(hit.messages.map((m) => m.id), [b.id, a.id]);

    const percent = await (await s.api(
      `/conversations/${s.groupId}/messages?q=${encodeURIComponent('100%')}`,
      { token: s.tokens.owner },
    )).json();
    assert.deepEqual(percent.messages.map((m) => m.id), [wildcard.id]);

    const underscore = await (await s.api(
      `/conversations/${s.groupId}/messages?q=_`,
      { token: s.tokens.owner },
    )).json();
    assert.equal(underscore.messages.length, 0);

    await s.api(`/conversations/${s.groupId}/messages/${a.id}/recall`, {
      token: s.tokens.owner,
      method: 'POST',
    });
    const afterRecall = await (await s.api(
      `/conversations/${s.groupId}/messages?q=hello`,
      { token: s.tokens.owner },
    )).json();
    assert.deepEqual(afterRecall.messages.map((m) => m.id), [b.id]);

    const tooLong = await s.api(`/conversations/${s.groupId}/messages?q=${'字'.repeat(101)}`, {
      token: s.tokens.owner,
    });
    assert.equal(tooLong.status, 400);

    const outsider = await s.api(`/conversations/${s.groupId}/messages?q=hello`, {
      token: 'x'.repeat(20),
    });
    assert.equal(outsider.status, 401);
  } finally {
    await s.close();
  }
});
