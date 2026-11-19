import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

async function makeServer(realtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-realtime-'));
  const gateway = await createGateway({
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'realtime-test-secret',
    realtime,
    startSocial: false,
    startRebuildWorker: false,
  });
  await gateway.authService.createUser({ username: 'realtime', password: 'password123' });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = await (
    await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'realtime', password: 'password123' }),
    })
  ).json();
  return {
    gateway,
    base,
    bearer: { authorization: `Bearer ${login.accessToken}` },
    userId: login.userId,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function config(s) {
  const res = await fetch(`${s.base}/realtime/config`, { headers: s.bearer });
  return { status: res.status, body: await res.json() };
}

test('realtime config: legacy / user / auto percent / auto allowlist', async () => {
  const legacy = await makeServer({ mode: 'legacy' });
  try {
    const result = await config(legacy);
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'legacy');
    assert.equal(result.body.streamPath, null);
    assert.equal(result.body.fallbackPath, '/conversations/:id/stream');
    assert.equal(result.body.contractVersion, 1);
    assert.equal(result.body.replayLimit, 200);
    assert.equal(result.body.streamEnabled, false);
  } finally {
    await legacy.close();
  }

  const user = await makeServer({ mode: 'user', streamEnabled: true });
  try {
    const result = await config(user);
    assert.equal(result.body.mode, 'user');
    assert.equal(result.body.streamEnabled, true);
    assert.equal(result.body.streamPath, '/stream');
  } finally {
    await user.close();
  }

  const all = await makeServer({ mode: 'auto', percent: 100, streamEnabled: true });
  try {
    assert.equal((await config(all)).body.mode, 'user');
  } finally {
    await all.close();
  }

  const none = await makeServer({ mode: 'auto', percent: 0, streamEnabled: true });
  try {
    assert.equal((await config(none)).body.mode, 'legacy');
    assert.equal(none.gateway.ctx.realtimeModeForUser('u-allow'), 'legacy');
  } finally {
    await none.close();
  }

  const allow = await makeServer({
    mode: 'auto',
    userIds: ['u-allow'],
    percent: 0,
    streamEnabled: true,
  });
  try {
    assert.equal(allow.gateway.ctx.realtimeModeForUser('u-allow'), 'user');
    assert.equal(allow.gateway.ctx.realtimeModeForUser('u-other'), 'legacy');
  } finally {
    await allow.close();
  }
});

test('stream 未启用时，user/auto 仍锁在 legacy', async () => {
  const user = await makeServer({ mode: 'user' });
  try {
    const result = await config(user);
    assert.equal(result.body.mode, 'legacy');
    assert.equal(result.body.streamEnabled, false);
  } finally {
    await user.close();
  }

  const auto = await makeServer({ mode: 'auto', percent: 100 });
  try {
    assert.equal((await config(auto)).body.mode, 'legacy');
  } finally {
    await auto.close();
  }
});

test('realtime config 需要 Bearer', async () => {
  const s = await makeServer({ mode: 'legacy' });
  try {
    const res = await fetch(`${s.base}/realtime/config`);
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});
