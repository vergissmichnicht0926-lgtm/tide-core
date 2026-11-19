import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyPassword } from '../auth/password.mjs';
import { closeDatabase, openDatabase } from '../db/index.mjs';
import { resetPassword } from '../scripts/reset-password.mjs';

test('重置口令与吊销设备在同一事务，可保留指定设备', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-reset-password-'));
  const state = openDatabase(path.join(dir, 'gw.db'));
  try {
    const now = '2026-11-12T00:00:00.000Z';
    state.db.prepare(
      `INSERT INTO users(id, username, password_hash, role, display_name, created_at)
       VALUES ('u1', 'owner', 'old', 'admin', 'Owner', ?)`,
    ).run(now);
    for (const id of ['d1', 'd2', 'd3']) {
      state.db.prepare(
        `INSERT INTO devices(id, user_id, name, refresh_hash, created_at, expires_at, revoked_at)
         VALUES (?, 'u1', ?, ?, ?, ?, ?)`,
      ).run(id, id, `hash-${id}`, now, now, id === 'd3' ? now : null);
    }

    const result = await resetPassword({
      db: state.db,
      username: 'owner',
      password: 'new-password',
      keepDeviceId: 'd1',
      now: new Date('2026-11-12T01:00:00.000Z'),
    });
    assert.deepEqual(result, { ok: true, username: 'owner', revokedDevices: 1 });

    const user = state.db.prepare('SELECT password_hash FROM users WHERE id = ?').get('u1');
    assert.equal(await verifyPassword('new-password', user.password_hash), true);
    const devices = state.db.prepare(
      'SELECT id, revoked_at FROM devices ORDER BY id',
    ).all();
    assert.equal(devices[0].revoked_at, null);
    assert.equal(devices[1].revoked_at, '2026-11-12T01:00:00.000Z');
    assert.equal(devices[2].revoked_at, now);

    const again = await resetPassword({
      db: state.db,
      username: 'owner',
      password: 'another-password',
      now: new Date('2026-11-12T02:00:00.000Z'),
    });
    assert.equal(again.revokedDevices, 1);
    assert.ok(
      state.db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('d1').revoked_at,
    );
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
