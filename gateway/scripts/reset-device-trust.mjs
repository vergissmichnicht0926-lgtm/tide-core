#!/usr/bin/env node
/**
 * 管理员账号丢失全部设备时的服务器侧兜底。
 *
 * 用法：
 *   node gateway/scripts/reset-device-trust.mjs <username>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthService } from '../auth/service.mjs';
import { closeDatabase, openDatabase } from '../db/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const username = process.argv[2]?.trim();
if (!username) {
  console.error('用法: node gateway/scripts/reset-device-trust.mjs <username>');
  process.exit(2);
}

const dbPath = path.resolve(process.env.TIDE_DB_PATH || path.join(root, 'data', 'gateway.db'));
const secretPath = path.join(root, 'data', 'jwt-secret.txt');
const secret = process.env.TIDE_JWT_SECRET
  || (fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8').trim() : '');
if (!secret) {
  console.error('缺少 TIDE_JWT_SECRET 或 data/jwt-secret.txt');
  process.exit(2);
}

const state = openDatabase(dbPath);
try {
  if (state.readOnly) throw new Error('数据库只读，拒绝重置设备信任');
  const user = state.db.prepare(
    'SELECT id, username, role FROM users WHERE username = ?',
  ).get(username);
  if (!user) throw new Error(`用户不存在: ${username}`);
  const service = createAuthService({
    db: state.db,
    secret,
    deviceTrustRequired: true,
  });
  const result = service.resetDeviceTrust({
    userId: user.id,
    actorUserId: null,
  });
  console.log(`已重置设备信任: ${user.username} (${user.id}, ${user.role})`);
  console.log(`一次性重绑码: ${result.resetCode}`);
  console.log(`有效期至: ${result.expiresAt}`);
} finally {
  closeDatabase(state);
}
