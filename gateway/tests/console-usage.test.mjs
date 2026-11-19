/** 0.24 用量：计数、幂等、缺天补零、byConversation、单价。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { bumpUsageMessages } from '../settings.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-usage-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin', password: 'password123', role: 'admin',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const app = await gateway.authService.login({
    username: 'admin', password: 'password123', deviceName: 'usage-test',
  });
  const id = await gateway.ctx.createDirectConversation({
    userId: admin.id,
    title: '用量测试',
  });
  const agentToken = gateway.dbState.db.prepare(
    'SELECT agent_token FROM conversation WHERE id = ?',
  ).get(id).agent_token;

  const loginRes = await fetch(`${base}/console/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123' }),
  });
  const loginBody = await loginRes.json();
  const cookieMatch = (loginRes.headers.get('set-cookie') || '').match(/tide_admin=([^;]+)/);
  const cookie = cookieMatch ? `tide_admin=${cookieMatch[1]}` : '';

  const agent = (body) => fetch(`${base}/agent/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-token': agentToken,
      'x-agent-call': '1',
      'x-agent-secret': 'test-secret',
    },
    body: JSON.stringify(body),
  });
  return {
    gateway,
    base,
    id,
    admin,
    app,
    db: gateway.dbState.db,
    login: { cookie, csrf: loginBody.csrfToken },
    agent,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('0.24 计数：用户、助手、轮次与 clientBatchId 幂等', async () => {
  const s = await makeServer();
  try {
    const prompt = await fetch(`${s.base}/conversations/${s.id}/prompt`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${s.app.accessToken}`,
      },
      body: JSON.stringify({ text: '你好', client_msg_id: 'usage-user-1' }),
    });
    assert.equal(prompt.status, 200);
    let row = s.db.prepare(
      'SELECT messages, turns, chars_in, chars_out FROM usage_daily WHERE user_id = ?',
    ).get(s.admin.id);
    assert.equal(row.messages, 1);
    assert.equal(row.chars_in, 2);
    assert.equal(row.chars_out, 0);
    assert.equal(row.turns, 0);

    const reply = await s.agent({
      messages: ['收到'],
      clientBatchId: 'usage-reply-1',
    });
    assert.equal(reply.status, 200);
    row = s.db.prepare(
      'SELECT messages, turns, chars_in, chars_out FROM usage_daily WHERE user_id = ?',
    ).get(s.admin.id);
    assert.equal(row.messages, 2);
    assert.equal(row.chars_out, 2);

    await s.gateway.social.onTurnEnd(s.id);
    row = s.db.prepare(
      'SELECT messages, turns, chars_in, chars_out FROM usage_daily WHERE user_id = ?',
    ).get(s.admin.id);
    assert.equal(row.turns, 1);

    const duplicate = await s.agent({
      messages: ['收到'],
      clientBatchId: 'usage-reply-1',
    });
    assert.equal(duplicate.status, 200);
    row = s.db.prepare(
      'SELECT messages, turns, chars_in, chars_out FROM usage_daily WHERE user_id = ?',
    ).get(s.admin.id);
    assert.equal(row.messages, 2, '幂等重试不能重复计数');

    bumpUsageMessages(s.db, s.admin.id, 1, '2026-11-13', 3);
    const previous = s.db.prepare(
      "SELECT messages, chars_in FROM usage_daily WHERE user_id = ? AND day = '2026-11-13'",
    ).get(s.admin.id);
    assert.equal(previous.messages, 1);
    assert.equal(previous.chars_in, 3);
  } finally {
    await s.close();
  }
});

test('0.24 API：7/30 天补零、byConversation、单价与 CSRF', async () => {
  const s = await makeServer();
  try {
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const insert = s.db.prepare(
      `INSERT INTO usage_daily
         (user_id, day, messages, tokens, turns, chars_in, chars_out, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    );
    insert.run(s.admin.id, todayKey, 5, 2, 50, 80, Date.now());
    insert.run(s.admin.id, yesterdayKey, 3, 1, 30, 40, Date.now());
    s.db.prepare(
      `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
       VALUES (?, ?, 'assistant', ?, ?, ?)`,
    ).run(
      'usage-msg-1',
      s.id,
      JSON.stringify({ type: 'text', text: '六个字符的输出' }),
      Date.now(),
      1,
    );

    const weekRes = await fetch(`${s.base}/console/api/usage?days=7`, {
      headers: { cookie: s.login.cookie },
    });
    assert.equal(weekRes.status, 200);
    const week = await weekRes.json();
    assert.equal(week.days.length, 7);
    assert.equal(week.totals.messages, 8);
    assert.equal(week.totals.turns, 3);
    assert.equal(week.totals.charsIn, 80);
    assert.equal(week.totals.charsOut, 120);
    assert.equal(week.byConversation[0].id, s.id);
    assert.equal(week.byConversation[0].charsOut, 7);
    assert.equal(week.price.inPer1k, 0);

    const month = await (await fetch(`${s.base}/console/api/usage?days=30`, {
      headers: { cookie: s.login.cookie },
    })).json();
    assert.equal(month.days.length, 30);
    assert.equal((await fetch(`${s.base}/console/api/usage?days=10`, {
      headers: { cookie: s.login.cookie },
    })).status, 400);

    const save = await fetch(`${s.base}/console/api/bot/price`, {
      method: 'PATCH',
      headers: {
        cookie: s.login.cookie,
        'x-tide-csrf': s.login.csrf,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inPer1k: 1, outPer1k: 2 }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual((await save.json()).price, { inPer1k: 1, outPer1k: 2 });
    assert.equal((await fetch(`${s.base}/console/api/bot/price`, {
      method: 'PATCH',
      headers: { cookie: s.login.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ inPer1k: 1, outPer1k: 2 }),
    })).status, 403);

    const settings = await fetch(`${s.base}/admin/settings`, {
      headers: { authorization: `Bearer ${s.app.accessToken}` },
    }).then((r) => r.json());
    assert.equal(settings.settings.priceInPer1k, undefined);
    assert.equal(settings.settings.priceOutPer1k, undefined);
  } finally {
    await s.close();
  }
});
