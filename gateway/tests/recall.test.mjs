/** 0.11：消息撤回窗口、权限与事件形状。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-recall-'));
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
  const outsider = await gateway.authService.createUser({
    username: 'outsider', password: 'password123', role: 'guest', displayName: '外人',
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
    outsider: await login('outsider'),
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
    body: JSON.stringify({ title: '撤回测试群', kind: 'group' }),
  })).json();
  await api(`/conversations/${group.id}/members`, {
    token: tokens.owner,
    method: 'POST',
    body: JSON.stringify({ user_id: guest.id }),
  });
  return {
    gateway, base, api, tokens, groupId: group.id, owner, guest, outsider,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function post(s, token, text) {
  const res = await s.api(`/conversations/${s.groupId}/prompt`, {
    token,
    method: 'POST',
    body: JSON.stringify({ text, client_msg_id: `c-${Math.random().toString(16).slice(2)}` }),
  });
  const body = await res.json();
  return body.message;
}

test('两分钟内撤回自己的消息，列表里留 recalled 空正文', async () => {
  const s = await makeServer();
  try {
    const message = await post(s, s.tokens.guest, '说错话了');
    assert.ok(message?.id);
    const recalled = await s.api(
      `/conversations/${s.groupId}/messages/${message.id}/recall`,
      { token: s.tokens.guest, method: 'POST' },
    );
    assert.equal(recalled.status, 200);

    const page = await (await s.api(`/conversations/${s.groupId}/messages`, {
      token: s.tokens.owner,
    })).json();
    const row = page.messages.find((m) => m.id === message.id);
    assert.equal(row.recalled, true);
    assert.equal(row.content.text, '');

    const again = await s.api(
      `/conversations/${s.groupId}/messages/${message.id}/recall`,
      { token: s.tokens.guest, method: 'POST' },
    );
    assert.equal(again.status, 200);
    assert.equal((await again.json()).already, true);
  } finally {
    await s.close();
  }
});

test('超过 2 分钟本人不能撤回，群主可以；别人不能撤回', async () => {
  const s = await makeServer();
  try {
    const message = await post(s, s.tokens.guest, '三分钟前的话');
    s.gateway.dbState.db.prepare(
      'UPDATE message SET created_at = ? WHERE id = ?',
    ).run(Date.now() - 3 * 60_000, message.id);

    const denied = await s.api(
      `/conversations/${s.groupId}/messages/${message.id}/recall`,
      { token: s.tokens.guest, method: 'POST' },
    );
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'recall-forbidden');

    const peer = await post(s, s.tokens.owner, '群主的话');
    const peerDenied = await s.api(
      `/conversations/${s.groupId}/messages/${peer.id}/recall`,
      { token: s.tokens.guest, method: 'POST' },
    );
    assert.equal(peerDenied.status, 403);

    const ownerRecall = await s.api(
      `/conversations/${s.groupId}/messages/${message.id}/recall`,
      { token: s.tokens.owner, method: 'POST' },
    );
    assert.equal(ownerRecall.status, 200);

    const outsider = await s.api(
      `/conversations/${s.groupId}/messages/${peer.id}/recall`,
      { token: s.tokens.outsider, method: 'POST' },
    );
    assert.equal(outsider.status, 404);
  } finally {
    await s.close();
  }
});

test('助手消息不能撤回', async () => {
  const s = await makeServer();
  try {
    const message = await post(s, s.tokens.guest, '问一句');
    s.gateway.dbState.db.prepare("UPDATE message SET role = 'assistant' WHERE id = ?")
      .run(message.id);
    const res = await s.api(
      `/conversations/${s.groupId}/messages/${message.id}/recall`,
      { token: s.tokens.guest, method: 'POST' },
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'recall-forbidden');
  } finally {
    await s.close();
  }
});
