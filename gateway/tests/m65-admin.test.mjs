/** M6.5a：admin/guest 角色、邀请码注册、guest direct、配额、secret fail-closed。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer({ agentSecret = 'test-secret', publicBaseUrl = 'https://tide.example/tide' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-m65-'));
  const gateway = await createGateway({
    agentSecret,
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    publicBaseUrl,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin',
    password: 'password123',
    role: 'admin',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest0',
    password: 'password123',
    role: 'guest',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username, password = 'password123') => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, device_name: 'test' }),
    });
    return { status: res.status, body: await res.json() };
  };
  const adminLogin = await login('admin');
  const guestLogin = await login('guest0');
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(token ? bearer(token) : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  return {
    dir,
    gateway,
    base,
    admin,
    guest,
    adminToken: adminLogin.body.accessToken,
    guestToken: guestLogin.body.accessToken,
    adminLogin,
    guestLogin,
    api,
    async close() {
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (res) => res.json();

test('角色登录：admin/guest 的 role 与 capabilities 不同', async () => {
  const s = await makeServer();
  try {
    assert.equal(s.adminLogin.body.role, 'admin');
    assert.deepEqual(s.adminLogin.body.capabilities, ['chat', 'upload', 'admin']);
    assert.equal(s.guestLogin.body.role, 'guest');
    assert.deepEqual(s.guestLogin.body.capabilities, ['chat', 'upload']);
    const me = await json(await s.api('/auth/me', { token: s.guestToken }));
    assert.equal(me.role, 'guest');
    assert.equal(me.username, 'guest0');
  } finally {
    await s.close();
  }
});

test('新格式邀请码：输入小写也能兑换', async () => {
  const s = await makeServer();
  try {
    const invite = await json(await s.api('/admin/invites', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', expiresInMinutes: 60, maxUses: 1 }),
    }));
    assert.match(invite.invite.code, /^[A-HJ-NP-Z2-9]{12}$/);
    assert.doesNotMatch(invite.invite.code, /[01IO]/);

    for (let i = 0; i < 20; i += 1) {
      const extra = await json(await s.api('/admin/invites', {
        token: s.adminToken,
        method: 'POST',
        body: JSON.stringify({ kind: 'bot', expiresInMinutes: 60, maxUses: 1 }),
      }));
      assert.match(extra.invite.code, /^[A-HJ-NP-Z2-9]{12}$/);
      assert.doesNotMatch(extra.invite.code, /[01IO]/);
    }

    // 列表也要带 joinUrl：客户端只在有 joinUrl 时才显示「分享」。
    const listed = await json(await s.api('/admin/invites', { token: s.adminToken }));
    const row = listed.invites.find((item) => item.id === invite.invite.id);
    assert.ok(row.joinUrl && row.joinUrl.startsWith('tide://join?'));
    assert.ok(row.joinUrl.includes(`code=${invite.invite.code}`));

    const reg = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: invite.invite.code.toLowerCase(),
        username: 'guestlower',
        password: 'password123',
      }),
    });
    assert.equal(reg.status, 201);
    assert.equal((await json(reg)).username, 'guestlower');
  } finally {
    await s.close();
  }
});

test('未配置公网地址：创建邀请返回 warnings', async () => {
  const s = await makeServer({ publicBaseUrl: '' });
  try {
    const res = await s.api('/admin/invites', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', expiresInMinutes: 60, maxUses: 1 }),
    });
    assert.equal(res.status, 201);
    const body = await json(res);
    assert.deepEqual(body.warnings, ['public-base-url-missing']);
    assert.equal(body.invite.joinUrl, null);
    assert.equal(body.invite.webUrl, null);
  } finally {
    await s.close();
  }
});

test('旧格式邀请码仍可兑换，大小写仍敏感', async () => {
  const s = await makeServer();
  try {
    const now = Date.now();
    s.gateway.dbState.db.prepare(
      `INSERT INTO invite
         (id, code, kind, role, expires_at, max_uses, used_count, created_by,
          group_id, revoked_at, created_at)
       VALUES ('inv-old', 'uRZ5Ad-cFEaO', 'bot', 'guest', ?, 1, 0, ?, NULL, NULL, ?)`,
    ).run(now + 3_600_000, s.admin.id, now);

    const exact = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: 'uRZ5Ad-cFEaO',
        username: 'oldcode1',
        password: 'password123',
      }),
    });
    assert.equal(exact.status, 201);

    const lowered = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: 'urz5ad-cfeao',
        username: 'oldcode2',
        password: 'password123',
      }),
    });
    assert.equal(lowered.status, 400);
    assert.equal((await lowered.json()).error.code, 'invite-invalid');
  } finally {
    await s.close();
  }
});

test('邀请码注册：默认一次，自动建 guest direct；复用被拒', async () => {
  const s = await makeServer();
  try {
    const invite = await json(await s.api('/admin/invites', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', expiresInMinutes: 60, maxUses: 1 }),
    }));
    assert.equal(invite.invite.kind, 'bot');
    assert.equal(invite.invite.maxUses, 1);
    assert.match(invite.invite.joinUrl, /^tide:\/\/join\?/);
    assert.equal(
      new URL(invite.invite.joinUrl).searchParams.get('server'),
      'https://tide.example/tide',
    );
    assert.equal(new URL(invite.invite.joinUrl).searchParams.get('code'), invite.invite.code);

    const reg = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: invite.invite.code,
        username: 'guest1',
        password: 'password123',
        device_name: 'phone',
      }),
    });
    assert.equal(reg.status, 201);
    const regBody = await json(reg);
    assert.equal(regBody.role, 'guest');
    assert.ok(regBody.conversationId);

    const conversations = await json(await s.api('/conversations', {
      token: regBody.accessToken,
    }));
    assert.equal(conversations.conversations.length, 1);
    assert.equal(conversations.conversations[0].kind, 'direct');

    const reuse = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: invite.invite.code,
        username: 'guest2',
        password: 'password123',
      }),
    });
    assert.equal(reuse.status, 400);
    assert.equal((await json(reuse)).error.code, 'invite-exhausted');
  } finally {
    await s.close();
  }
});

test('guest 不能建会话/看 admin；申请私聊由管理员审批后落 direct', async () => {
  const s = await makeServer();
  try {
    const denied = await s.api('/conversations', {
      token: s.guestToken,
      method: 'POST',
      body: JSON.stringify({ title: 'guest 自建' }),
    });
    assert.equal(denied.status, 403);
    const adminDenied = await s.api('/admin/users', { token: s.guestToken });
    assert.equal(adminDenied.status, 403);

    const req = await s.api('/requests', {
      token: s.guestToken,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot' }),
    });
    assert.equal(req.status, 201);
    const reqBody = await json(req);
    const pending = await json(await s.api('/admin/requests', { token: s.adminToken }));
    assert.equal(pending.requests.length, 1);
    const approved = await s.api(`/admin/requests/${reqBody.requestId}/approve`, {
      token: s.adminToken,
      method: 'POST',
      body: '{}',
    });
    assert.equal(approved.status, 200);
    const approvedBody = await json(approved);
    assert.ok(approvedBody.conversationId);
    const list = await json(await s.api('/conversations', { token: s.guestToken }));
    assert.equal(list.conversations[0].id, approvedBody.conversationId);
  } finally {
    await s.close();
  }
});

test('admin 用户统计按消息发送者归属，不把群友发言算到群主头上', async () => {
  const s = await makeServer();
  try {
    const group = await json(await s.api('/conversations', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ title: '统计群', kind: 'group' }),
    }));
    const added = await s.api(`/conversations/${group.id}/members`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ user_id: s.guest.id }),
    });
    assert.equal(added.status, 201);

    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ text: '群主发言', client_msg_id: 'admin-stat-1' }),
    });
    await s.api(`/conversations/${group.id}/prompt`, {
      token: s.guestToken,
      method: 'POST',
      body: JSON.stringify({ text: '旅客发言', client_msg_id: 'guest-stat-1' }),
    });

    const users = await json(await s.api('/admin/users', { token: s.adminToken }));
    const admin = users.users.find((user) => user.userId === s.admin.id);
    const guest = users.users.find((user) => user.userId === s.guest.id);
    assert.equal(admin.messageCount, 1);
    assert.equal(guest.messageCount, 1);
    assert.ok(admin.lastActiveAt);
    assert.ok(guest.lastActiveAt);
  } finally {
    await s.close();
  }
});

test('每日消息配额：先查后写，第二条 429', async () => {
  const s = await makeServer();
  try {
    const invite = await json(await s.api('/admin/invites', {
      token: s.adminToken,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', maxUses: 1 }),
    }));
    const reg = await json(await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: invite.invite.code,
        username: 'quotaGuest',
        password: 'password123',
      }),
    }));
    await s.api('/admin/settings', {
      token: s.adminToken,
      method: 'PUT',
      body: JSON.stringify({ perUserLimits: { dailyMessages: 1 } }),
    });
    const first = await s.api(`/conversations/${reg.conversationId}/prompt`, {
      token: reg.accessToken,
      method: 'POST',
      body: JSON.stringify({ text: '第一条', client_msg_id: 'quota-1' }),
    });
    assert.equal(first.status, 200);
    const second = await s.api(`/conversations/${reg.conversationId}/prompt`, {
      token: reg.accessToken,
      method: 'POST',
      body: JSON.stringify({ text: '第二条', client_msg_id: 'quota-2' }),
    });
    assert.equal(second.status, 429);
    assert.equal((await json(second)).error.code, 'quota-exceeded');
  } finally {
    await s.close();
  }
});

test('admin settings：defaultWakeConfig 保存后读回仍是修改值', async () => {
  const s = await makeServer();
  try {
    const put = await s.api('/admin/settings', {
      token: s.adminToken,
      method: 'PUT',
      body: JSON.stringify({
        defaultWakeConfig: {
          mode: 'active',
          triggers: { keywords: ['测试'], probability: 0.9 },
        },
      }),
    });
    assert.equal(put.status, 200);
    const saved = (await json(put)).settings.defaultWakeConfig;
    assert.equal(saved.mode, 'active');
    assert.deepEqual(saved.triggers.keywords, ['测试']);
    assert.equal(saved.triggers.probability, 0.9);
    const got = (await json(await s.api('/admin/settings', { token: s.adminToken }))).settings;
    assert.equal(got.defaultWakeConfig.mode, 'active');
    assert.deepEqual(got.defaultWakeConfig.triggers.keywords, ['测试']);
  } finally {
    await s.close();
  }
});

test('secret fail-closed：health 标记 + 无 secret 网关拒绝 /agent/*', async () => {
  const ok = await makeServer({ agentSecret: 'test-secret' });
  try {
    const health = await json(await ok.api('/health'));
    assert.equal(health.agentSecret, true);
  } finally {
    await ok.close();
  }
  const noSecret = await makeServer({ agentSecret: null });
  try {
    const health = await json(await noSecret.api('/health'));
    assert.equal(health.agentSecret, false);
    const res = await fetch(`${noSecret.base}/agent/prompt`, {
      headers: {
        'x-agent-token': 'whatever',
        'x-agent-call': '1',
        'x-agent-secret': 'whatever',
      },
    });
    assert.equal(res.status, 503);
    assert.equal((await json(res)).error.code, 'agent-secret-unconfigured');
  } finally {
    await noSecret.close();
  }
});

test('MCP 缺 TIDE_AGENT_SECRET 启动失败', async () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const child = spawn(process.execPath, ['mcp/tide-mcp.mjs'], {
    cwd: root,
    env: { ...process.env, TIDE_AGENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
});
