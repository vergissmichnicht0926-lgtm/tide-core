// 鉴权模块测试 —— 真 node:sqlite 临时库，不 mock。
//   node --test tests/auth.test.mjs

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthService } from '../gateway/auth/service.mjs';
import { createRateLimiter } from '../gateway/auth/rate-limit.mjs';
import { signJwt, verifyJwt, newSecret } from '../gateway/auth/jwt.mjs';
import { hashPassword, verifyPassword } from '../gateway/auth/password.mjs';
import { createAuthRoutes } from '../gateway/routes/auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SCHEMA = readFileSync(path.join(ROOT, 'gateway/auth/schema.sql'), 'utf8');
const MAIN_SCHEMA = readFileSync(path.join(ROOT, 'gateway/db/schema.sql'), 'utf8');
const SECRET = newSecret();

// ── 测试装置 ────────────────────────────────────────────────────────────

function makeEnv({ ttlDays = 30 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tide-auth-'));
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  db.exec(MAIN_SCHEMA);

  let clock = Date.parse('2026-11-11T00:00:00.000Z');
  const now = () => clock;
  const advance = (ms) => {
    clock += ms;
  };

  const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, now });
  const service = createAuthService({
    db,
    secret: SECRET,
    refreshTtlDays: ttlDays,
    limiter,
    now,
  });

  return {
    db,
    service,
    limiter,
    now,
    advance,
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let env;
let user;

beforeEach(async () => {
  env = makeEnv();
  user = await env.service.createUser({ username: 'yg', password: 'hunter2hunter2' });
});

afterEach(() => {
  env.close();
});

// ── 密码 ────────────────────────────────────────────────────────────────

describe('password', () => {
  test('hash 后能验过，错密码验不过', async () => {
    const h = await hashPassword('correct horse');
    assert.match(h, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await verifyPassword('correct horse', h), true);
    assert.equal(await verifyPassword('wrong horse', h), false);
  });

  test('同一密码两次 hash 盐不同', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('same', a), true);
    assert.equal(await verifyPassword('same', b), true);
  });

  test('坏格式的哈希返回 false 而不是抛', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('x', 'scrypt$1$2$3'), false);
    assert.equal(await verifyPassword('x', 'argon2$x$y$z$a$b'), false);
    assert.equal(await verifyPassword('x', ''), false);
  });
});

// ── JWT ─────────────────────────────────────────────────────────────────

describe('jwt', () => {
  test('签了能验，payload 带回来', () => {
    const token = signJwt({ sub: 'u1', dev: 'd1' }, { secret: SECRET, expiresInSec: 60 });
    const { payload } = verifyJwt(token, { secret: SECRET });
    assert.equal(payload.sub, 'u1');
    assert.equal(payload.dev, 'd1');
    assert.equal(typeof payload.exp, 'number');
  });

  test('签名被改一个字节 → bad-signature', () => {
    const token = signJwt({ sub: 'u1' }, { secret: SECRET, expiresInSec: 60 });
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`;
    assert.throws(() => verifyJwt(tampered, { secret: SECRET }), /签名不匹配/);
  });

  test('换 secret 验不过', () => {
    const token = signJwt({ sub: 'u1' }, { secret: SECRET, expiresInSec: 60 });
    assert.throws(() => verifyJwt(token, { secret: newSecret() }), /签名不匹配/);
  });

  test('过期 → expired', () => {
    let t = 1_000_000;
    const token = signJwt({ sub: 'u1' }, { secret: SECRET, expiresInSec: 10, now: () => t });
    t += 11_000;
    assert.throws(() => verifyJwt(token, { secret: SECRET, now: () => t }), /已过期/);
  });

  test('alg=none 被拒', () => {
    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const data = Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url');
    assert.throws(() => verifyJwt(`${head}.${data}.`, { secret: SECRET }), /不支持的 alg/);
  });

  test('段数不对 → malformed', () => {
    assert.throws(() => verifyJwt('a.b', { secret: SECRET }), /三段/);
  });
});

// ── 限流 ────────────────────────────────────────────────────────────────

describe('rate-limit', () => {
  test('失败 5 次后锁住，窗口滑过后恢复', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: () => clock });
    let clock = 1000;
    for (let i = 0; i < 3; i += 1) rl.fail('k');
    assert.equal(rl.check('k').ok, false);
    assert.ok(rl.check('k').retryAfterMs > 0);

    clock += 60_001;
    assert.equal(rl.check('k').ok, true);
    assert.equal(rl.size(), 0);
  });

  test('succeed 清零', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 2 });
    rl.fail('k');
    rl.fail('k');
    assert.equal(rl.check('k').ok, false);
    rl.succeed('k');
    assert.equal(rl.check('k').ok, true);
  });
});

// ── 登录 / 刷新 / 登出 ──────────────────────────────────────────────────

describe('login', () => {
  test('正确凭据 → 拿到 access + refresh', async () => {
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    assert.ok(r.accessToken.split('.').length === 3);
    assert.ok(r.refreshToken.length > 30);
    assert.equal(r.expiresIn, 900);
    assert.equal(r.user.username, 'yg');
    assert.equal(r.device.id.startsWith('dev_'), true);
  });

  test('错密码 → 401 bad-credentials', async () => {
    await assert.rejects(
      () => env.service.login({ username: 'yg', password: 'nope' }),
      (err) => err.status === 401 && err.code === 'bad-credentials',
    );
  });

  test('不存在的用户 → 401，且不泄露"用户不存在"', async () => {
    await assert.rejects(
      () => env.service.login({ username: 'ghost', password: 'whatever' }),
      (err) => err.status === 401 && err.code === 'bad-credentials',
    );
  });

  test('连续失败 5 次 → 第 6 次 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => env.service.login({ username: 'yg', password: 'bad' }));
    }
    await assert.rejects(
      () => env.service.login({ username: 'yg', password: 'hunter2hunter2' }),
      (err) => err.status === 429 && err.code === 'too-many-requests',
    );
  });

  test('失败后成功 → 计数清零，再失败也不立刻锁', async () => {
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => env.service.login({ username: 'yg', password: 'bad' }));
    }
    await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    for (let i = 0; i < 3; i += 1) {
      await assert.rejects(() => env.service.login({ username: 'yg', password: 'bad' }));
    }
    // 新一轮只攒了 3 次，还没到 5
    assert.equal(env.limiter.check('yg').ok, true);
  });
});

describe('refresh', () => {
  test('换新 token，旧的立刻失效', async () => {
    const first = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    const second = env.service.refresh({ refreshToken: first.refreshToken });

    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.ok(second.accessToken.split('.').length === 3);

    assert.throws(
      () => env.service.refresh({ refreshToken: first.refreshToken }),
      (err) => err.status === 401 && err.code === 'token-invalid',
    );
  });

  test('过期 → token-expired', async () => {
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    env.advance(31 * 24 * 60 * 60 * 1000);
    assert.throws(
      () => env.service.refresh({ refreshToken: r.refreshToken }),
      (err) => err.status === 401 && err.code === 'token-expired',
    );
  });

  test('logout 之后 refresh 失效', async () => {
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    env.service.logout({ refreshToken: r.refreshToken });
    assert.throws(
      () => env.service.refresh({ refreshToken: r.refreshToken }),
      (err) => err.status === 401 && err.code === 'token-revoked',
    );
  });

  test('access token 过期后仍能用 refresh 续', async () => {
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    env.advance(20 * 60 * 1000); // 20 分钟，access 已过期
    assert.throws(() => env.service.authenticate(r.accessToken), /已过期/);

    const next = env.service.refresh({ refreshToken: r.refreshToken });
    const who = env.service.authenticate(next.accessToken);
    assert.equal(who.userId, user.id);
  });
});

describe('authenticate', () => {
  test('正常 token → userId + deviceId', async () => {
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    const who = env.service.authenticate(r.accessToken);
    assert.equal(who.userId, user.id);
    assert.equal(who.deviceId, r.device.id);
  });

  test('乱造 token → token-invalid', () => {
    assert.throws(() => env.service.authenticate('a.b.c'), /access token 无效/);
  });

  test('设备被撤销后 access token 立刻失效', async () => {
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    assert.doesNotThrow(() => env.service.authenticate(r.accessToken));

    env.service.revokeDevice({ userId: user.id, deviceId: r.device.id });
    assert.throws(
      () => env.service.authenticate(r.accessToken),
      (err) => err.status === 401 && err.code === 'token-revoked',
    );
  });
});

describe('devices', () => {
  test('列设备带 createdAt / lastSeenAt', async () => {
    await env.service.login({ username: 'yg', password: 'hunter2hunter2', deviceName: '手机' });
    await env.service.login({ username: 'yg', password: 'hunter2hunter2', deviceName: '电脑' });

    const { devices } = env.service.listDevices({ userId: user.id });
    assert.equal(devices.length, 2);
    assert.deepEqual(devices.map((d) => d.name).sort(), ['手机', '电脑'].sort());
    assert.ok(devices.every((d) => d.revokedAt === null));
  });

  test('不能撤别人的设备 → 404', async () => {
    const other = await env.service.createUser({ username: 'other', password: 'otherpass123' });
    const r = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });

    assert.throws(
      () => env.service.revokeDevice({ userId: other.id, deviceId: r.device.id }),
      (err) => err.status === 404,
    );
  });
});

// ── 路由壳 ──────────────────────────────────────────────────────────────

describe('routes', () => {
  test('路由表包含七条，登录/注册是 public', () => {
    const routes = createAuthRoutes({ service: env.service });
    const paths = routes.map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(paths, [
      'GET /auth/devices',
      'GET /auth/me',
      'POST /auth/devices/:id/revoke',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/refresh',
      'POST /auth/register',
    ]);
    assert.equal(routes.find((r) => r.path === '/auth/login').public, true);
  });

  test('login 返回 {ok:true,...}', async () => {
    const routes = createAuthRoutes({ service: env.service });
    const login = routes.find((r) => r.path === '/auth/login');
    const out = await login.handle({
      body: { username: 'yg', password: 'hunter2hunter2' },
      headers: {},
    });
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.ok(out.body.accessToken);
  });

  test('/auth/me 没带 token → 401 token-missing', async () => {
    const routes = createAuthRoutes({ service: env.service });
    const me = routes.find((r) => r.path === '/auth/me');
    await assert.rejects(
      () => me.handle({ headers: {} }),
      (err) => err.status === 401 && err.code === 'token-missing',
    );
  });

  test('/auth/me 带 token → 返回 userId', async () => {
    const login = await env.service.login({ username: 'yg', password: 'hunter2hunter2' });
    const routes = createAuthRoutes({ service: env.service });
    const me = routes.find((r) => r.path === '/auth/me');
    const out = await me.handle({ headers: { authorization: `Bearer ${login.accessToken}` } });
    assert.equal(out.body.userId, user.id);
  });
});
