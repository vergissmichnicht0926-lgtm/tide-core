import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDatabase } from '../db/backup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = process.env.TIDE_DB_PATH || path.join(root, 'data', 'gateway.db');
const outDir = process.argv[2] || path.join(root, 'data', 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destPath = path.join(outDir, `tide-${stamp}.db`);

if (!fs.existsSync(dbPath)) {
  console.error(`源数据库不存在: ${dbPath}`);
  process.exit(1);
}

const result = backupDatabase({ dbPath, destPath });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  console.error('备份校验失败');
  process.exit(1);
}
