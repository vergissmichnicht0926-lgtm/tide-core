/** 管理台 P0：静态、登录/CSRF、命名空间隔离、总览、会话、事件表。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { pruneEvents, writeEvent } from '../events-store.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-console-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    publicBaseUrl: '',
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
  const login = async (username, password = 'password123', headers = {}) => {
    const res = await fetch(`${base}/console/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    const setCookie = res.headers.get('set-cookie') || '';
    const match = setCookie.match(/tide_admin=([^;]+)/);
    return {
      res,
      body,
      setCookie,
      cookie: match ? `tide_admin=${match[1]}` : '',
    };
  };
  return {
    dir, gateway, base, admin, guest, login,
    api: (p, { cookie, ...init } = {}) => fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(cookie ? { cookie } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    }),
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('静态：/console 跳转、三文件、CSP/no-store', async () => {
  const s = await makeServer();
  try {
    const redirect = await fetch(`${s.base}/console`, { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), 'console/');

    const html = await fetch(`${s.base}/console/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await html.text(), /汐语管理台/);

    const css = await fetch(`${s.base}/console/admin.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const js = await fetch(`${s.base}/console/admin.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    assert.equal((await fetch(`${s.base}/console/nope.js`)).status, 404);
  } finally {
    await s.close();
  }
});

test('登录：cookie 属性、会话读取、非管理员拒绝', async () => {
  const s = await makeServer();
  try {
    const admin = await s.login('admin');
    assert.equal(admin.res.status, 200);
    assert.match(admin.setCookie, /HttpOnly/);
    assert.match(admin.setCookie, /Secure/);
    assert.match(admin.setCookie, /SameSite=Strict/);
    assert.match(admin.setCookie, /Path=\/tide\/console/);
    assert.ok(admin.body.csrfToken);

    const session = await s.api('/console/api/session', { cookie: admin.cookie });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.ok(sessionBody.csrfToken);
    assert.equal(sessionBody.user.username, 'admin');

    const wrong = await s.login('admin', 'wrong-password');
    assert.equal(wrong.res.status, 401);
    assert.equal(wrong.body.error.code, 'bad-credentials');

    const guest = await s.login('guest');
    assert.equal(guest.res.status, 401);
  } finally {
    await s.close();
  }
});

test('登录限流：连续 5 次失败后第 6 次 429', async () => {
  const s = await makeServer();
  try {
    for (let i = 0; i < 5; i += 1) {
      const attempt = await s.login('admin', 'wrong-password');
      assert.equal(attempt.res.status, 401);
    }
    const locked = await s.login('admin', 'wrong-password');
    assert.equal(locked.res.status, 429);
    assert.ok(locked.body.error.retryAfterMs > 0);
  } finally {
    await s.close();
  }
});

test('登录限流按 username+IP 计数：换 IP 不会锁住同账号', async () => {
  const s = await makeServer();
  try {
    for (let i = 0; i < 5; i += 1) {
      const attempt = await s.login('admin', 'wrong-password', { 'x-real-ip': '1.1.1.1' });
      assert.equal(attempt.res.status, 401);
    }
    const locked = await s.login('admin', 'wrong-password', { 'x-real-ip': '1.1.1.1' });
    assert.equal(locked.res.status, 429);

    // 同一账号换一个 IP，不应继承别人的失败计数。
    const other = await s.login('admin', 'password123', { 'x-real-ip': '2.2.2.2' });
    assert.equal(other.res.status, 200);

    const lastLogin = s.gateway.dbState.db.prepare(
      "SELECT detail FROM event_log WHERE kind = 'console.login' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.match(lastLogin.detail, /2\.2\.2\.2/);
  } finally {
    await s.close();
  }
});

test('CSRF：登出必须带 X-Tide-CSRF；console cookie 不能授权 /admin', async () => {
  const s = await makeServer();
  try {
    const login = await s.login('admin');
    const noCsrf = await s.api('/console/api/session', {
      method: 'DELETE',
      cookie: login.cookie,
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, 'csrf-invalid');

    const ok = await s.api('/console/api/session', {
      method: 'DELETE',
      cookie: login.cookie,
      headers: { 'x-tide-csrf': login.body.csrfToken },
    });
    assert.equal(ok.status, 200);
    const after = await s.api('/console/api/session', { cookie: login.cookie });
    assert.equal(after.status, 401);

    const fresh = await s.login('admin');
    const adminApi = await fetch(`${s.base}/admin/users`, {
      headers: { cookie: fresh.cookie },
    });
    assert.equal(adminApi.status, 401);
  } finally {
    await s.close();
  }
});

test('overview：六盏灯、指标、事件与版本', async () => {
  const s = await makeServer();
  try {
    const login = await s.login('admin');
    const res = await s.api('/console/api/overview', { cookie: login.cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    for (const key of ['gateway', 'db', 'dsh', 'tunnel', 'cert', 'backup']) {
      assert.ok(Object.hasOwn(body.lights, key), `missing light ${key}`);
    }
    assert.equal(body.lights.tunnel.ok, null);
    assert.equal(body.lights.cert.ok, null);
    assert.equal(typeof body.metrics.todayMessages, 'number');
    assert.ok(Array.isArray(body.events));
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.equal(body.version, pkg.version);
    assert.equal(body.dbVersion, String(s.gateway.dbState.version));

    const started = s.gateway.dbState.db.prepare(
      "SELECT COUNT(*) AS n FROM event_log WHERE kind = 'gateway.start'",
    ).get().n;
    assert.ok(started >= 1);
  } finally {
    await s.close();
  }
});

test('会话表：dsh_session 与软删过滤', async () => {
  const s = await makeServer();
  try {
    const login = await s.login('admin');
    const conversationId = await s.gateway.ctx.createDirectConversation({
      userId: s.admin.id,
      title: '管理台会话',
    });
    s.gateway.dbState.db.prepare(
      'UPDATE conversation SET dsh_session_id = ? WHERE id = ?',
    ).run('sess-abcdef-123456', conversationId);
    s.gateway.dbState.db.prepare(
      `INSERT INTO conversation (id, user_id, kind, title, created_at, updated_at,
                                 agent_token, policy_hash, deleted_at)
       VALUES ('deleted-conv', ?, 'group', '已删除', 1, 1, 'tok-deleted', 'h', 1)`,
    ).run(s.admin.id);
    s.gateway.dbState.db.prepare(
      `INSERT INTO conversation_member
         (conversation_id, user_id, display_name, role, joined_at, join_seq, last_read_seq)
       VALUES ('deleted-conv', ?, '管理员', 'owner', 1, 0, 0)`,
    ).run(s.admin.id);

    const res = await s.api('/console/api/conversations', { cookie: login.cookie });
    assert.equal(res.status, 200);
    const body = await res.json();
    const row = body.conversations.find((item) => item.id === conversationId);
    assert.ok(row);
    assert.equal(row.dshSessionId, 'sess-abcdef-123456');
    assert.ok(!body.conversations.some((item) => item.id === 'deleted-conv'));
  } finally {
    await s.close();
  }
});

test('event_log：截断、保留清理', async () => {
  const s = await makeServer();
  try {
    const db = s.gateway.dbState.db;
    writeEvent(db, { kind: 'test.event', detail: { text: 'x'.repeat(3000) } });
    const row = db.prepare(
      "SELECT detail FROM event_log WHERE kind = 'test.event' ORDER BY id DESC LIMIT 1",
    ).get();
    assert.equal(row.detail.length, 2000);

    db.prepare(
      `INSERT INTO event_log (at, level, kind, conversation_id, detail)
       VALUES ('2000-01-01T00:00:00.000Z', 'info', 'old.event', NULL, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO event_log (at, level, kind, conversation_id, detail)
       VALUES (?, 'info', 'fresh.event', NULL, NULL)`,
    ).run(new Date().toISOString());
    const pruned = pruneEvents(db, { days: 30, maxRows: 100000 });
    assert.ok(pruned.deleted >= 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM event_log WHERE kind = 'old.event'").get().n,
      0,
    );
  } finally {
    await s.close();
  }
});

test('TIDE_CONSOLE=0 时 /console 返回 404', async () => {
  const s = await makeServer();
  const previous = process.env.TIDE_CONSOLE;
  try {
    process.env.TIDE_CONSOLE = '0';
    assert.equal((await fetch(`${s.base}/console/`)).status, 404);
  } finally {
    if (previous === undefined) delete process.env.TIDE_CONSOLE;
    else process.env.TIDE_CONSOLE = previous;
    await s.close();
  }
});
