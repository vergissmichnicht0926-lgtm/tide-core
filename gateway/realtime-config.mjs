import { createHash } from 'node:crypto';

function envFlag(name) {
  const value = String(process.env[name] ?? '').toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const STREAM_REPLAY_LIMIT = positiveInteger(
  process.env.TIDE_STREAM_REPLAY_LIMIT,
  200,
);

export function parseRealtimeConfig(options = {}) {
  const raw = options.realtime ?? {};
  const modeRaw = raw.mode ?? process.env.TIDE_REALTIME ?? 'legacy';
  const mode = ['legacy', 'user', 'auto'].includes(String(modeRaw).toLowerCase())
    ? String(modeRaw).toLowerCase()
    : 'legacy';
  const userIdsRaw = raw.userIds ?? process.env.TIDE_REALTIME_USER_IDS ?? '';
  const userIds = Array.isArray(userIdsRaw)
    ? userIdsRaw.map(String).filter(Boolean)
    : String(userIdsRaw).split(',').map((value) => value.trim()).filter(Boolean);
  const percentRaw = raw.percent ?? process.env.TIDE_REALTIME_PERCENT ?? 0;
  const parsedPercent = Number(percentRaw);
  const percent = Number.isFinite(parsedPercent)
    ? Math.min(100, Math.max(0, parsedPercent))
    : 0;
  const streamEnabled = raw.streamEnabled ?? envFlag('TIDE_REALTIME_STREAM_ENABLED');
  return { mode, userIds, percent, streamEnabled };
}

export function realtimeModeForUser(realtime, userId) {
  // P0-1 还没有 /stream；没显式启用时，服务端自己锁在 legacy。
  if (!realtime.streamEnabled) return 'legacy';
  if (realtime.mode === 'user') return 'user';
  if (realtime.mode === 'legacy') return 'legacy';
  if (realtime.userIds.includes(String(userId))) return 'user';
  const bucket = createHash('sha256')
    .update(String(userId))
    .digest()
    .readUInt32BE(0) % 100;
  return bucket < realtime.percent ? 'user' : 'legacy';
}
