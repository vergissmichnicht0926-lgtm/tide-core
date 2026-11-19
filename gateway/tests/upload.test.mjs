/**
 * POST /conversations/:id/upload + GET /attachments/:id（App 预览）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

async function makeServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-upload-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    jwtSecret: 'upload-test-secret-upload-test-secret',
    startRebuildWorker: false,
    logger: silent,
    ...options,
  });
  await gateway.authService.createUser({ username: 'u1', password: 'password123' });
  await gateway.authService.createUser({ username: 'u2', password: 'password123' });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;

  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123' }),
    });
    assert.equal(res.status, 200);
    return (await res.json()).accessToken;
  };

  const token1 = await login('u1');
  const token2 = await login('u2');
  const bearer = { authorization: `Bearer ${token1}` };
  const created = await (
    await fetch(`${base}/conversations`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '上传测试' }),
    })
  ).json();

  return {
    dir,
    gateway,
    base,
    bearer,
    bearer2: { authorization: `Bearer ${token2}` },
    conv: created,
    db: gateway.dbState.db,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function multipartBody(boundary, filename, contentType, data) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${contentType}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

async function upload(s, { filename, contentType, data }) {
  const boundary = '----tide-test-boundary';
  return fetch(`${s.base}/conversations/${s.conv.id}/upload`, {
    method: 'POST',
    headers: {
      ...s.bearer,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartBody(boundary, filename, contentType, data),
  });
}

test('multipart 上传：落库、草稿态可预览、可被 agent 读取', async () => {
  const s = await makeServer();
  try {
    const res = await upload(s, {
      filename: 'notes.md',
      contentType: 'text/markdown; charset=utf-8',
      data: '# 标题\n上传成功',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.attachment_id);
    assert.equal(body.name, 'notes.md');
    assert.equal(body.kind, 'file');
    assert.equal(body.media_type, 'text/markdown');
    assert.equal(body.bytes, Buffer.byteLength('# 标题\n上传成功'));

    const row = s.db.prepare('SELECT * FROM attachment WHERE id = ?').get(body.attachment_id);
    assert.equal(row.conversation_id, s.conv.id);
    assert.equal(row.message_id, null);
    assert.equal(row.name, 'notes.md');
    assert.ok(fs.existsSync(row.local_path));
    assert.match(row.local_path, /attachments/);
    assert.equal(row.sha256.length, 64);

    const preview = await fetch(`${s.base}/attachments/${body.attachment_id}`, {
      headers: s.bearer,
    });
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /text\/markdown/);
    assert.equal(await preview.text(), '# 标题\n上传成功');

    const agentToken = s.db.prepare('SELECT agent_token FROM conversation WHERE id = ?')
      .get(s.conv.id).agent_token;
    const agentRead = await fetch(
      `${s.base}/agent/attachments/${body.attachment_id}/content`,
      { headers: { 'x-agent-token': agentToken, 'x-agent-call': '1', 'x-agent-secret': 'test-secret' } },
    );
    assert.equal(agentRead.status, 200);
    assert.equal((await agentRead.json()).text, '# 标题\n上传成功');
  } finally {
    await s.close();
  }
});

test('raw 上传：filename 里的 ../ 被 basename 化，落盘仍在会话目录', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/conversations/${s.conv.id}/upload`, {
      method: 'POST',
      headers: {
        ...s.bearer,
        'content-type': 'text/plain',
        'x-file-name': '../../evil.txt',
      },
      body: 'raw body',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, 'evil.txt');
    const row = s.db.prepare('SELECT local_path FROM attachment WHERE id = ?')
      .get(body.attachment_id);
    const root = path.join(s.gateway.workspaceRoot, 'conversations', s.conv.id, 'attachments');
    assert.equal(path.dirname(row.local_path), root);
    assert.ok(fs.existsSync(row.local_path));
    assert.equal(fs.existsSync(path.join(s.dir, 'evil.txt')), false);
  } finally {
    await s.close();
  }
});

test('中文文件名下载返回合法的 Content-Disposition', async () => {
  const s = await makeServer();
  try {
    const text = '# 中文附件\n下载测试';
    const res = await upload(s, {
      filename: '樱_角色设定_v2.md',
      contentType: 'text/markdown; charset=utf-8',
      data: text,
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.name, '樱_角色设定_v2.md');

    const preview = await fetch(`${s.base}/attachments/${body.attachment_id}`, {
      headers: s.bearer,
    });
    assert.equal(preview.status, 200);
    const disposition = preview.headers.get('content-disposition');
    assert.match(disposition, /^inline; filename="[^"]+"; filename\*=UTF-8''/);
    assert.doesNotMatch(disposition, /[^\x20-\x7e]/);
    assert.equal(await preview.text(), text);
  } finally {
    await s.close();
  }
});

test('multipart 普通字段排在文件前面也能解析', async () => {
  const s = await makeServer();
  try {
    const boundary = '----tide-field-first';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n`
        + 'Content-Type: text/plain\r\n\r\nabc\r\n',
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const res = await fetch(`${s.base}/conversations/${s.conv.id}/upload`, {
      method: 'POST',
      headers: {
        ...s.bearer,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.name, 'a.txt');
    assert.equal(json.bytes, 3);
  } finally {
    await s.close();
  }
});

test('上传大小和会话配额超限明确报错，且不落文件/行', async () => {
  const size = await makeServer({ uploadMaxBytes: 4 });
  try {
    const res = await fetch(`${size.base}/conversations/${size.conv.id}/upload`, {
      method: 'POST',
      headers: { ...size.bearer, 'content-type': 'text/plain', 'x-file-name': 'big.txt' },
      body: '12345',
    });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'attachment-too-large');
    assert.equal(
      size.db.prepare('SELECT COUNT(*) AS n FROM attachment').get().n,
      0,
    );
  } finally {
    await size.close();
  }

  const quota = await makeServer({ conversationMaxBytes: 6 });
  try {
    const first = await fetch(`${quota.base}/conversations/${quota.conv.id}/upload`, {
      method: 'POST',
      headers: { ...quota.bearer, 'content-type': 'text/plain', 'x-file-name': 'a.txt' },
      body: '1234',
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${quota.base}/conversations/${quota.conv.id}/upload`, {
      method: 'POST',
      headers: { ...quota.bearer, 'content-type': 'text/plain', 'x-file-name': 'b.txt' },
      body: '5678',
    });
    assert.equal(second.status, 413);
    assert.equal((await second.json()).error.code, 'attachment-quota-exceeded');
    assert.equal(
      quota.db.prepare('SELECT COUNT(*) AS n FROM attachment').get().n,
      1,
    );
  } finally {
    await quota.close();
  }
});

test('App 预览鉴权：别的用户拿 id 也读不到', async () => {
  const s = await makeServer();
  try {
    const res = await upload(s, {
      filename: 'secret.txt',
      contentType: 'text/plain',
      data: 'secret',
    });
    const body = await res.json();
    const foreign = await fetch(`${s.base}/attachments/${body.attachment_id}`, {
      headers: s.bearer2,
    });
    assert.equal(foreign.status, 404);
  } finally {
    await s.close();
  }
});

test('上传的附件可以在 prompt 里挂上，消息里返回对象元数据', async () => {
  const s = await makeServer();
  try {
    const up = await upload(s, {
      filename: 'photo.png',
      contentType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const att = await up.json();
    assert.equal(att.kind, 'image');

    const prompt = await fetch(`${s.base}/conversations/${s.conv.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '看这张图',
        attachments: [att.attachment_id],
        client_msg_id: 'cm-upload-1',
      }),
    });
    assert.equal(prompt.status, 200);

    const messages = await (
      await fetch(`${s.base}/conversations/${s.conv.id}/messages`, { headers: s.bearer })
    ).json();
    assert.equal(messages.messages.length, 1);
    const attached = messages.messages[0].content.attachments;
    assert.equal(attached.length, 1);
    assert.equal(attached[0].id, att.attachment_id);
    assert.equal(attached[0].name, 'photo.png');
    assert.equal(attached[0].mimeType, 'image/png');
    assert.equal(attached[0].size, 4);
  } finally {
    await s.close();
  }
});

test('图片附件会作为原生 image content block 投给 DSH', async () => {
  const calls = [];
  const dsh = {
    async createWorkspace() { return { workspaceId: 'ws-image' }; },
    async createSession() { return { sessionId: 'session-image' }; },
    async recap() { return { sent: false }; },
    async prompt(sessionId, content) {
      calls.push({ sessionId, content });
      return { requestId: 'req-image' };
    },
    async waitTurnEnd() { return true; },
    async readMessages() { return []; },
  };
  const s = await makeServer({ dsh });
  try {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const up = await upload(s, {
      filename: 'photo.png',
      contentType: 'image/png',
      data: bytes,
    });
    const att = await up.json();
    const prompt = await fetch(`${s.base}/conversations/${s.conv.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '看这张图',
        attachments: [att.attachment_id],
        client_msg_id: 'cm-image-block',
      }),
    });
    assert.equal(prompt.status, 200);
    assert.equal(calls.length, 1);
    const image = calls[0].content.find((block) => block.type === 'image');
    assert.ok(image, 'prompt 里必须有 image block');
    assert.equal(image.mediaType, 'image/png');
    assert.equal(image.name, 'photo.png');
    assert.equal(image.data, bytes.toString('base64'));
  } finally {
    await s.close();
  }
});

test('群聊图片未唤醒时，下一次被叫醒会补送未读图片', async () => {
  const calls = [];
  const dsh = {
    async createWorkspace() { return { workspaceId: 'ws-group-image' }; },
    async createSession() { return { sessionId: 'session-group-image' }; },
    async recap() { return { sent: false }; },
    async prompt(sessionId, content) {
      calls.push({ sessionId, content });
      return { requestId: 'req-group-image' };
    },
    async waitTurnEnd() { return true; },
    async readMessages() { return []; },
  };
  const s = await makeServer({ dsh });
  try {
    const created = await fetch(`${s.base}/conversations`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '图片群', kind: 'group' }),
    });
    const group = await created.json();
    const row = s.gateway.dbState.db.prepare(
      'SELECT wake_config_json FROM conversation WHERE id = ?',
    ).get(group.id);
    const wake = JSON.parse(row.wake_config_json);
    wake.mode = 'diving';
    wake.infinite = true;
    wake.sleepUntil = null;
    wake.batchWindowMs = 1000;
    wake.triggers = {
      atMention: true,
      nameMention: false,
      speakerIds: [],
      keywords: [],
      question: false,
      poke: false,
      anyMessage: false,
      probability: 0,
    };
    // 不走 default 归一化，否则 probability:0 会被 defaultWakeConfig 的 0.05 覆盖。
    wake.confirmedBy = 'test';
    wake.confirmedAt = Date.now();
    s.gateway.dbState.db.prepare(
      'UPDATE conversation SET wake_config_json = ? WHERE id = ?',
    ).run(JSON.stringify(wake), group.id);

    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64',
    );
    const up = await fetch(`${s.base}/conversations/${group.id}/upload`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'image/png', 'x-file-name': 'group.png' },
      body: bytes,
    });
    const att = await up.json();
    const first = await fetch(`${s.base}/conversations/${group.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '',
        attachments: [att.attachment_id],
        client_msg_id: 'cm-group-image-1',
      }),
    });
    const firstBody = await first.json();
    assert.equal(firstBody.wake_scheduled, false);
    assert.equal(calls.length, 0);

    const second = await fetch(`${s.base}/conversations/${group.id}/prompt`, {
      method: 'POST',
      headers: { ...s.bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '@汐语 看刚才的图',
        client_msg_id: 'cm-group-image-2',
      }),
    });
    const secondBody = await second.json();
    assert.equal(secondBody.wake_scheduled, true, JSON.stringify(secondBody));
    for (let i = 0; i < 60 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(calls.length, 1);
    const image = calls[0].content.find((block) => block.type === 'image');
    assert.ok(image, '叫醒时必须补送未读图片');
    assert.equal(image.data, bytes.toString('base64'));
  } finally {
    await s.close();
  }
});
