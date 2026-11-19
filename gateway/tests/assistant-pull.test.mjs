/**
 * DSH turn 结束后的游标同步。
 *
 * 汐语的用户可见出口只有 `chat_send`。DSH 的 assistant/message 是模型最终回答，
 * 其中经常混着「我先等着」「安静收尾」这类过程旁白；这些内容绝不能当兜底正文
 * 落库或广播。这个文件专门守住这条边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer(dshOptions = {}, logger = silent, gatewayOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-pull-'));
  const dsh = createFakeDsh(dshOptions);
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    dsh,
    startRebuildWorker: false,
    logger,
    ...gatewayOptions,
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
      body: JSON.stringify({ title: 'assistant 游标' }),
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
      },
    });

  const prompt = (body) =>
    fetch(`${base}/conversations/${created.id}/prompt`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const messages = async () => {
    const res = await fetch(`${base}/conversations/${created.id}/messages?limit=50`, {
      headers: bearer,
    });
    return (await res.json()).messages ?? [];
  };

  return {
    dir,
    dsh,
    gateway,
    base,
    bearer,
    conv: created,
    token,
    agent,
    prompt,
    messages,
    row: (sql, ...args) => gateway.dbState.db.prepare(sql).get(...args),
    all: (sql, ...args) => gateway.dbState.db.prepare(sql).all(...args),
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(check, message, timeoutMs = 4_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test('turn 最终回答不落库、不广播，只推进 DSH 游标', async () => {
  const s = await makeServer({ replyText: '主人还没接话，我先等着。（安静收尾，不再输出。）' });
  const controller = new AbortController();
  const events = [];
  const res = await fetch(`${s.base}/conversations/${s.conv.id}/stream?since_seq=0`, {
    headers: s.bearer,
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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
          const type = chunk.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // abort
    }
  })();

  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = await s.prompt({ text: '在吗', client_msg_id: 'pull-1' });
    assert.equal(sent.status, 200);

    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 2,
      'DSH 游标没有越过 user + assistant 两条',
    );
    const rows = await s.messages();
    assert.deepEqual(rows.map((row) => row.role), ['user']);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      events.filter((event) => event.type === 'assistant_message').length,
      0,
      '最终回答不能进 SSE',
    );
  } finally {
    controller.abort();
    await s.close();
  }
});

test('recap 的哨兵回复与普通最终回答都不进聊天记录', async () => {
  const s = await makeServer({
    recapSent: true,
    recapReplyText: '已恢复',
    replyText: '真正要显示的回复也只能走 chat_send',
  });
  try {
    const now = Date.now();
    s.gateway.dbState.db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq, client_msg_id)
       VALUES ('hist-u', ?, 'user', '{"type":"text","text":"旧消息"}', ?, 1, 'hist-u')`,
    ).run(s.conv.id, now);
    s.gateway.dbState.db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq)
       VALUES ('hist-a', ?, 'assistant', '{"type":"text","text":"旧回复"}', ?, 2)`,
    ).run(s.conv.id, now + 1);

    const res = await s.prompt({ text: '接着上次说', client_msg_id: 'pull-2' });
    assert.equal(res.status, 200);
    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 3,
      'DSH 游标没有越过 recap 与当前 turn',
    );
    const rows = await s.messages();
    assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant', 'user']);
    assert.deepEqual(rows.map((row) => row.content.text), ['旧消息', '旧回复', '接着上次说']);
    assert.ok(!rows.some((row) => row.content.text === '已恢复'));
    assert.ok(!rows.some((row) => row.content.text === '真正要显示的回复也只能走 chat_send'));
  } finally {
    await s.close();
  }
});

test('连续两个 turn 只留下用户消息，最终回答不会重复或混入', async () => {
  const s = await makeServer({ replyText: '我先等等，不另外发。' });
  try {
    await s.prompt({ text: '第一句', client_msg_id: 'pull-3a' });
    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 2,
      '第一轮游标未推进',
    );
    await s.prompt({ text: '第二句', client_msg_id: 'pull-3b' });
    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 4,
      '第二轮游标未推进',
    );

    const rows = await s.messages();
    assert.deepEqual(rows.map((row) => row.role), ['user', 'user']);
    assert.deepEqual(rows.map((row) => row.content.text), ['第一句', '第二句']);
    assert.equal(
      s.all(
        "SELECT id FROM message WHERE conversation_id = ? AND role = 'assistant'",
        s.conv.id,
      ).length,
      0,
    );
  } finally {
    await s.close();
  }
});

test('chat_send 已经产出真实消息时，turn 最终旁白同样不进库', async () => {
  const s = await makeServer({ replyText: '已回复。', autoReplyChatSent: true });
  try {
    await s.prompt({ text: '在吗', client_msg_id: 'pull-4' });
    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 2,
      '游标未推进',
    );
    const sent = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['真正发出去的一条'], clientBatchId: 'pull-4-send' }),
    });
    assert.equal(sent.status, 200);
    const rows = await s.messages();
    assert.deepEqual(rows.map((row) => row.role), ['user', 'assistant']);
    assert.equal(rows[1].content.text, '真正发出去的一条');
  } finally {
    await s.close();
  }
});

test('未调用 chat_send 的最终文本会留下一条排障 warn', async () => {
  const warnings = [];
  const logger = {
    log() {},
    error() {},
    warn(message) { warnings.push(String(message)); },
  };
  const s = await makeServer({
    replyText: '主人还没接话，我先等着，安静收尾。',
  }, logger);
  try {
    await s.prompt({ text: '在吗', client_msg_id: 'warn-1' });
    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 2,
      '游标未推进',
    );
    const hit = warnings.find((line) => line.includes('未经 chat_send 发出'));
    assert.ok(hit, `应记录未发送 warn，实际 ${JSON.stringify(warnings)}`);
    assert.match(hit, new RegExp(s.conv.id));
    assert.match(hit, /turn=/);
    assert.match(hit, /主人还没接话/);
  } finally {
    await s.close();
  }
});

test('direct 未走 chat_send 时会追加一次纠错 prompt', async () => {
  const s = await makeServer(
    { replyText: '摸头这一下，我算是收下了。' },
    silent,
    { sendRescue: true },
  );
  try {
    await s.prompt({ text: '摸摸脑袋', client_msg_id: 'rescue-1' });
    await waitFor(
      () => s.dsh.getCallCount('prompt') >= 2,
      '没有追加 chat_send 纠错 prompt',
    );
    const prompts = s.dsh.calls.filter((call) => call.name === 'prompt');
    const rescueText = prompts[1].content[0].text;
    assert.match(rescueText, /系统纠错/);
    assert.match(rescueText, /没有调用 chat_send/);
    assert.match(rescueText, /摸头这一下/);
    assert.equal(prompts.length, 2, '只纠错一次，不能递归重试');
  } finally {
    await s.close();
  }
});

test('过程旁白不会触发 chat_send 纠错', async () => {
  const s = await makeServer(
    { replyText: '（安静收尾，不再输出。）' },
    silent,
    { sendRescue: true },
  );
  try {
    await s.prompt({ text: '在吗', client_msg_id: 'rescue-meta' });
    await waitFor(
      () =>
        s.row('SELECT dsh_after_seq FROM conversation WHERE id = ?', s.conv.id).dsh_after_seq >= 2,
      '游标未推进',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(s.dsh.getCallCount('prompt'), 1);
  } finally {
    await s.close();
  }
});

test('replyCheck / timer 回合不会触发发送纠错', async () => {
  const s = await makeServer(
    { replyText: '刚想了一下。' },
    silent,
    { sendRescue: true },
  );
  try {
    await s.gateway.social.deliverWake(s.conv.id, 'replyCheck', { skipMessageCheck: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(s.dsh.getCallCount('prompt'), 1);
  } finally {
    await s.close();
  }
});
