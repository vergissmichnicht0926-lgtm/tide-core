/**
 * `dsh/client.mjs` 的集成测试。
 *
 * 需要真 DSH 0.2.1 实例，通过环境变量开启；没设就整组 skip，
 * 这样 `npm test` 在没有 lab 实例的机器上仍然全绿。
 *
 *   TIDE_TEST_DSH_URL=http://127.0.0.1:3081
 *   TIDE_TEST_DSH_HOME=D:/dsh/lab/dsh-home
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDsh, mintBrowserCookie, DshError } from '../dsh/client.mjs';

const BASE_URL = process.env.TIDE_TEST_DSH_URL;
const DSH_HOME = process.env.TIDE_TEST_DSH_HOME;
const enabled = Boolean(BASE_URL && DSH_HOME);

const silent = { log() {}, warn() {}, error() {} };

test('mintBrowserCookie 名字随 authority 变化，值可被同一个 secret 复现', () => {
  const secret = Buffer.alloc(32, 7);
  const a = mintBrowserCookie('127.0.0.1:3081', secret);
  const b = mintBrowserCookie('127.0.0.1:3081', secret);
  const c = mintBrowserCookie('127.0.0.1:9999', secret);

  assert.equal(a.cookie.split('=')[0], b.cookie.split('=')[0], '同一 authority 名字相同');
  assert.notEqual(a.cookie.split('=')[0], c.cookie.split('=')[0], '不同 authority 名字不同');

  const [, value] = a.cookie.split('=');
  const parts = value.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'v1');
  const payload = JSON.parse(Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  assert.equal(payload.authority, '127.0.0.1:3081');
  assert.equal(payload.version, 1);
  assert.ok(payload.expiresAt > payload.issuedAt);
});

test('凭据文件缺失时报 dsh/credentials-* 而不是崩在 fs 里', async () => {
  const dsh = createDsh({
    baseUrl: 'http://127.0.0.1:1',
    credentialsPath: path.join(os.tmpdir(), 'no-such-credentials.yaml'),
    logger: silent,
  });
  await assert.rejects(
    () => dsh.getSession('whatever'),
    (error) => error instanceof DshError && error.code === 'dsh/credentials-unreadable',
  );
});

test('DSH 不可达时报 dsh/unreachable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-dsh-'));
  const creds = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(
    creds,
    'version: 1\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
  );
  const dsh = createDsh({
    baseUrl: 'http://127.0.0.1:9',
    credentialsPath: creds,
    logger: silent,
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED');
    },
  });
  await assert.rejects(
    () => dsh.getSession('x'),
    (error) => error instanceof DshError && error.code === 'dsh/unreachable',
  );
  assert.equal(await dsh.ping(), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('凭据文件里 browser-session 不是第一条时，不会读到别人的 secret', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-creds-'));
  const creds = path.join(dir, '.credentials.yaml');
  // 前一条记录也带 secret，而且比 browser-session 的更长——旧的正则会一路吃过去
  fs.writeFileSync(
    creds,
    [
      'version: 1',
      'records:',
      '  another-grant:',
      '    kind: grant',
      '    payload:',
      '      secret: ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      '      secret: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '  trailing: 1',
      '',
    ].join('\n'),
  );
  const seen = [];
  const dsh = createDsh({
    baseUrl: 'http://127.0.0.1:1',
    credentialsPath: creds,
    logger: silent,
    fetchImpl: async (_url, init) => {
      seen.push(init.headers.cookie);
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: JSON.parse(init.body).rpcId,
        result: { ok: true, value: { items: [] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(await dsh.getSession('x'), null);
  assert.equal(seen.length, 1);
  // cookie 值形如 v1.<body>.<sig>，sig 是用 secret 对 body 做的 HMAC。
  // 两个候选 secret 各算一次，看哪一个能复现签名 —— 这比字符串包含可靠。
  const [, value] = seen[0].split('=');
  const [, body, sig] = value.split('.');
  const sign = (secret) => crypto.createHmac('sha256', secret).update(body).digest('base64url');
  assert.equal(sig, sign(Buffer.alloc(32, 0)), '应当用 browser-session 自己的 secret');
  assert.notEqual(sig, sign(Buffer.alloc(32, 0x5a)), '不是前一条记录的 secret');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('收到 401 时清掉缓存的 secret 重读凭据再试一次', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-creds-'));
  const creds = path.join(dir, '.credentials.yaml');
  const writeCreds = (byte) => fs.writeFileSync(
    creds,
    [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      `      secret: ${Buffer.alloc(32, byte).toString('base64url')}`,
      '',
    ].join('\n'),
  );
  writeCreds(1);

  let calls = 0;
  const dsh = createDsh({
    baseUrl: 'http://127.0.0.1:1',
    credentialsPath: creds,
    logger: silent,
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        // 模拟 DSH 那边轮换了凭据：旧 cookie 401，同时文件已经变了
        writeCreds(2);
        return new Response('unauthorized', { status: 401 });
      }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: JSON.parse(init.body).rpcId,
        result: { ok: true, value: { items: [] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(await dsh.getSession('x'), null, '重试之后应当成功');
  assert.equal(calls, 2, '只重试一次');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('一直 401 两次之后仍然抛 dsh/unauthorized，不无限重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-creds-'));
  const creds = path.join(dir, '.credentials.yaml');
  fs.writeFileSync(
    creds,
    [
      'version: 1',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      `      secret: ${Buffer.alloc(32, 3).toString('base64url')}`,
      '',
    ].join('\n'),
  );
  let calls = 0;
  const dsh = createDsh({
    baseUrl: 'http://127.0.0.1:1',
    credentialsPath: creds,
    logger: silent,
    fetchImpl: async () => {
      calls += 1;
      return new Response('unauthorized', { status: 401 });
    },
  });
  await assert.rejects(
    () => dsh.getSession('x'),
    (error) => error instanceof DshError && error.code === 'dsh/unauthorized',
  );
  assert.equal(calls, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createWorkspace / createSession / getSession / waitTurnEnd / cancel 打真实例', { skip: !enabled && '需要 TIDE_TEST_DSH_URL + TIDE_TEST_DSH_HOME' }, async () => {
  const dsh = createDsh({ baseUrl: BASE_URL, dshHome: DSH_HOME, logger: silent });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-dsh-live-'));

  try {
    assert.equal(await dsh.ping(), true, '实例应当可达');

    const workspacePath = path.join(dir, 'conversations', 'conv-live');
    fs.mkdirSync(workspacePath, { recursive: true });
    const { workspaceId } = await dsh.createWorkspace({ conversationId: 'conv-live', path: workspacePath });
    assert.ok(workspaceId, '应当拿到 workspaceId');

    const { sessionId } = await dsh.createSession({ preset: 'tide', workspaceId });
    assert.match(sessionId, /^session-/);

    const got = await dsh.getSession(sessionId);
    assert.equal(got.agentPreset, 'tide');

    assert.equal(await dsh.getSession('session-does-not-exist-0000'), null, '不存在返回 null');
    assert.equal(await dsh.waitTurnEnd(sessionId, 5_000), true, '空闲会话立即返回 true');

    await dsh.cancel(sessionId);

    await assert.rejects(
      () => dsh.createSession({ preset: 'tide', workspaceId: 'no-such-workspace' }),
      (error) => error instanceof DshError && error.code === 'workspace/not-found',
    );
    await assert.rejects(
      () => dsh.createSession({ preset: 'no-such-preset-at-all', workspaceId }),
      (error) => error instanceof DshError && error.code === 'agent-preset/not-found',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
