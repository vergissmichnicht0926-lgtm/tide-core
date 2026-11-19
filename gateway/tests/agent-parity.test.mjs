/**
 * 契约对等性：同一组请求打到 fake gateway 和真网关，顶层响应形状必须一致。
 *
 * fake gateway（mcp/fake-gateway.mjs）是 M1 定下来的固定装置，契约先在那里写成；
 * M2b 的真实现在这里对一遍，以后任何一侧改了形状都会立刻红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };
const FAKE_PORT = 7898;
const FAKE_TOKEN_A = 'a'.repeat(48);
const BAD_TOKEN = 'f'.repeat(48);

async function startFake() {
  const child = spawn(
    process.execPath,
    ['mcp/fake-gateway.mjs', '--port', String(FAKE_PORT), '--deterministic'],
    { cwd: path.resolve(import.meta.dirname, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake gateway 启动超时')), 8_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  return child;
}

async function startReal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-parity-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startRebuildWorker: false,
    logger: silent,
  });
  await gateway.authService.createUser({ username: 'u', password: 'password123' });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = await (
    await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'u', password: 'password123' }),
    })
  ).json();
  const created = await (
    await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${login.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '对等性' }),
    })
  ).json();
  const agentToken = gateway.dbState.db
    .prepare('SELECT agent_token FROM conversation WHERE id = ?')
    .get(created.id).agent_token;
  return {
    dir,
    gateway,
    base,
    agentToken,
    async close() {
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 两边各打一次。fakeToken 默认是 fake seed 里 c_A 的令牌；realToken 是真网关建的会话。
 * 返回 { fake: {status, body}, real: {status, body} }。
 */
async function callBoth(origins, pathname, { method = 'GET', body, fakeToken, realToken } = {}) {
  const send = async (origin, agentToken) => {
    const res = await fetch(`${origin}${pathname}`, {
      method,
      headers: {
        'x-agent-call': '1',
        'x-agent-secret': 'test-secret',
        'x-agent-token': agentToken,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  };
  const [fake, real] = await Promise.all([
    send(origins.fake, fakeToken ?? FAKE_TOKEN_A),
    send(origins.real, realToken),
  ]);
  return { fake, real };
}

function keysOf(obj) {
  return Object.keys(obj).sort();
}

test('fake 与真网关的 /agent/* 顶层响应形状一致', async () => {
  const fake = await startFake();
  const real = await startReal();
  const origins = { fake: `http://127.0.0.1:${FAKE_PORT}`, real: real.base };
  try {
    const cases = [
      ['GET', '/agent/prompt'],
      ['GET', '/agent/messages?limit=2'],
      ['POST', '/agent/messages', { messages: ['对等性检查'], clientBatchId: 'p-1' }],
      ['POST', '/agent/read', { throughSeq: 1 }],
      ['POST', '/agent/wait', { purpose: 'messages', quietMs: 1000, timeoutMs: 1000 }],
      ['POST', '/agent/wake-config', { config: { mode: 'diving', triggers: { probability: 0.1 } } }],
      ['POST', '/agent/memory', { kind: 'topic', text: '形状一致' }],
      ['GET', '/agent/memory'],
      ['DELETE', '/agent/memory', { id: 999_999 }],
    ];

    for (const [method, pathname, body] of cases) {
      const { fake: f, real: r } = await callBoth(origins, pathname, {
        method,
        body,
        realToken: real.agentToken,
      });
      assert.equal(r.status, f.status, `${method} ${pathname} 状态码`);
      assert.deepEqual(keysOf(r.body), keysOf(f.body), `${method} ${pathname} 顶层字段`);
    }
  } finally {
    fake.kill();
    await real.close();
  }
});

test('错误信封形状一致：错误响应都是 { error: { code, message } }', async () => {
  const fake = await startFake();
  const real = await startReal();
  const origins = { fake: `http://127.0.0.1:${FAKE_PORT}`, real: real.base };
  try {
    const cases = [
      { name: '坏 token', method: 'GET', pathname: '/agent/prompt', tokens: 'bad' },
      { name: '空 messages', method: 'POST', pathname: '/agent/messages', body: { messages: [] }, tokens: 'good' },
      { name: '未知路径', method: 'GET', pathname: '/agent/nope', tokens: 'good' },
    ];

    for (const item of cases) {
      const opts = {
        method: item.method,
        body: item.body,
        ...(item.tokens === 'bad'
          ? { fakeToken: BAD_TOKEN, realToken: BAD_TOKEN }
          : { realToken: real.agentToken }),
      };
      const { fake: f, real: r } = await callBoth(origins, item.pathname, opts);
      assert.equal(r.status, f.status, `${item.name} 状态码`);
      assert.ok(r.body.error, `${item.name} 真网关应当返回 error`);
      assert.ok(f.body.error, `${item.name} fake 应当返回 error`);
      assert.deepEqual(keysOf(r.body.error), keysOf(f.body.error), `${item.name} error 字段`);
      assert.equal(typeof r.body.error.code, 'string');
      assert.equal(typeof r.body.error.message, 'string');
    }
  } finally {
    fake.kill();
    await real.close();
  }
});
