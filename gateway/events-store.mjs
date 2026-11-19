/**
 * 结构化事件：管理台总览/排障用。
 * 写失败不能影响主请求，所以对外只暴露永不抛的 writeEvent。
 */

export function writeEvent(db, { level = 'info', kind, conversationId = null, detail = null } = {}) {
  try {
    if (!kind) return;
    const text = detail == null
      ? null
      : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 2000);
    db.prepare(
      `INSERT INTO event_log (at, level, kind, conversation_id, detail)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(new Date().toISOString(), String(level), String(kind), conversationId, text);
  } catch {
    // 事件表坏了/锁了都不该把消息或请求带崩
  }
}

/** 保留 30 天 / 最多 10 万条；由每日备份任务调用，也可手动跑。 */
export function pruneEvents(db, { days = 30, maxRows = 100_000 } = {}) {
  const before = db.prepare('SELECT COUNT(*) AS n FROM event_log').get().n;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM event_log WHERE at < ?').run(cutoff);
  const edge = db.prepare(
    'SELECT id FROM event_log ORDER BY id DESC LIMIT 1 OFFSET ?',
  ).get(maxRows);
  if (edge) db.prepare('DELETE FROM event_log WHERE id <= ?').run(edge.id);
  const after = db.prepare('SELECT COUNT(*) AS n FROM event_log').get().n;
  return { before, after, deleted: Number(before) - Number(after) };
}
