import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-gw-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    dshBaseUrl: 'http://127.0.0.1:3081',
  });
  await gateway.authService.createUser({ username: 'tester', password: 'password123' });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  return { dir, gateway, base };
}

test('health and conversation skeleton', async () => {
  const { dir, gateway, base } = await start();
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const h = await health.json();
    assert.equal(h.ok, true);
    assert.equal(h.db, 'ok');
    assert.equal(h.publicBaseUrl, '');

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'password123', deviceName: 'test' }),
    });
    assert.equal(login.status, 200);
    const session = await login.json();
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken);

    const created = await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ title: '测试对话' }),
    });
    assert.equal(created.status, 201);
    const conv = await created.json();
    assert.ok(conv.id);

    const list = await (await fetch(`${base}/conversations`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    })).json();
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0].id, conv.id);

    const prompt = await fetch(`${base}/conversations/${conv.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ text: '你好', client_msg_id: 'cm1' }),
    });
    assert.equal(prompt.status, 200);
    assert.equal((await prompt.json()).queued, true);

    const messages = await (await fetch(`${base}/conversations/${conv.id}/messages`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    })).json();
    assert.equal(messages.messages.length, 1);
    assert.equal(messages.messages[0].content.text, '你好');

    const read = await fetch(`${base}/conversations/${conv.id}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ through_seq: 1 }),
    });
    assert.equal((await read.json()).user_read_seq, 1);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('health exposes configured publicBaseUrl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-gw-public-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    publicBaseUrl: 'https://tide.example/tide',
    startSocial: false,
    startRebuildWorker: false,
    logger: { log() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.publicBaseUrl, 'https://tide.example/tide');
  } finally {
    gateway.closeSse();
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
