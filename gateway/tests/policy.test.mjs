import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-policy-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'policy-test-secret-policy-test-secret',
  });
  const tester = await gateway.authService.createUser({ username: 'tester', password: 'password123' });
  const owner = await gateway.authService.createUser({ username: 'owner', password: 'password123' });
  gateway.ctx.config.ownerIds.push(owner.id);
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123' }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).accessToken;
  };
  return { dir, gateway, base, tester, owner, login };
}

async function createConversation(base, token) {
  const res = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: 'policy test' }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function switchPolicy(base, token, id, policy) {
  const res = await fetch(`${base}/conversations/${id}/policy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ policy }),
  });
  return { status: res.status, body: await res.json() };
}

async function cleanup({ dir, gateway }) {
  await new Promise((resolve) => gateway.server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

test('非白名单用户切 owner → 403 且库不变', async () => {
  const env = await setup();
  try {
    const token = await env.login('tester');
    const conv = await createConversation(env.base, token);
    const before = env.gateway.dbState.db.prepare(
      'SELECT policy, policy_hash, agent_token FROM conversation WHERE id = ?',
    ).get(conv.id);
    const result = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'forbidden');
    const after = env.gateway.dbState.db.prepare(
      'SELECT policy, policy_hash, agent_token FROM conversation WHERE id = ?',
    ).get(conv.id);
    assert.deepEqual(after, before);
    assert.equal(
      env.gateway.dbState.db.prepare(
        'SELECT COUNT(*) AS n FROM rebuild_queue WHERE conversation_id = ?',
      ).get(conv.id).n,
      0,
    );
  } finally {
    await cleanup(env);
  }
});

test('会话列表带 policy，切换后立即反映', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    const switched = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(switched.status, 200);

    const list = async () => {
      const res = await fetch(`${env.base}/conversations`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      return (await res.json()).conversations.find((item) => item.id === conv.id);
    };
    assert.equal((await list()).policy, 'owner');

    const down = await switchPolicy(env.base, token, conv.id, 'restricted');
    assert.equal(down.status, 200);
    assert.equal((await list()).policy, 'restricted');
  } finally {
    await cleanup(env);
  }
});

test('白名单用户切 owner → 200，且明确 rebuild_pending', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    const result = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(result.status, 200);
    assert.equal(result.body.policy, 'owner');
    assert.equal(result.body.agent_token_rotated, false);
    assert.equal(result.body.rebuilt, false);
    assert.equal(result.body.rebuild_pending, true);
    const row = env.gateway.dbState.db.prepare(
      'SELECT policy, policy_hash FROM conversation WHERE id = ?',
    ).get(conv.id);
    assert.equal(row.policy, 'owner');
    const hash = JSON.parse(row.policy_hash);
    assert.equal(hash.ownerId, env.owner.id);
    assert.equal(hash.permissionLevel, 'owner');
    const queued = env.gateway.dbState.db.prepare(
      'SELECT reason FROM rebuild_queue WHERE conversation_id = ?',
    ).all(conv.id);
    assert.deepEqual(queued.map((r) => r.reason), ['policy:owner']);
  } finally {
    await cleanup(env);
  }
});

test('同值切换不刷新 rebuild_queue 时间戳', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    const first = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(first.status, 200);
    assert.equal(first.body.rebuild_pending, true);

    const queueBefore = env.gateway.dbState.db.prepare(
      `SELECT reason, created_at, attempts, last_error, state, next_attempt_at
         FROM rebuild_queue WHERE conversation_id = ?`,
    ).get(conv.id);
    const convBefore = env.gateway.dbState.db.prepare(
      'SELECT updated_at FROM conversation WHERE id = ?',
    ).get(conv.id);

    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(second.status, 200);
    assert.equal(second.body.rebuild_pending, true);

    const queueAfter = env.gateway.dbState.db.prepare(
      `SELECT reason, created_at, attempts, last_error, state, next_attempt_at
         FROM rebuild_queue WHERE conversation_id = ?`,
    ).all(conv.id);
    const convAfter = env.gateway.dbState.db.prepare(
      'SELECT updated_at FROM conversation WHERE id = ?',
    ).get(conv.id);
    assert.equal(queueAfter.length, 1);
    assert.equal(queueAfter[0].reason, 'policy:owner');
    assert.equal(queueAfter[0].created_at, queueBefore.created_at);
    assert.equal(convAfter.updated_at, convBefore.updated_at);
    assert.equal(queueAfter[0].attempts, 0);
    assert.equal(queueAfter[0].last_error, null);
    assert.equal(queueAfter[0].state, 'pending');
    assert.equal(typeof queueAfter[0].next_attempt_at, 'number');
    assert.equal(queueAfter[0].next_attempt_at, queueBefore.next_attempt_at);

    env.gateway.dbState.db.prepare(
      'DELETE FROM rebuild_queue WHERE conversation_id = ?',
    ).run(conv.id);
    const third = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(third.status, 200);
    assert.equal(third.body.rebuild_pending, false);
  } finally {
    await cleanup(env);
  }
});

test('新排入的 rebuild_queue 行立即可被 worker 扫到', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    const result = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(result.status, 200);

    const row = env.gateway.dbState.db.prepare(
      `SELECT state, created_at, next_attempt_at
         FROM rebuild_queue WHERE conversation_id = ?`,
    ).get(conv.id);
    assert.equal(row.state, 'pending');
    assert.equal(typeof row.next_attempt_at, 'number');
    assert.equal(row.next_attempt_at, row.created_at);

    const naive = env.gateway.dbState.db.prepare(
      `SELECT id FROM rebuild_queue
        WHERE conversation_id = ? AND state = 'pending' AND next_attempt_at <= ?`,
    ).all(conv.id, Date.now());
    assert.equal(naive.length, 1);

    const claimed = env.gateway.dbState.db.prepare(
      `SELECT id FROM rebuild_queue
        WHERE conversation_id = ? AND state = 'pending'
          AND COALESCE(next_attempt_at, 0) <= ?`,
    ).all(conv.id, Date.now());
    assert.equal(claimed.length, 1);
  } finally {
    await cleanup(env);
  }
});

test('/prompt 在 pending 队列行存在时返回 409，且不落消息', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    const switched = await switchPolicy(env.base, token, conv.id, 'owner');
    assert.equal(switched.status, 200);

    const count = () => env.gateway.dbState.db.prepare(
      'SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?',
    ).get(conv.id).n;
    const before = count();

    const blocked = await fetch(`${env.base}/conversations/${conv.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '切换期间发一句', client_msg_id: 'cm-gated' }),
    });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.error.code, 'rebuild-in-progress');
    assert.equal(body.error.rebuild_state, 'pending');
    assert.equal(count(), before, '闸门拒绝时不能落消息');

    env.gateway.dbState.db.prepare(
      'DELETE FROM rebuild_queue WHERE conversation_id = ?',
    ).run(conv.id);
    const ok = await fetch(`${env.base}/conversations/${conv.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '恢复后发一句', client_msg_id: 'cm-gated' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(count(), before + 1);
  } finally {
    await cleanup(env);
  }
});

test('/prompt 在 failed 队列行存在时仍返回 409，并带 rebuild_state=failed', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    await switchPolicy(env.base, token, conv.id, 'owner');
    env.gateway.dbState.db.prepare(
      `UPDATE rebuild_queue SET state = 'failed', next_attempt_at = NULL
        WHERE conversation_id = ?`,
    ).run(conv.id);

    const res = await fetch(`${env.base}/conversations/${conv.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: '失败行还在', client_msg_id: 'cm-failed' }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'rebuild-in-progress');
    assert.equal(body.error.rebuild_state, 'failed');
  } finally {
    await cleanup(env);
  }
});

test('GET /conversations 返回 rebuild_state 和 rebuild_pending', async () => {
  const env = await setup();
  try {
    const token = await env.login('owner');
    const conv = await createConversation(env.base, token);
    await switchPolicy(env.base, token, conv.id, 'owner');

    const list = await (await fetch(`${env.base}/conversations`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0].rebuild_state, 'pending');
    assert.equal(list.conversations[0].rebuild_pending, true);

    env.gateway.dbState.db.prepare(
      'DELETE FROM rebuild_queue WHERE conversation_id = ?',
    ).run(conv.id);
    const empty = await (await fetch(`${env.base}/conversations`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    assert.equal(empty.conversations[0].rebuild_state, null);
    assert.equal(empty.conversations[0].rebuild_pending, false);
  } finally {
    await cleanup(env);
  }
});
