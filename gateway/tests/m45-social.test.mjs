/**
 * M4.5 验收：v2 唤醒、[SILENT]、replyCheck、proactive 系数、沉睡前观察、
 * 群/私聊差异、水位、迁移、限流。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../server.mjs';
import { closeDatabase, openDatabase } from '../db/index.mjs';
import { planSendDelays, splitReplyText } from '../messages.mjs';
import { defaultWakeConfig, evaluateWakeTrigger } from '../social/wake.mjs';
import {
  proactiveProbability,
  replyCheckDelay,
  wakeLimitRetry,
} from '../social/engine.mjs';
import { createFakeDsh } from './fake-dsh.mjs';

const silent = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function groupWake(overrides = {}) {
  const cfg = defaultWakeConfig();
  cfg.batchWindowMs = 1000;
  cfg.confirmedBy = 'agent';
  cfg.confirmedAt = Date.now();
  cfg.triggers.probability = 0;
  return { ...cfg, ...overrides, triggers: { ...cfg.triggers, ...(overrides.triggers || {}) } };
}

async function makeServer({ dshOptions = {}, socialConfig = {}, kind = 'direct', wake = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-m45-'));
  const dsh = createFakeDsh(dshOptions);
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    dsh,
    startRebuildWorker: false,
    logger: silent,
    socialConfig: {
      proactiveMinMs: 3_600_000,
      proactiveMaxMs: 3_600_000,
      ...socialConfig,
    },
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
      body: JSON.stringify({ title: kind === 'group' ? '测试群' : '测试私聊', kind }),
    })
  ).json();
  const db = gateway.dbState.db;
  if (wake) {
    db.prepare('UPDATE conversation SET wake_config_json = ? WHERE id = ?')
      .run(JSON.stringify(wake), created.id);
  }
  const token = db.prepare('SELECT agent_token FROM conversation WHERE id = ?')
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
  const prompt = (text, extra = {}) =>
    fetch(`${base}/conversations/${created.id}/prompt`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...extra }),
    });
  const setWake = (config) =>
    agent('/wake-config', { method: 'POST', body: JSON.stringify({ config }) });
  return {
    dir,
    gateway,
    dsh,
    base,
    db,
    id: created.id,
    token,
    agent,
    prompt,
    setWake,
    async close() {
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
    async closeKeepDir() {
      await new Promise((resolve) => gateway.server.close(resolve));
    },
  };
}

const json = (res) => res.json();

// ── 纯函数：8 触发 ─────────────────────────────────────────────────────

test('8 触发按固定顺序判定，private 直接命中', () => {
  const base = defaultWakeConfig();
  const withTriggers = (overrides) => ({
    ...base,
    triggers: { ...base.triggers, ...overrides },
  });
  const ev = (config, text, extra = {}) =>
    evaluateWakeTrigger({ kind: 'group', config, text, ...extra });

  assert.equal(evaluateWakeTrigger({ kind: 'direct', config: base, text: '随便' }), 'private');
  assert.equal(ev(withTriggers({ anyMessage: true }), '随便'), 'anyMessage');
  assert.equal(ev(base, '@汐语 在吗'), 'atMention');
  assert.equal(
    ev(withTriggers({ atMention: false }), '汐语今天好看吗', { quoteTargetIsSelf: false }),
    'nameMention',
  );
  assert.equal(
    ev(withTriggers({ atMention: false, nameMention: false, keywords: ['暗号'] }), '暗号在这'),
    'keyword:暗号',
  );
  assert.equal(
    ev(withTriggers({ atMention: false, nameMention: false, keywords: [] }), '你觉得这个行不行？'),
    'question',
  );
  assert.equal(
    ev(withTriggers({ atMention: false, nameMention: false, keywords: [], speakerIds: ['u2'] }), '随便', {
      senderId: 'u2',
      senderLabel: '阿二',
      quoteTargetIsSelf: false,
    }),
    'speaker:阿二',
  );
  assert.equal(
    ev(withTriggers({ atMention: false, nameMention: false, keywords: [], probability: 1 }), '随便', {
      random: () => 0,
    }),
    'probability',
  );
  assert.equal(
    ev(
      withTriggers({
        atMention: false,
        nameMention: false,
        keywords: [],
        question: false,
        probability: 0,
      }),
      '随便',
    ),
    null,
  );
  assert.equal(
    ev(base, '只引用不附文', { quoteTargetIsSelf: true }),
    'atMention',
  );
});

// ── 纯函数：proactive 五系数 / replyCheck / 限频 ───────────────────────

test('分条节奏：第一条立即，之后 1~3 秒，20% 长间隔', () => {
  assert.deepEqual(planSendDelays(1, { random: () => 0.5 }), [0]);
  assert.deepEqual(
    planSendDelays(3, {
      random: () => 0.5,
      minMs: 1000,
      maxMs: 3000,
      longProbability: 0,
    }),
    [0, 2000, 2000],
  );
  const long = planSendDelays(2, {
    random: () => 0.1,
    minMs: 1000,
    maxMs: 3000,
    longMinMs: 5000,
    longMaxMs: 10_000,
    longProbability: 0.2,
  });
  assert.equal(long[1], 5500);
});

test('splitReplyText 超过 8 条时回调截断信息，不静默丢内容', () => {
  let info = null;
  const chunks = splitReplyText(
    Array.from({ length: 9 }, (_, i) => `${'甲'.repeat(300)}第${i + 1}段。`).join(''),
    { onTruncate: (value) => { info = value; } },
  );
  assert.equal(chunks.length, 8);
  assert.equal(info.originalMessages, 9);
  assert.equal(info.keptMessages, 8);
});

test('proactive 五个系数、replyCheck 乘数、唤醒限频窗口', () => {
  const base = proactiveProbability({ base: 0.4, hour: 12, ownCountLastHour: 0 });
  assert.equal(base, 0.4);
  assert.ok(Math.abs(proactiveProbability({
    base: 0.4,
    pendingThoughts: 1,
    hour: 12,
  }) - 0.56) < 1e-9);
  assert.ok(Math.abs(proactiveProbability({
    base: 0.4,
    lastAiReplyAt: Date.now(),
    hour: 12,
  }) - 0.2) < 1e-9);
  assert.ok(Math.abs(proactiveProbability({
    base: 0.4,
    hour: 23,
  }) - 0.12) < 1e-9);
  assert.ok(Math.abs(proactiveProbability({
    base: 0.4,
    hour: 12,
    ownCountLastHour: 5,
  }) - 0.12) < 1e-9);

  assert.equal(replyCheckDelay(30_000, []), 30_000);
  assert.equal(replyCheckDelay(30_000, ['在吗？']), 45_000);
  assert.equal(replyCheckDelay(30_000, ['一', '二', '在吗？']), 58_500);

  const now = Date.now();
  assert.ok(wakeLimitRetry({ wakeTimes: [now], now }) >= 59_000);
  const hourTimes = Array.from({ length: 12 }, (_, i) => now - i * 1000);
  assert.ok(wakeLimitRetry({ wakeTimes: hourTimes, now }) >= 3_500_000);
});

// ── 群聊/私聊差异 + prompt 覆盖 ─────────────────────────────────────────

test('群聊普通消息不唤醒，@ 才唤醒；prompt 覆盖三段私聊 persona 并澄清 MCP resource', async () => {
  const s = await makeServer({ kind: 'group', wake: groupWake() });
  try {
    const plain = await json(await s.prompt('今天天气不错'));
    assert.equal(plain.message.role, 'user');
    assert.equal(plain.message.text, '今天天气不错');
    assert.equal(plain.wake_scheduled, false);
    assert.equal(plain.wake_reason, null);
    assert.equal(s.dsh.getCallCount('prompt'), 0, '普通群消息不投递');

    const at = await json(await s.prompt('@汐语 在吗'));
    assert.equal(at.wake_scheduled, true);
    assert.equal(at.wake_reason, 'atMention');
    await sleep(1400);
    assert.equal(s.dsh.getCallCount('prompt'), 1, '合批窗口后投递一次');
    const text = s.dsh.calls.find((c) => c.name === 'prompt').content[0].text;
    assert.match(text, /【群聊规则（覆盖上文「1:1 对话规则」）】/);
    assert.match(text, /【群聊里的该说\/不该说（覆盖上文「该说\/不该说」）】/);
    assert.match(text, /最多 8 条/);
    assert.match(text, /MCP resource/);
    assert.match(text, /\[SILENT\]/);
    const stored = s.db.prepare(
      "SELECT wake_reason FROM message WHERE conversation_id = ? AND seq = 2",
    ).get(s.id);
    assert.equal(stored.wake_reason, 'atMention');
  } finally {
    await s.close();
  }
});

test('私聊每条消息都投递，prompt 是私聊口径', async () => {
  const s = await makeServer({ kind: 'direct' });
  try {
    const res = await json(await s.prompt('随便说一句'));
    assert.equal(res.delivered, true);
    assert.equal(res.wake_reason, 'private');
    assert.equal(s.dsh.getCallCount('prompt'), 1);
    const text = s.dsh.calls.find((c) => c.name === 'prompt').content[0].text;
    assert.match(text, /【私聊规则（覆盖上文「1:1 对话规则」）】/);
    assert.match(text, /私聊不允许 \[SILENT\]/);
    assert.doesNotMatch(text, /【群聊规则/);
  } finally {
    await s.close();
  }
});

test('chat_send 的 assistant_message 事件自带完整 message，并且按节奏逐条推送', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake(),
    socialConfig: { sendPacing: { minMs: 30, maxMs: 30, longProbability: 0 } },
  });
  try {
    const events = [];
    const seenAt = [];
    s.gateway.events.subscribe(s.id, (event) => {
      events.push(event);
      if (event.type === 'assistant_message') seenAt.push(Date.now());
    });
    const res = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['第一条', '第二条'], clientBatchId: 'm45-pacing-1' }),
    });
    assert.equal(res.status, 200);
    await sleep(10);
    const first = events.find((event) => event.type === 'assistant_message');
    assert.equal(first.message.text, '第一条');
    assert.equal(first.message.role, 'assistant');
    await sleep(90);
    assert.equal(seenAt.length, 2);
    // 集成测试只验异步分两次推送、顺序正确；具体间隔由 planSendDelays 单测覆盖。
    assert.ok(seenAt[1] >= seenAt[0], '第二条不能早于第一条推送');
    const second = events.filter((event) => event.type === 'assistant_message')[1];
    assert.equal(second.message.text, '第二条');
  } finally {
    await s.close();
  }
});

test('两个发送批次共用一条推送链，后一批不会插到前一批中间', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake(),
    socialConfig: { sendPacing: { minMs: 40, maxMs: 40, longProbability: 0 } },
  });
  try {
    const order = [];
    s.gateway.events.subscribe(s.id, (event) => {
      if (event.type === 'assistant_message') order.push(event.message.text);
    });
    await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['a', 'b', 'c'] }),
    });
    await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['d'] }),
    });
    await sleep(200);
    assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  } finally {
    await s.close();
  }
});

test('pending_wake 一次回放多条：队首 skipped 不会堵住后面', async () => {
  const s = await makeServer({ kind: 'group', wake: groupWake() });
  try {
    const now = Date.now();
    for (let i = 1; i <= 3; i += 1) {
      s.db.prepare(
        `INSERT INTO pending_wake(conversation_id, reason, seq, created_at)
         VALUES (?, 'question', ?, ?)`,
      ).run(s.id, i, now + i);
    }
    await s.gateway.social.onTurnEnd(s.id);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?').get(s.id).n,
      0,
    );
  } finally {
    await s.close();
  }
});

test('engine.start() 重放停机期间的 pending_wake', async () => {
  const wake = defaultWakeConfig();
  wake.batchWindowMs = 1000;
  wake.confirmedBy = 'agent';
  wake.confirmedAt = Date.now();
  const s = await makeServer({ kind: 'direct', wake });
  try {
    s.db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq)
       VALUES (?, ?, 'user', ?, ?, 1)`,
    ).run('m-start-replay', s.id, JSON.stringify({ type: 'text', text: '停机期间的消息' }), Date.now());
    s.db.prepare('UPDATE conversation SET agent_read_seq = 0 WHERE id = ?').run(s.id);
    s.db.prepare(
      `INSERT INTO pending_wake(conversation_id, reason, seq, created_at)
       VALUES (?, 'private', 1, ?)`,
    ).run(s.id, Date.now());

    s.gateway.social.stop();
    s.db.prepare('UPDATE conversation SET wake_config_json = ? WHERE id = ?')
      .run(JSON.stringify(wake), s.id);
    const before = s.dsh.getCallCount('prompt');
    s.gateway.social.start();
    await sleep(1500);

    assert.ok(s.dsh.getCallCount('prompt') >= before + 1, '启动后应重放 pending_wake');
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?').get(s.id).n,
      0,
    );
  } finally {
    await s.close();
  }
});

test('唤醒限频超限时，第二个 reason 落 pending_wake，不蒸发', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake(),
    socialConfig: { maxWakePerMinute: 1, maxWakePerHour: 10 },
  });
  try {
    await s.gateway.social.deliverWake(s.id, 'atMention', { skipMessageCheck: true });
    await sleep(100);
    await s.gateway.social.deliverWake(s.id, 'question', { skipMessageCheck: true });
    assert.equal(s.dsh.getCallCount('prompt'), 1);
    const pending = s.db
      .prepare('SELECT reason FROM pending_wake WHERE conversation_id = ?')
      .all(s.id);
    assert.ok(pending.some((row) => row.reason === 'question'));
  } finally {
    await s.close();
  }
});

test('纯文本最终回答不再当兜底发出去', async () => {
  const s = await makeServer({
    kind: 'direct',
    dshOptions: { replyText: '甲'.repeat(700) },
    socialConfig: { sendPacing: { minMs: 10, maxMs: 10, longProbability: 0 } },
  });
  try {
    const events = [];
    s.gateway.events.subscribe(s.id, (event) => events.push(event));
    await json(await s.prompt('来一段长的兜底正文'));
    await sleep(120);
    const rows = s.db
      .prepare(
        `SELECT seq, content_json, dsh_message_id FROM message
          WHERE conversation_id = ? AND role = 'assistant'
          ORDER BY seq ASC`,
      )
      .all(s.id);
    assert.equal(rows.length, 0, '最终回答不是消息，不能走兜底发布');
    assert.equal(events.filter((event) => event.type === 'assistant_message').length, 0);
  } finally {
    await s.close();
  }
});

// ── [SILENT] 两条路径 ──────────────────────────────────────────────────

test('[SILENT]：群聊显式沉默算 action；私聊 400；纯文本 [SILENT] 不落库且算空转', async () => {
  const group = await makeServer({ kind: 'group', wake: groupWake() });
  try {
    group.db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?')
      .run(JSON.stringify({ noActionCount: 2 }), group.id);
    const res = await group.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['[SILENT]'] }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.silent, true);
    assert.deepEqual(body.messages, []);
    assert.equal(
      group.db.prepare('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?').get(group.id).n,
      0,
    );
    const social = JSON.parse(
      group.db.prepare('SELECT social_state_json FROM conversation WHERE id = ?').get(group.id)
        .social_state_json,
    );
    assert.equal(social.noActionCount, 0, '显式 [SILENT] 是 action，清零 noActionCount');
  } finally {
    await group.close();
  }

  const priv = await makeServer({ kind: 'direct' });
  try {
    const bad = await priv.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['[SILENT]'] }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error.code, 'private_must_reply');
  } finally {
    await priv.close();
  }

  const textSilent = await makeServer({ kind: 'direct', dshOptions: { replyText: '[SILENT]' } });
  try {
    await json(await textSilent.prompt('只输出 [SILENT]'));
    await sleep(120);
    assert.equal(
      textSilent.db
        .prepare("SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND role = 'assistant'")
        .get(textSilent.id).n,
      0,
      '纯文本 [SILENT] 不写 message',
    );
    const social = JSON.parse(
      textSilent.db.prepare('SELECT social_state_json FROM conversation WHERE id = ?')
        .get(textSilent.id).social_state_json,
    );
    assert.equal(social.noActionCount, 1, '纯文本 [SILENT] 按没行动计数');
  } finally {
    await textSilent.close();
  }
});

// ── noAction 三次重置 ──────────────────────────────────────────────────

test('连续 3 次真空转 → wake_config 重置为默认并留一次提醒（最多 2 次）', async () => {
  const s = await makeServer({ kind: 'direct', dshOptions: { autoReply: false } });
  try {
    assert.equal((await s.setWake({ mode: 'active' })).status, 200);
    for (let i = 0; i < 3; i += 1) {
      await json(await s.prompt(`第 ${i + 1} 条`, { client_msg_id: `no-action-${i}` }));
      await sleep(100);
    }
    const conv = s.db.prepare(
      'SELECT wake_config_json, social_state_json FROM conversation WHERE id = ?',
    ).get(s.id);
    const wake = JSON.parse(conv.wake_config_json);
    const social = JSON.parse(conv.social_state_json);
    assert.equal(wake.confirmedBy, 'default');
    assert.equal(wake.mode, 'diving');
    assert.equal(wake.triggers.atMention, true);
    assert.equal(social.noActionCount, 0);
    assert.equal(social.wakeConfigReminders, 1);
    assert.equal(social.wakeConfigReminderPending, true);
  } finally {
    await s.close();
  }
});

// ── 沉睡前观察 ────────────────────────────────────────────────────────

test('沉睡前观察：没等够 409；等满窗口放行；明确结束语可跳过', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake(),
    socialConfig: { preSleepWaitMs: 1000 },
  });
  try {
    await json(await s.prompt('早'));
    assert.equal((await s.setWake({ mode: 'active' })).status, 200);
    const blocked = await s.setWake({ mode: 'diving' });
    assert.equal(blocked.status, 409);
    const blockedBody = await json(blocked);
    assert.equal(blockedBody.error.code, 'pre_sleep_wait_required');
    assert.ok(blockedBody.error.remainingMs > 0);

    const waited = await json(await s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'messages', quietMs: 1000, timeoutMs: 1000 }),
    }));
    assert.equal(waited.preSleepWaitSatisfied, true);
    assert.equal((await s.setWake({ mode: 'diving' })).status, 200);

    await json(await s.prompt('晚安'));
    assert.equal((await s.setWake({ mode: 'diving' })).status, 200, '晚安可跳过观察');
  } finally {
    await s.close();
  }
});

// ── replyCheck ────────────────────────────────────────────────────────

test('chat_send 之后安排 replyCheck：问句把 30s 拉到 45s（测试用 1s 基数）', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake(),
    socialConfig: { replyCheckMs: 1000 },
  });
  try {
    const sent = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['你还在吗？'] }),
    });
    assert.equal(sent.status, 200);
    await sleep(1800);
    assert.ok(s.dsh.getCallCount('prompt') >= 1, 'replyCheck 应当叫醒一次');
    const text = s.dsh.calls
      .filter((c) => c.name === 'prompt')
      .at(-1).content[0].text;
    assert.match(text, /【回复检查】/);
  } finally {
    await s.close();
  }
});

test('私聊 replyCheck 明确禁止无新消息时补发，并提示 chat_mark_read', async () => {
  const s = await makeServer({
    kind: 'direct',
    socialConfig: { replyCheckMs: 1000 },
  });
  try {
    const sent = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['你还在吗？'] }),
    });
    assert.equal(sent.status, 200);
    await sleep(1800);
    const text = s.dsh.calls
      .filter((c) => c.name === 'prompt')
      .at(-1).content[0].text;
    assert.match(text, /【回复检查】/);
    assert.match(text, /不要调用 chat_send/);
    assert.match(text, /chat_mark_read/);
  } finally {
    await s.close();
  }
});

test('私聊 chat_wait 会取消待执行的 replyCheck', async () => {
  const s = await makeServer({
    kind: 'direct',
    socialConfig: { replyCheckMs: 1000 },
  });
  try {
    const sent = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['先等你一下'] }),
    });
    assert.equal(sent.status, 200);
    await sleep(200);
    assert.equal(s.gateway.social.hasTimer(s.id, 'replyCheckTimer'), true);

    const waited = await s.agent('/wait', {
      method: 'POST',
      body: JSON.stringify({ purpose: 'reply', timeoutMs: 1000, quietMs: 1000 }),
    });
    assert.equal(waited.status, 200);
    await sleep(100);
    assert.equal(s.gateway.social.hasTimer(s.id, 'replyCheckTimer'), false);
  } finally {
    await s.close();
  }
});

test('proactiveCheck 只对群聊排；群聊安静时会主动唤醒，私聊不会', async () => {
  const group = await makeServer({
    kind: 'group',
    wake: groupWake(),
    socialConfig: {
      proactiveMinMs: 1000,
      proactiveMaxMs: 1000,
      proactiveIdleMs: 0,
      proactiveProbability: 1,
    },
  });
  try {
    assert.equal(group.gateway.social.hasTimer(group.id, 'proactiveTimer'), true);
    await group.gateway.social.deliverWake(group.id, 'proactiveCheck', {
      skipMessageCheck: true,
    });
    await sleep(120);
    assert.ok(group.dsh.getCallCount('prompt') >= 1, '群聊主动机会应当叫醒模型');
    const text = group.dsh.calls.find((c) => c.name === 'prompt').content[0].text;
    assert.match(text, /【主动机会】/);
  } finally {
    await group.close();
  }

  const direct = await makeServer({
    kind: 'direct',
    socialConfig: {
      proactiveMinMs: 1000,
      proactiveMaxMs: 1000,
      proactiveIdleMs: 0,
      proactiveProbability: 1,
    },
  });
  try {
    await sleep(200);
    assert.equal(direct.gateway.social.hasTimer(direct.id, 'proactiveTimer'), false);
    assert.equal(direct.dsh.getCallCount('prompt'), 0, '私聊不排 proactive');
  } finally {
    await direct.close();
  }
});

// ── 发送节流 ──────────────────────────────────────────────────────────

test('发送节流：8 条/分打满后整批进 send_queue，窗口腾出后自动落库', async () => {
  const s = await makeServer({ kind: 'direct' });
  try {
    const now = Date.now();
    for (let i = 1; i <= 8; i += 1) {
      s.db.prepare(
        `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
      ).run(`seed-${i}`, s.id, JSON.stringify({ type: 'text', text: `旧 ${i}` }), now, i);
    }
    const res = await s.agent('/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: ['第九条'] }),
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.queued, true);
    assert.deepEqual(body.messages, []);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM send_queue WHERE state = 'pending'").get().n,
      1,
    );

    s.db.prepare('UPDATE message SET created_at = ? WHERE conversation_id = ?')
      .run(now - 61_000, s.id);
    s.gateway.social.flushSendQueue(s.id);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND role = 'assistant'")
        .get(s.id).n,
      9,
    );
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM send_queue WHERE state = 'sent'").get().n,
      1,
    );
  } finally {
    await s.close();
  }
});

// ── 水位 ──────────────────────────────────────────────────────────────

test('水位按快照连续前缀推进；未展示的消息不能靠 chat_mark_read 越过；[SILENT] 不推进', async () => {
  const s = await makeServer({ kind: 'group', wake: groupWake() });
  try {
    await json(await s.prompt('@汐语 你好'));
    await sleep(1400);
    const readAfterWake = s.db.prepare('SELECT agent_read_seq FROM conversation WHERE id = ?')
      .get(s.id).agent_read_seq;
    assert.ok(readAfterWake >= 1);

    await json(await s.prompt('嗯'));
    const latest = s.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?',
    ).get(s.id).m;
    const read = await json(await s.agent('/read', {
      method: 'POST',
      body: JSON.stringify({ throughSeq: latest }),
    }));
    assert.equal(read.clamped, true);
    assert.equal(read.agentReadThroughSeq, readAfterWake, '未展示的消息不能越读');

    await s.agent('/messages', { method: 'POST', body: JSON.stringify({ messages: ['[SILENT]'] }) });
    const afterSilent = s.db.prepare('SELECT agent_read_seq FROM conversation WHERE id = ?')
      .get(s.id).agent_read_seq;
    assert.equal(afterSilent, readAfterWake, '[SILENT] 不推进水位');
  } finally {
    await s.close();
  }
});

// ── 老会话迁移 ────────────────────────────────────────────────────────

test('老会话 wake_config_json={} 迁移后回填完整默认，@ 能命中', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-migrate-'));
  const dbPath = path.join(dir, 'gw.db');
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE conversation (
        id TEXT PRIMARY KEY,
        legacy_key TEXT UNIQUE,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        avatar TEXT,
        summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dsh_session_id TEXT,
        dsh_workspace_id TEXT,
        dsh_after_seq INTEGER NOT NULL DEFAULT 0,
        agent_token TEXT NOT NULL,
        policy TEXT NOT NULL DEFAULT 'restricted',
        policy_hash TEXT NOT NULL,
        user_read_seq INTEGER NOT NULL DEFAULT 0,
        agent_read_seq INTEGER NOT NULL DEFAULT 0,
        recap_at INTEGER,
        wake_config TEXT
      );
    `);
    const now = Date.now();
    legacy.prepare(
      `INSERT INTO conversation
         (id, user_id, title, created_at, updated_at, agent_token, policy, policy_hash, wake_config)
       VALUES ('old-1', 'u1', '老会话', ?, ?, ?, 'restricted', 'h', '{}')`,
    ).run(now, now, 'a'.repeat(48));
  } finally {
    legacy.close();
  }
  const state = openDatabase(dbPath);
  try {
    const row = state.db.prepare(
      'SELECT kind, wake_config_json FROM conversation WHERE id = ?',
    ).get('old-1');
    assert.equal(row.kind, 'direct');
    const wake = JSON.parse(row.wake_config_json);
    assert.equal(wake.mode, 'diving');
    assert.equal(wake.triggers.atMention, true);
    assert.ok(wake.triggers.keywords.includes('汐语'));
    assert.equal(
      evaluateWakeTrigger({ kind: 'group', config: wake, text: '@汐语 在吗' }),
      'atMention',
    );
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── P6：会话级 limits / hint ───────────────────────────────────────────

test('会话 limits 优先：maxWakePerHour=1 时第 2 次唤醒被限流', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake({
      limits: {
        maxWakePerMinute: 1,
        maxWakePerHour: 1,
        preSleepWaitMs: 300_000,
        noActionLimit: 3,
        maxWakeConfigReminders: 2,
      },
    }),
  });
  try {
    s.db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?')
      .run(JSON.stringify({ wakeTimes: [Date.now()], lastAiReplyAt: 0 }), s.id);
    await s.gateway.social.deliverWake(s.id, 'question', { skipMessageCheck: true });
    assert.equal(s.dsh.getCallCount('prompt'), 0);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?')
        .get(s.id).n,
      1,
    );
  } finally {
    await s.close();
  }
});

test('连续无行动重置保留 limits 与 hint', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake({
      limits: {
        maxWakePerMinute: 2,
        maxWakePerHour: 20,
        preSleepWaitMs: 600_000,
        noActionLimit: 2,
        maxWakeConfigReminders: 0,
      },
      hint: '保留我',
    }),
  });
  try {
    s.db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?')
      .run(JSON.stringify({ noActionCount: 1, lastActionAt: 0 }), s.id);
    s.gateway.social.beginTurn(s.id);
    await s.gateway.social.onTurnEnd(s.id);
    const cfg = JSON.parse(
      s.db.prepare('SELECT wake_config_json AS j FROM conversation WHERE id = ?').get(s.id).j,
    );
    assert.equal(cfg.mode, 'diving');
    assert.equal(cfg.limits.maxWakePerHour, 20);
    assert.equal(cfg.limits.preSleepWaitMs, 600000);
    assert.equal(cfg.limits.noActionLimit, 2);
    assert.equal(cfg.limits.maxWakeConfigReminders, 0);
    assert.equal(cfg.hint, '保留我');
  } finally {
    await s.close();
  }
});

test('提示词注入实际 preSleepWaitMs，summary 带 limits', async () => {
  const s = await makeServer({
    kind: 'group',
    wake: groupWake({
      limits: {
        maxWakePerMinute: 3,
        maxWakePerHour: 30,
        preSleepWaitMs: 700_000,
        noActionLimit: 4,
        maxWakeConfigReminders: 1,
      },
      hint: '主动一点',
    }),
  });
  try {
    await json(await s.prompt('@汐语 你好'));
    await sleep(1400);
    const text = s.dsh.calls.find((call) => call.name === 'prompt').content[0].text;
    assert.match(text, /timeoutMs=700000/);
    assert.match(text, /沉睡前观察 700 秒/);
    assert.match(text, /每小时 30 次/);
    assert.match(text, /管理员建议：主动一点/);
  } finally {
    await s.close();
  }
});
