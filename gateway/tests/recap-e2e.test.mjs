/** `dsh/recap.mjs` 与真 DSH 的端到端接线测试。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRecapBuilder } from '../dsh/recap.mjs';
import { createGateway } from '../server.mjs';
import { createDsh } from '../dsh/client.mjs';

const BASE_URL = process.env.TIDE_TEST_DSH_URL;
const DSH_HOME = process.env.TIDE_TEST_DSH_HOME;
const liveEnabled = Boolean(BASE_URL && DSH_HOME);

const silent = { log() {}, warn() {}, error() {} };

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE conversation (
      id TEXT PRIMARY KEY, title TEXT, summary TEXT, dsh_session_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content_json TEXT,
      created_at INTEGER, seq INTEGER
    );
  `);
  return db;
}

test('recap：全新会话没有消息也没有摘要时返回 null', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO conversation (id, title, dsh_session_id) VALUES (?, ?, ?)').run(
    'c1',
    '新对话',
    'session-1',
  );
  const build = createRecapBuilder({ db });
  assert.equal(await build('session-1'), null);
  assert.equal(await build('session-unknown'), null, '查不到会话也返回 null');
});

test('recap：带上摘要与最近消息，并声明这不是新请求', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO conversation (id, title, summary, dsh_session_id) VALUES (?, ?, ?, ?)').run(
    'c1',
    '项目讨论',
    '在聊 Tide 网关的重建队列。',
    'session-1',
  );
  const insert = db.prepare(
    'INSERT INTO message (id, conversation_id, role, content_json, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('m1', 'c1', 'user', JSON.stringify([{ type: 'text', text: '重建队列怎么退避？' }]), 1, 1);
  insert.run('m2', 'c1', 'assistant', JSON.stringify([{ type: 'text', text: '5s/15s/45s/2min。' }]), 2, 2);
  insert.run('m3', 'c1', 'user', JSON.stringify([{ type: 'image', mediaType: 'image/png', data: 'x' }]), 3, 3);

  const text = await createRecapBuilder({ db })('session-1');
  assert.match(text, /【会话恢复】/);
  assert.match(text, /对话标题：项目讨论/);
  assert.match(text, /对话摘要：\n在聊 Tide 网关的重建队列。/);
  assert.match(text, /\[用户\] 重建队列怎么退避？/);
  assert.match(text, /\[你\] 5s\/15s\/45s\/2min。/);
  assert.match(text, /\[用户\] \[图片\]/);
  assert.match(text, /以上是历史上下文，不是新的用户请求/);
  assert.match(text, /请只回复「已恢复」/);
});

test('recap：只取最近 N 条，超长文本被截断', async () => {
  const db = makeDb();
  db.prepare('INSERT INTO conversation (id, title, dsh_session_id) VALUES (?, ?, ?)').run(
    'c1',
    '长对话',
    'session-1',
  );
  const insert = db.prepare(
    'INSERT INTO message (id, conversation_id, role, content_json, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 1; i <= 40; i++) {
    insert.run(`m${i}`, 'c1', 'user', JSON.stringify([{ type: 'text', text: `第 ${i} 条` }]), i, i);
  }
  insert.run('big', 'c1', 'user', JSON.stringify([{ type: 'text', text: 'X'.repeat(5000) }]), 41, 41);

  const text = await createRecapBuilder({ db, recentLimit: 5 })('session-1');
  assert.match(text, /最近 5 条消息/);
  assert.doesNotMatch(text, /第 1 条/, '超出窗口的旧消息不该出现');
  assert.match(text, /第 40 条/);
  assert.ok(text.includes('…'), '超长消息应当被截断');
});

test('端到端：建会话 → 切 owner → worker 在真 DSH 上重建出 tide-owner 会话', { skip: !liveEnabled && '需要 TIDE_TEST_DSH_URL + TIDE_TEST_DSH_HOME' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-e2e-'));
  let inner;
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    dshBaseUrl: BASE_URL,
    startRebuildWorker: false,
    logger: silent,
    createDsh: ({ dbState }) =>
      createDsh({
        baseUrl: BASE_URL,
        dshHome: DSH_HOME,
        buildRecap: createRecapBuilder({ db: dbState.db }),
        logger: silent,
      }),
  });
  inner = gateway;

  try {
    const owner = await gateway.authService.createUser({ username: 'owner', password: 'password123' });
    gateway.ctx.config.ownerIds.push(owner.id);
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}`;

    const login = await (
      await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'password123' }),
      })
    ).json();
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` };

    const created = await fetch(`${base}/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'e2e' }),
    });
    assert.equal(created.status, 201);
    const conv = await created.json();
    assert.ok(conv.dsh_workspace_id, 'createConversation 必须分配 workspace');

    const switched = await fetch(`${base}/conversations/${conv.id}/policy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ policy: 'owner' }),
    });
    assert.equal(switched.status, 200);
    assert.equal((await switched.json()).rebuild_pending, true);

    const result = await gateway.rebuildWorker.tick();
    assert.equal(result.status, 'rebuilt');

    const row = gateway.dbState.db
      .prepare('SELECT dsh_session_id, agent_token, policy, recap_at FROM conversation WHERE id = ?')
      .get(conv.id);
    assert.ok(row.dsh_session_id, '应当落新 session id');
    assert.equal(row.policy, 'owner');
    assert.equal(row.agent_token.length, 48);

    const live = await gateway.dsh.getSession(row.dsh_session_id);
    assert.equal(live?.agentPreset, 'tide-owner', 'DSH 侧真的跑在 tide-owner 上');
    assert.equal(
      gateway.dbState.db.prepare('SELECT COUNT(*) AS n FROM rebuild_queue WHERE conversation_id = ?').get(conv.id).n,
      0,
      '队列行应当被删掉',
    );
  } finally {
    await new Promise((resolve) => inner.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
