/** 0.25 语音：用户录音消息、外部音频入口、提示词与幂等。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';
import { formatSnapshot } from '../social/prompt.mjs';
import { buildConversationPrompt } from '../social/prompt.mjs';

const silent = { log() {}, warn() {}, error() {} };

function wav(seconds = 1) {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  const out = Buffer.alloc(44 + data.length);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + data.length, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-voice-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gateway.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'u', password: 'password123', role: 'admin',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const app = await gateway.authService.login({
    username: 'u', password: 'password123', deviceName: 'voice-test',
  });
  const id = await gateway.ctx.createDirectConversation({
    userId: admin.id,
    title: '语音测试',
  });
  const agentToken = gateway.dbState.db.prepare(
    'SELECT agent_token FROM conversation WHERE id = ?',
  ).get(id).agent_token;
  return {
    gateway,
    base,
    id,
    admin,
    app,
    agentToken,
    db: gateway.dbState.db,
    async close() {
      gateway.closeSse();
      gateway.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function voicePost(s, body, headers = {}) {
  return fetch(`${s.base}/agent/voice`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('0.25 外部音频：Bearer 入口、落库、幂等与时长', async () => {
  const s = await makeServer();
  try {
    const audio = wav(1).toString('base64');
    const body = {
      conversationId: s.id,
      text: '这是云端合成的一句话',
      audioBase64: audio,
      mimeType: 'audio/wav',
      clientBatchId: 'voice-agent-1',
    };
    const res = await voicePost(s, body, {
      authorization: `Bearer ${s.agentToken}`,
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.ok(out.messageId);
    assert.ok(out.attachmentId);
    assert.ok(out.durationMs >= 900 && out.durationMs <= 1300, String(out.durationMs));

    const attachment = s.db.prepare(
      'SELECT kind, media_type, uploader_user_id FROM attachment WHERE id = ?',
    ).get(out.attachmentId);
    assert.equal(attachment.kind, 'audio');
    assert.equal(attachment.media_type, 'audio/wav');
    assert.equal(attachment.uploader_user_id, null);

    const message = s.db.prepare(
      'SELECT content_json, role FROM message WHERE id = ?',
    ).get(out.messageId);
    const content = JSON.parse(message.content_json);
    assert.equal(message.role, 'assistant');
    assert.equal(content.text, '这是云端合成的一句话');
    assert.equal(content.voice.durationMs, out.durationMs);
    assert.deepEqual(content.attachments, [out.attachmentId]);

    const again = await voicePost(s, body, {
      authorization: `Bearer ${s.agentToken}`,
    });
    assert.equal(again.status, 200);
    const duplicate = await again.json();
    assert.equal(duplicate.messageId, out.messageId);
    assert.equal(duplicate.duplicated, true);
    assert.equal(
      s.db.prepare("SELECT COUNT(*) AS n FROM message WHERE conversation_id = ? AND role = 'assistant'")
        .get(s.id).n,
      1,
    );
  } finally {
    await s.close();
  }
});

test('0.25 用户语音：上传 audio 附件后 text 可为空', async () => {
  const s = await makeServer();
  try {
    const bytes = wav(1);
    const upload = await fetch(`${s.base}/conversations/${s.id}/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.app.accessToken}`,
        'content-type': 'audio/mp4',
        'x-file-name': 'voice.m4a',
      },
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(uploaded.kind, 'audio');

    const prompt = await fetch(`${s.base}/conversations/${s.id}/prompt`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.app.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: '',
        attachments: [uploaded.attachment_id],
        voice: { durationMs: 3200 },
        client_msg_id: 'voice-user-1',
      }),
    });
    assert.equal(prompt.status, 200);
    const message = s.db.prepare(
      `SELECT content_json FROM message
        WHERE conversation_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
    ).get(s.id);
    const content = JSON.parse(message.content_json);
    assert.equal(content.text, '');
    assert.equal(content.voice.durationMs, 3200);
    assert.deepEqual(content.attachments, [uploaded.attachment_id]);
  } finally {
    await s.close();
  }
});

test('0.25 语音校验：mime、base64、大小、会话与提示词', async () => {
  const s = await makeServer();
  try {
    const headers = { authorization: `Bearer ${s.agentToken}` };
    const base = {
      conversationId: s.id,
      text: '校验',
      audioBase64: wav(1).toString('base64'),
      mimeType: 'audio/wav',
    };
    assert.equal((await voicePost(s, { ...base, mimeType: 'text/plain' }, headers)).status, 400);
    assert.equal((await voicePost(s, { ...base, audioBase64: '%%%' }, headers)).status, 400);
    assert.equal((await voicePost(s, { ...base, audioBase64: Buffer.alloc(3 * 1024 * 1024).toString('base64') }, headers)).status, 413);
    assert.equal((await voicePost(s, { ...base, conversationId: 'conv_other' }, headers)).status, 403);
    assert.equal((await voicePost(s, base)).status, 401);

    const ok = await voicePost(s, {
      ...base,
      text: '带原文的语音',
      clientBatchId: 'voice-prompt-1',
    }, headers);
    assert.equal(ok.status, 200);
    const rows = s.db.prepare(
      `SELECT seq, role, content_json, created_at, wake_reason, sender_name, sender_user_id
         FROM message WHERE conversation_id = ? ORDER BY seq`,
    ).all(s.id);
    assert.match(formatSnapshot(rows, 'direct'), /［语音 1\.0 秒］带原文的语音/);
    const conversation = s.db.prepare('SELECT * FROM conversation WHERE id = ?').get(s.id);
    const prompt = buildConversationPrompt({
      db: s.db,
      conversation,
      wakeConfig: JSON.parse(conversation.wake_config_json),
      socialState: {},
      reason: null,
    });
    assert.match(prompt.text, /语音消息你听不到内容/);
  } finally {
    await s.close();
  }
});
