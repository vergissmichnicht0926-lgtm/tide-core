/** 管理台 P3：默认唤醒配置与用户配额（写 bot_settings）。 */

import fs from 'node:fs';
import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { loadBotSettings, saveBotSettings } from '../settings.mjs';
import {
  normalizeWakeConfig,
  validateWakeConfigInput,
  wakeConfigSummary,
} from '../social/wake.mjs';
import { audit } from '../routes/admin-data.mjs';

const LIMIT_KEYS = Object.freeze({
  dailyMessages: [1, 100_000],
  maxConversations: [1, 1_000],
  uploadMb: [1, 1_024],
});

function bad(message) {
  return new ApiError(400, 'bad-request', message);
}

function wakeView(settings) {
  const cfg = normalizeWakeConfig(settings.defaultWakeConfig);
  return {
    config: {
      mode: cfg.mode,
      triggers: cfg.triggers,
      batchWindowMs: cfg.batchWindowMs,
      limits: cfg.limits,
      hint: cfg.hint,
    },
    summary: wakeConfigSummary(cfg),
    updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : null,
  };
}

export function getWake(ctx) {
  return wakeView(loadBotSettings(ctx.dbState.db));
}

export async function patchWake(ctx, req, session) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'config') throw bad(`未知字段: ${key}`);
  }
  if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
    throw bad('config 必填');
  }
  const current = loadBotSettings(ctx.dbState.db).defaultWakeConfig;
  const validated = validateWakeConfigInput(body.config, current, {
    kind: 'group',
    now: Date.now(),
  });
  const settings = saveBotSettings(ctx.dbState.db, { defaultWakeConfig: validated });
  audit(ctx, session.user.userId, 'settings.update', 'bot_settings', {
    keys: ['defaultWakeConfig'],
  });
  return { ok: true, ...wakeView(settings) };
}

export async function patchLimits(ctx, req, session) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'limits') throw bad(`未知字段: ${key}`);
  }
  const limits = body.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw bad('limits 必填');
  }
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS[key]) throw bad(`未知配额字段: ${key}`);
  }
  const next = {};
  for (const [key, [min, max]] of Object.entries(LIMIT_KEYS)) {
    const value = Number(limits[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw bad(`${key} 必须是 ${min}~${max} 的整数`);
    }
    next[key] = value;
  }
  const settings = saveBotSettings(ctx.dbState.db, { perUserLimits: next });
  audit(ctx, session.user.userId, 'settings.update', 'bot_settings', {
    keys: ['perUserLimits'],
  });
  return {
    ok: true,
    limits: settings.perUserLimits,
    updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : null,
  };
}

const TOOLS_PATH = new URL('../public/console/tools.json', import.meta.url);
let toolsCache = null;

export function listTools() {
  if (!toolsCache) {
    toolsCache = JSON.parse(fs.readFileSync(TOOLS_PATH, 'utf8'));
  }
  return toolsCache;
}
