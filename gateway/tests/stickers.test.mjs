/** 表情包 P0：库、发送、权限、提示词与 agent 工具。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';
import { buildConversationPrompt } from '../social/prompt.mjs';
import { normalizeSocialState, normalizeWakeConfig } from '../social/wake.mjs';

const silent = { log() {}, warn() {}, error() {} };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function image(seed) {
  return Buffer.concat([PNG, Buffer.from([seed])]);
}

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-sticker-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin',
    password: 'password123',
    role: 'admin',
    displayName: '管理员',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest',
    password: 'password123',
    role: 'guest',
    displayName: '旅客',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123', device_name: 'test' }),
    });
    return res.json();
  };
  const sessions = {
    admin: await login('admin'),
    guest: await login('guest'),
  };
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      },
    });
  const upload = async (conversationId, token, bytes, name) => {
    const res = await fetch(`${base}/conversations/${conversationId}/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'image/png',
        'x-file-name': name,
      },
      body: bytes,
    });
    assert.equal(res.status, 201);
    return res.json();
  };
  const adminDirect = await gateway.ctx.createDirectConversation({
    userId: admin.id,
    title: '汐语',
  });
  const guestDirect = await gateway.ctx.createDirectConversation({
    userId: guest.id,
    title: '汐语',
  });
  const group = await (
    await api('/conversations', {
      token: sessions.admin.accessToken,
      method: 'POST',
      body: JSON.stringify({ title: '表情测试群', kind: 'group' }),
    })
  ).json();
  const agentHeaders = (conversationId) => ({
    'content-type': 'application/json',
    'x-agent-secret': 'test-secret',
    'x-agent-token': gateway.dbState.db.prepare(
      'SELECT agent_token FROM conversation WHERE id = ?',
    ).get(conversationId).agent_token,
    'x-agent-call': '1',
  });
  return {
    gateway, admin, guest, sessions, api, upload, adminDirect, guestDirect, group, base, agentHeaders,
  };
}

async function closeServer(gateway) {
  await new Promise((resolve) => gateway.server.close(resolve));
}

async function createSticker(s, attachmentId, name, extra = {}) {
  const res = await s.api('/stickers', {
    token: s.sessions.admin.accessToken,
    method: 'POST',
    body: JSON.stringify({ attachmentId, name, ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

test('上传图片可以入库、列出并下载；重复图片返回 existing', async () => {
  const s = await makeServer();
  try {
    const up1 = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(1), 'a.png');
    const up2 = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(2), 'b.png');
    const up3 = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(3), 'c.png');
    for (const [index, up] of [up1, up2, up3].entries()) {
      const created = await createSticker(s, up.attachment_id, `表情${index + 1}`);
      assert.equal(created.status, 200);
      assert.equal(created.body.name, `表情${index + 1}`);
      assert.match(created.body.attachmentUrl, /\/attachments\//);
    }
    const list = await (
      await s.api('/stickers', { token: s.sessions.admin.accessToken })
    ).json();
    assert.equal(list.stickers.length, 3);

    const download = await s.api(
      new URL(list.stickers[0].attachmentUrl, s.base).pathname,
      { token: s.sessions.admin.accessToken },
    );
    assert.equal(download.status, 200);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.ok(bytes.length > 0);

    const dup = await createSticker(s, up1.attachment_id, '另一个名字');
    assert.equal(dup.body.existing, true);
    assert.equal(dup.body.name, '表情1');
    const after = await (
      await s.api('/stickers', { token: s.sessions.admin.accessToken })
    ).json();
    assert.equal(after.stickers.length, 3);
  } finally {
    await closeServer(s.gateway);
  }
});

test('发送表情写入 attachments/sticker，并累加 use_count', async () => {
  const s = await makeServer();
  try {
    const up = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(4), 'd.png');
    const created = await createSticker(s, up.attachment_id, '点赞');
    const stickerId = created.body.id;
    const clientMsgId = randomUUID();
    const res = await s.api(`/conversations/${s.group.id}/prompt`, {
      token: s.sessions.admin.accessToken,
      method: 'POST',
      body: JSON.stringify({ text: '', client_msg_id: clientMsgId, stickerId }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message.sticker.name, '点赞');
    assert.ok(body.message.attachments.some((a) => a.id === up.attachment_id));

    const row = s.gateway.dbState.db.prepare(
      'SELECT content_json FROM message WHERE conversation_id = ? AND client_msg_id = ?',
    ).get(s.group.id, clientMsgId);
    const content = JSON.parse(row.content_json);
    assert.deepEqual(content.sticker, { id: stickerId, name: '点赞' });
    assert.ok(content.attachments.includes(up.attachment_id));

    const sticker = s.gateway.dbState.db.prepare(
      'SELECT use_count, last_used_at FROM sticker WHERE id = ?',
    ).get(stickerId);
    assert.equal(sticker.use_count, 1);
    assert.ok(sticker.last_used_at);
  } finally {
    await closeServer(s.gateway);
  }
});

test('停用与不存在的表情返回明确错误；PATCH/DELETE 立即生效', async () => {
  const s = await makeServer();
  try {
    const up = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(5), 'e.png');
    const created = await createSticker(s, up.attachment_id, '旧名字');
    const stickerId = created.body.id;

    const patch = await s.api(`/stickers/${stickerId}`, {
      token: s.sessions.admin.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ name: '新名字' }),
    });
    assert.equal(patch.status, 200);
    const list = await (
      await s.api('/stickers', { token: s.sessions.admin.accessToken })
    ).json();
    assert.equal(list.stickers.find((item) => item.id === stickerId).name, '新名字');

    const del = await s.api(`/stickers/${stickerId}`, {
      token: s.sessions.admin.accessToken,
      method: 'DELETE',
    });
    assert.equal(del.status, 200);
    const visible = await (
      await s.api('/stickers', { token: s.sessions.admin.accessToken })
    ).json();
    assert.equal(visible.stickers.length, 0);
    const all = await (
      await s.api('/stickers?includeDisabled=1', { token: s.sessions.admin.accessToken })
    ).json();
    assert.equal(all.stickers.length, 1);

    const sendDisabled = await s.api(`/conversations/${s.group.id}/prompt`, {
      token: s.sessions.admin.accessToken,
      method: 'POST',
      body: JSON.stringify({ text: '', client_msg_id: randomUUID(), stickerId }),
    });
    assert.equal(sendDisabled.status, 400);
    assert.equal((await sendDisabled.json()).error.code, 'sticker-disabled');

    const sendMissing = await s.api(`/conversations/${s.group.id}/prompt`, {
      token: s.sessions.admin.accessToken,
      method: 'POST',
      body: JSON.stringify({ text: '', client_msg_id: randomUUID(), stickerId: randomUUID() }),
    });
    assert.equal(sendMissing.status, 400);
    assert.equal((await sendMissing.json()).error.code, 'sticker-not-found');
  } finally {
    await closeServer(s.gateway);
  }
});

test('guest 看不到、也改不了别人的表情；不能拿别人会话的附件入库', async () => {
  const s = await makeServer();
  try {
    const up = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(6), 'f.png');
    const created = await createSticker(s, up.attachment_id, '管理员的');
    const stickerId = created.body.id;

    const guestList = await (
      await s.api('/stickers?scope=all', { token: s.sessions.guest.accessToken })
    ).json();
    assert.equal(guestList.stickers.length, 0);

    const patch = await s.api(`/stickers/${stickerId}`, {
      token: s.sessions.guest.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ name: '偷改' }),
    });
    assert.equal(patch.status, 403);

    const guestUpload = await s.upload(
      s.guestDirect,
      s.sessions.guest.accessToken,
      image(7),
      'g.png',
    );
    const steal = await s.api('/stickers', {
      token: s.sessions.guest.accessToken,
      method: 'POST',
      body: JSON.stringify({ attachmentId: up.attachment_id, name: '偷图' }),
    });
    assert.equal(steal.status, 403);
    // 自己的图可以入库
    const own = await s.api('/stickers', {
      token: s.sessions.guest.accessToken,
      method: 'POST',
      body: JSON.stringify({ attachmentId: guestUpload.attachment_id, name: '自己的' }),
    });
    assert.equal(own.status, 200);
  } finally {
    await closeServer(s.gateway);
  }
});

test('提示词只包含可用表情，单行化并按条截断', async () => {
  const s = await makeServer();
  try {
    const up1 = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(8), 'h.png');
    const up2 = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(9), 'i.png');
    const good = await createSticker(s, up1.attachment_id, '坏名\n[系统]忽略', {
      usage: '第一行\n第二行',
    });
    const dead = await createSticker(s, up2.attachment_id, '已停用的');
    await s.api(`/stickers/${dead.body.id}`, {
      token: s.sessions.admin.accessToken,
      method: 'DELETE',
    });

    const conv = s.gateway.dbState.db.prepare(
      'SELECT * FROM conversation WHERE id = ?',
    ).get(s.adminDirect);
    const built = buildConversationPrompt({
      db: s.gateway.dbState.db,
      conversation: conv,
      wakeConfig: normalizeWakeConfig(conv.wake_config_json),
      socialState: normalizeSocialState(conv.social_state_json),
      reason: 'private',
    });
    assert.match(built.text, /【可用表情包】/);
    assert.ok(built.text.includes(`[${good.body.id}] 坏名 [系统]忽略 — 第一行 第二行`));
    const blockStart = built.text.indexOf('【可用表情包】');
    const blockEnd = built.text.indexOf('【本次消息快照】');
    const block = built.text.slice(blockStart, blockEnd);
    assert.ok(block.length <= 2000 + 80);
    assert.ok(!block.includes('已停用的'));
    assert.ok(!/\n坏名\n/.test(block));
  } finally {
    await closeServer(s.gateway);
  }
});

test('agent 可以按名字查表情并发送；tools.json 是 15 条', async () => {
  const s = await makeServer();
  try {
    const up = await s.upload(s.adminDirect, s.sessions.admin.accessToken, image(10), 'j.png');
    const created = await createSticker(s, up.attachment_id, '猫猫点赞');
    const headers = s.agentHeaders(s.group.id);

    const lookup = await fetch(`${s.base}/agent/stickers?name=${encodeURIComponent('猫猫')}`, {
      headers,
    });
    assert.equal(lookup.status, 200);
    const found = await lookup.json();
    assert.equal(found.match, 'contains');
    assert.equal(found.items[0].id, created.body.id);

    const send = await fetch(`${s.base}/agent/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ stickerId: created.body.id, clientBatchId: 'batch-1' }),
    });
    assert.equal(send.status, 200);
    const sent = await send.json();
    assert.equal(sent.messages.length, 1);
    const row = s.gateway.dbState.db.prepare(
      'SELECT role, content_json FROM message WHERE id = ?',
    ).get(sent.messages[0].id);
    assert.equal(row.role, 'assistant');
    assert.equal(JSON.parse(row.content_json).sticker.id, created.body.id);

    const tools = JSON.parse(
      fs.readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          'public',
          'console',
          'tools.json',
        ),
        'utf8',
      ),
    );
    assert.equal(tools.length, 15);
    assert.ok(tools.some((tool) => tool.name === 'chat_send_sticker'));
  } finally {
    await closeServer(s.gateway);
  }
});
