/** 管理台「访问与安全」：审计日志与登录历史（只读）。 */

const AUDIT_FILTERS = Object.freeze({
  all: '',
  login: "WHERE a.action LIKE 'login%'",
  invite: "WHERE a.action LIKE 'invite%'",
  settings: "WHERE a.action LIKE 'settings%'",
  device: "WHERE a.action LIKE 'device%'",
});

function intParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function listAudit(ctx, url) {
  const db = ctx.dbState.db;
  const limit = intParam(url.searchParams.get('limit'), 20, 1, 100);
  const offset = intParam(url.searchParams.get('offset'), 0, 0, 100_000);
  const filter = String(url.searchParams.get('filter') || 'all');
  const where = AUDIT_FILTERS[filter] ?? AUDIT_FILTERS.all;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${where}`).get().n;
  const rows = db.prepare(
    `SELECT a.id, a.action, a.target, a.actor_user_id, a.created_at,
            u.username, u.display_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_user_id
       ${where}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?`,
  ).all(limit, offset);
  return {
    total,
    limit,
    offset,
    filter: where ? filter : 'all',
    rows: rows.map((row) => ({
      id: row.id,
      at: new Date(row.created_at).toISOString(),
      action: row.action,
      actor: row.display_name || row.username || row.actor_user_id,
      target: row.target ?? null,
      result: 'ok',
    })),
  };
}

export function listLoginAttempts(ctx, url) {
  const db = ctx.dbState.db;
  const limit = intParam(url.searchParams.get('limit'), 20, 1, 100);
  const offset = intParam(url.searchParams.get('offset'), 0, 0, 100_000);
  const total = db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n;
  const rows = db.prepare(
    `SELECT id, username, ok, ip, at
       FROM login_attempts
      ORDER BY id DESC
      LIMIT ? OFFSET ?`,
  ).all(limit, offset);
  return {
    total,
    limit,
    offset,
    rows: rows.map((row) => ({
      id: row.id,
      at: row.at,
      username: row.username,
      ok: Boolean(row.ok),
      ip: row.ip ?? null,
    })),
  };
}
