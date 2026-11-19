/**
 * `/agent/*` 真网关契约测试。
 *
 * 打的是真 SQLite + 真路由，不是 fake gateway。fake gateway 那一组（contract.test.mjs）
 * 继续保留作为固定装置；这一组验的是实现和契约是否真的一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-agent-'));
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
  const bearer = { authorization: `Bearer ${login.accessToken}` };

  const created = await (
    await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '测试对话' }),
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
    gateway,
    base,
    bearer,
    conversationId: created.id,
    token,
    agent,
    db: gateway.dbState.db,
    async close() {
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (res) => res.json();

// ── 鉴权 ────────────────────────────────────────────────────────────────

test('鉴权：缺 token / 缺 x-agent-call / 错 token 分别报对应错误码', async () => {
  const s = await makeServer();
  try {
    const noToken = await fetch(`${s.base}/agent/prompt`, {
      headers: { 'x-agent-call': '1', 'x-agent-secret': 'test-secret' },
    });
    assert.equal(noToken.status, 401);
    assert.equal((await json(noToken)).error.code, 'token-missing');

    const noCall = await fetch(`${s.base}/agent/prompt`, {
      headers: { 'x-agent-token': s.token, 'x-agent-secret': 'test-secret' },
    });
    assert.equal(noCall.status, 401);
    assert.equal((await json(noCall)).error.code, 'agent-call-missing');

    const wrong = await fetch(`${s.base}/agent/prompt`, {
      headers: {
        'x-agent-token': 'f'.repeat(48),
        'x-agent-call': '1',
        'x-agent-secret': 'test-secret',
      },
    });
    assert.equal(wrong.status, 401);
    assert.equal((await json(wrong)).error.code, 'token-invalid');

    const wrongSecret = await fetch(`${s.base}/agent/prompt`, {
      headers: {
        'x-agent-token': s.token,
        'x-agent-call': '1',
        'x-agent-secret': 'wrong',
      },
    });
    assert.equal(wrongSecret.status, 401);
    assert.equal((await json(wrongSecret)).error.code, 'agent-secret-invalid');
  } finally {
    await s.close();
  }
});

test('鉴权：会话排队重建时返回 403 conversation-closed 并带 rebuild_state', async () => {
  const s = await makeServer();
  try {
    const now = Date.now();
    s.db.prepare(
      'INSERT INTO rebuild_queue(conversation_id, reason, next_attempt_at, created_at) VALUES (?, ?, ?, ?)',
    ).run(s.conversationId, 'policy:owner', now, now);

    const res = await s.agent('/prompt');
    assert.equal(res.status, 403);
    const body = await json(res);
    assert.equal(body.error.code, 'conversation-closed');
    assert.equal(body.error.rebuild_state, 'pending');
  } finally {
    await s.close();
  }
});

test('agent 可改自己的公开资料，guest 被拒绝', async () => {
  const s = await makeServer();
  try {
    const before = await s.agent('/profile');
    assert.equal(before.status, 200);
    assert.equal((await json(before)).profile.name, '汐语');

    const png = 'data:image/png;base64,'
      + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
    const updated = await s.agent('/profile', {
      method: 'POST',
      body: JSON.stringify({ name: '小汐', signature: '今天也在', avatar: png }),
    });
    assert.equal(updated.status, 200);
    const profile = (await json(updated)).profile;
    assert.equal(profile.name, '小汐');
    assert.equal(profile.signature, '今天也在');
    assert.equal(profile.hasAvatar, true);

    const after = await json(await s.agent('/profile'));
    assert.equal(after.profile.name, '小汐');
    assert.equal(after.profile.hasAvatar, true);

    const bad = await s.agent('/profile', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(bad.status, 400);

    s.db.prepare("UPDATE users SET role = 'guest' WHERE username = 'u'").run();
    const denied = await s.agent('/profile', {
      method: 'POST',
      body: JSON.stringify({ signature: 'guest 不该改' }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await json(denied)).error.code, 'profile-forbidden');
  } finally {
    await s.close();
  }
});

// ── 读路径 ──────────────────────────────────────────────────────────────

test('GET /agent/prompt：指纹是 sha256 前 4 位，未读按 role=user 统计', async () => {
  const s = await makeServer();
  try {
    const res = await s.agent('/prompt');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.ok, true);
    assert.equal(body.agentReadThroughSeq, 0);
    assert.equal(body.unread.count, 0);
    assert.match(body.prompt, /policy=restricted/);
    assert.equal(
      body.tokenFingerprint,
      createHash('sha256').update(s.token).digest('hex').slice(0, 4),
      '指纹必须是 sha256 token 的前 4 位，不是 token 末 4 位',
    );
  } finally {
    await s.close();
  }
});

test('GET /agent/messages：空 afterSeq 取最新，afterSeq 递增取，hasMore 方向随游标变', async () => {
  const s = await makeServer();
  try {
    for (let i = 1; i <= 3; i += 1) {
      await s.agent('/messages', {
        method: 'POST',
        body: JSON.stringify({ messages: [`第 ${i} 条`] }),
      });
    }

    // 契约 2.2：空 afterSeq = 最新 limit 条，hasMore 表示"还有更早的"。
    const tail = await json(await s.agent('/messages?limit=2'));
    assert.equal(tail.messages.length, 2);
    assert.deepEqual(tail.messages.map((m) => m.seq), [2, 3], '空 afterSeq 要给最新的两条');
    assert.equal(tail.messages[0].role, 'assistant');
    assert.equal(tail.messages[0].text, '第 2 条');
    assert.equal(tail.messages[1].text, '第 3 条');
    assert.equal(tail.hasMore, true, '还有更早的');
    assert.equal(tail.latestSeq, 3);

    // 全取完时 hasMore 必须翻成 false，否则 App 会一直往前翻。
    const full = await json(await s.agent('/messages?limit=100'));
    assert.equal(full.messages.length, 3);
    assert.equal(full.hasMore, false);

    // 有游标时按 ASC 向后取，hasMore 表示"还有更新的"。
    const after = await json(await s.agent('/messages?afterSeq=2'));
    assert.deepEqual(after.messages.map((m) => m.seq), [3]);
    assert.equal(after.hasMore, false);

    const afterZero = await json(await s.agent('/messages?afterSeq=0&limit=2'));
    assert.deepEqual(afterZero.messages.map((m) => m.seq), [1, 2], 'afterSeq=0 从最早开始');
    assert.equal(afterZero.hasMore, true, '还有更新的');

    const bad = await s.agent('/messages?limit=999');
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

// ── 写路径 ──────────────────────────────────────────────────────────────

test('POST /agent/messages：整批原子落库，seq 连续', async () => {
  const s = await makeServer();
  try {
    const res = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['一', '二', '三'], clientBatchId: 'b-1' }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.duplicated, false);
    assert.deepEqual(body.messages.map((m) => m.seq), [1, 2, 3]);

    const rows = s.db.prepare(
      'SELECT seq, role FROM message WHERE conversation_id = ? ORDER BY seq',
    ).all(s.conversationId);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.role === 'assistant'));
  } finally {
    await s.close();
  }
});

test('POST /agent/messages：同 clientBatchId 同 payload 幂等，不同 payload 409', async () => {
  const s = await makeServer();
  try {
    const first = await json(await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['原话'], clientBatchId: 'b-1' }),
    }));
    assert.equal(first.duplicated, false);

    const again = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['原话'], clientBatchId: 'b-1' }),
    });
    assert.equal(again.status, 200);
    const replay = await json(again);
    assert.equal(replay.duplicated, true);
    assert.deepEqual(replay.messages, first.messages, '重放要返回原来那条，不是新建');

    const conflict = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['改了'], clientBatchId: 'b-1' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await json(conflict)).error.code, 'batch-conflict');

    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?').get(s.conversationId).n,
      1,
      '幂等与冲突都不该多出消息',
    );
  } finally {
    await s.close();
  }
});

test('POST /agent/messages：拆分后超 8 条 / 空白项整批拒绝，一条都不落', async () => {
  const s = await makeServer();
  try {
    const cases = [
      { messages: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
      { messages: ['x'.repeat(4501)] },
      { messages: ['ok', '   '] },
      { messages: [] },
    ];
    for (const body of cases) {
      const res = await s.agent('/messages', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal((await json(res)).error.code, 'bad-request');
    }
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?').get(s.conversationId).n,
      0,
      '整批拒绝时不能留下半批',
    );
  } finally {
    await s.close();
  }
});

test('POST /agent/messages：超长单条自动拆成多条，不再 400 后整轮沉默', async () => {
  const s = await makeServer();
  try {
    const text = '甲'.repeat(700);
    const res = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [text], clientBatchId: 'long-1' }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.messages.length, 2);
    const rows = s.db.prepare(
      "SELECT content_json FROM message WHERE conversation_id = ? AND role = 'assistant' ORDER BY seq",
    ).all(s.conversationId);
    assert.equal(rows.length, 2);
    const texts = rows.map((row) => JSON.parse(row.content_json).text);
    assert.equal(texts.join(''), text);
    assert.ok(texts.every((chunk) => chunk.length <= 500));
  } finally {
    await s.close();
  }
});

// ── 已读水位 ────────────────────────────────────────────────────────────

test('POST /agent/read：只前进不后退，越界 400', async () => {
  const s = await makeServer();
  try {
    await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['a', 'b'] }),
    });

    const up = await json(await s.agent('/read', {
      method: 'POST',
      body: JSON.stringify({ throughSeq: 2 }),
    }));
    assert.equal(up.agentReadThroughSeq, 2);

    const back = await json(await s.agent('/read', {
      method: 'POST',
      body: JSON.stringify({ throughSeq: 1 }),
    }));
    assert.equal(back.agentReadThroughSeq, 2, '回退必须无效');

    const over = await s.agent('/read', {
      method: 'POST',
      body: JSON.stringify({ throughSeq: 99 }),
    });
    assert.equal(over.status, 400);
  } finally {
    await s.close();
  }
});

test('已读水位只影响 agent_read_seq，不动 user_read_seq', async () => {
  const s = await makeServer();
  try {
    await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['a'] }),
    });
    await s.agent('/read', { method: 'POST', body: JSON.stringify({ throughSeq: 1 }) });
    const conv = s.db.prepare(
      'SELECT agent_read_seq, user_read_seq FROM conversation WHERE id = ?',
    ).get(s.conversationId);
    assert.equal(conv.agent_read_seq, 1);
    assert.equal(conv.user_read_seq, 0, '两个水位必须独立');
  } finally {
    await s.close();
  }
});

// ── wait ────────────────────────────────────────────────────────────────

test('POST /agent/wait：reply 模式对方早已安静 → arrived=false, quiet=true', async () => {
  const s = await makeServer();
  try {
    const past = Date.now() - 60_000;
    s.db.prepare(
      `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
       VALUES (?, ?, 'user', ?, ?, 1)`,
    ).run(randomUUID(), s.conversationId, JSON.stringify({ type: 'text', text: '早先的话' }), past);

    const res = await s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'reply', quietMs: 1000, timeoutMs: 2000 }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.arrived, false, '消息是进 wait 之前就有了');
    assert.equal(body.quiet, true, 'reply 模式从最后一条来信起算静默');
    assert.equal(body.timeout, false);
    assert.deepEqual(body.newMessages, []);
  } finally {
    await s.close();
  }
});

test('POST /agent/wait：等到了新消息 → arrived=true，newMessages 只含进来的', async () => {
  const s = await makeServer();
  try {
    setTimeout(() => {
      const now = Date.now();
      s.db.prepare(
        `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
         VALUES (?, ?, 'user', ?, ?, 1)`,
      ).run(randomUUID(), s.conversationId, JSON.stringify({ type: 'text', text: '来了' }), now);
    }, 300);

    const res = await s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'messages', quietMs: 1000, timeoutMs: 4000 }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.arrived, true);
    // arrived 一变真就返回，不会为了凑 quiet 再多等——arrived=true / quiet=false
    // 表示「有新消息，对方可能还在继续说」，正是该让模型决定要不要再等一手的信号。
    assert.equal(body.quiet, false);
    assert.equal(body.timeout, false);
    assert.equal(body.newMessages.length, 1);
    assert.equal(body.newMessages[0].text, '来了');

    // 紧接着用 reply 模式再等一手：对方已经安静超过 quietMs 就该立刻返回
    const next = await json(await s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'reply', quietMs: 1000, timeoutMs: 3000 }),
    }));
    assert.equal(next.arrived, false, '这条消息在上一轮 wait 之前就落库了');
    assert.equal(next.quiet, true);
  } finally {
    await s.close();
  }
});

test('POST /agent/wait：同会话并发第二个 wait 立刻 429', async () => {
  const s = await makeServer();
  try {
    const first = s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'messages', quietMs: 1000, timeoutMs: 3000 }),
    });
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    const second = await s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'messages', quietMs: 1000, timeoutMs: 3000 }),
    });
    assert.equal(second.status, 429);
    assert.equal((await json(second)).error.code, 'wait-busy');

    const firstRes = await first;
    assert.equal(firstRes.status, 200);
  } finally {
    await s.close();
  }
});

test('POST /agent/wait：参数越界 400', async () => {
  const s = await makeServer();
  try {
    for (const body of [
      { quietMs: 10 },
      { quietMs: 99_999 },
      { timeoutMs: 10 },
      { timeoutMs: 9_999_999 },
    ]) {
      const res = await s.agent('/wait', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await s.close();
  }
});

// ── memory ──────────────────────────────────────────────────────────────

test('POST /agent/memory：同 kind+key 覆盖，不同 key 并存', async () => {
  const s = await makeServer();
  try {
    const first = await json(await s.agent('/memory', {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic', key: '当前话题', text: '在聊网关' }),
    }));
    assert.equal(first.overwritten, undefined);

    const second = await json(await s.agent('/memory', {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic', key: '当前话题', text: '改聊测试' }),
    }));
    assert.equal(second.overwritten, true);
    assert.equal(second.id, first.id, '覆盖要落在同一行');

    await s.agent('/memory', {
      method: 'POST',
      body: JSON.stringify({ kind: 'topic', key: '另一个', text: '并存' }),
    });

    const list = await json(await s.agent('/memory?kind=topic'));
    assert.equal(list.items.length, 2);
    assert.equal(
      list.items.find((i) => i.key === '当前话题').text,
      '改聊测试',
    );
  } finally {
    await s.close();
  }
});

test('DELETE /agent/memory：按 kind 批量必须带 confirm，按 id 缺失 404', async () => {
  const s = await makeServer();
  try {
    await s.agent('/memory', {
      method: 'POST',
      body: JSON.stringify({ kind: 'thought', text: '一个念头' }),
    });

    const noConfirm = await s.agent('/memory', {
      method: 'DELETE',
      body: JSON.stringify({ kind: 'thought' }),
    });
    assert.equal(noConfirm.status, 400);

    const ok = await s.agent('/memory', {
      method: 'DELETE',
      body: JSON.stringify({ kind: 'thought', confirm: true }),
    });
    assert.equal((await json(ok)).removed, 1);

    const missing = await s.agent('/memory', {
      method: 'DELETE',
      body: JSON.stringify({ id: 999 }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('POST /agent/memory：kind 不合法或 text 超长都拒绝', async () => {
  const s = await makeServer();
  try {
    for (const body of [
      { kind: 'nope', text: 'x' },
      { kind: 'topic', text: '' },
      { kind: 'topic', text: 'x'.repeat(501) },
    ]) {
      const res = await s.agent('/memory', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    }
  } finally {
    await s.close();
  }
});

// ── 附件 ────────────────────────────────────────────────────────────────

function seedAttachment(s, { conversationId, body = 'hello', name = 'note.txt', mediaType = 'text/plain' }) {
  const id = randomUUID();
  const dir = path.join(s.gateway.workspaceRoot, 'conversations', conversationId, 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  s.db.prepare(
    `INSERT INTO attachment (id, conversation_id, message_id, kind, media_type, bytes, local_path, created_at)
     VALUES (?, ?, NULL, 'file', ?, ?, ?, ?)`,
  ).run(id, conversationId, mediaType, Buffer.byteLength(body), file, Date.now());
  return { id, file, dir };
}

test('GET /agent/attachments/:id/content：草稿态（message_id 为 NULL）也能读', async () => {
  const s = await makeServer();
  try {
    const att = seedAttachment(s, { conversationId: s.conversationId, body: '还没发出去的附件' });
    const res = await s.agent(`/attachments/${att.id}/content`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.text, '还没发出去的附件');
    assert.equal(body.mimeType, 'text/plain');
    assert.equal(body.eof, true);
  } finally {
    await s.close();
  }
});

test('GET /agent/attachments/:id/content：别人的附件 403，不存在 404', async () => {
  const s = await makeServer();
  try {
    const other = await json(await fetch(`${s.base}/conversations`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '另一个对话' }),
    }));
    const foreign = seedAttachment(s, { conversationId: other.id, body: '机密' });

    const res = await s.agent(`/attachments/${foreign.id}/content`);
    assert.equal(res.status, 403);
    assert.equal((await json(res)).error.code, 'attachment-forbidden');

    const missing = await s.agent(`/attachments/${randomUUID()}/content`);
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('GET /agent/attachments/:id/content：路径越界拒绝，offset/limit 正常切片', async () => {
  const s = await makeServer();
  try {
    const att = seedAttachment(s, { conversationId: s.conversationId, body: '0123456789' });

    const slice = await json(await s.agent(`/attachments/${att.id}/content?offset=2&limit=3`));
    assert.equal(slice.text, '234');
    assert.equal(slice.eof, false);
    assert.equal(slice.truncated, true);

    // 把 local_path 改成指向目录外，必须被 canonicalize 挡掉
    const outside = path.join(s.dir, 'outside.txt');
    fs.writeFileSync(outside, '不该被读到');
    s.db.prepare('UPDATE attachment SET local_path = ? WHERE id = ?').run(outside, att.id);

    const escape = await s.agent(`/attachments/${att.id}/content`);
    assert.equal(escape.status, 403);
    assert.equal((await json(escape)).error.code, 'attachment-forbidden');
  } finally {
    await s.close();
  }
});

// ── P1 回归：契约字段与真实现对齐 ──────────────────────────────────────

test('消息里的 attachments 是对象而不是 id 字符串（M1 契约 2.2）', async () => {
  const s = await makeServer();
  try {
    const att = seedAttachment(s, { conversationId: s.conversationId, body: 'x', name: 'a.txt' });
    const res = await fetch(`${s.base}/conversations/${s.conversationId}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '发个附件', attachments: [att.id] }),
    });
    assert.ok(res.status === 200 || res.status === 201, `postPrompt 状态 ${res.status}`);

    const gotRaw = await s.agent('/messages?limit=5');
    const got = await json(gotRaw);
    assert.equal(gotRaw.status, 200, `读消息失败: ${JSON.stringify(got).slice(0, 200)}`);
    assert.ok(Array.isArray(got.messages), 'messages 应当是数组');
    const msg = got.messages.find((m) => m.text === '发个附件');
    assert.ok(msg, '应当能读回刚发的消息');
    assert.equal(msg.attachments.length, 1);
    const a = msg.attachments[0];
    assert.equal(a.id, att.id);
    assert.equal(a.name, 'a.txt');
    assert.equal(typeof a.mimeType, 'string', 'mimeType 不能是 undefined');
    assert.equal(typeof a.size, 'number', 'size 不能是 undefined');
  } finally {
    await s.close();
  }
});

test('wake-config 落库，下一轮 prompt 读到同一份（chat_set_wake_config 要真的生效）', async () => {
  const s = await makeServer();
  try {
    const before = await json(await s.agent('/prompt'));
    assert.equal(before.wakeConfig.mode, 'diving');
    assert.equal(before.wakeConfig.triggers.atMention, true);
    assert.equal(before.wakeConfig.triggers.probability, 0.05);

    const set = await json(await s.agent('/wake-config', {
      method: 'POST',
      body: JSON.stringify({
        config: { mode: 'active', triggers: { probability: 0.2 } },
      }),
    }));
    assert.equal(set.config.mode, 'active');
    assert.equal(set.config.triggers.anyMessage, true);
    assert.equal(set.config.triggers.probability, 0.2);

    const after = await json(await s.agent('/prompt'));
    assert.equal(after.wakeConfig.mode, 'active');
    assert.equal(after.wakeConfig.triggers.probability, 0.2);
    assert.equal(after.wakeConfig.confirmedBy, 'agent');

    // 一份没有任何触发条件的配置会把会话变成永眠，必须拒绝
    const bad = await s.agent('/wake-config', {
      method: 'POST',
      body: JSON.stringify({
        config: {
          mode: 'diving',
          triggers: {
            atMention: false,
            nameMention: false,
            speakerIds: [],
            keywords: [],
            question: false,
            poke: false,
            anyMessage: false,
            probability: 0,
          },
        },
      }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

test('wake-config 拒绝未知字段，不再 200 后静默吞掉', async () => {
  const s = await makeServer();
  try {
    const oldShape = await s.agent('/wake-config', {
      method: 'POST',
      body: JSON.stringify({
        config: { enabled: true, minIntervalMinutes: 60, quietHours: [1, 7] },
      }),
    });
    assert.equal(oldShape.status, 400);
    assert.equal((await json(oldShape)).error.code, 'bad-request');

    const typo = await s.agent('/wake-config', {
      method: 'POST',
      body: JSON.stringify({
        config: { mode: 'diving', triggers: { nameMentioned: true } },
      }),
    });
    assert.equal(typo.status, 400);
    assert.equal((await json(typo)).error.code, 'bad-request');
  } finally {
    await s.close();
  }
});

test('附件 symlink 指到 root 外面要 403（词法检查挡不住，靠 realpath）', async (t) => {
  const s = await makeServer();
  try {
    const outsideDir = path.join(s.dir, 'outside-dir');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outside, '这段内容在附件根之外');

    const dir = path.join(s.gateway.workspaceRoot, 'conversations', s.conversationId, 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const link = path.join(dir, 'leak.txt');
    try {
      // Windows 上文件 symlink 要开发者模式/管理员，目录 junction 不要；
      // 两种都试，能建哪个用哪个。
      try {
        fs.symlinkSync(outside, link, 'file');
      } catch {
        fs.symlinkSync(outsideDir, link, 'junction');
      }
    } catch {
      t.skip('当前平台建不了 symlink / junction');
      return;
    }

    const id = randomUUID();
    s.db.prepare(
      `INSERT INTO attachment (id, conversation_id, message_id, kind, media_type, bytes, local_path, created_at)
       VALUES (?, ?, NULL, 'file', 'text/plain', ?, ?, ?)`,
    ).run(id, s.conversationId, Buffer.byteLength('这段内容在附件根之外'), link, Date.now());

    const res = await s.agent(`/attachments/${id}/content`);
    assert.equal(res.status, 403, 'symlink 逃逸必须被 realpath 那一步挡住');
    assert.equal((await json(res)).error.code, 'attachment-forbidden');
  } finally {
    await s.close();
  }
});

test('大附件只读需要的那一段，不把整个文件读进内存', async () => {
  const s = await makeServer();
  try {
    // 1MB 文件，limit 64 字节：响应里的 size 是文件全长，text 只有 64 字节
    const big = 'A'.repeat(1_048_576);
    const att = seedAttachment(s, { conversationId: s.conversationId, body: big, name: 'big.txt' });
    const body = await json(await s.agent(`/attachments/${att.id}/content?offset=1000&limit=64`));
    assert.equal(body.size, 1_048_576, 'size 是文件总长，不是切片长度');
    assert.equal(body.text.length, 64);
    assert.equal(body.offset, 1000);
    assert.equal(body.truncated, true);
    assert.equal(body.eof, false);

    const tail = await json(await s.agent(`/attachments/${att.id}/content?offset=1048570&limit=64`));
    assert.equal(tail.text.length, 6);
    assert.equal(tail.eof, true);
    assert.equal(tail.truncated, false);
  } finally {
    await s.close();
  }
});
