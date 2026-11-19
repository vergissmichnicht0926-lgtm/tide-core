import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-reg-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    dshBaseUrl: '',
    jwtSecret: 'test-secret-test-secret-test-secret-123456',
  });
  await gateway.authService.createUser({ username: 'tester', password: 'password123' });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'password123' }),
  }).then((r) => r.json());
  const token = login.accessToken;
  const headers = (extra = {}) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    ...extra,
  });
  const post = (url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const createConversation = async (title) => {
    const res = await post('/conversations', { title });
    assert.equal(res.status, 201);
    return res.json();
  };
  return { dir, gateway, base, token, headers, post, createConversation };
}

async function cleanup({ dir, gateway }) {
  await new Promise((resolve) => gateway.server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

test('P0-1 跨会话附件被拒且消息不落库', async () => {
  const env = await setup();
  try {
    const a = await env.createConversation('A');
    const b = await env.createConversation('B');
    const attachmentId = randomUUID();
    env.gateway.dbState.db.prepare(
      `INSERT INTO attachment
         (id, conversation_id, kind, media_type, bytes, local_path, created_at)
       VALUES (?, ?, 'file', 'text/plain', 4, 'D:/tmp/test.txt', ?)`,
    ).run(attachmentId, b.id, Date.now());

    const res = await env.post(`/conversations/${a.id}/prompt`, {
      text: '看看这个',
      attachments: [attachmentId],
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'bad-request');

    const count = env.gateway.dbState.db.prepare(
      'SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?',
    ).get(a.id).n;
    assert.equal(count, 0);

    const att = env.gateway.dbState.db.prepare(
      'SELECT conversation_id, message_id FROM attachment WHERE id = ?',
    ).get(attachmentId);
    assert.equal(att.conversation_id, b.id);
    assert.equal(att.message_id, null);
  } finally {
    await cleanup(env);
  }
});

test('P0-2 through_seq 超过最新 seq 返回 400', async () => {
  const env = await setup();
  try {
    const a = await env.createConversation('A');
    await env.post(`/conversations/${a.id}/prompt`, { text: 'hi', client_msg_id: 'm1' });
    const res = await env.post(`/conversations/${a.id}/read`, { through_seq: 999999 });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'bad-request');
    const row = env.gateway.dbState.db.prepare(
      'SELECT user_read_seq FROM conversation WHERE id = ?',
    ).get(a.id);
    assert.equal(row.user_read_seq, 0);
  } finally {
    await cleanup(env);
  }
});

test('P0-3 非法 before / after_seq 返回 400', async () => {
  const env = await setup();
  try {
    const a = await env.createConversation('A');
    for (const query of ['before=abc', 'after_seq=nope']) {
      const res = await fetch(
        `${env.base}/conversations/${a.id}/messages?${query}`,
        { headers: env.headers() },
      );
      assert.equal(res.status, 400, query);
      const body = await res.json();
      assert.equal(body.error.code, 'bad-request');
    }
  } finally {
    await cleanup(env);
  }
});
