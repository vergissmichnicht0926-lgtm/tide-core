// 手动触发事件表清理：30 天 / 最多 10 万条。
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { pruneEvents } from '../events-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = process.env.TIDE_DB_PATH || path.join(root, 'data', 'gateway.db');
const db = new DatabaseSync(dbPath);
try {
  console.log(JSON.stringify(pruneEvents(db), null, 2));
} finally {
  db.close();
}
