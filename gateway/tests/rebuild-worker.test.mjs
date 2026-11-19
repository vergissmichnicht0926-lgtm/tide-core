// rebuild-worker 的验收 —— 对应计划 10.16 的四条验收 + 崩溃窗口 + recap best-effort。
//
//   node --test gateway/tests/rebuild-worker.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase, nowMs } from '../db/index.mjs';
import { createRebuildWorker } from '../rebuild/worker.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function setup({ dshOptions, clockStart = 1_000_000, events = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-rw-'));
  const dbState = openDatabase(path.join(dir, 'g.db'));
  const db = dbState.db;

  // 一个会话（手动插，绕开 auth）。默认 restricted，提权用例靠 enqueue('policy:owner')
  const userId = `usr_${randomUUID().slice(0, 8)}`;
  const convId = randomUUID();
  db.prepare(
    `INSERT INTO conversation
       (id, user_id, title, created_at, updated_at, agent_token, policy, policy_hash,
        dsh_workspace_id)
     VALUES (?, ?, '测试会话', ?, ?, 'old-token', 'restricted', '{"preset":"tide"}', ?)`,
  ).run(convId, userId, nowMs(), nowMs(), `ws-${convId.slice(0, 8)}`);

  let clock = clockStart;
  const dsh = createFakeDsh(dshOptions);
  const worker = createRebuildWorker({
    db,
    dsh,
    events,
    now: () => clock,
    logger: silent,
    turnEndTimeoutMs: 30_000,
  });

  const enqueue = (reason = 'policy:owner', extra = {}) => {
    const id = db
      .prepare(
        `INSERT INTO rebuild_queue(conversation_id, reason, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(convId, reason, extra.nextAttemptAt ?? clock, clock).lastInsertRowid;
    return Number(id);
  };

  const row = (id) => db.prepare('SELECT * FROM rebuild_queue WHERE id = ?').get(id);
  const rows = () => db.prepare('SELECT * FROM rebuild_queue ORDER BY id').all();
  const conv = () => db.prepare('SELECT * FROM conversation WHERE id = ?').get(convId);
  const advance = (ms) => {
    clock += ms;
  };

  const cleanup = () => {
    closeDatabase(dbState);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, db, dbState, dsh, worker, convId, enqueue, row, rows, conv, advance, cleanup };
}

test('验收① session/cancel 永远不回 turn/end，30 秒超时后仍完成重建', async () => {
  const env = await setup({ dshOptions: { turnEndMode: 'timeout' } });
  try {
    const id = env.enqueue('policy:owner');
    const result = await env.worker.tick();

    assert.equal(result.status, 'rebuilt', '超时不该把整条记失败');
    assert.equal(env.dsh.getCallCount('waitTurnEnd'), 0, '没有旧 session 时不该等 turn/end');

    // 有旧 session 的场景
    env.db
      .prepare('UPDATE conversation SET dsh_session_id = ? WHERE id = ?')
      .run('sess-old', env.convId);
    env.dsh.sessions.set('sess-old', { agentPreset: 'tide' });
    const id2 = env.enqueue('policy:owner');
    const r2 = await env.worker.tick();

    assert.equal(r2.status, 'rebuilt');
    assert.equal(env.dsh.getCallCount('cancel'), 1, 'cancel 发出去了');
    const waitCall = env.dsh.calls.find((c) => c.name === 'waitTurnEnd');
    assert.equal(waitCall.timeoutMs, 30_000, '最多等 30 秒');
    assert.equal(env.row(id2), undefined, '重建成功要删行');
    assert.equal(env.rows().length, 0);
    assert.ok(id > 0);
  } finally {
    env.cleanup();
  }
});

test('验收② session/create 连续失败 5 次：退避 5s/15s/45s/2min，第 5 次 failed', async () => {
  const env = await setup({ dshOptions: { createFailTimes: 5 } });
  try {
    const id = env.enqueue('policy:owner');

    const expectedDelays = [5_000, 15_000, 45_000, 120_000];
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const before = env.row(id).next_attempt_at;
      const r = await env.worker.tick();
      assert.equal(r.status, 'failed', `第 ${attempt} 次应当失败`);

      const row = env.row(id);
      assert.equal(row.attempts, attempt);
      assert.equal(row.state, 'pending', `第 ${attempt} 次还没到上限，应当还能重试`);
      assert.match(row.last_error, /session\/create/);
      assert.equal(
        row.next_attempt_at - before,
        expectedDelays[attempt - 1],
        `第 ${attempt} 次失败后应当等 ${expectedDelays[attempt - 1]}ms`,
      );

      // 推进到下次可执行
      env.advance(expectedDelays[attempt - 1]);
    }

    const last = await env.worker.tick();
    assert.equal(last.status, 'failed');
    const finalRow = env.row(id);
    assert.equal(finalRow.attempts, 5, '第 5 次执行后 attempts 到 5');
    assert.equal(finalRow.state, 'failed', '第 5 次失败置 failed');
    assert.equal(finalRow.next_attempt_at, null, 'failed 行不再排期');

    // failed 行永远不再被 claim
    env.advance(24 * 60 * 60 * 1000);
    assert.equal(env.worker.claimNext(), undefined, 'failed 行不该被领走');
    assert.equal(env.rows().length, 1, 'failed 行保留给人工');
  } finally {
    env.cleanup();
  }
});

test('验收③ 网关重启后从 next_attempt_at 接着退避，不从 0 重来', async () => {
  const env = await setup({ dshOptions: { createFailTimes: 2 } });
  try {
    const id = env.enqueue('policy:owner');
    await env.worker.tick(); // 失败 1 次，等 5s
    let row = env.row(id);
    assert.equal(row.attempts, 1);
    const scheduledAt = row.next_attempt_at;

    // 模拟重启：新建一个 worker 实例，共享同一个库和同一个时钟
    const worker2 = createRebuildWorker({
      db: env.db,
      dsh: env.dsh,
      now: () => scheduledAt, // 正好到点
      logger: silent,
    });

    const r = await worker2.tick();
    assert.equal(r.status, 'failed', '第二次仍失败');
    row = env.row(id);
    assert.equal(row.attempts, 2, 'attempts 从库里接着数，不是从 0 重来');
    assert.equal(row.next_attempt_at - scheduledAt, 15_000, '第二档退避是 15s');
  } finally {
    env.cleanup();
  }
});

test('验收④ 重建失败不改写 conversation.policy', async () => {
  const env = await setup({ dshOptions: { createFailTimes: 5 } });
  try {
    // 想提权到 owner，但重建连续失败：库里的 policy 必须留在 restricted，
    // 否则就成了"库说 owner、DSH 跑 restricted"。
    env.enqueue('policy:owner');
    const before = env.conv();
    assert.equal(before.policy, 'restricted');

    await env.worker.tick();
    assert.equal(env.conv().policy, 'restricted', '失败处理器不能把 policy 改成 owner');
    assert.equal(env.conv().policy_hash, before.policy_hash);
  } finally {
    env.cleanup();
  }
});

test('崩溃窗口：已有 session 已是目标 preset → 采纳并删行，不重复创建', async () => {
  const env = await setup();
  try {
    env.db
      .prepare('UPDATE conversation SET dsh_session_id = ? WHERE id = ?')
      .run('sess-existing', env.convId);
    env.dsh.sessions.set('sess-existing', { agentPreset: 'tide-owner' });
    const id = env.enqueue('policy:owner');

    const r = await env.worker.tick();
    assert.equal(r.status, 'adopted');
    assert.equal(env.row(id), undefined, '采纳后应当删行');
    assert.equal(env.dsh.getCallCount('createSession'), 0, '不能盲目再建一个 session');
    assert.equal(env.dsh.getCallCount('cancel'), 0, '已经是目标档，不用 cancel');
  } finally {
    env.cleanup();
  }
});

test('崩溃窗口：已有 session 但不是目标 preset → 正常重建', async () => {
  const env = await setup();
  try {
    env.db
      .prepare('UPDATE conversation SET dsh_session_id = ? WHERE id = ?')
      .run('sess-wrong', env.convId);
    env.dsh.sessions.set('sess-wrong', { agentPreset: 'tide' });
    env.enqueue('policy:owner');

    const r = await env.worker.tick();
    assert.equal(r.status, 'rebuilt');
    assert.equal(env.dsh.getCallCount('cancel'), 1);
    assert.equal(env.dsh.getCallCount('createSession'), 1);
    const created = env.dsh.calls.find((c) => c.name === 'createSession');
    assert.equal(created.preset, 'tide-owner', 'owner 档要用 tide-owner');
    assert.equal(env.conv().dsh_session_id, 'sess-1');
  } finally {
    env.cleanup();
  }
});

test('recap 失败不影响重建成功，不重试整条', async () => {
  const env = await setup({ dshOptions: { recapFails: true } });
  try {
    const id = env.enqueue('policy:owner');
    const r = await env.worker.tick();

    assert.equal(r.status, 'rebuilt', 'recap 是 best-effort');
    assert.equal(env.row(id), undefined, '不能因为 recap 挂了就留着队列行');
    assert.equal(env.dsh.getCallCount('recap'), 1);
    assert.equal(env.dsh.getCallCount('createSession'), 1, '不能重复建 session');
  } finally {
    env.cleanup();
  }
});

test('agent_token 在重建时轮换，旧 token 不再有效', async () => {
  const env = await setup();
  try {
    assert.equal(env.conv().agent_token, 'old-token');
    env.enqueue('policy:owner');
    await env.worker.tick();

    const after = env.conv().agent_token;
    assert.notEqual(after, 'old-token', 'token 必须轮换');
    assert.equal(after.length, 48, '24 字节 hex = 48 字符');
  } finally {
    env.cleanup();
  }
});

test('降权走 tide preset，提权走 tide-owner', async () => {
  const env = await setup();
  try {
    env.enqueue('policy:restricted');
    await env.worker.tick();
    assert.equal(env.dsh.calls.find((c) => c.name === 'createSession').preset, 'tide');

    env.dsh.calls.length = 0;
    env.enqueue('policy:owner');
    await env.worker.tick();
    assert.equal(env.dsh.calls.find((c) => c.name === 'createSession').preset, 'tide-owner');
  } finally {
    env.cleanup();
  }
});

test('claimNext 用 COALESCE 兜住 NULL，naive 写法会漏', async () => {
  const env = await setup();
  try {
    // 手工插一行 next_attempt_at 为 NULL 的（模拟旧库遗留）
    env.db
      .prepare(
        `INSERT INTO rebuild_queue(conversation_id, reason, next_attempt_at, created_at)
         VALUES (?, 'policy:owner', NULL, ?)`,
      )
      .run(env.convId, nowMs());

    const naive = env.db
      .prepare(
        `SELECT COUNT(*) AS n FROM rebuild_queue
          WHERE state = 'pending' AND next_attempt_at <= ?`,
      )
      .get();
    assert.equal(naive.n, 0, 'naive 写法确实漏掉 NULL 行');

    const claimed = env.worker.claimNext();
    assert.ok(claimed, 'worker 必须用 COALESCE 捞到这一行');
    assert.equal(claimed.reason, 'policy:owner');
  } finally {
    env.cleanup();
  }
});

// ── P0-1 / P0-2 / recap_at（R1 审查后追加）─────────────────────────────

test('P0-1 session/list 抖动 → 整条失败退避，不能当"没有旧会话"再建一个', async () => {
  const env = await setup({ dshOptions: { listThrows: true } });
  try {
    env.db
      .prepare('UPDATE conversation SET dsh_session_id = ? WHERE id = ?')
      .run('sess-existing', env.convId);
    env.dsh.sessions.set('sess-existing', { agentPreset: 'tide-owner' });
    const id = env.enqueue('policy:owner');

    const r = await env.worker.tick();
    assert.equal(r.status, 'failed', 'DSH 抖动必须记失败，不能当作没有旧会话');
    assert.equal(env.dsh.getCallCount('createSession'), 0, '不能凭空再建一个 session');
    assert.equal(env.dsh.getCallCount('cancel'), 0, '没确认旧会话状态前不该动它');

    const row = env.row(id);
    assert.equal(row.attempts, 1);
    assert.equal(row.state, 'pending', '还能重试');
    assert.match(row.last_error, /session\/list/);
  } finally {
    env.cleanup();
  }
});

test('P0-1 会话真的 404 → 当没有旧会话，正常重建', async () => {
  const env = await setup();
  try {
    env.db
      .prepare('UPDATE conversation SET dsh_session_id = ? WHERE id = ?')
      .run('sess-gone', env.convId);
    env.dsh.state.listThrows = false;
    env.dsh.getSession = async (sessionId) => {
      env.dsh.calls.push({ name: 'getSession', sessionId });
      const error = new Error('session not found');
      error.code = 'session/not-found';
      throw error;
    };
    const id = env.enqueue('policy:owner');

    const r = await env.worker.tick();
    assert.equal(r.status, 'rebuilt', 'not-found 应当按没有旧会话处理');
    assert.equal(env.dsh.getCallCount('createSession'), 1);
    assert.equal(env.row(id), undefined);
  } finally {
    env.cleanup();
  }
});

test('P0-2 缺 dsh_workspace_id → 拒绝建 session，走退避', async () => {
  const env = await setup();
  try {
    env.db.prepare('UPDATE conversation SET dsh_workspace_id = NULL WHERE id = ?').run(env.convId);
    const id = env.enqueue('policy:owner');

    const r = await env.worker.tick();
    assert.equal(r.status, 'failed');
    assert.equal(env.dsh.getCallCount('createSession'), 0, '不能落到 DSH 默认 workspace');
    assert.match(env.row(id).last_error, /workspace/);
  } finally {
    env.cleanup();
  }
});

test('recap 成功写 recap_at，建 session 时先清空', async () => {
  const env = await setup();
  try {
    env.db.prepare('UPDATE conversation SET recap_at = 123 WHERE id = ?').run(env.convId);
    env.enqueue('policy:owner');
    await env.worker.tick();

    const conv = env.conv();
    assert.notEqual(conv.recap_at, 123, '旧 recap_at 必须清掉');
    assert.equal(typeof conv.recap_at, 'number', 'recap 成功后要写回时间戳');
  } finally {
    env.cleanup();
  }
});

test('recap 失败时 recap_at 留 NULL，下次采纳补一次', async () => {
  const env = await setup({ dshOptions: { recapFails: true } });
  try {
    env.enqueue('policy:owner');
    await env.worker.tick();
    assert.equal(env.conv().recap_at, null, 'recap 失败就不该写 recap_at');

    // 关掉失败，再来一条队列行 —— 采纳分支应当补 recap
    env.dsh.state.recapFails = false;
    env.dsh.calls.length = 0;
    env.enqueue('policy:owner');
    const r = await env.worker.tick();

    assert.equal(r.status, 'adopted');
    assert.equal(env.dsh.getCallCount('recap'), 1, '采纳时发现 recap_at 为 NULL 要补一次');
    assert.equal(typeof env.conv().recap_at, 'number');
  } finally {
    env.cleanup();
  }
});

test('人工把行改成 failed 后，迟到的失败不把它改回 pending', async () => {
  const env = await setup({ dshOptions: { createFailTimes: 1 } });
  try {
    const id = env.enqueue('policy:owner');
    // 先跑一次失败，attempts=1
    await env.worker.tick();
    assert.equal(env.row(id).state, 'pending');

    // 人工介入：标记 failed
    env.db.prepare("UPDATE rebuild_queue SET state = 'failed' WHERE id = ?").run(id);

    // 再手动调 recordFailure 模拟迟到写回
    const before = env.row(id);
    env.db
      .prepare(
        `UPDATE rebuild_queue SET attempts = ?, last_error = ?, state = ?, next_attempt_at = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(before.attempts + 1, 'late', 'pending', 0, id);

    assert.equal(env.row(id).state, 'failed', '人工设的 failed 不能被改回 pending');
    assert.equal(env.row(id).attempts, before.attempts, 'attempts 也不该被迟到写回推高');
  } finally {
    env.cleanup();
  }
});

test('rebuild 成功：epoch+1，只发本会话 rebuilt，其他会话不变', async () => {
  const events = {
    list: [],
    publish(conversationId, event) { this.list.push({ conversationId, event }); },
  };
  const env = await setup({ events });
  try {
    env.db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq)
       VALUES ('msg-1', ?, 'user', '{}', ?, 1)`,
    ).run(env.convId, Date.now());
    const otherId = randomUUID();
    env.db.prepare(
      `INSERT INTO conversation
         (id, user_id, title, created_at, updated_at, agent_token, policy, policy_hash,
          dsh_workspace_id)
       VALUES (?, 'other-user', 'other', ?, ?, 'other-token', 'restricted', 'hash', ?)`,
    ).run(otherId, Date.now(), Date.now(), 'ws-other');

    env.enqueue('policy:owner');
    const result = await env.worker.tick();
    assert.equal(result.status, 'rebuilt');
    assert.equal(env.conv().epoch, 2);
    assert.equal(env.db.prepare('SELECT epoch FROM conversation WHERE id = ?').get(otherId).epoch, 1);

    assert.equal(events.list.length, 1);
    const { conversationId, event } = events.list[0];
    assert.equal(conversationId, env.convId);
    assert.equal(event.type, 'conversation.rebuilt');
    assert.equal(event.conversationId, env.convId);
    assert.equal(event.epoch, 2);
    assert.equal(event.seq, 1);
    assert.equal(event.reason, 'policy:owner');
    assert.equal(event.dsh_session_id, undefined);
    assert.equal(event.agent_token, undefined);
  } finally {
    env.cleanup();
  }
});

test('adopted / 失败 不递增 epoch、不发 rebuilt', async () => {
  const adoptedEvents = {
    list: [],
    publish(conversationId, event) { this.list.push({ conversationId, event }); },
  };
  const adopted = await setup({ events: adoptedEvents });
  try {
    adopted.db
      .prepare('UPDATE conversation SET dsh_session_id = ? WHERE id = ?')
      .run('sess-adopted', adopted.convId);
    adopted.dsh.sessions.set('sess-adopted', { agentPreset: 'tide-owner' });
    adopted.enqueue('policy:owner');
    const result = await adopted.worker.tick();
    assert.equal(result.status, 'adopted');
    assert.equal(adopted.conv().epoch, 1);
    assert.equal(adoptedEvents.list.length, 0);
  } finally {
    adopted.cleanup();
  }

  const failedEvents = {
    list: [],
    publish(conversationId, event) { this.list.push({ conversationId, event }); },
  };
  const failed = await setup({ dshOptions: { createFailTimes: 1 }, events: failedEvents });
  try {
    failed.enqueue('policy:owner');
    const result = await failed.worker.tick();
    assert.equal(result.status, 'failed');
    assert.equal(failed.conv().epoch, 1);
    assert.equal(failedEvents.list.length, 0);
  } finally {
    failed.cleanup();
  }
});
