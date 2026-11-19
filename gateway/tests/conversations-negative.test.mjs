// conversations 路由的负向用例 —— 对应 docs/M2a-REVIEW.md 的三条 P0。
// 这三条在 R1 修之前应该是红的（TDD 的红阶段），修完转绿。
//
//   node --test gateway/tests/conversations-negative.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';

let dir;
let gateway;
let base;
let token;
let userId;

async function api(method, p, { body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** 直接往库里塞一条属于 convId 的附件（M2a 还没有上传接口） */
function seedAttachment(convId) {
  const id = randomUUID();
  gateway.dbState.db
    .prepare(
      `INSERT INTO attachment
         (id, conversation_id, message_id, kind, media_type, bytes, sha256, local_path, created_at)
       VALUES (?, ?, NULL, 'file', 'text/plain', 5, 'deadbeef', '/tmp/x.txt', ?)`,
    )
    .run(id, convId, Date.now());
  return id;
}

const countMessages = (convId) =>
  gateway.dbState.db
    .prepare('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?')
    .get(convId).n;

const readSeqOf = (convId) =>
  gateway.dbState.db.prepare(
    'SELECT last_read_seq FROM conversation_member WHERE conversation_id = ? AND user_id = ?',
  ).get(convId, userId).last_read_seq;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-neg-'));
  gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    jwtSecret: 'negative-test-secret-negative',
  });
  await gateway.authService.createUser({ username: 'tester', password: 'password123' });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${gateway.server.address().port}`;

  const login = await api('POST', '/auth/login', {
    body: { username: 'tester', password: 'password123' },
  });
  assert.equal(login.status, 200);
  token = login.json.accessToken;
  userId = login.json.userId;
});

after(async () => {
  await new Promise((resolve) => gateway.server.close(resolve));
  try {
    gateway.dbState.db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── P0-1 附件归属 ───────────────────────────────────────────────────────

test('P0-1 用别的对话的附件 id 发消息 → 400，且消息不落库', async () => {
  const a = (await api('POST', '/conversations', { body: { title: 'A' } })).json;
  const b = (await api('POST', '/conversations', { body: { title: 'B' } })).json;
  const foreignAtt = seedAttachment(b.id);

  const before = countMessages(a.id);
  const res = await api('POST', `/conversations/${a.id}/prompt`, {
    body: { text: '看看这个', attachments: [foreignAtt] },
  });

  assert.equal(res.status, 400, '跨会话附件应当被拒绝，而不是 200');
  assert.equal(res.json?.error?.code, 'bad-request');
  assert.equal(countMessages(a.id), before, '被拒绝的 prompt 不能留下消息');

  const att = gateway.dbState.db
    .prepare('SELECT conversation_id, message_id FROM attachment WHERE id = ?')
    .get(foreignAtt);
  assert.equal(att.conversation_id, b.id, '附件不能跑到别的对话去');
  assert.equal(att.message_id, null, '附件不能被挂到被拒绝的消息上');
});

test('P0-1 对照：同一对话的附件能正常挂上', async () => {
  const c = (await api('POST', '/conversations', { body: { title: 'C' } })).json;
  const ownAtt = seedAttachment(c.id);

  const res = await api('POST', `/conversations/${c.id}/prompt`, {
    body: { text: '带附件', attachments: [ownAtt] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.queued, true);

  const att = gateway.dbState.db
    .prepare('SELECT message_id FROM attachment WHERE id = ?')
    .get(ownAtt);
  assert.ok(att.message_id, '同会话附件必须被挂到消息上');
});

test('P0-1 不存在的附件 id → 400，且消息不落库', async () => {
  const d = (await api('POST', '/conversations', { body: { title: 'D' } })).json;
  const beforeCount = countMessages(d.id);

  const res = await api('POST', `/conversations/${d.id}/prompt`, {
    body: { text: '幽灵附件', attachments: [randomUUID()] },
  });
  assert.equal(res.status, 400);
  assert.equal(countMessages(d.id), beforeCount);
});

// ── P0-2 已读水位 clamp ─────────────────────────────────────────────────

test('P0-2 through_seq 超过最新 seq → 400，水位不动', async () => {
  const e = (await api('POST', '/conversations', { body: { title: 'E' } })).json;
  await api('POST', `/conversations/${e.id}/prompt`, { body: { text: '第一条' } });

  const beforeSeq = readSeqOf(e.id);
  const res = await api('POST', `/conversations/${e.id}/read`, {
    body: { through_seq: 999999 },
  });

  assert.equal(res.status, 400, '超出最新 seq 的水位必须被拒绝');
  assert.equal(res.json?.error?.code, 'bad-request');
  assert.equal(readSeqOf(e.id), beforeSeq, '被拒绝的 read 不能改动水位');
});

test('P0-2 对照：正好等于最新 seq → 200 且生效', async () => {
  const f = (await api('POST', '/conversations', { body: { title: 'F' } })).json;
  await api('POST', `/conversations/${f.id}/prompt`, { body: { text: '第一条' } });
  await api('POST', `/conversations/${f.id}/prompt`, { body: { text: '第二条' } });

  const res = await api('POST', `/conversations/${f.id}/read`, { body: { through_seq: 2 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.user_read_seq, 2);
  assert.equal(readSeqOf(f.id), 2);
});

// ── P0-3 分页参数校验 ───────────────────────────────────────────────────

test('P0-3 before 不是数字 → 400，不是空列表', async () => {
  const g = (await api('POST', '/conversations', { body: { title: 'G' } })).json;
  await api('POST', `/conversations/${g.id}/prompt`, { body: { text: '有消息的对话' } });

  const res = await api('GET', `/conversations/${g.id}/messages?before=abc`);
  assert.equal(res.status, 400, '非法 before 必须报错，不能静默返回空');
  assert.equal(res.json?.error?.code, 'bad-request');
});

test('P0-3 after_seq 不是数字 → 400', async () => {
  const h = (await api('POST', '/conversations', { body: { title: 'H' } })).json;
  await api('POST', `/conversations/${h.id}/prompt`, { body: { text: '有消息' } });

  const res = await api('GET', `/conversations/${h.id}/messages?after_seq=nope`);
  assert.equal(res.status, 400);
});

test('P0-3 对照：合法分页参数照常工作', async () => {
  const i = (await api('POST', '/conversations', { body: { title: 'I' } })).json;
  for (const t of ['一', '二', '三']) {
    await api('POST', `/conversations/${i.id}/prompt`, { body: { text: t } });
  }

  const all = await api('GET', `/conversations/${i.id}/messages?limit=2`);
  assert.equal(all.status, 200);
  assert.equal(all.json.messages.length, 2);
  assert.equal(all.json.has_more, true);

  const after = await api('GET', `/conversations/${i.id}/messages?after_seq=2`);
  assert.equal(after.status, 200);
  assert.equal(after.json.messages.length, 1);
  assert.equal(after.json.messages[0].content.text, '三');
});

test('P0-0 after_seq 按正序分页，不跳消息；before 仍按倒序取更早页', async () => {
  const conv = (await api('POST', '/conversations', { body: { title: '分页' } })).json;
  const insert = gateway.dbState.db.prepare(
    `INSERT INTO message
       (id, conversation_id, role, content_json, created_at, seq)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  );
  const now = Date.now();
  for (let seq = 1; seq <= 120; seq += 1) {
    insert.run(
      randomUUID(),
      conv.id,
      JSON.stringify({ type: 'text', text: `m${seq}` }),
      now + seq,
      seq,
    );
  }

  const first = await api('GET', `/conversations/${conv.id}/messages?after_seq=0&limit=100`);
  assert.equal(first.status, 200);
  assert.equal(first.json.messages.length, 100);
  assert.equal(first.json.messages[0].content.text, 'm1');
  assert.equal(first.json.messages[99].content.text, 'm100');
  assert.equal(first.json.has_more, true, 'after_seq 的 has_more 表示还有更新的消息');

  const second = await api(
    'GET',
    `/conversations/${conv.id}/messages?after_seq=100&limit=100`,
  );
  assert.equal(second.status, 200);
  assert.equal(second.json.messages.length, 20);
  assert.equal(second.json.messages[0].content.text, 'm101');
  assert.equal(second.json.messages[19].content.text, 'm120');
  assert.equal(second.json.has_more, false);

  // 没有 after_seq 时保持原语义：DESC + reverse，返回最新两页，has_more 表示还有更早的。
  const latest = await api('GET', `/conversations/${conv.id}/messages?limit=2`);
  assert.equal(latest.status, 200);
  assert.deepEqual(latest.json.messages.map((m) => m.content.text), ['m119', 'm120']);
  assert.equal(latest.json.has_more, true);

  const older = await api('GET', `/conversations/${conv.id}/messages?before=119&limit=2`);
  assert.equal(older.status, 200);
  assert.deepEqual(older.json.messages.map((m) => m.content.text), ['m117', 'm118']);
  assert.equal(older.json.has_more, true);
});

test('P0-0 边界：恰好 100 条时 after_seq 不返回 has_more', async () => {
  const conv = (await api('POST', '/conversations', { body: { title: '整页' } })).json;
  const insert = gateway.dbState.db.prepare(
    `INSERT INTO message
       (id, conversation_id, role, content_json, created_at, seq)
     VALUES (?, ?, 'assistant', ?, ?, ?)`,
  );
  const now = Date.now();
  for (let seq = 1; seq <= 100; seq += 1) {
    insert.run(
      randomUUID(),
      conv.id,
      JSON.stringify({ type: 'text', text: `m${seq}` }),
      now + seq,
      seq,
    );
  }

  const page = await api('GET', `/conversations/${conv.id}/messages?after_seq=0&limit=100`);
  assert.equal(page.status, 200);
  assert.equal(page.json.messages.length, 100);
  assert.equal(page.json.messages[0].content.text, 'm1');
  assert.equal(page.json.messages[99].content.text, 'm100');
  assert.equal(page.json.has_more, false);
});
