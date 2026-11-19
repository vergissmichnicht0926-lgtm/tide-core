/** 0.23 发送节奏：多气泡间隔。 */

import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { audit } from '../routes/admin-data.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';
import { writeConsoleChange } from './http.mjs';

function bad(message) {
  return new ApiError(400, 'bad-request', message);
}

export async function patchSend(ctx, req, session) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'bubbleDelayMs') throw bad(`未知字段: ${key}`);
  }
  const delayMs = Number(body.bubbleDelayMs);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 3000) {
    throw bad('bubbleDelayMs 必须是 0~3000 的整数');
  }
  const settings = saveBotSettings(ctx.dbState.db, { bubbleDelayMs: delayMs });
  audit(ctx, session.user.userId, 'bot.send', 'bot_settings', { bubbleDelayMs: delayMs });
  writeConsoleChange(ctx, 'bot.send', 'bot_settings', { bubbleDelayMs: delayMs });
  return {
    ok: true,
    bubbleDelayMs: settings.bubbleDelayMs,
    updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : null,
  };
}

export function getSend(ctx) {
  return { bubbleDelayMs: loadBotSettings(ctx.dbState.db).bubbleDelayMs };
}
