// OPS-ONLY: requires local DB + JWT secret. Never expose through an HTTP route.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { signJwt } from '../auth/jwt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = process.env.TIDE_DB_PATH || path.join(root, 'data', 'gateway.db');
const secretPath = process.env.TIDE_JWT_SECRET_FILE || path.join(root, 'data', 'jwt-secret.txt');
const userId = process.env.TIDE_VERIFY_USER_ID || process.argv[2];
const secret = process.env.TIDE_JWT_SECRET
  || fs.readFileSync(secretPath, 'utf8').trim();

if (!userId) throw new Error('TIDE_VERIFY_USER_ID 或第一个参数必须提供');
if (!secret) throw new Error('TIDE_JWT_SECRET 或 data/jwt-secret.txt 缺失');

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const device = db.prepare(
    `SELECT d.id
       FROM devices d
       LEFT JOIN trusted_devices t ON t.id = d.trusted_device_id
      WHERE d.user_id = ?
        AND d.revoked_at IS NULL
        AND (d.trusted_device_id IS NULL OR t.revoked_at IS NULL)
      ORDER BY d.last_seen_at DESC
      LIMIT 1`,
  ).get(userId);
  if (!device) throw new Error(`用户 ${userId} 没有可用设备`);
  const token = signJwt(
    { sub: userId, dev: device.id },
    { secret, expiresInSec: 300 },
  );
  process.stdout.write(token);
} finally {
  db.close();
}
