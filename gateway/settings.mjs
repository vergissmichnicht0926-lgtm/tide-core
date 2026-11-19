/** 单 bot 的全局设置与按天用量。M6.5 只做 admin 写、guests 读不到正文。 */

import { defaultWakeConfig, normalizeWakeConfig } from './social/wake.mjs';

export const DEFAULT_PER_USER_LIMITS = Object.freeze({
  dailyMessages: 500,
  maxConversations: 5,
  uploadMb: 100,
});

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function loadBotSettings(db) {
  const row = db.prepare('SELECT * FROM bot_settings WHERE id = 1').get();
  const limits = { ...DEFAULT_PER_USER_LIMITS, ...parseJson(row?.per_user_limits_json, {}) };
  return {
    aiName: row?.ai_name || null,
    aiSignature: row?.ai_signature || null,
    aiAvatar: row?.ai_avatar || null,
    personaOverride: row?.persona_override || null,
    model: row?.model || null,
    toolProfile: row?.tool_profile || null,
    defaultWakeConfig: row?.default_wake_config_json
      ? normalizeWakeConfig(row.default_wake_config_json)
      : defaultWakeConfig(),
    perUserLimits: {
      dailyMessages: Math.max(1, Number(limits.dailyMessages) || DEFAULT_PER_USER_LIMITS.dailyMessages),
      maxConversations: Math.max(1, Number(limits.maxConversations) || DEFAULT_PER_USER_LIMITS.maxConversations),
      uploadMb: Math.max(1, Number(limits.uploadMb) || DEFAULT_PER_USER_LIMITS.uploadMb),
    },
    silentUntil: Math.max(0, Number(row?.silent_until_ms) || 0),
    bubbleDelayMs: Math.min(3000, Math.max(0, Math.round(Number(row?.bubble_delay_ms) || 0))),
    priceInPer1k: Math.max(0, Number(row?.price_in_per_1k) || 0),
    priceOutPer1k: Math.max(0, Number(row?.price_out_per_1k) || 0),
    updatedAt: Number(row?.updated_at) || 0,
  };
}

export function saveBotSettings(db, patch = {}) {
  const current = loadBotSettings(db);
  const next = {
    aiName: Object.prototype.hasOwnProperty.call(patch, 'aiName')
      ? (patch.aiName == null ? null : String(patch.aiName).trim().slice(0, 40) || null)
      : current.aiName,
    aiSignature: Object.prototype.hasOwnProperty.call(patch, 'aiSignature')
      ? (patch.aiSignature == null
        ? null
        : String(patch.aiSignature).trim().slice(0, 200) || null)
      : current.aiSignature,
    aiAvatar: Object.prototype.hasOwnProperty.call(patch, 'aiAvatar')
      ? (patch.aiAvatar == null
        ? null
        : String(patch.aiAvatar).trim().slice(0, 500000) || null)
      : current.aiAvatar,
    personaOverride: Object.prototype.hasOwnProperty.call(patch, 'personaOverride')
      ? (patch.personaOverride == null ? null : String(patch.personaOverride).trim().slice(0, 4000) || null)
      : current.personaOverride,
    model: Object.prototype.hasOwnProperty.call(patch, 'model')
      ? (patch.model == null ? null : String(patch.model).trim().slice(0, 200) || null)
      : current.model,
    toolProfile: Object.prototype.hasOwnProperty.call(patch, 'toolProfile')
      ? (patch.toolProfile == null ? null : String(patch.toolProfile).trim().slice(0, 100) || null)
      : current.toolProfile,
    defaultWakeConfig: patch.defaultWakeConfig
      ? normalizeWakeConfig({
          ...current.defaultWakeConfig,
          ...patch.defaultWakeConfig,
          triggers: {
            ...current.defaultWakeConfig.triggers,
            ...(patch.defaultWakeConfig.triggers || {}),
          },
          confirmedBy: 'admin',
          confirmedAt: Date.now(),
        })
      : current.defaultWakeConfig,
    perUserLimits: { ...current.perUserLimits, ...(patch.perUserLimits || {}) },
    silentUntil: Object.prototype.hasOwnProperty.call(patch, 'silentUntil')
      ? Math.max(0, Number(patch.silentUntil) || 0)
      : current.silentUntil,
    bubbleDelayMs: Object.prototype.hasOwnProperty.call(patch, 'bubbleDelayMs')
      ? Math.min(3000, Math.max(0, Math.round(Number(patch.bubbleDelayMs) || 0)))
      : current.bubbleDelayMs,
    priceInPer1k: Object.prototype.hasOwnProperty.call(patch, 'priceInPer1k')
      ? Math.max(0, Number(patch.priceInPer1k) || 0)
      : current.priceInPer1k,
    priceOutPer1k: Object.prototype.hasOwnProperty.call(patch, 'priceOutPer1k')
      ? Math.max(0, Number(patch.priceOutPer1k) || 0)
      : current.priceOutPer1k,
  };
  next.perUserLimits.dailyMessages = Math.max(
    1,
    Number(next.perUserLimits.dailyMessages) || DEFAULT_PER_USER_LIMITS.dailyMessages,
  );
  next.perUserLimits.maxConversations = Math.max(
    1,
    Number(next.perUserLimits.maxConversations) || DEFAULT_PER_USER_LIMITS.maxConversations,
  );
  next.perUserLimits.uploadMb = Math.max(
    1,
    Number(next.perUserLimits.uploadMb) || DEFAULT_PER_USER_LIMITS.uploadMb,
  );
  db.prepare(
    `UPDATE bot_settings
        SET ai_name = ?, ai_signature = ?, ai_avatar = ?,
            persona_override = ?, model = ?, tool_profile = ?,
            default_wake_config_json = ?, per_user_limits_json = ?,
            silent_until_ms = ?, bubble_delay_ms = ?,
            price_in_per_1k = ?, price_out_per_1k = ?, updated_at = ?
      WHERE id = 1`,
  ).run(
    next.aiName,
    next.aiSignature,
    next.aiAvatar,
    next.personaOverride,
    next.model,
    next.toolProfile,
    JSON.stringify(next.defaultWakeConfig),
    JSON.stringify(next.perUserLimits),
    next.silentUntil,
    next.bubbleDelayMs,
    next.priceInPer1k,
    next.priceOutPer1k,
    Date.now(),
  );
  return loadBotSettings(db);
}

/** 每日用量按服务器本地日期记，Asia/Shanghai 部署下就是自然日。 */
export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function usageToday(db, userId, day = localDay()) {
  return db
    .prepare(
      `SELECT messages, tokens, turns, chars_in, chars_out
         FROM usage_daily WHERE user_id = ? AND day = ?`,
    )
    .get(userId, day) || {
    messages: 0, tokens: 0, turns: 0, chars_in: 0, chars_out: 0,
  };
}

export function bumpUsageMessages(db, userId, count = 1, day = localDay(), chars = 0) {
  db.prepare(
    `INSERT INTO usage_daily(user_id, day, messages, tokens, chars_in, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id, day)
     DO UPDATE SET messages = messages + excluded.messages,
                   chars_in = chars_in + excluded.chars_in,
                   updated_at = excluded.updated_at`,
  ).run(userId, day, count, Math.max(0, Number(chars) || 0), Date.now());
}

export function bumpUsageAssistant(db, conversationId, chars, day = localDay()) {
  const conv = db.prepare('SELECT user_id FROM conversation WHERE id = ?').get(conversationId);
  if (!conv?.user_id) return;
  const length = Math.max(0, Number(chars) || 0);
  db.prepare(
    `INSERT INTO usage_daily(user_id, day, messages, tokens, chars_out, updated_at)
     VALUES (?, ?, 1, 0, ?, ?)
     ON CONFLICT(user_id, day)
     DO UPDATE SET messages = messages + 1,
                   chars_out = chars_out + excluded.chars_out,
                   updated_at = excluded.updated_at`,
  ).run(conv.user_id, day, length, Date.now());
}

export function bumpUsageTurn(db, userId, day = localDay(), count = 1) {
  db.prepare(
    `INSERT INTO usage_daily(user_id, day, messages, tokens, turns, updated_at)
     VALUES (?, ?, 0, 0, ?, ?)
     ON CONFLICT(user_id, day)
     DO UPDATE SET turns = turns + excluded.turns, updated_at = excluded.updated_at`,
  ).run(userId, day, count, Date.now());
}

/** 配额只数用户自己发的消息，assistant 消息不计入每日额度。 */
export function userMessagesToday(db, userId, day = localDay()) {
  const start = new Date(`${day}T00:00:00`).getTime();
  if (!Number.isFinite(start)) return 0;
  return db.prepare(
    `SELECT COUNT(*) AS n FROM message
      WHERE role = 'user' AND sender_user_id = ?
        AND created_at >= ? AND created_at < ?`,
  ).get(userId, start, start + 24 * 60 * 60 * 1000).n;
}
