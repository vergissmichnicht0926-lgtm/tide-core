import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silent = { log() {}, warn() {}, error() {} };

test('createGateway 注入 dsh 后创建 worker，start=false 时由测试驱动 tick', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-wiring-'));
  const dsh = createFakeDsh();
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'wiring-test-secret-wiring-test-secret',
    dsh,
    startRebuildWorker: false,
    logger: silent,
  });
  try {
    assert.ok(gateway.rebuildWorker, '注入 dsh 后应当有 worker');
    assert.equal(gateway.ctx.rebuildWorker, gateway.rebuildWorker);
    assert.equal(gateway.ctx.dsh, dsh);

    const owner = await gateway.authService.createUser({
      username: 'owner',
      password: 'password123',
    });
    gateway.ctx.config.ownerIds.push(owner.id);
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}`;

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'password123' }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).accessToken;

    const created = await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: 'wiring' }),
    });
    assert.equal(created.status, 201);
    const conv = await created.json();
    assert.ok(conv.dsh_workspace_id, 'createConversation 应当分配 workspace');

    const switched = await fetch(`${base}/conversations/${conv.id}/policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ policy: 'owner' }),
    });
    assert.equal(switched.status, 200);
    gateway.dbState.db
      .prepare('UPDATE conversation SET dsh_after_seq = 999 WHERE id = ?')
      .run(conv.id);

    const result = await gateway.rebuildWorker.tick();
    assert.equal(result.status, 'rebuilt');
    const row = gateway.dbState.db.prepare(
      `SELECT dsh_session_id, dsh_workspace_id, agent_token, dsh_after_seq
         FROM conversation WHERE id = ?`,
    ).get(conv.id);
    assert.ok(row.dsh_session_id);
    assert.equal(row.dsh_workspace_id, conv.dsh_workspace_id);
    assert.equal(row.dsh_after_seq, 0, '新 DSH 会话的读游标必须从 0 重新开始');
    assert.equal(row.agent_token.length, 48);
    assert.equal(
      gateway.dbState.db.prepare(
        'SELECT COUNT(*) AS n FROM rebuild_queue WHERE conversation_id = ?',
      ).get(conv.id).n,
      0,
    );
    const createdCall = dsh.calls.find((call) => call.name === 'createSession');
    assert.equal(createdCall.preset, 'tide-owner');
    const workspaceCall = dsh.calls.find((call) => call.name === 'createWorkspace');
    assert.ok(workspaceCall, '应当先创建 workspace');
    assert.match(workspaceCall.path, /conversations/);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
