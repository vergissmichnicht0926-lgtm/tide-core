import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

function insertMessage(db, conversationId, seq) {
  db.prepare(
    `INSERT INTO message
       (id, conversation_id, role, content_json, created_at, seq)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  ).run(
    randomUUID(),
    conversationId,
    JSON.stringify({ type: 'text', text: `m${seq}` }),
    Date.now() + seq,
    seq,
  );
}

function openSse(url, headers) {
  const controller = new AbortController();
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';

  const opening = fetch(url, { headers, signal: controller.signal }).then(async (res) => {
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
    throw new Error(`SSE 等待 ${type} 超时；已收到 ${events.map((event) => event.type).join(',')}`);
  };

  return { opening, events, waitFor, close: () => controller.abort() };
}

async function waitForHealth(base, predicate, timeoutMs = 4_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const health = await (await fetch(`${base}/health`)).json();
    if (predicate(health)) return health;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('health 指标等待超时');
}

async function openGateway(dbPath) {
  const gateway = await createGateway({
    dbPath,
    jwtSecret: 'p0-6-restart-secret',
    realtime: { mode: 'user', streamEnabled: true },
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  return {
    gateway,
    base: `http://127.0.0.1:${gateway.server.address().port}`,
  };
}

async function closeGateway(gateway) {
  gateway.closeSse();
  gateway.server.closeAllConnections?.();
  await new Promise((resolve) => gateway.server.close(resolve));
}

test('网关重启后 ready/replay 与 after_seq 从同一 DB 水位续上', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-p0-6-'));
  const dbPath = path.join(dir, 'gateway.db');
  let first;
  let second;
  let sse;
  try {
    first = await openGateway(dbPath);
    await first.gateway.authService.createUser({
      username: 'restart',
      password: 'password123',
    });
    first.gateway.dbState.db.prepare(
      "UPDATE users SET role = 'admin' WHERE username = 'restart'",
    ).run();
    const login = await (
      await fetch(`${first.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'restart', password: 'password123' }),
      })
    ).json();
    const bearer = { authorization: `Bearer ${login.accessToken}` };
    const conversation = await (
      await fetch(`${first.base}/conversations`, {
        method: 'POST',
        headers: { ...bearer, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'restart' }),
      })
    ).json();
    for (let seq = 1; seq <= 3; seq += 1) {
      insertMessage(first.gateway.dbState.db, conversation.id, seq);
    }

    sse = openSse(
      `${first.base}/stream?since=${encodeURIComponent(`${conversation.id}:1:1`)}`,
      bearer,
    );
    await sse.opening;
    const readyBefore = await sse.waitFor('ready');
    assert.equal(
      readyBefore.data.conversations.find((item) => item.conversationId === conversation.id)
        .latestSeq,
      3,
    );
    await sse.waitFor('assistant_message', (event) => event.data.seq === 3);
    const liveHealth = await waitForHealth(
      first.base,
      (health) => health.realtime.activeUserConnections === 1,
    );
    assert.equal(liveHealth.realtime.connectionsOpened, 1);
    assert.equal(liveHealth.realtime.replayEvents, 2);
    sse.close();
    await waitForHealth(
      first.base,
      (health) => health.realtime.activeUserConnections === 0
        && health.realtime.connectionsClosed === 1,
    );
    await closeGateway(first.gateway);
    first = null;

    second = await openGateway(dbPath);
    sse = openSse(
      `${second.base}/stream?since=${encodeURIComponent(`${conversation.id}:1:2`)}`,
      bearer,
    );
    await sse.opening;
    const readyAfter = await sse.waitFor('ready');
    assert.equal(
      readyAfter.data.conversations.find((item) => item.conversationId === conversation.id)
        .latestSeq,
      3,
    );
    const replayed = await sse.waitFor(
      'assistant_message',
      (event) => event.data.seq === 3,
    );
    assert.equal(replayed.data.message.text, 'm3');
    assert.equal(
      sse.events.filter((event) => event.type === 'assistant_message').length,
      1,
    );

    const rest = await fetch(
      `${second.base}/conversations/${conversation.id}/messages?after_seq=2&limit=100`,
      { headers: bearer },
    );
    assert.equal(rest.status, 200);
    const page = await rest.json();
    assert.equal(page.epoch, 1);
    assert.equal(page.latest_seq, 3);
    assert.deepEqual(page.messages.map((message) => message.seq), [3]);
    const catchUpHealth = await waitForHealth(
      second.base,
      (health) => health.realtime.catchUpRequests === 1,
    );
    assert.equal(catchUpHealth.realtime.replayEvents, 1);
  } finally {
    if (sse) sse.close();
    if (first) await closeGateway(first.gateway);
    if (second) await closeGateway(second.gateway);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
