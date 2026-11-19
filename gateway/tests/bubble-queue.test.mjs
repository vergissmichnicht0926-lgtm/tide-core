/** 0.23 多气泡：segments、抖动、幂等与重启恢复。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silent = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-bubble-'));
  const dsh = createFakeDsh();
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    dsh,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'u', password: 'password123', role: 'admin',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const id = await gateway.ctx.createDirectConversation({
    userId: admin.id,
    title: '气泡测试',
  });
  const token = gateway.dbState.db.prepare(
    'SELECT agent_token FROM conversation WHERE id = ?',
  ).get(id).agent_token;
  const agent = (body) => fetch(`${base}/agent/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-token': token,
      'x-agent-call': '1',
      'x-agent-secret': 'test-secret',
    },
    body: JSON.stringify(body),
  });
  return {
    gateway,
    db: gateway.dbState.db,
    id,
    agent,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function setDelay(db, ms) {
  db.prepare('UPDATE bot_settings SET bubble_delay_ms = ? WHERE id = 1').run(ms);
}

function assistantRows(db, id) {
  return db.prepare(
    `SELECT id, seq, created_at, content_json FROM message
      WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq ASC`,
  ).all(id);
}

test('0.23 segments：三段按气泡间隔落库并逐条推送', async () => {
  const s = await makeServer();
  try {
    setDelay(s.db, 1000);
    const events = [];
    s.gateway.events.subscribe(s.id, (event) => {
      if (event.type === 'assistant_message') events.push(event);
    });
    const res = await s.agent({
      segments: ['第一段', '第二段', '第三段'],
      clientBatchId: 'bubble-three',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queued, true);
    assert.equal(body.bubbles, true);
    assert.equal(body.messages.length, 0);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM bubble_queue WHERE conversation_id = ?').get(s.id).n,
      3,
    );

    await sleep(3600);
    const rows = assistantRows(s.db, s.id);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3]);
    assert.ok(rows[1].created_at - rows[0].created_at >= 650);
    assert.ok(rows[2].created_at - rows[1].created_at >= 650);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM bubble_queue WHERE state = 'sent'").get().n,
      3,
    );
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((event) => event.message.text),
      ['第一段', '第二段', '第三段'],
    );
  } finally {
    await s.close();
  }
});

test('0.23 气泡间隔 0：回到整批插入', async () => {
  const s = await makeServer();
  try {
    setDelay(s.db, 0);
    const res = await s.agent({
      segments: ['A', 'B', 'C'],
      clientBatchId: 'bubble-zero',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queued, false);
    assert.equal(body.bubbles, undefined);
    assert.equal(body.messages.length, 3);
    const rows = assistantRows(s.db, s.id);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => row.created_at)).size, 1);
  } finally {
    await s.close();
  }
});

test('0.23 segments：五段、单段超长与 messages/segments 混用都 400', async () => {
  const s = await makeServer();
  try {
    for (const body of [
      { segments: ['1', '2', '3', '4', '5'] },
      { segments: ['x'.repeat(2001)] },
      { messages: ['a'], segments: ['b'] },
    ]) {
      const res = await s.agent(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, 'bad-request');
    }
  } finally {
    await s.close();
  }
});

test('0.23 clientBatchId 幂等：同一批 segments 只落一次', async () => {
  const s = await makeServer();
  try {
    setDelay(s.db, 0);
    const payload = { segments: ['一', '二', '三'], clientBatchId: 'bubble-idem' };
    assert.equal((await s.agent(payload)).status, 200);
    const second = await s.agent(payload);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).duplicated, true);
    assert.equal(assistantRows(s.db, s.id).length, 3);
  } finally {
    await s.close();
  }
});

test('0.23 重启恢复：pending 气泡在 start 后继续发送', async () => {
  const s = await makeServer();
  try {
    setDelay(s.db, 3000);
    const res = await s.agent({ segments: ['重启一', '重启二'], clientBatchId: 'bubble-restart' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).queued, true);
    s.gateway.social.stop();
    s.db.prepare(
      "UPDATE bubble_queue SET not_before_ms = ? WHERE state = 'pending'",
    ).run(Date.now() - 1000);
    s.gateway.social.start();
    await sleep(400);
    assert.equal(assistantRows(s.db, s.id).length, 2);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM bubble_queue WHERE state = 'pending'").get().n,
      0,
    );
  } finally {
    await s.close();
  }
});
