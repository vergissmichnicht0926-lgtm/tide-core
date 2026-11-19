import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../auth/password.mjs';
import { closeDatabase, openDatabase, withTransaction } from '../db/index.mjs';

export async function resetPassword({ db, username, password, keepDeviceId = null, now = new Date() }) {
  if (!username || !password) throw new Error('username / password 必填');
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) throw new Error(`用户不存在: ${username}`);
  if (keepDeviceId) {
    const kept = db.prepare(
      'SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).get(keepDeviceId, user.id);
    if (!kept) throw new Error(`保留设备不存在或已吊销: ${keepDeviceId}`);
  }
  const hash = await hashPassword(password);
  let revokedDevices = 0;
  withTransaction(db, () => {
    const result = db.prepare(
      'UPDATE users SET password_hash = ? WHERE id = ?',
    ).run(hash, user.id);
    if (result.changes !== 1) throw new Error(`用户更新失败: ${username}`);
    const revokedAt = now.toISOString();
    const revoke = keepDeviceId
      ? db.prepare(
          `UPDATE devices SET revoked_at = ?
            WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
        ).run(revokedAt, user.id, keepDeviceId)
      : db.prepare(
          'UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        ).run(revokedAt, user.id);
    revokedDevices = revoke.changes;
  });
  return { ok: true, username, revokedDevices };
}

async function main() {
  const args = process.argv.slice(2);
  const username = args.find((arg) => !arg.startsWith('--'));
  const password = process.env.TIDE_NEW_PASSWORD;
  const keepIndex = args.indexOf('--keep-device');
  const keepDeviceId = keepIndex >= 0 ? args[keepIndex + 1] : null;
  if (!username || !password) {
    console.error(
      '用法: TIDE_NEW_PASSWORD=... node scripts/reset-password.mjs <username> [--keep-device <id>]',
    );
    process.exit(1);
  }

  const dbPath = path.resolve(process.env.TIDE_DB_PATH || './data/gateway.db');
  const state = openDatabase(dbPath);
  try {
    const result = await resetPassword({
      db: state.db,
      username,
      password,
      keepDeviceId,
    });
    console.log(JSON.stringify(result));
  } finally {
    closeDatabase(state);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
