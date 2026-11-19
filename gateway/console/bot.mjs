/** 机器人只读状态 + 人格卡编辑。 */

import { createHash } from 'node:crypto';
import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';
import { wakeConfigSummary } from '../social/wake.mjs';
import { audit } from '../routes/admin-data.mjs';
import { writeConsoleChange } from './http.mjs';
import { silenceView } from './silence.mjs';

const BOT_KEYS = new Set(['name', 'signature', 'personaOverride', 'avatar']);
const AVATAR_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i;

function bad(message) {
  return new ApiError(400, 'bad-request', message);
}

function avatarVersion(avatar) {
  if (!avatar) return null;
  return createHash('sha256').update(String(avatar)).digest('hex').slice(0, 12);
}

export function getBot(ctx) {
  const settings = loadBotSettings(ctx.dbState.db);
  const silence = silenceView(settings);
  return {
    bot: {
      name: settings.aiName || '汐语',
      signature: settings.aiSignature || '',
      hasAvatar: Boolean(settings.aiAvatar),
      avatarVersion: avatarVersion(settings.aiAvatar),
      personaOverride: settings.personaOverride,
      model: settings.model,
      toolProfile: settings.toolProfile,
      modelWired: false,
      toolProfileWired: false,
    },
    runtime: {
      realtimeMode: ctx.realtime?.mode ?? 'legacy',
      streamEnabled: Boolean(ctx.realtime?.streamEnabled),
      wake: settings.defaultWakeConfig,
      wakeSummary: wakeConfigSummary(settings.defaultWakeConfig),
      silence: {
        global: silence.silentUntil || null,
        until: silence.until,
        active: silence.active,
        note: 'global-switch',
      },
    },
    silentUntil: silence.silentUntil,
    send: { bubbleDelayMs: settings.bubbleDelayMs },
    price: {
      inPer1k: settings.priceInPer1k,
      outPer1k: settings.priceOutPer1k,
    },
    limits: settings.perUserLimits,
  };
}

export function getBotAvatar(ctx, res) {
  const avatar = loadBotSettings(ctx.dbState.db).aiAvatar;
  if (!avatar) throw new ApiError(404, 'no-avatar', '还没有头像');
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([\s\S]+)$/i.exec(avatar);
  if (!match) throw new ApiError(404, 'no-avatar', '头像格式不可读');
  const type = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  res.writeHead(200, {
    'content-type': type,
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

export async function patchBot(ctx, req, session) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  for (const key of Object.keys(body)) {
    if (!BOT_KEYS.has(key)) throw bad(`未知字段: ${key}`);
  }

  const patch = {};
  if (Object.hasOwn(body, 'name')) {
    if (body.name === null) {
      patch.aiName = null;
    } else {
      if (typeof body.name !== 'string') throw bad('name 必须是字符串');
      const value = body.name.trim();
      if (!value || value.length > 40) throw bad('昵称必须是 1~40 字');
      patch.aiName = value;
    }
  }
  if (Object.hasOwn(body, 'signature')) {
    if (body.signature === null) {
      patch.aiSignature = null;
    } else {
      if (typeof body.signature !== 'string') throw bad('signature 必须是字符串');
      const value = body.signature.trim();
      if (value.length > 200) throw bad('签名最多 200 字');
      patch.aiSignature = value || null;
    }
  }
  if (Object.hasOwn(body, 'personaOverride')) {
    if (body.personaOverride === null) {
      patch.personaOverride = null;
    } else {
      if (typeof body.personaOverride !== 'string') throw bad('personaOverride 必须是字符串');
      const value = body.personaOverride.trim();
      if (value.length > 4000) throw bad('人格提示词最多 4000 字');
      patch.personaOverride = value || null;
    }
  }
  if (Object.hasOwn(body, 'avatar')) {
    if (body.avatar === null || body.avatar === '') {
      patch.aiAvatar = null;
    } else {
      if (typeof body.avatar !== 'string' || !AVATAR_RE.test(body.avatar)) {
        throw bad('avatar 必须是 data:image/...;base64 字符串');
      }
      if (body.avatar.length > 500_000) throw bad('头像太大（最多 500000 字符）');
      patch.aiAvatar = body.avatar;
    }
  }
  if (Object.keys(patch).length === 0) throw bad('没有可更新的字段');

  const settings = saveBotSettings(ctx.dbState.db, patch);
  const keys = Object.keys(body);
  audit(ctx, session.user.userId, 'settings.update', 'bot_settings', { keys });
  writeConsoleChange(ctx, 'bot.update', 'bot_settings', { keys });
  return { ok: true, ...getBot(ctx), settingsUpdatedAt: settings.updatedAt };
}
