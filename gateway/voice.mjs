/** 语音消息：时长校验、外部音频落库与 ffprobe 量时长。 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nextSeq, nowMs, withTransaction } from './db/index.mjs';
import {
  assertReplyTarget,
  parseContent,
  publishAssistantMessages,
} from './messages.mjs';
import { bumpUsageAssistant, localDay } from './settings.mjs';

export const MIN_VOICE_MS = 1000;
export const MAX_VOICE_MS = 60_000;
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;

function audioError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function normalizeVoice(raw) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw audioError(400, 'bad-request', 'voice 必须是对象');
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'durationMs') throw audioError(400, 'bad-request', `未知 voice 字段: ${key}`);
  }
  const durationMs = Number(raw.durationMs);
  if (!Number.isInteger(durationMs)
    || durationMs < MIN_VOICE_MS
    || durationMs > MAX_VOICE_MS) {
    throw audioError(400, 'bad-request', 'voice.durationMs 必须是 1000~60000 的整数');
  }
  return { durationMs };
}

export function decodeAudioBase64(value, { maxBytes = MAX_VOICE_BYTES } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw audioError(400, 'audio-invalid', 'audioBase64 不能为空');
  }
  const normalized = value.replace(/\s+/g, '');
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw audioError(400, 'audio-invalid', 'audioBase64 不是合法 base64');
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== normalized) {
    throw audioError(400, 'audio-invalid', 'audioBase64 不是合法 base64');
  }
  if (bytes.length > maxBytes) {
    throw audioError(413, 'audio-too-large', `音频不能超过 ${maxBytes} 字节`);
  }
  return bytes;
}

export function probeDurationMs(file) {
  try {
    const result = spawnSync(
      process.env.FFPROBE_PATH || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { encoding: 'utf8', timeout: 8_000, windowsHide: true },
    );
    if (result.status !== 0) return 0;
    const seconds = Number(String(result.stdout || '').trim());
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 1000);
  } catch {
    return 0;
  }
}

function audioExtension(mimeType) {
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('webm')) return 'webm';
  return 'bin';
}

function batchHash(text, mimeType, audioSha, replyTo) {
  return createHash('sha256')
    .update(JSON.stringify({
      text,
      mimeType,
      audioSha,
      replyTo: replyTo ?? null,
    }))
    .digest('hex')
    .slice(0, 32);
}

function duplicateView(db, conversationId, messageId) {
  const row = db.prepare(
    'SELECT id, seq, content_json FROM message WHERE id = ? AND conversation_id = ?',
  ).get(messageId, conversationId);
  if (!row) return null;
  const content = parseContent(row.content_json);
  const ids = Array.isArray(content?.attachments) ? content.attachments : [];
  return {
    ok: true,
    messageId: row.id,
    seq: row.seq,
    attachmentId: ids[0] ?? null,
    durationMs: Number(content?.voice?.durationMs) || 0,
    duplicated: true,
  };
}

export async function storeAgentVoice(ctx, conversation, body) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > 500) {
    throw audioError(400, 'audio-invalid', 'text 必须是 1~500 字');
  }
  const mimeType = String(body.mimeType || '').split(';')[0].trim().toLowerCase();
  if (!mimeType.startsWith('audio/')) {
    throw audioError(400, 'audio-invalid', 'mimeType 必须是 audio/*');
  }
  const bytes = decodeAudioBase64(body.audioBase64);
  const audioSha = createHash('sha256').update(bytes).digest('hex');
  const replyTo = assertReplyTarget(
    ctx.dbState.db,
    conversation.id,
    body.replyToMessageId,
  );
  const batchId = body.clientBatchId ? String(body.clientBatchId).slice(0, 200) : null;
  const hash = batchHash(text, mimeType, audioSha, replyTo);

  if (batchId) {
    const prev = ctx.dbState.db.prepare(
      `SELECT payload_hash, message_ids_json FROM message_batch
        WHERE conversation_id = ? AND client_batch_id = ?`,
    ).get(conversation.id, batchId);
    if (prev) {
      if (prev.payload_hash !== hash) {
        throw audioError(409, 'batch-conflict', 'clientBatchId 已被另一份 payload 使用');
      }
      let ids = [];
      try {
        const parsed = JSON.parse(prev.message_ids_json);
        if (Array.isArray(parsed)) ids = parsed;
      } catch {
        // 空批次
      }
      const duplicate = ids.length ? duplicateView(ctx.dbState.db, conversation.id, ids[0]) : null;
      if (duplicate) return duplicate;
      throw audioError(409, 'batch-in-flight', '这个 clientBatchId 还在处理中');
    }
  }

  const used = ctx.dbState.db.prepare(
    'SELECT COALESCE(SUM(bytes), 0) AS n FROM attachment WHERE conversation_id = ?',
  ).get(conversation.id).n;
  if (used + bytes.length > ctx.conversationMaxBytes) {
    throw audioError(413, 'audio-too-large', '这个会话的附件空间已满');
  }

  let durationMs = 0;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-voice-'));
  const temp = path.join(tempDir, `audio.${audioExtension(mimeType)}`);
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    durationMs = probeDurationMs(temp);
  } catch {
    durationMs = 0;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
  if (durationMs < MIN_VOICE_MS || durationMs > MAX_VOICE_MS) {
    const fallback = Number(body.durationMs);
    durationMs = Number.isInteger(fallback) ? fallback : 0;
  }
  if (durationMs < MIN_VOICE_MS || durationMs > MAX_VOICE_MS) {
    throw audioError(400, 'audio-invalid', '量不出有效时长，请提供 1000~60000 的 durationMs');
  }

  const attachmentId = randomUUID();
  const messageId = randomUUID();
  const dir = path.join(
    ctx.workspaceRoot,
    'conversations',
    conversation.id,
    'attachments',
  );
  const localPath = path.join(dir, attachmentId);
  const name = `voice-${attachmentId.slice(0, 8)}.${audioExtension(mimeType)}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localPath, bytes, { flag: 'wx' });
  } catch (error) {
    try { fs.rmSync(localPath, { force: true }); } catch {}
    throw audioError(500, 'audio-store-failed', `音频落盘失败：${error.message}`);
  }

  const content = JSON.stringify({
    type: 'text',
    text,
    attachments: [attachmentId],
    voice: { durationMs },
    ...(replyTo ? { replyToMessageId: replyTo } : {}),
  });
  try {
    withTransaction(ctx.dbState.db, () => {
      const now = nowMs();
      ctx.dbState.db.prepare(
        `INSERT INTO attachment
           (id, conversation_id, message_id, kind, name, media_type, bytes, sha256,
            local_path, remote_path, uploader_user_id, created_at)
         VALUES (?, ?, NULL, 'audio', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(
        attachmentId,
        conversation.id,
        name,
        mimeType,
        bytes.length,
        audioSha,
        localPath,
        now,
      );
      const seq = nextSeq(ctx.dbState.db, conversation.id);
      ctx.dbState.db.prepare(
        `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq)
         VALUES (?, ?, 'assistant', ?, ?, ?)`,
      ).run(messageId, conversation.id, content, now, seq);
      ctx.dbState.db.prepare(
        'UPDATE attachment SET message_id = ? WHERE id = ?',
      ).run(messageId, attachmentId);
      ctx.dbState.db.prepare(
        'UPDATE conversation SET updated_at = ?, summary = ? WHERE id = ?',
      ).run(now, text.slice(0, 80), conversation.id);
      if (batchId) {
        ctx.dbState.db.prepare(
          `INSERT INTO message_batch
             (conversation_id, client_batch_id, payload_hash, message_ids_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(conversation.id, batchId, hash, JSON.stringify([messageId]), now);
      }
      bumpUsageAssistant(
        ctx.dbState.db,
        conversation.id,
        text.length,
        localDay(new Date(now)),
      );
    });
  } catch (error) {
    try { fs.rmSync(localPath, { force: true }); } catch {}
    if (error?.status) throw error;
    throw audioError(500, 'audio-store-failed', `音频入库失败：${error.message}`);
  }

  const row = ctx.dbState.db.prepare(
    'SELECT id, seq FROM message WHERE id = ?',
  ).get(messageId);
  publishAssistantMessages(ctx, conversation.id, [row]);
  return {
    ok: true,
    messageId,
    seq: row.seq,
    attachmentId,
    durationMs,
    duplicated: false,
  };
}
