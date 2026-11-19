/** 0.22 全局静默：API、审计、引擎闸门。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silentLogger = { log() {}, warn() {}, error() {} };

async function makeConsoleServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-silence-console-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    realtime: { mode: 'user', streamEnabled: true },
    startSocial: false,
    startRebuildWorker: false,
    logger: silentLogger,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin', password: 'password123', role: 'admin',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const loginRes = await fetch(`${base}/console/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123' }),
  });
  const loginBody = await loginRes.json();
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const match = setCookie.match(/tide_admin=([^;]+)/);
  const cookie = match ? `tide_admin=${match[1]}` : '';
  const patch = (body, csrf = loginBody.csrfToken) => fetch(`${base}/console/api/bot/silence`, {
    method: 'PATCH',
    headers: {
      cookie,
      ...(csrf ? { 'x-tide-csrf': csrf } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const getBot = () => fetch(`${base}/console/api/bot`, { headers: { cookie } }).then((r) => r.json());
  return {
    gateway,
    admin,
    base,
    db: gateway.dbState.db,
    patch,
    getBot,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('0.22 静默 API：三种 body、落库与审计', async () => {
  const s = await makeConsoleServer();
  try {
    assert.equal((await s.getBot()).silentUntil, 0);

    const appSession = await s.gateway.authService.login({
      username: 'admin', password: 'password123', deviceName: 'silence-test',
    });
    const adminSettings = await fetch(`${s.base}/admin/settings`, {
      headers: { authorization: `Bearer ${appSession.accessToken}` },
    }).then((r) => r.json());
    assert.equal(adminSettings.settings.silentUntil, undefined);
    assert.deepEqual(
      Object.keys(adminSettings.settings),
      ['aiName', 'aiSignature', 'aiAvatar', 'personaOverride', 'model',
        'toolProfile', 'defaultWakeConfig', 'perUserLimits', 'updatedAt'],
    );

    for (const body of [{ minutes: 30 }, { minutes: 60 }, { minutes: 480 }]) {
      const res = await s.patch(body);
      assert.equal(res.status, 200);
      const out = await res.json();
      assert.equal(out.active, true);
      assert.equal(out.silentUntil, Number(s.db.prepare(
        'SELECT silent_until_ms AS n FROM bot_settings WHERE id = 1',
      ).get().n));
    }

    const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const untilRes = await s.patch({ until });
    assert.equal(untilRes.status, 200);
    assert.equal((await untilRes.json()).until, until);

    const off = await s.patch({ off: true });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).silentUntil, 0);
    assert.equal((await s.getBot()).silentUntil, 0);

    const audit = s.db.prepare(
      "SELECT detail_json FROM audit_log WHERE action = 'bot.silence' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.ok(audit);
    assert.match(audit.detail_json, /"until":null/);
    const event = s.db.prepare(
      `SELECT detail FROM event_log WHERE kind = 'console.change'
        ORDER BY id DESC LIMIT 1`,
    ).get();
    assert.ok(event);
    assert.match(event.detail, /bot\.silence/);
  } finally {
    await s.close();
  }
});

test('0.22 静默 API：越界、过去时间、混用字段与 CSRF', async () => {
  const s = await makeConsoleServer();
  try {
    const bad = [
      { minutes: 0 },
      { minutes: 10_081 },
      { until: new Date(Date.now() - 60_000).toISOString() },
      { minutes: 30, off: true },
      { minutes: 30, extra: true },
      { off: false },
    ];
    for (const body of bad) {
      const res = await s.patch(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, 'bad-request');
    }
    const noCsrf = await s.patch({ minutes: 30 }, '');
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});

async function makeEngineServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-silence-engine-'));
  const logs = [];
  const dsh = createFakeDsh();
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    dsh,
    startRebuildWorker: false,
    logger: {
      log(message) { logs.push(String(message)); },
      warn(message) { logs.push(String(message)); },
      error() {},
    },
  });
  const admin = await gateway.authService.createUser({
    username: 'u', password: 'password123', role: 'admin',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const app = await gateway.authService.login({
    username: 'u', password: 'password123', deviceName: 'silence-engine',
  });
  const created = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${app.accessToken}`,
    },
    body: JSON.stringify({ title: '静默测试群', kind: 'group' }),
  }).then((r) => r.json());
  const id = created.id || created.conversation?.id;
  return {
    gateway,
    dsh,
    db: gateway.dbState.db,
    id,
    base,
    app,
    logs,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('0.22 静默引擎：不唤醒、不排队、恢复后正常', async () => {
  const s = await makeEngineServer();
  try {
    const setSilent = (ms) => s.db.prepare(
      'UPDATE bot_settings SET silent_until_ms = ? WHERE id = 1',
    ).run(ms);

    setSilent(Date.now() + 10 * 60 * 1000);
    const prompt = await fetch(`${s.base}/conversations/${s.id}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.app.accessToken}`,
      },
      body: JSON.stringify({ text: '@汐语 静默期的消息', client_msg_id: 'silent-user-1' }),
    });
    assert.equal(prompt.status, 200);
    assert.equal(
      s.db.prepare(
        "SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND role = 'user'",
      ).get(s.id).n,
      1,
      '静默不影响消息落库',
    );
    const userSeq = s.db.prepare(
      "SELECT MAX(seq) AS seq FROM message WHERE conversation_id = ? AND role = 'user'",
    ).get(s.id).seq;
    const readSeq = s.db.prepare(
      'SELECT agent_read_seq FROM conversation WHERE id = ?',
    ).get(s.id).agent_read_seq;
    assert.ok(userSeq > readSeq, '未读水位不应被静默推进');

    await s.gateway.social.deliverWake(s.id, 'question', { skipMessageCheck: true });
    assert.equal(s.dsh.getCallCount('prompt'), 0);
    let wake = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(s.id).j,
    );
    assert.equal(wake.wakeCount, 0);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?').get(s.id).n,
      0,
    );
    assert.ok(s.logs.some((line) => line.includes('silent')), '日志应包含 silent');

    setSilent(0);
    await s.gateway.social.deliverWake(s.id, 'question', { skipMessageCheck: true });
    assert.equal(s.dsh.getCallCount('prompt'), 1, '解除后应恢复唤醒');
    await s.gateway.social.onTurnEnd(s.id);

    setSilent(Date.now() - 1000);
    s.db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?').run('{}', s.id);
    await s.gateway.social.deliverWake(s.id, 'question', { skipMessageCheck: true });
    assert.equal(s.dsh.getCallCount('prompt'), 2, '过期后应正常唤醒');
  } finally {
    await s.close();
  }
});
