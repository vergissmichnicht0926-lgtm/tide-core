// /auth/refresh 与 /auth/logout 的 refreshToken 字段名回归。
//
// 事故原型：Android 客户端发 { refresh_token }，路由只读 body.refreshToken，
// 于是续期恒定 400 bad-request。客户端把「字段名写错」读成「凭证真的过期了」，
// 界面显示「登录已失效」且没有任何退路（用户只能重装）。
// 这里把两种写法都钉住，任何一种被改回单键都会红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-auth-field-'));
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

async function login(base, deviceName) {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'password123', device_name: deviceName }),
  });
  assert.equal(r.status, 200);
  return r.json();
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('refresh 接受 snake_case 的 refresh_token（Android 客户端就是这么发的）', async () => {
  const { dir, gateway, base } = await start();
  try {
    const s = await login(base, 'snake');
    const r = await post(base, '/auth/refresh', { refresh_token: s.refreshToken });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.ok(out.accessToken, '必须换到新的 access token');
    assert.ok(out.refreshToken, '轮换后必须返回新的 refresh token');
    assert.notEqual(out.refreshToken, s.refreshToken, 'refresh token 必须真的轮换');
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh 继续接受 camelCase 的 refreshToken（老写法不能破）', async () => {
  const { dir, gateway, base } = await start();
  try {
    const s = await login(base, 'camel');
    const r = await post(base, '/auth/refresh', { refreshToken: s.refreshToken });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.ok(out.accessToken);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('轮换之后旧 refresh token 立刻失效', async () => {
  const { dir, gateway, base } = await start();
  try {
    const s = await login(base, 'rotate');
    const first = await post(base, '/auth/refresh', { refresh_token: s.refreshToken });
    assert.equal(first.status, 200);

    const replay = await post(base, '/auth/refresh', { refresh_token: s.refreshToken });
    // 已轮换 = 凭证无效，走 401 token-invalid（不是 400 bad-request——字段是好的，是凭证死了）
    assert.equal(replay.status, 401);
    const body = await replay.json();
    assert.equal(body.error.code, 'token-invalid');
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两个字段名都缺时给出明确报错，而不是静默成功', async () => {
  const { dir, gateway, base } = await start();
  try {
    const r = await post(base, '/auth/refresh', {});
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, 'bad-request');
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logout 也认两种字段名', async () => {
  const { dir, gateway, base } = await start();
  try {
    const s = await login(base, 'logout');
    const r = await post(base, '/auth/logout', { refresh_token: s.refreshToken });
    assert.equal(r.status, 200);
    // 登出后同一 refresh token 不能再换 access
    const again = await post(base, '/auth/refresh', { refresh_token: s.refreshToken });
    assert.notEqual(again.status, 200);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refreshToken 不是字符串时回退到 refresh_token', async () => {
  const { dir, gateway, base } = await start();
  try {
    const s = await login(base, 'fallback-number');
    const r = await post(base, '/auth/refresh', {
      refreshToken: 123,
      refresh_token: s.refreshToken,
    });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).accessToken);

    const s2 = await login(base, 'fallback-empty');
    const r2 = await post(base, '/auth/refresh', {
      refreshToken: '',
      refresh_token: s2.refreshToken,
    });
    assert.equal(r2.status, 200);
    assert.ok((await r2.json()).accessToken);
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('两个字段同时给时 refreshToken 优先', async () => {
  const { dir, gateway, base } = await start();
  try {
    const camelValid = await login(base, 'priority-camel');
    const ok = await post(base, '/auth/refresh', {
      refreshToken: camelValid.refreshToken,
      refresh_token: 'definitely-not-a-token',
    });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).accessToken);

    const snakeValid = await login(base, 'priority-snake');
    const rejected = await post(base, '/auth/refresh', {
      refreshToken: 'definitely-not-a-token',
      refresh_token: snakeValid.refreshToken,
    });
    assert.equal(rejected.status, 401);
    assert.equal((await rejected.json()).error.code, 'token-invalid');
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
