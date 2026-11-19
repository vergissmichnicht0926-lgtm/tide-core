/** P6.1 管理台：某个会话自己的唤醒配置。 */

import { ApiError } from '../auth/errors.mjs';
import { nowMs } from '../db/index.mjs';
import { readJson } from '../http.mjs';
import { audit } from '../routes/admin-data.mjs';
import { loadBotSettings } from '../settings.mjs';
import {
  normalizeWakeConfig,
  validateWakeConfigInput,
  wakeConfigSummary,
} from '../social/wake.mjs';
import { writeConsoleChange } from './http.mjs';

// 这些字段由网关在投递/重置时维护，控制台只能读，不能写。
const MANAGED_FIELDS = Object.freeze([
  'sleepUntil',
  'lastWakeAt',
  'wakeCount',
  'confirmedAt',
  'confirmedBy',
]);
function bad(message) {
  return new ApiError(400, 'bad-request', message);
}

function configView(cfg) {
  return {
    mode: cfg.mode,
    triggers: {
      atMention: cfg.triggers.atMention,
      nameMention: cfg.triggers.nameMention,
      speakerIds: [...cfg.triggers.speakerIds],
      keywords: [...cfg.triggers.keywords],
      question: cfg.triggers.question,
      poke: cfg.triggers.poke,
      anyMessage: cfg.triggers.anyMessage,
      probability: cfg.triggers.probability,
    },
    batchWindowMs: cfg.batchWindowMs,
    limits: { ...cfg.limits },
    hint: cfg.hint,
  };
}

// infinite 不出现在接口的 config 里，但“与默认值相同”必须把它算进去。
function comparable(cfg) {
  return { ...configView(cfg), infinite: cfg.infinite !== false };
}

function sleepUntilMs(cfg) {
  if (cfg.infinite || !cfg.sleepUntil) return 0;
  const ms = Date.parse(cfg.sleepUntil);
  return Number.isFinite(ms) ? ms : 0;
}

function loadConversation(ctx, conversationId) {
  const row = ctx.dbState.db.prepare(
    `SELECT id, title, kind, wake_config_json
       FROM conversation
      WHERE id = ? AND deleted_at IS NULL`,
  ).get(conversationId);
  if (!row) throw new ApiError(404, 'conversation-not-found', '会话不存在');
  return row;
}

function buildView(ctx, row, cfg = normalizeWakeConfig(row.wake_config_json)) {
  const defaults = normalizeWakeConfig(loadBotSettings(ctx.dbState.db).defaultWakeConfig);
  return {
    ok: true,
    conversationId: row.id,
    title: row.title,
    kind: row.kind,
    config: configView(cfg),
    sleepUntil: sleepUntilMs(cfg),
    summary: wakeConfigSummary(cfg),
    defaults: configView(defaults),
    matchesDefaults: JSON.stringify(comparable(cfg)) === JSON.stringify(comparable(defaults)),
  };
}

function writeWake(ctx, conversationId, cfg) {
  ctx.dbState.db.prepare(
    'UPDATE conversation SET wake_config_json = ?, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify(cfg), nowMs(), conversationId);
}

export function getConversationWake(ctx, conversationId) {
  return buildView(ctx, loadConversation(ctx, conversationId));
}

export async function patchConversationWake(ctx, req, session, conversationId) {
  const body = await readConfigBody(req);
  const managed = MANAGED_FIELDS.filter((key) => Object.hasOwn(body.config, key));
  if (managed.length > 0) {
    throw bad(`${managed.join('、')} 由网关维护，不能通过控制台修改`);
  }
  const row = loadConversation(ctx, conversationId);
  const current = normalizeWakeConfig(row.wake_config_json);
  const cfg = validateWakeConfigInput(body.config, current, {
    kind: row.kind,
    now: Date.now(),
  });
  // 控制台写入不是 AI 自己确认的配置，标成 admin 便于排障。
  cfg.confirmedBy = 'admin';
  cfg.confirmedAt = Date.now();
  writeWake(ctx, conversationId, cfg);

  const changed = Object.keys(body.config);
  audit(ctx, session.user.userId, 'conversation.wake.update', conversationId, { changed });
  writeConsoleChange(ctx, 'conversation.wake.update', conversationId, { changed });
  return buildView(ctx, row, cfg);
}

export function resetConversationWake(ctx, session, conversationId) {
  const row = loadConversation(ctx, conversationId);
  const defaults = normalizeWakeConfig(loadBotSettings(ctx.dbState.db).defaultWakeConfig);
  writeWake(ctx, conversationId, defaults);

  audit(ctx, session.user.userId, 'conversation.wake.reset', conversationId, {});
  writeConsoleChange(ctx, 'conversation.wake.reset', conversationId, {});
  return buildView(ctx, row, defaults);
}

async function readConfigBody(req) {
  const body = await readJsonObject(req);
  for (const key of Object.keys(body)) {
    if (key !== 'config') throw bad(`未知字段: ${key}`);
  }
  const config = body.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw bad('config 必填');
  }
  return { config };
}

async function readJsonObject(req) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  return body;
}
