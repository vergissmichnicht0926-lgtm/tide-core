/** 管理台 P1：机器人、人格卡、邀请码、设备。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { loadBotSettings } from '../settings.mjs';

const silent = { log() {}, warn() {}, error() {} };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function makeServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-console-p1-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    publicBaseUrl: options.publicBaseUrl ?? '',
    realtime: { mode: 'user', streamEnabled: true },
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin', password: 'password123', role: 'admin', displayName: '管理员',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest', password: 'password123', role: 'guest',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;

  const consoleLogin = async (username = 'admin', password = 'password123') => {
    const res = await fetch(`${base}/console/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/tide_admin=([^;]+)/);
    return {
      res,
      body,
      cookie: match ? `tide_admin=${match[1]}` : '',
      csrf: body.csrfToken,
    };
  };

  const api = (p, { cookie, csrf, ...init } = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-tide-csrf': csrf } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });

  const appLogin = async (username = 'guest', password = 'password123') => {
    const session = await gateway.authService.login({
      username, password, deviceName: 'test-device',
    });
    return { ...session, bearer: { authorization: `Bearer ${session.accessToken}` } };
  };

  return {
    dir, gateway, base, db: gateway.dbState.db, admin, guest, consoleLogin, api, appLogin,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertInvite(db, {
  id, code, createdBy, kind = 'bot', expiresAt, maxUses = 1, used = 0, revokedAt = null,
}) {
  db.prepare(
    `INSERT INTO invite
       (id, code, kind, role, expires_at, max_uses, used_count, created_by, group_id,
        revoked_at, created_at)
     VALUES (?, ?, ?, 'guest', ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, code, kind, expiresAt, maxUses, used, createdBy, revokedAt, Date.now());
}

test('bot：只读状态、未接入标注与登录保护', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const res = await s.api('/console/api/bot', { cookie: login.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.bot.name, '汐语');
    assert.equal(body.bot.modelWired, false);
    assert.equal(body.bot.toolProfileWired, false);
    assert.equal(body.runtime.silence.global, null);
    assert.equal(body.runtime.realtimeMode, 'user');
    assert.equal(body.runtime.wake.mode, 'diving');
    assert.match(body.runtime.wakeSummary, /潜水|diving/);

    assert.equal((await s.api('/console/api/bot')).status, 401);
    assert.equal((await s.api('/console/api/bot/avatar', { cookie: login.cookie })).status, 404);
  } finally {
    await s.close();
  }
});

test('人格卡：CSRF、未知字段、长度与头像格式校验', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const headers = { cookie: login.cookie };

    const noCsrf = await s.api('/console/api/bot', {
      ...headers, method: 'PATCH', body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(noCsrf.status, 403);

    const unknown = await s.api('/console/api/bot', {
      ...headers, csrf: login.csrf, method: 'PATCH', body: JSON.stringify({ foo: 1 }),
    });
    assert.equal(unknown.status, 400);

    const longName = await s.api('/console/api/bot', {
      ...headers, csrf: login.csrf, method: 'PATCH', body: JSON.stringify({ name: 'x'.repeat(41) }),
    });
    assert.equal(longName.status, 400);

    const badAvatar = await s.api('/console/api/bot', {
      ...headers,
      csrf: login.csrf,
      method: 'PATCH',
      body: JSON.stringify({ avatar: 'data:text/plain;base64,abc' }),
    });
    assert.equal(badAvatar.status, 400);

    const ok = await s.api('/console/api/bot', {
      ...headers,
      csrf: login.csrf,
      method: 'PATCH',
      body: JSON.stringify({
        name: '小汐', signature: '签名', personaOverride: '人格', avatar: PNG,
      }),
    });
    assert.equal(ok.status, 200);
    const saved = await ok.json();
    assert.equal(saved.bot.name, '小汐');
    assert.equal(saved.bot.signature, '签名');
    assert.equal(saved.bot.personaOverride, '人格');
    assert.equal(saved.bot.hasAvatar, true);

    const avatar = await s.api('/console/api/bot/avatar', { cookie: login.cookie });
    assert.equal(avatar.status, 200);
    assert.equal(avatar.headers.get('content-type'), 'image/png');
    assert.ok((await avatar.arrayBuffer()).byteLength > 0);

    const audit = s.db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.update'",
    ).get().n;
    const events = s.db.prepare(
      "SELECT COUNT(*) AS n FROM event_log WHERE kind = 'console.change'",
    ).get().n;
    assert.equal(audit, 1);
    assert.equal(events, 1);
  } finally {
    await s.close();
  }
});

test('邀请码：四态判定与 shareable', async () => {
  const s = await makeServer({ publicBaseUrl: 'https://example.test/tide' });
  try {
    const login = await s.consoleLogin();
    const now = Date.now();
    insertInvite(s.db, {
      id: 'i-active', code: 'ACTIVE234567', createdBy: s.admin.id,
      expiresAt: now + 3_600_000,
    });
    insertInvite(s.db, {
      id: 'i-expired', code: 'EXPIRED23456', createdBy: s.admin.id,
      expiresAt: now - 1_000,
    });
    insertInvite(s.db, {
      id: 'i-used', code: 'USED23456789', createdBy: s.admin.id,
      expiresAt: now + 3_600_000, maxUses: 1, used: 1,
    });
    insertInvite(s.db, {
      id: 'i-revoked', code: 'REVOKED23456', createdBy: s.admin.id,
      expiresAt: now + 3_600_000, revokedAt: now - 500,
    });

    const res = await s.api('/console/api/invites', { cookie: login.cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byId = new Map(body.invites.map((invite) => [invite.id, invite]));
    assert.equal(byId.get('i-active').status, 'active');
    assert.equal(byId.get('i-expired').status, 'expired');
    assert.equal(byId.get('i-used').status, 'used-up');
    assert.equal(byId.get('i-revoked').status, 'revoked');
    assert.equal(byId.get('i-active').shareable, true);
    for (const id of ['i-expired', 'i-used', 'i-revoked']) {
      assert.equal(byId.get(id).shareable, false);
    }
  } finally {
    await s.close();
  }
});

test('邀请码：创建校验、链接与无公网地址告警', async () => {
  const s = await makeServer({ publicBaseUrl: 'https://example.test/tide' });
  try {
    const login = await s.consoleLogin();
    const post = (body) => s.api('/console/api/invites', {
      cookie: login.cookie,
      csrf: login.csrf,
      method: 'POST',
      body: JSON.stringify(body),
    });

    assert.equal((await post({ kind: 'group' })).status, 400);
    assert.equal((await post({ kind: 'group', groupId: 'nope' })).status, 404);
    assert.equal((await post({ kind: 'bot', expiresInMinutes: 3 })).status, 400);
    assert.equal((await post({ kind: 'bot', maxUses: 0 })).status, 400);

    const created = await post({ kind: 'bot', expiresInMinutes: 60, maxUses: 2 });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.invite.usedCount, 0);
    assert.equal(body.invite.maxUses, 2);
    assert.ok(body.invite.joinUrl);
    assert.ok(body.invite.webUrl);
    assert.equal(body.warnings, undefined);

    const revoked = await s.api(`/console/api/invites/${body.invite.id}/revoke`, {
      cookie: login.cookie, csrf: login.csrf, method: 'POST',
    });
    assert.equal(revoked.status, 200);

    const listed = await (await s.api('/console/api/invites', { cookie: login.cookie })).json();
    const row = listed.invites.find((invite) => invite.id === body.invite.id);
    assert.equal(row.status, 'revoked');
    assert.equal(row.shareable, false);

    const again = await s.api(`/console/api/invites/${body.invite.id}/revoke`, {
      cookie: login.cookie, csrf: login.csrf, method: 'POST',
    });
    assert.equal(again.status, 404);
  } finally {
    await s.close();
  }

  const noUrl = await makeServer();
  try {
    const login = await noUrl.consoleLogin();
    const res = await noUrl.api('/console/api/invites', {
      cookie: login.cookie,
      csrf: login.csrf,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.warnings, ['public-base-url-missing']);
    assert.equal(body.invite.joinUrl, null);
    assert.equal(body.invite.webUrl, null);
  } finally {
    await noUrl.close();
  }
});

test('写接口 CSRF 全覆盖', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const device = await s.appLogin();
    const cases = [
      ['/console/api/bot', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }],
      ['/console/api/invites', { method: 'POST', body: JSON.stringify({ kind: 'bot' }) }],
      ['/console/api/invites/any/revoke', { method: 'POST' }],
      [`/console/api/users/${s.guest.id}/devices/${device.deviceId}/revoke`, { method: 'POST' }],
    ];
    for (const [url, init] of cases) {
      const res = await s.api(url, { cookie: login.cookie, ...init });
      assert.equal(res.status, 403, `${url} 应 403`);
    }
  } finally {
    await s.close();
  }
});

test('用户与设备：列表、trustedDeviceId、未知用户', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    await s.appLogin();

    const users = await (await s.api('/console/api/users', { cookie: login.cookie })).json();
    assert.ok(users.users.some((user) => user.userId === s.guest.id));

    const devicesRes = await s.api(`/console/api/users/${s.guest.id}/devices`, {
      cookie: login.cookie,
    });
    assert.equal(devicesRes.status, 200);
    const devices = await devicesRes.json();
    assert.equal(devices.user.userId, s.guest.id);
    assert.equal(devices.devices.length, 1);
    assert.equal(devices.devices[0].active, true);
    assert.equal(devices.devices[0].trusted, false);
    assert.equal(devices.devices[0].trustedDeviceId, null);

    assert.equal(
      (await s.api('/console/api/users/usr_nope/devices', { cookie: login.cookie })).status,
      404,
    );
  } finally {
    await s.close();
  }
});

test('设备吊销：token 立即失效，活动流失效', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const device = await s.appLogin();
    await s.gateway.ctx.createDirectConversation({
      userId: s.guest.id, title: '吊销流测试',
    });

    const stream = await fetch(`${s.base}/stream?since=0`, { headers: device.bearer });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 5_000;
    while (!text.includes('event: ready')) {
      assert.ok(Date.now() < deadline, '等待 ready 超时');
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += decoder.decode(value, { stream: true });
    }
    assert.equal(s.gateway.ctx.realtimeStats.connectionsOpened, 1);

    const revoked = await s.api(
      `/console/api/users/${s.guest.id}/devices/${device.deviceId}/revoke`,
      { cookie: login.cookie, csrf: login.csrf, method: 'POST' },
    );
    assert.equal(revoked.status, 200);
    const result = await revoked.json();
    assert.equal(result.closedStreams, 1);
    assert.deepEqual(result.revokedDeviceIds, [device.deviceId]);

    const closed = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5_000)),
    ]);
    assert.ok(closed.done === true, `流应被关闭: ${JSON.stringify(closed)}`);
    assert.equal(s.gateway.ctx.sseConnections.size, 0);
    assert.equal(s.gateway.ctx.sseUserConnections.size, 0);
    assert.equal(s.gateway.ctx.realtimeStats.connectionsClosed, 1);

    const after = await fetch(`${s.base}/conversations`, { headers: device.bearer });
    assert.equal(after.status, 401);
    const body = await after.json();
    assert.equal(body.error.code, 'token-revoked');
  } finally {
    await s.close();
  }
});

test('TIDE_CONSOLE=0 时 P1 路由全部 404', async () => {
  const s = await makeServer();
  const previous = process.env.TIDE_CONSOLE;
  try {
    const login = await s.consoleLogin();
    process.env.TIDE_CONSOLE = '0';
    for (const url of ['/console/api/bot', '/console/api/invites', '/console/api/users']) {
      const res = await s.api(url, { cookie: login.cookie });
      assert.equal(res.status, 404, `${url} 应 404`);
    }
  } finally {
    if (previous === undefined) delete process.env.TIDE_CONSOLE;
    else process.env.TIDE_CONSOLE = previous;
    await s.close();
  }
});

// ── P2 只读端点 ────────────────────────────────────────────────────────

test('P2：overview 只加字段，旧字段语义不变', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const body = await (await s.api('/console/api/overview', { cookie: login.cookie })).json();
    assert.equal(typeof body.metrics.conversationCount, 'number');
    assert.equal(typeof body.metrics.replaySkipped, 'number');
    assert.equal(typeof body.metrics.epochChanged, 'number');
    assert.equal(typeof body.metrics.activeUserConnections, 'number');
    assert.equal(typeof body.metrics.todayMessages, 'number');
    assert.equal(typeof body.metrics.cursorAhead, 'number');
    assert.equal(body.version, JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ).version);
    const session = await (await s.api('/console/api/session', { cookie: login.cookie })).json();
    assert.equal(session.version, body.version);
  } finally {
    await s.close();
  }
});

test('P2：conversations 带 membersDetail，事件按会话过滤并限制条数', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const conversationId = await s.gateway.ctx.createDirectConversation({
      userId: s.admin.id,
      title: '详情测试',
    });
    const otherId = await s.gateway.ctx.createDirectConversation({
      userId: s.admin.id,
      title: '另一个',
    });
    const at = new Date().toISOString();
    const insertEvent = s.db.prepare(
      `INSERT INTO event_log (at, level, kind, conversation_id, detail)
       VALUES (?, 'info', ?, ?, ?)`,
    );
    insertEvent.run(at, 'sse.open', conversationId, 'e1');
    insertEvent.run(at, 'message.failed', conversationId, 'e2');
    insertEvent.run(at, 'sse.open', conversationId, 'e3');
    insertEvent.run(at, 'sse.open', otherId, 'other');

    const list = await (await s.api('/console/api/conversations', { cookie: login.cookie })).json();
    const item = list.conversations.find((row) => row.id === conversationId);
    assert.ok(Array.isArray(item.membersDetail));
    assert.equal(item.membersDetail[0].role, 'owner');
    assert.ok(item.membersDetail[0].name);

    const events = await (await s.api(
      `/console/api/conversations/${conversationId}/events?limit=2`,
      { cookie: login.cookie },
    )).json();
    assert.equal(events.events.length, 2);
    assert.ok(events.events.every((event) => event.conversationId === conversationId));
    const all = await (await s.api(
      `/console/api/conversations/${conversationId}/events?limit=99`,
      { cookie: login.cookie },
    )).json();
    assert.equal(all.events.length, 3);
  } finally {
    await s.close();
  }
});

test('P2：audit 过滤与分页、login-attempts', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const insertAudit = s.db.prepare(
      `INSERT INTO audit_log (actor_user_id, action, target, detail_json, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    );
    const now = Date.now();
    insertAudit.run(s.admin.id, 'settings.update', 'bot_settings', now);
    insertAudit.run(s.admin.id, 'invite.create', 'inv-1', now + 1);
    insertAudit.run(s.admin.id, 'device.revoke', 'dev-1', now + 2);

    const settings = await (await s.api(
      '/console/api/audit?filter=settings&limit=20&offset=0',
      { cookie: login.cookie },
    )).json();
    assert.equal(settings.total, 1);
    assert.equal(settings.rows[0].action, 'settings.update');
    assert.equal(settings.rows[0].actor, '管理员');

    const all = await (await s.api('/console/api/audit?limit=2&offset=0', {
      cookie: login.cookie,
    })).json();
    assert.equal(all.total, 3);
    assert.equal(all.rows.length, 2);
    assert.equal(all.rows[0].action, 'device.revoke');

    s.db.prepare('DELETE FROM login_attempts').run();
    s.db.prepare(
      "INSERT INTO login_attempts (username, ip, ok, at) VALUES ('admin', '1.2.3.4', 1, ?)",
    ).run(new Date().toISOString());
    s.db.prepare(
      "INSERT INTO login_attempts (username, ip, ok, at) VALUES ('bad', '5.6.7.8', 0, ?)",
    ).run(new Date().toISOString());
    const logins = await (await s.api('/console/api/login-attempts?limit=20&offset=0', {
      cookie: login.cookie,
    })).json();
    assert.equal(logins.total, 2);
    assert.equal(typeof logins.rows[0].ok, 'boolean');
  } finally {
    await s.close();
  }
});

test('P2：静态视图与 tools.json 可访问，旧视图已下线', async () => {
  const s = await makeServer();
  try {
    for (const path of [
      '/console/views/simulation.js',
      '/console/views/persona.js',
      '/console/views/invites.js',
      '/console/views/security.js',
      '/console/views/tools.js',
    ]) {
      assert.equal((await fetch(`${s.base}${path}`)).status, 200, path);
    }
    const tools = await fetch(`${s.base}/console/tools.json`);
    assert.equal(tools.status, 200);
    const list = await tools.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 10);
    assert.equal((await fetch(`${s.base}/console/views/bot.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/console/views/users.js`)).status, 404);
  } finally {
    await s.close();
  }
});

// ── P3 配置面 ──────────────────────────────────────────────────────────

test('P3：默认唤醒配置读写、新会话继承、全关 400', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const initial = await (await s.api('/console/api/bot/wake', {
      cookie: login.cookie,
    })).json();
    assert.equal(initial.config.mode, 'diving');
    assert.ok(initial.summary);

    const res = await s.api('/console/api/bot/wake', {
      cookie: login.cookie,
      csrf: login.csrf,
      method: 'PATCH',
      body: JSON.stringify({
        config: {
          mode: 'active',
          triggers: {
            atMention: true,
            nameMention: false,
            question: true,
            poke: false,
            anyMessage: false,
            keywords: ['暗号'],
            probability: 0,
          },
          batchWindowMs: 5000,
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.mode, 'active');
    assert.equal(body.config.triggers.anyMessage, true, 'active 强制 anyMessage');
    assert.equal(body.config.triggers.nameMention, false);
    assert.equal(body.config.batchWindowMs, 5000);

    const stored = JSON.parse(
      s.db.prepare('SELECT default_wake_config_json AS j FROM bot_settings WHERE id = 1').get().j,
    );
    assert.equal(stored.mode, 'active');
    assert.equal(stored.batchWindowMs, 5000);

    const cid = await s.gateway.ctx.createDirectConversation({
      userId: s.admin.id,
      title: '新会话',
    });
    const wake = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(cid).j,
    );
    assert.equal(wake.mode, 'active');
    assert.equal(wake.batchWindowMs, 5000);

    const bad = await s.api('/console/api/bot/wake', {
      cookie: login.cookie,
      csrf: login.csrf,
      method: 'PATCH',
      body: JSON.stringify({
        config: {
          mode: 'diving',
          triggers: {
            atMention: false,
            nameMention: false,
            question: false,
            poke: false,
            anyMessage: false,
            keywords: [],
            speakerIds: [],
            probability: 0,
          },
          batchWindowMs: 8000,
        },
      }),
    });
    assert.equal(bad.status, 400);
    const badBody = await bad.json();
    assert.equal(badBody.error.code, 'bad-request');
    assert.match(badBody.error.message, /至少保留一个触发/);
  } finally {
    await s.close();
  }
});

test('P3：用户配额校验、落库与 CSRF', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const patch = (limits, csrf = login.csrf) => s.api('/console/api/bot/limits', {
      cookie: login.cookie,
      csrf,
      method: 'PATCH',
      body: JSON.stringify({ limits }),
    });

    for (const limits of [
      { dailyMessages: 0, maxConversations: 5, uploadMb: 100 },
      { dailyMessages: 10, maxConversations: 0, uploadMb: 100 },
      { dailyMessages: 10, maxConversations: 5, uploadMb: 999999 },
    ]) {
      assert.equal((await patch(limits)).status, 400, JSON.stringify(limits));
    }

    const ok = await patch({ dailyMessages: 123, maxConversations: 7, uploadMb: 42 });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(body.limits, {
      dailyMessages: 123, maxConversations: 7, uploadMb: 42,
    });
    const settings = loadBotSettings(s.db);
    assert.equal(settings.perUserLimits.dailyMessages, 123);
    assert.equal(settings.perUserLimits.uploadMb, 42);

    const bot = await (await s.api('/console/api/bot', { cookie: login.cookie })).json();
    assert.equal(bot.limits.maxConversations, 7);

    const noCsrf = await s.api('/console/api/bot/limits', {
      cookie: login.cookie,
      method: 'PATCH',
      body: JSON.stringify({ limits: { dailyMessages: 1, maxConversations: 1, uploadMb: 1 } }),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});

test('P3：tools 端点返回生成的 15 个工具', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const list = await (await s.api('/console/api/tools', { cookie: login.cookie })).json();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 15);
    assert.ok(list.every((tool) => Array.isArray(tool.params)));
    assert.ok(list[0].params.some((param) => param.name === 'token' && param.required === true));
  } finally {
    await s.close();
  }
});

test('P6：默认 limits/hint 流向新会话，旧会话不变', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const oldId = await s.gateway.ctx.createDirectConversation({
      userId: s.admin.id,
      title: '旧会话',
    });
    const oldBefore = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(oldId).j,
    );
    const initial = await (await s.api('/console/api/bot/wake', {
      cookie: login.cookie,
    })).json();
    const limits = {
      maxWakePerMinute: 2,
      maxWakePerHour: 20,
      preSleepWaitMs: 600000,
      noActionLimit: 5,
      maxWakeConfigReminders: 4,
    };
    const res = await s.api('/console/api/bot/wake', {
      cookie: login.cookie,
      csrf: login.csrf,
      method: 'PATCH',
      body: JSON.stringify({
        config: { ...initial.config, limits, hint: '默认建议' },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.config.limits, limits);
    assert.equal(body.config.hint, '默认建议');
    assert.match(body.summary, /每小时 20 次/);
    assert.match(body.summary, /管理员建议：默认建议/);

    const oldAfter = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(oldId).j,
    );
    assert.deepEqual(oldAfter.limits, oldBefore.limits);
    assert.equal(oldAfter.hint, oldBefore.hint);

    const newId = await s.gateway.ctx.createDirectConversation({
      userId: s.admin.id,
      title: '新会话',
    });
    const fresh = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(newId).j,
    );
    assert.deepEqual(fresh.limits, limits);
    assert.equal(fresh.hint, '默认建议');
  } finally {
    await s.close();
  }
});

test('P6：/admin/settings 不暴露 limits/hint，控制台仍可见', async () => {
  const s = await makeServer();
  try {
    const session = await s.gateway.authService.login({
      username: 'admin',
      password: 'password123',
    });
    const res = await fetch(`${s.base}/admin/settings`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.settings.defaultWakeConfig.limits, undefined);
    assert.equal(body.settings.defaultWakeConfig.hint, undefined);

    const login = await s.consoleLogin();
    const wake = await (await s.api('/console/api/bot/wake', {
      cookie: login.cookie,
    })).json();
    assert.ok(wake.config.limits);
    assert.equal(wake.config.hint, '');
  } finally {
    await s.close();
  }
});

// ── P5 运维块 ──────────────────────────────────────────────────────────

test('P5：ops 需要登录，返回 probe/gateway/db/backup 四块', async () => {
  const s = await makeServer();
  try {
    assert.equal((await s.api('/console/api/ops')).status, 401);
    const login = await s.consoleLogin();
    const res = await s.api('/console/api/ops', { cookie: login.cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const key of ['probe', 'gateway', 'db', 'backup']) {
      assert.ok(body[key], key);
    }
    assert.equal(typeof body.gateway.pid, 'number');
    assert.equal(typeof body.gateway.uptimeSec, 'number');
    assert.equal(typeof body.db.walBytes, 'number');
    assert.ok(body.gateway.version);
  } finally {
    await s.close();
  }
});

test('P5：probe 状态 ok / stale / failed / missing', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const probeFile = path.join(s.dir, 'probe-status.json');
    const read = async () => (await (await s.api('/console/api/ops', {
      cookie: login.cookie,
    })).json()).probe;

    fs.writeFileSync(probeFile, JSON.stringify({
      lastCheckAt: new Date().toISOString(),
      lastResult: 'ok',
      lastRestartAt: null,
      restartMs: null,
      targetPid: 4321,
      reason: 'port listening',
      error: null,
    }));
    let probe = await read();
    assert.equal(probe.status, 'ok');
    assert.equal(probe.targetPid, 4321);
    assert.equal(probe.reason, 'port listening');
    assert.equal(probe.restartMs, null);
    assert.equal(probe.lastRestartAt, null);

    fs.writeFileSync(probeFile, JSON.stringify({
      lastCheckAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      lastResult: 'ok',
      targetPid: 4321,
      reason: 'port listening',
      error: null,
    }));
    probe = await read();
    assert.equal(probe.status, 'stale');

    fs.writeFileSync(probeFile, JSON.stringify({
      lastCheckAt: new Date().toISOString(),
      lastResult: 'restarted',
      lastRestartAt: new Date().toISOString(),
      restartMs: 6300,
      targetPid: 4321,
      reason: 'recovered',
      error: null,
    }));
    probe = await read();
    assert.equal(probe.status, 'ok');
    assert.equal(probe.lastResult, 'restarted');
    assert.equal(probe.restartMs, 6300);

    fs.writeFileSync(probeFile, JSON.stringify({
      lastCheckAt: new Date().toISOString(),
      lastResult: 'failed',
      targetPid: null,
      reason: 'failed to recover',
      error: 'boom',
    }));
    probe = await read();
    assert.equal(probe.status, 'failed');

    fs.writeFileSync(probeFile, '{半截');
    const res = await s.api('/console/api/ops', { cookie: login.cookie });
    assert.equal(res.status, 200);
    probe = (await res.json()).probe;
    assert.equal(probe.status, 'missing');
  } finally {
    await s.close();
  }
});

test('P5：backup.log 优先，离机副本与文件名字段可用', async () => {
  const s = await makeServer();
  try {
    const login = await s.consoleLogin();
    const at = new Date(Date.now() - 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(s.dir, 'backup.log'), `${JSON.stringify({
      ok: true,
      at,
      backup: 'D:\\dsh\\tide-core\\data\\backups\\daily\\tide-test.db.gz',
      bytes: 1234,
      source: { conversations: 1, messages: 2, attachments: 0 },
      offsite: { host: 'example', remotePath: '/home/admin/tide/backup/tide-test.db.gz', sha256: 'abc123' },
    })}\n`);
    const body = await (await s.api('/console/api/ops', { cookie: login.cookie })).json();
    assert.equal(body.backup.lastAt, at);
    assert.equal(body.backup.bytes, 1234);
    assert.equal(body.backup.fileName, 'tide-test.db.gz');
    assert.equal(body.backup.offsite.ok, true);
    assert.equal(body.backup.offsite.remotePath, '/home/admin/tide/backup/tide-test.db.gz');
    assert.ok(body.backup.ageSec >= 3500 && body.backup.ageSec <= 3700);
  } finally {
    await s.close();
  }
});

test('P5：静态页无贴纸/语音占位卡，也无重启/停止按钮', async () => {
  const html = fs.readFileSync(
    new URL('../public/console/index.html', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(html, /贴纸/);
  assert.doesNotMatch(html, /语音/);
  assert.doesNotMatch(html, /重启|停止|Stop/);
});

