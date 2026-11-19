import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';
import { flushBuffered } from '../routes/conversations.mjs';

const silent = { log() {}, warn() {}, error() {} };

test('flushBuffered 丢弃已回放 seq，保留更新消息和非消息事件', () => {
  const buffered = [
    { type: 'assistant_message', conversationId: 'c1', seq: 2 },
    { type: 'assistant_message', conversationId: 'c1', seq: 3 },
    { type: 'turn_end', conversationId: 'c1' },
  ];
  const lastSent = new Map([['c1', 2]]);
  const sent = [];
  const result = flushBuffered(buffered, lastSent, (event) => {
    sent.push(event);
    return true;
  });
  assert.deepEqual(result, { sent: 2, dropped: 1 });
  assert.deepEqual(sent.map((event) => event.seq ?? event.type), [3, 'turn_end']);
  assert.equal(buffered.length, 0);
});

async function makeServer(realtime = { mode: 'user', streamEnabled: true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-stream-user-'));
  const gateway = await createGateway({
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'stream-user-test-secret',
    realtime,
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  await gateway.authService.createUser({ username: 'stream', password: 'password123' });
  gateway.dbState.db.prepare("UPDATE users SET role = 'admin' WHERE username = 'stream'").run();
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = await (
    await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'stream', password: 'password123' }),
    })
  ).json();
  const bearer = { authorization: `Bearer ${login.accessToken}` };
  const create = async (title) => {
    const res = await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const conversations = [await create('A'), await create('B'), await create('C')];
  return {
    gateway,
    base,
    bearer,
    conversations,
    db: gateway.dbState.db,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertMessage(s, conversationId, seq, text = `m${seq}`) {
  s.db.prepare(
    `INSERT INTO message
       (id, conversation_id, role, content_json, created_at, seq)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(
    randomUUID(),
    conversationId,
    JSON.stringify({ type: 'text', text }),
    Date.now() + seq,
    seq,
  );
}

function openSse(url, headers) {
  const controller = new AbortController();
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';

  const ready = fetch(url, { headers, signal: controller.signal }).then(async (res) => {
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const lines = chunk.split('\n');
            const type = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            if (type && data) events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch {
        // abort / close
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
    throw new Error(`SSE 等待 ${type} 超时；已收到 ${events.map((e) => e.type).join(',')}`);
  };

  return { ready, events, waitFor, close: () => controller.abort() };
}

test('用户级 ready 包含三会话 epoch/unread，live 事件按 cid 分发', async () => {
  const s = await makeServer();
  try {
    insertMessage(s, s.conversations[0].id, 1);
    insertMessage(s, s.conversations[0].id, 2);
    insertMessage(s, s.conversations[1].id, 1);
    const sse = openSse(`${s.base}/stream`, s.bearer);
    try {
      const ready = await sse.waitFor('ready');
      assert.equal(ready.data.conversations.length, 3);
      const byId = new Map(
        ready.data.conversations.map((item) => [item.conversationId, item]),
      );
      assert.equal(byId.get(s.conversations[0].id).latestSeq, 2);
      assert.equal(byId.get(s.conversations[0].id).lastSentSeq, 2);
      assert.equal(byId.get(s.conversations[0].id).unread, 2);
      assert.equal(byId.get(s.conversations[1].id).latestSeq, 1);
      assert.equal(byId.get(s.conversations[2].id).latestSeq, 0);
      assert.equal(byId.get(s.conversations[0].id).epoch, 1);

      insertMessage(s, s.conversations[0].id, 3);
      s.gateway.events.publish(s.conversations[0].id, {
        type: 'assistant_message',
        seq: 3,
        message: { id: 'live-3', seq: 3, role: 'assistant', text: 'live' },
      });
      const live = await sse.waitFor('assistant_message', (event) => event.data.seq === 3);
      assert.equal(live.data.conversationId, s.conversations[0].id);
      assert.equal(live.data.messageId, 'live-3');
      assert.equal(live.data.epoch, 1);
    } finally {
      sse.close();
    }
  } finally {
    await s.close();
  }
});

test('since 精确游标回放；epochChanged 发 rebuilt 且不重放旧 backlog', async () => {
  const s = await makeServer();
  try {
    const [a, b] = s.conversations;
    insertMessage(s, a.id, 1, 'a1');
    insertMessage(s, a.id, 2, 'a2');
    insertMessage(s, b.id, 1, 'b1');

    const exact = openSse(
      `${s.base}/stream?since=${encodeURIComponent(`${a.id}:1:1,${b.id}:1:1`)}`,
      s.bearer,
    );
    try {
      await exact.waitFor('ready');
      const replay = await exact.waitFor('assistant_message', (event) => event.data.seq === 2);
      assert.equal(replay.data.conversationId, a.id);
      assert.equal(replay.data.message.text, 'a2');
      assert.equal(exact.events.filter((event) => event.type === 'assistant_message').length, 1);
    } finally {
      exact.close();
    }

    const changed = openSse(
      `${s.base}/stream?since=${encodeURIComponent(`${a.id}:0:0`)}`,
      s.bearer,
    );
    try {
      const ready = await changed.waitFor('ready');
      assert.equal(
        ready.data.conversations.find((item) => item.conversationId === a.id).epochChanged,
        true,
      );
      const rebuilt = await changed.waitFor('conversation.rebuilt');
      assert.equal(rebuilt.data.conversationId, a.id);
      assert.equal(rebuilt.data.reason, 'epoch-mismatch');
      assert.equal(changed.events.filter((event) => event.type === 'assistant_message').length, 0);
    } finally {
      changed.close();
    }
  } finally {
    await s.close();
  }
});

test('replay 超限标记 replaySkipped；非法 since 400；legacy 模式 409', async () => {
  const s = await makeServer();
  try {
    const a = s.conversations[0];
    for (let seq = 1; seq <= 201; seq += 1) insertMessage(s, a.id, seq);
    const skipped = openSse(
      `${s.base}/stream?since=${encodeURIComponent(`${a.id}:1:0`)}`,
      s.bearer,
    );
    try {
      const ready = await skipped.waitFor('ready');
      assert.equal(
        ready.data.conversations.find((item) => item.conversationId === a.id).replaySkipped,
        true,
      );
      assert.equal(skipped.events.filter((event) => event.type === 'assistant_message').length, 0);
    } finally {
      skipped.close();
    }

    const bad = await fetch(`${s.base}/stream?since=bad`, { headers: s.bearer });
    assert.equal(bad.status, 400);

    const health = await (await fetch(`${s.base}/health`)).json();
    assert.equal(health.realtime.replaySkipped, 1);
  } finally {
    await s.close();
  }

  const legacy = await makeServer({ mode: 'legacy' });
  try {
    const res = await fetch(`${legacy.base}/stream`, { headers: legacy.bearer });
    assert.equal(res.status, 409);
  } finally {
    await legacy.close();
  }
});
