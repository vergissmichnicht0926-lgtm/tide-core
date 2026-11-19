/** 0.22 全局静默：只拦“它自己想说话”，不拦显式发送。 */

import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { audit } from '../routes/admin-data.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';
import { writeConsoleChange } from './http.mjs';

const MAX_SILENCE_MS = 7 * 24 * 60 * 60 * 1000;

function bad(message) {
  return new ApiError(400, 'bad-request', message);
}

function isoOrNull(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

export function silenceView(settings, now = Date.now()) {
  const until = Number(settings.silentUntil) || 0;
  return {
    silentUntil: until,
    until: isoOrNull(until),
    active: until > now,
  };
}

export async function patchSilence(ctx, req, session) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  const keys = Object.keys(body);
  const modes = ['minutes', 'until', 'off'].filter((key) => Object.hasOwn(body, key));
  if (modes.length !== 1) throw bad('minutes / until / off 必须三选一');
  for (const key of keys) {
    if (!['minutes', 'until', 'off'].includes(key)) throw bad(`未知字段: ${key}`);
  }

  const now = Date.now();
  let until = 0;
  let source = modes[0];
  if (source === 'off') {
    if (body.off !== true) throw bad('off 必须是 true');
  } else if (source === 'minutes') {
    const minutes = Number(body.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
      throw bad('minutes 必须是 1~10080 的整数');
    }
    until = now + minutes * 60_000;
  } else {
    if (typeof body.until !== 'string' || !body.until.trim()) {
      throw bad('until 必须是 ISO 时间字符串');
    }
    const parsed = Date.parse(body.until);
    if (!Number.isFinite(parsed) || parsed <= now) throw bad('until 必须在未来');
    if (parsed - now > MAX_SILENCE_MS) throw bad('静默最长 7 天');
    until = parsed;
    source = 'until';
  }

  const settings = saveBotSettings(ctx.dbState.db, { silentUntil: until });
  const detail = { until: isoOrNull(until), source };
  audit(ctx, session.user.userId, 'bot.silence', 'bot_settings', detail);
  writeConsoleChange(ctx, 'bot.silence', 'bot_settings', detail);
  return { ok: true, ...silenceView(settings, now) };
}

export function currentSilence(ctx) {
  return silenceView(loadBotSettings(ctx.dbState.db));
}
