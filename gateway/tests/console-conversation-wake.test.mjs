/** P6.1：管理台会话级唤醒。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-conversation-wake-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    realtime: { mode: 'user', streamEnabled: true },
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin',
    password: 'password123',
    role: 'admin',
    displayName: '管理员',
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
  const cookieMatch = setCookie.match(/tide_admin=([^;]+)/);
  const login = {
    cookie: cookieMatch ? `tide_admin=${cookieMatch[1]}` : '',
    csrf: loginBody.csrfToken,
  };

  const api = (p, { csrf, ...init } = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(login.cookie ? { cookie: login.cookie } : {}),
      ...(csrf ? { 'x-tide-csrf': csrf } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });

  const createConversation = async (title) => gateway.ctx.createDirectConversation({
    userId: admin.id,
    title,
  });

  return {
    dir,
    gateway,
    db: gateway.dbState.db,
    admin,
    base,
    login,
    api,
    createConversation,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function wakePath(id) {
  return `/console/api/conversations/${encodeURIComponent(id)}/wake`;
}

test('P6.1 GET：新会话与默认值一致，sleepUntil 为只读数字', async () => {
  const s = await makeServer();
  try {
    const id = await s.createConversation('会话唤醒读取');
    const res = await s.api(wakePath(id));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.conversationId, id);
    assert.equal(body.title, '会话唤醒读取');
    assert.equal(body.kind, 'direct');
    assert.equal(body.config.mode, 'diving');
    assert.equal(body.config.limits.maxWakePerHour, 12);
    assert.equal(body.config.hint, '');
    assert.equal(body.sleepUntil, 0);
    assert.equal(body.matchesDefaults, true);
    assert.equal(typeof body.summary, 'string');
    assert.equal(body.defaults.limits.maxWakePerHour, 12);
  } finally {
    await s.close();
  }
});

test('P6.1 PATCH：落库、审计、拒绝网关自管字段与非法 limits', async () => {
  const s = await makeServer();
  try {
    const id = await s.createConversation('会话唤醒写入');
    const config = {
      mode: 'diving',
      triggers: {
        atMention: true,
        nameMention: false,
        question: true,
        poke: false,
        anyMessage: false,
        keywords: ['暗号'],
        probability: 0.2,
      },
      batchWindowMs: 5000,
      limits: {
        maxWakePerMinute: 2,
        maxWakePerHour: 9,
        preSleepWaitMs: 120000,
        noActionLimit: 4,
        maxWakeConfigReminders: 1,
      },
      hint: '这个会话可以主动一点',
    };
    const put = await s.api(wakePath(id), {
      method: 'PATCH',
      csrf: s.login.csrf,
      body: JSON.stringify({ config }),
    });
    assert.equal(put.status, 200);
    const saved = await put.json();
    assert.equal(saved.matchesDefaults, false);
    assert.equal(saved.config.batchWindowMs, 5000);
    assert.equal(saved.config.limits.maxWakePerHour, 9);
    assert.equal(saved.config.hint, '这个会话可以主动一点');
    assert.equal(saved.config.triggers.nameMention, false);
    assert.equal(saved.config.triggers.probability, 0.2);

    const stored = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(id).j,
    );
    assert.equal(stored.limits.maxWakePerHour, 9);
    assert.equal(stored.confirmedBy, 'admin');

    const auditRow = s.db.prepare(
      `SELECT target, detail_json FROM audit_log
        WHERE action = 'conversation.wake.update'
        ORDER BY id DESC LIMIT 1`,
    ).get();
    assert.equal(auditRow.target, id);
    assert.deepEqual(JSON.parse(auditRow.detail_json).changed.length, Object.keys(config).length);
    const eventRow = s.db.prepare(
      `SELECT detail FROM event_log
        WHERE kind = 'console.change'
        ORDER BY id DESC LIMIT 1`,
    ).get();
    assert.ok(eventRow, '应写入 console.change 事件');
    assert.match(eventRow.detail, new RegExp(id));
    assert.match(eventRow.detail, /conversation\.wake\.update/);

    const reject = async (body) => {
      const res = await s.api(wakePath(id), {
        method: 'PATCH',
        csrf: s.login.csrf,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
      const error = await res.json();
      assert.equal(error.error.code, 'bad-request');
      return error.error.message;
    };

    assert.match(await reject({ config: { sleepUntil: 1 } }), /sleepUntil/);
    assert.match(await reject({ config: { lastWakeAt: 1 } }), /lastWakeAt/);
    assert.match(
      await reject({ config: { limits: { foo: 1 } } }),
      /未知 limits 字段/,
    );
    assert.match(
      await reject({ config: { hint: 'x'.repeat(201) } }),
      /hint 最多 200 字/,
    );
    assert.match(await reject({ config: {}, extra: true }), /未知字段/);
  } finally {
    await s.close();
  }
});

test('P6.1 reset：复制当前默认值而不是产品常量', async () => {
  const s = await makeServer();
  try {
    const id = await s.createConversation('会话唤醒重置');
    const defaults = await s.api('/console/api/bot/wake', {
      method: 'PATCH',
      csrf: s.login.csrf,
      body: JSON.stringify({ config: { limits: { maxWakePerHour: 5 } } }),
    });
    assert.equal(defaults.status, 200);

    const custom = await s.api(wakePath(id), {
      method: 'PATCH',
      csrf: s.login.csrf,
      body: JSON.stringify({ config: { limits: { maxWakePerHour: 2 } } }),
    });
    assert.equal(custom.status, 200);
    assert.equal((await custom.json()).matchesDefaults, false);

    const reset = await s.api(`${wakePath(id)}/reset`, {
      method: 'POST',
      csrf: s.login.csrf,
    });
    assert.equal(reset.status, 200);
    const body = await reset.json();
    assert.equal(body.config.limits.maxWakePerHour, 5);
    assert.equal(body.matchesDefaults, true);

    const got = await (await s.api(wakePath(id))).json();
    assert.equal(got.config.limits.maxWakePerHour, 5);
    assert.equal(got.matchesDefaults, true);

    const auditRow = s.db.prepare(
      `SELECT target FROM audit_log
        WHERE action = 'conversation.wake.reset'
        ORDER BY id DESC LIMIT 1`,
    ).get();
    assert.equal(auditRow.target, id);
    const eventRow = s.db.prepare(
      `SELECT detail FROM event_log
        WHERE kind = 'console.change'
        ORDER BY id DESC LIMIT 1`,
    ).get();
    assert.ok(eventRow, '应写入 reset 的 console.change 事件');
    assert.match(eventRow.detail, /conversation\.wake\.reset/);
  } finally {
    await s.close();
  }
});

test('P6.1 权限：无 session 401，无 CSRF 403，未知会话 404', async () => {
  const s = await makeServer();
  try {
    const id = await s.createConversation('会话唤醒权限');
    const noSession = await fetch(`${s.base}${wakePath(id)}`);
    assert.equal(noSession.status, 401);
    assert.equal((await noSession.json()).error.code, 'console-unauthorized');

    const noCsrf = await s.api(wakePath(id), {
      method: 'PATCH',
      body: JSON.stringify({ config: { mode: 'active' } }),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, 'csrf-invalid');

    const missing = await s.api(wakePath('conv_missing'));
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'conversation-not-found');
  } finally {
    await s.close();
  }
});

test('P6.1 生效：会话 A 限流不影响会话 B', async () => {
  const s = await makeServer();
  try {
    const a = await s.createConversation('限流会话 A');
    const b = await s.createConversation('不限流会话 B');
    const patch = await s.api(wakePath(a), {
      method: 'PATCH',
      csrf: s.login.csrf,
      body: JSON.stringify({ config: { limits: { maxWakePerHour: 1 } } }),
    });
    assert.equal(patch.status, 200);

    // 两分钟前的一条记录：只触发 A 的“每小时 1 次”，不碰每分钟上限。
    const seed = JSON.stringify({ wakeTimes: [Date.now() - 120_000], lastAiReplyAt: 0 });
    s.db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?').run(seed, a);
    s.db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?').run(seed, b);

    await s.gateway.social.deliverWake(a, 'question', { skipMessageCheck: true });
    await s.gateway.social.deliverWake(b, 'question', { skipMessageCheck: true });

    const pendingA = s.db.prepare(
      'SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?',
    ).get(a).n;
    const pendingB = s.db.prepare(
      'SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?',
    ).get(b).n;
    assert.equal(pendingA, 1, 'A 应被限流并进入 pending_wake');
    assert.equal(pendingB, 0, 'B 不应受 A 的限制影响');

    const wakeA = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(a).j,
    );
    const wakeB = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(b).j,
    );
    assert.equal(wakeA.wakeCount, 0, 'A 在限流前不应进入投递');
    assert.equal(wakeB.wakeCount, 1, 'B 应正常进入投递');
  } finally {
    await s.close();
  }
});
