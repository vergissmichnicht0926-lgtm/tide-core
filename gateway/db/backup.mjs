import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 用 SQLite 的 VACUUM INTO 做一致性备份。
 * 目标文件必须不存在；失败时不覆盖已有备份。
 */
export function backupDatabase({ dbPath, destPath }) {
  if (!dbPath || !destPath) throw new Error('dbPath 与 destPath 必填');
  const source = path.resolve(dbPath);
  const dest = path.resolve(destPath);
  if (!fs.existsSync(source)) throw new Error(`源数据库不存在: ${source}`);
  if (fs.existsSync(dest)) throw new Error(`备份目标已存在: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const db = new DatabaseSync(source);
  try {
    const sqlPath = dest.replaceAll('\\', '/').replaceAll("'", "''");
    db.exec(`VACUUM INTO '${sqlPath}'`);
  } finally {
    db.close();
  }

  const verification = verifyBackup(source, dest);
  return {
    path: dest,
    bytes: fs.statSync(dest).size,
    ...verification,
  };
}

export function verifyBackup(sourcePath, backupPath) {
  const source = snapshot(sourcePath);
  const backup = snapshot(backupPath);
  const ok =
    source.integrity === 'ok' &&
    backup.integrity === 'ok' &&
    JSON.stringify(source.conversations) === JSON.stringify(backup.conversations) &&
    source.attachments === backup.attachments;
  return { ok, source: source.summary, backup: backup.summary };
}

function snapshot(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrityRow = db.prepare('PRAGMA integrity_check').get();
    const integrity = Object.values(integrityRow ?? {})[0];
    const conversations = db.prepare(
      `SELECT c.id, c.agent_read_seq,
              (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) AS messages,
              (SELECT COALESCE(MAX(m.seq), 0) FROM message m WHERE m.conversation_id = c.id) AS max_seq
         FROM conversation c
        ORDER BY c.id`,
    ).all();
    const attachments = db.prepare('SELECT COUNT(*) AS n FROM attachment').get().n;
    return {
      integrity,
      conversations,
      attachments,
      summary: {
        conversations: conversations.length,
        messages: conversations.reduce((sum, row) => sum + row.messages, 0),
        attachments,
      },
    };
  } finally {
    db.close();
  }
}
