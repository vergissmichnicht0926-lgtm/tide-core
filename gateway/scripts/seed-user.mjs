import path from 'node:path';
import { createAuthService } from '../auth/service.mjs';
import { newSecret } from '../auth/jwt.mjs';
import { closeDatabase, openDatabase } from '../db/index.mjs';

const args = process.argv.slice(2);
const username = args[0];
const password = args[1];
const roleIndex = args.indexOf('--role');
const role = roleIndex >= 0 ? args[roleIndex + 1] : 'guest';
if (!username || !password) {
  console.error('用法: node scripts/seed-user.mjs <username> <password> [--role admin|guest]');
  process.exit(1);
}
if (role !== 'admin' && role !== 'guest') {
  console.error('--role 必须是 admin 或 guest');
  process.exit(1);
}

const dbPath = path.resolve(process.env.TIDE_DB_PATH || './data/gateway.db');
const state = openDatabase(dbPath);
try {
  const service = createAuthService({
    db: state.db,
    secret: process.env.TIDE_JWT_SECRET || newSecret(),
  });
  const user = await service.createUser({ username, password, role });
  console.log(JSON.stringify(user));
} finally {
  closeDatabase(state);
}
