import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-read-sync-'));
  const gateway = await createGateway({
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'read-sync-test-secret',
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  await gateway.authService.createUser({ username: 'reader', password: 'password123' });
  await gateway.authService.createUser({ username: 'other', password: 'password123' });
  gateway.dbState.db.prepare("UPDATE users SET role = 'admin' WHERE username = 'reader'").run();
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123' }),
    });
    return res.json();
  };
  const reader = await login('reader');
  const other = await login('other');
  const bearer = { authorization: `Bearer ${reader.accessToken}` };
  const created = await (
    await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '已读同步' }),
    })
  ).json();
  for (let seq = 1; seq <= 3; seq += 1) {
    gateway.dbState.db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq)
       VALUES (?, ?, 'assistant', ?, ?, ?)`,
    ).run(
      randomUUID(),
      created.id,
      JSON.stringify({ type: 'text', text: `m${seq}` }),
      Date.now() + seq,
      seq,
    );
  }
  return {
    gateway,
    base,
    bearer,
    conversationId: created.id,
    readerId: reader.userId,
    otherId: other.userId,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function read(s, throughSeq) {
  return fetch(`${s.base}/conversations/${s.conversationId}/read`, {
    method: 'POST',
    headers: { ...s.bearer, 'content-type': 'application/json' },
    body: JSON.stringify({ through_seq: throughSeq }),
  });
}

test('postRead 只向本用户发 conversation.read，低 seq 不回退', async () => {
  const s = await makeServer();
  const readerEvents = [];
  const otherEvents = [];
  s.gateway.events.subscribeUser(s.readerId, (event) => readerEvents.push(event));
  s.gateway.events.subscribeUser(s.otherId, (event) => otherEvents.push(event));
  try {
    const first = await read(s, 2);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.last_read_seq, 2);
    assert.equal(firstBody.epoch, 1);
    assert.equal(readerEvents.length, 1);
    assert.equal(readerEvents[0].type, 'conversation.read');
    assert.equal(readerEvents[0].conversationId, s.conversationId);
    assert.equal(readerEvents[0].lastReadSeq, 2);
    assert.equal(readerEvents[0].epoch, 1);
    assert.equal(otherEvents.length, 0);

    const lower = await read(s, 1);
    assert.equal(lower.status, 200);
    assert.equal((await lower.json()).last_read_seq, 2);
    assert.equal(readerEvents.length, 1, '低 seq 不回退也不重复发事件');

    const higher = await read(s, 3);
    assert.equal(higher.status, 200);
    assert.equal((await higher.json()).last_read_seq, 3);
    assert.equal(readerEvents.length, 2);
    assert.equal(readerEvents[1].lastReadSeq, 3);
    assert.equal(otherEvents.length, 0);
  } finally {
    await s.close();
  }
});
