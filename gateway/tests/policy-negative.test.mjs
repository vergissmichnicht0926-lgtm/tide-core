// postPolicy 的交叉验证 —— 与 R1 的 policy.test.mjs 独立重写一遍，验同一件事。
// 额外补一条他想漏的：降权不该要白名单。
//
//   node --test gateway/tests/policy-negative.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

let dir;
let gateway;
let base;
let ownerToken;
let strangerToken;
let ownerId;
let strangerId;

async function api(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function login(username) {
  const r = await api('POST', '/auth/login', {
    body: { username, password: 'password123' },
  });
  assert.equal(r.status, 200, `login ${username}`);
  return r.json.accessToken;
}

const rowOf = (convId) =>
  gateway.dbState.db
    .prepare('SELECT policy, policy_hash, agent_token FROM conversation WHERE id = ?')
    .get(convId);

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-polneg-'));
  gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'policy-negative-secret-policy-neg',
  });
  const owner = await gateway.authService.createUser({ username: 'owner', password: 'password123' });
  const stranger = await gateway.authService.createUser({
    username: 'stranger',
    password: 'password123',
  });
  ownerId = owner.id;
  strangerId = stranger.id;
  // 白名单只放 owner 一个 —— stranger 不在里面
  gateway.ctx.config.ownerIds = [ownerId];

  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${gateway.server.address().port}`;
  ownerToken = await login('owner');
  strangerToken = await login('stranger');
});

after(async () => {
  await new Promise((resolve) => gateway.server.close(resolve));
  try {
    gateway.dbState.db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非白名单用户切 owner → 403，policy / policy_hash / agent_token 全不变', async () => {
  const conv = (await api('POST', '/conversations', {
    token: strangerToken,
    body: { title: 'stranger 的对话' },
  })).json;
  const before = rowOf(conv.id);

  const res = await api('POST', `/conversations/${conv.id}/policy`, {
    token: strangerToken,
    body: { policy: 'owner' },
  });

  assert.equal(res.status, 403, '非白名单用户不能自己提权');
  assert.equal(res.json?.error?.code, 'forbidden');

  const after_ = rowOf(conv.id);
  assert.equal(after_.policy, 'restricted', 'policy 必须留在 restricted');
  assert.equal(after_.policy_hash, before.policy_hash, 'policy_hash 不能被改写');
  assert.equal(after_.agent_token, before.agent_token, '提权失败不能轮换 token');
});

test('白名单内用户切 owner → 200，指纹含 ownerId，rebuild_pending 为真', async () => {
  const conv = (await api('POST', '/conversations', {
    token: ownerToken,
    body: { title: 'owner 的对话' },
  })).json;

  const res = await api('POST', `/conversations/${conv.id}/policy`, {
    token: ownerToken,
    body: { policy: 'owner' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.policy, 'owner');
  assert.equal(res.json.rebuild_pending, true, 'M2a 不能假装已经重建 session');
  assert.equal(res.json.rebuilt, false);
  assert.equal(res.json.agent_token_rotated, false);

  const row = rowOf(conv.id);
  assert.equal(row.policy, 'owner');
  assert.match(row.policy_hash, /tide-owner/, 'preset 要进指纹');
  assert.match(row.policy_hash, new RegExp(ownerId), 'ownerId 要进指纹');
});

test('降权不需要白名单：用户被移出 ownerIds 后仍能切回 restricted', async () => {
  const conv = (await api('POST', '/conversations', {
    token: ownerToken,
    body: { title: '先提权再被踢' },
  })).json;

  const up = await api('POST', `/conversations/${conv.id}/policy`, {
    token: ownerToken,
    body: { policy: 'owner' },
  });
  assert.equal(up.status, 200);
  assert.equal(rowOf(conv.id).policy, 'owner');

  // 模拟运维把人从白名单摘掉
  gateway.ctx.config.ownerIds = [];

  const down = await api('POST', `/conversations/${conv.id}/policy`, {
    token: ownerToken,
    body: { policy: 'restricted' },
  });
  assert.equal(down.status, 200, '降权永远该允许，否则被踢出白名单的会话降不下来');
  assert.equal(down.json.policy, 'restricted');
  assert.equal(rowOf(conv.id).policy, 'restricted');

  // 复位，别影响后续用例
  gateway.ctx.config.ownerIds = [ownerId];
});

test('白名单为空时切 owner → 403（fail-closed）', async () => {
  const conv = (await api('POST', '/conversations', {
    token: ownerToken,
    body: { title: '空白名单' },
  })).json;

  gateway.ctx.config.ownerIds = [];
  try {
    const res = await api('POST', `/conversations/${conv.id}/policy`, {
      token: ownerToken,
      body: { policy: 'owner' },
    });
    assert.equal(res.status, 403, '没配白名单就该全拒，不是全放');
    assert.equal(rowOf(conv.id).policy, 'restricted');
  } finally {
    gateway.ctx.config.ownerIds = [ownerId];
  }
});

test('别人的对话切 policy → 404，不是 403 泄露存在性', async () => {
  const conv = (await api('POST', '/conversations', {
    token: ownerToken,
    body: { title: 'owner 私有' },
  })).json;

  const res = await api('POST', `/conversations/${conv.id}/policy`, {
    token: strangerToken,
    body: { policy: 'restricted' },
  });
  assert.equal(res.status, 404, '不该告诉 stranger 这个 id 存在');
  assert.equal(res.json?.error?.code, 'not-found');
});
