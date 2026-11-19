/**
 * `/prompt` 真投递 + SSE 多设备广播。
 *
 * 用假 DSH 驱动 session/create、prompt、waitTurnEnd；消息正文以真 SQLite 为准。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer(dshOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sse-'));
  const dsh = createFakeDsh(dshOptions);
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    dsh,
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
  const bearer = { authorization: `Bearer ${login.accessToken}` };
  const created = await (
    await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'SSE 测试' }),
    })
  ).json();
  const token = gateway.dbState.db
    .prepare('SELECT agent_token FROM conversation WHERE id = ?')
    .get(created.id).agent_token;

  const agent = (p, init = {}) =>
    fetch(`${base}/agent${p}`, {
      ...init,
      headers: {
        'x-agent-token': token,
        'x-agent-call': '1',
        'x-agent-secret': 'test-secret',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });

  return {
    dir,
    dsh,
    gateway,
    base,
    bearer,
    userId: login.userId,
    conv: created,
    token,
    agent,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function openSse(url, headers) {
  const controller = new AbortController();
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';

  const ready = fetch(url, { headers, signal: controller.signal }).then(async (res) => {
    if (res.status !== 200) throw new Error(`SSE status ${res.status}`);
    const reader = res.body.getReader();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const lines = chunk.split('\n');
            const type = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            if (type && data) events.push({ type, data: JSON.parse(data) });
          }
        }
      } catch {
        // abort / server close
      }
    })();
    return res;
  });

  const waitFor = async (type, predicate = () => true, timeoutMs = 4_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find((event) => event.type === type && predicate(event));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`SSE 等待 ${type} 超时；已收到 ${events.map((e) => e.type).join(',')}`);
  };

  return { ready, events, waitFor, close: () => controller.abort() };
}

test('/prompt 真投递 + SSE 多设备广播 + since_seq 回放', async () => {
  // autoReply:false —— 这条测的是 /agent/messages 的落库与广播序号。
  // 开着 autoReply 时 DSH 也会回一条正文并被拉回本地，序号就会被推后；
  // 那条路径由 assistant-pull.test.mjs 专门覆盖。
  const s = await makeServer({ autoReply: false });
  const sse1 = openSse(`${s.base}/conversations/${s.conv.id}/stream?since_seq=0`, s.bearer);
  const sse2 = openSse(`${s.base}/conversations/${s.conv.id}/stream?since_seq=0`, s.bearer);
  try {
    await sse1.waitFor('ready');
    await sse2.waitFor('ready');

    const prompt = await fetch(`${s.base}/conversations/${s.conv.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好', client_msg_id: 'cm-sse-1' }),
    });
    assert.equal(prompt.status, 200);
    const promptBody = await prompt.json();
    assert.equal(promptBody.queued, true);
    assert.equal(promptBody.delivered, true);
    assert.equal(promptBody.turn_started, true);
    assert.equal(promptBody.message.role, 'user');
    assert.equal(promptBody.message.seq, 1);
    assert.equal(promptBody.message.text, '你好');
    assert.equal(promptBody.message.clientMsgId, 'cm-sse-1');

    const user1 = await sse1.waitFor('user_message', (e) => e.data.message?.text === '你好');
    const user2 = await sse2.waitFor('user_message', (e) => e.data.message?.text === '你好');
    assert.equal(user1.data.message.seq, 1);
    assert.equal(user2.data.message.id, user1.data.message.id);
    assert.equal(user1.data.message.clientMsgId, 'cm-sse-1');

    const sent = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['收到'], clientBatchId: 'b-sse-1' }),
    });
    assert.equal(sent.status, 200);

    const assistant1 = await sse1.waitFor('assistant_message', (e) => e.data.message?.text === '收到');
    const assistant2 = await sse2.waitFor('assistant_message', (e) => e.data.message?.text === '收到');
    assert.equal(assistant1.data.message.seq, 2);
    assert.equal(assistant2.data.message.id, assistant1.data.message.id);
    await sse1.waitFor('turn_start');
    await sse1.waitFor('turn_end');

    const createCall = s.dsh.calls.find((call) => call.name === 'createSession');
    assert.equal(createCall.preset, 'tide');
    const promptCall = s.dsh.calls.find((call) => call.name === 'prompt');
    assert.match(promptCall.content[0].text, /【会话令牌】/);
    assert.match(promptCall.content[0].text, new RegExp(s.token));
    assert.match(promptCall.content[0].text, /你好/);

    const message = s.gateway.dbState.db.prepare(
      "SELECT dsh_turn FROM message WHERE conversation_id = ? AND role = 'user'",
    ).get(s.conv.id);
    assert.match(message.dsh_turn, /^req-/);

    // 新连接用 since_seq=0 应从 DB 回放两条消息
    const replay = openSse(`${s.base}/conversations/${s.conv.id}/stream?since_seq=0`, s.bearer);
    try {
      await replay.waitFor('user_message', (e) => e.data.message?.seq === 1);
      await replay.waitFor('assistant_message', (e) => e.data.message?.seq === 2);
    } finally {
      replay.close();
    }
  } finally {
    sse1.close();
    sse2.close();
    await s.close();
  }
});

test('/prompt 投递失败保留消息，同 client_msg_id 重试只投递一次', async () => {
  const s = await makeServer({ promptFailTimes: 1 });
  try {
    const first = await fetch(`${s.base}/conversations/${s.conv.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '重试这条', client_msg_id: 'cm-retry-1' }),
    });
    assert.equal(first.status, 503);
    const firstBody = await first.json();
    assert.equal(firstBody.error.code, 'gateway-unavailable');
    assert.equal(firstBody.error.delivered, false);
    assert.equal(firstBody.error.retryable, true);

    const stored = s.gateway.dbState.db.prepare(
      "SELECT dsh_turn FROM message WHERE conversation_id = ? AND client_msg_id = 'cm-retry-1'",
    ).get(s.conv.id);
    assert.equal(stored.dsh_turn, null);

    const second = await fetch(`${s.base}/conversations/${s.conv.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '重试这条', client_msg_id: 'cm-retry-1' }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.duplicated, true);
    assert.equal(secondBody.delivered, true);
    assert.equal(secondBody.turn_started, true);

    const after = s.gateway.dbState.db.prepare(
      "SELECT dsh_turn FROM message WHERE conversation_id = ? AND client_msg_id = 'cm-retry-1'",
    ).get(s.conv.id);
    assert.match(after.dsh_turn, /^req-/);
    assert.equal(
      s.dsh.calls.filter((call) => call.name === 'prompt').length,
      2,
      '第一次失败 + 第二次重试，总共两次 prompt',
    );
    assert.equal(
      s.dsh.calls.filter((call) => call.name === 'createSession').length,
      1,
      '重试复用同一个 session',
    );
  } finally {
    await s.close();
  }
});

test('/prompt 遇到 session/not-found 会按当前 policy 重建 session 并重投一次', async () => {
  const s = await makeServer({
    promptFailTimes: 1,
    promptFailCode: 'session/not-found',
  });
  try {
    const events = [];
    s.gateway.events.subscribeUser(s.userId, (event) => events.push(event));
    const res = await fetch(`${s.base}/conversations/${s.conv.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '会话丢了也要发出去', client_msg_id: 'cm-notfound-1' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.delivered, true);
    assert.equal(body.turn_started, true);
    assert.equal(
      s.dsh.calls.filter((call) => call.name === 'createSession').length,
      2,
      '旧 session 丢了，应当重建一次',
    );
    assert.equal(
      s.dsh.calls.filter((call) => call.name === 'prompt').length,
      2,
      '第一次 not-found，重建后重投一次',
    );
    const conv = s.gateway.dbState.db.prepare(
      'SELECT dsh_session_id, epoch FROM conversation WHERE id = ?',
    ).get(s.conv.id);
    assert.equal(conv.dsh_session_id, 'sess-2');
    assert.equal(conv.epoch, 1, 'delivery 兜底不递增 epoch');
    const rebuilt = events.filter((event) => event.type === 'conversation.rebuilt');
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0].conversationId, s.conv.id);
    assert.equal(rebuilt[0].epoch, 1);
    assert.equal(rebuilt[0].reason, 'session-not-found');
    assert.equal(rebuilt[0].seq, 1);
    const message = s.gateway.dbState.db.prepare(
      "SELECT dsh_turn FROM message WHERE conversation_id = ? AND client_msg_id = 'cm-notfound-1'",
    ).get(s.conv.id);
    assert.match(message.dsh_turn, /^req-/);
  } finally {
    await s.close();
  }
});

test('SSE 参数和鉴权：since_seq 非法 400，缺 Bearer 401', async () => {
  const s = await makeServer();
  try {
    const noAuth = await fetch(`${s.base}/conversations/${s.conv.id}/stream`);
    assert.equal(noAuth.status, 401);

    const bad = await fetch(`${s.base}/conversations/${s.conv.id}/stream?since_seq=abc`, {
      headers: s.bearer,
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'bad-request');
  } finally {
    await s.close();
  }
});
