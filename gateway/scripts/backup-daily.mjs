import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { runDailyBackup } from '../db/daily-backup.mjs';
import { pruneEvents, writeEvent } from '../events-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = process.env.TIDE_DB_PATH || path.join(root, 'data', 'gateway.db');
const outDir = process.argv[2] || path.join(root, 'data', 'backups', 'daily');
const logPath = process.env.TIDE_BACKUP_LOG || path.join(root, 'data', 'backup.log');
const offsiteEnabled = process.env.TIDE_BACKUP_OFFSITE !== '0';
const keyPath = process.env.TIDE_BACKUP_SCP_KEY
  || path.join(process.env.USERPROFILE || '', '.ssh', 'bot_key');
// 离机备份目标：优先环境变量，其次 data/backup-config.json（data/ 不入版本库），
// 都没有就只做本地备份——开源仓库里不留任何个人服务器地址。
function resolveOffsiteRemote() {
  if (process.env.TIDE_BACKUP_REMOTE) return process.env.TIDE_BACKUP_REMOTE.trim();
  try {
    const cfgPath = path.join(root, 'data', 'backup-config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return typeof cfg.remote === 'string' ? cfg.remote.trim() : '';
  } catch {
    return '';
  }
}

const remote = resolveOffsiteRemote();
const offsite = offsiteEnabled && remote
  ? { keyPath, remote }
  : null;

if (offsite && !fs.existsSync(keyPath)) {
  throw new Error(`SSH key 不存在: ${keyPath}`);
}

try {
  const result = runDailyBackup({ dbPath, outDir, keep: 7, logPath, offsite });
  try {
    const db = new DatabaseSync(dbPath);
    try {
      writeEvent(db, {
        kind: 'backup.ok',
        detail: {
          file: result.backup,
          bytes: result.bytes,
          offsite: Boolean(result.offsite),
        },
      });
      pruneEvents(db);
    } finally {
      db.close();
    }
  } catch {
    // 事件/清理失败不影响备份结果
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  try {
    const db = new DatabaseSync(dbPath);
    try {
      writeEvent(db, {
        level: 'error',
        kind: 'backup.fail',
        detail: { message: String(error?.message ?? error).slice(0, 300) },
      });
    } finally {
      db.close();
    }
  } catch {
    // 数据库不可写时只能靠 stderr
  }
  console.error(error?.stack ?? error);
  process.exit(1);
}
