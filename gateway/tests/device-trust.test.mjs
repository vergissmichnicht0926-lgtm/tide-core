import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };

function makeDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKey: der.toString('base64'),
    fingerprint: createHash('sha256').update(der).digest('hex'),
    privateKey,
  };
}

function signatureFor(key, payload) {
  return sign('sha256', Buffer.from(payload, 'utf8'), key.privateKey).toString('base64');
}

async function makeServer({ deviceTrustRequired = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-device-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    publicBaseUrl: 'https://tide.example/tide',
    deviceTrustRequired,
    jwtSecret: 'device-test-secret-device-test-secret',
    startRebuildWorker: false,
    startSocial: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin',
    password: 'password123',
    role: 'admin',
    displayName: '管理员',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      },
    });
  return {
    dir,
    gateway,
    db: gateway.dbState.db,
    base,
    admin,
    api,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function challenge(s, username, key, purpose = 'login') {
  const res = await s.api('/auth/device/challenge', {
    method: 'POST',
    body: JSON.stringify({
      username,
      key_fingerprint: key.fingerprint,
      purpose,
    }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function loginWithKey(s, username, password, key, extra = {}) {
  const challengeBody = await challenge(s, username, key, extra.purpose || 'login');
  const res = await s.api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      device_name: extra.deviceName || 'phone',
      device_public_key: key.publicKey,
      key_fingerprint: key.fingerprint,
      challenge_id: challengeBody.challengeId,
      signature: signatureFor(key, challengeBody.payload),
      ...(extra.resetCode ? { reset_code: extra.resetCode } : {}),
    }),
  });
  return { res, body: await res.json(), challenge: challengeBody };
}

async function loginAdmin(s) {
  const reset = s.gateway.authService.resetDeviceTrust({ userId: s.admin.id });
  const key = makeDeviceKey();
  const result = await loginWithKey(s, 'admin', 'password123', key, {
    resetCode: reset.resetCode,
    deviceName: 'admin phone',
  });
  assert.equal(result.res.status, 200);
  return { key, token: result.body.accessToken, resetCode: reset.resetCode };
}

test('首次注册绑定设备；同密钥直接登录，新设备必须审批', async () => {
  const s = await makeServer();
  try {
    const admin = await loginAdmin(s);
    const invite = await (await s.api('/admin/invites', {
      token: admin.token,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', expiresInMinutes: 60, maxUses: 2 }),
    })).json();

    const guestKey = makeDeviceKey();
    const regChallenge = await challenge(s, 'guest1', guestKey, 'register');
    const regRes = await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: invite.invite.code,
        username: 'guest1',
        password: 'password123',
        device_name: 'guest phone',
        device_public_key: guestKey.publicKey,
        key_fingerprint: guestKey.fingerprint,
        challenge_id: regChallenge.challengeId,
        signature: signatureFor(guestKey, regChallenge.payload),
      }),
    });
    assert.equal(regRes.status, 201);
    const reg = await regRes.json();
    assert.ok(reg.accessToken);
    assert.ok(reg.trustedDeviceId);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ? AND revoked_at IS NULL')
        .get(reg.userId).n,
      1,
    );

    const sameDevice = await loginWithKey(s, 'guest1', 'password123', guestKey, {
      deviceName: 'guest phone',
    });
    assert.equal(sameDevice.res.status, 200);
    assert.ok(sameDevice.body.accessToken);

    const secondKey = makeDeviceKey();
    const pending = await loginWithKey(s, 'guest1', 'password123', secondKey, {
      deviceName: 'tablet',
    });
    assert.equal(pending.res.status, 202);
    assert.equal(pending.body.approvalRequired, true);
    assert.ok(pending.body.approvalId);
    assert.ok(pending.body.approvalToken);
    assert.match(pending.body.verificationCode, /^\d{6}$/);
    assert.equal(pending.body.accessToken, undefined);

    const list = await (await s.api('/auth/device-approvals', {
      token: sameDevice.body.accessToken,
    })).json();
    assert.equal(list.approvals.length, 1);
    assert.equal(list.approvals[0].name, 'tablet');

    const wrongCode = pending.body.verificationCode === '000000' ? '000001' : '000000';
    const wrong = await s.api(`/auth/device-approvals/${pending.body.approvalId}/approve`, {
      token: sameDevice.body.accessToken,
      method: 'POST',
      body: JSON.stringify({ verification_code: wrongCode }),
    });
    assert.equal(wrong.status, 403);

    const approved = await s.api(`/auth/device-approvals/${pending.body.approvalId}/approve`, {
      token: sameDevice.body.accessToken,
      method: 'POST',
      body: JSON.stringify({ verification_code: pending.body.verificationCode }),
    });
    assert.equal(approved.status, 200);
    const duplicate = await s.api(`/auth/device-approvals/${pending.body.approvalId}/approve`, {
      token: sameDevice.body.accessToken,
      method: 'POST',
      body: JSON.stringify({ verification_code: pending.body.verificationCode }),
    });
    assert.equal(duplicate.status, 409);

    const status = await (await s.api(
      `/auth/device-approvals/${pending.body.approvalId}/status?token=${encodeURIComponent(pending.body.approvalToken)}`,
    )).json();
    assert.equal(status.status, 'approved');
    assert.ok(status.accessToken);
    assert.ok(status.refreshToken);

    const me = await s.api('/auth/me', { token: status.accessToken });
    assert.equal(me.status, 200);
  } finally {
    await s.close();
  }
});

test('拒绝新设备；管理员重置生成一次性重绑码', async () => {
  const s = await makeServer();
  try {
    const admin = await loginAdmin(s);
    const invite = await (await s.api('/admin/invites', {
      token: admin.token,
      method: 'POST',
      body: JSON.stringify({ kind: 'bot', expiresInMinutes: 60, maxUses: 1 }),
    })).json();
    const guestKey = makeDeviceKey();
    const regChallenge = await challenge(s, 'guest2', guestKey, 'register');
    const reg = await (await s.api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        code: invite.invite.code,
        username: 'guest2',
        password: 'password123',
        device_name: 'guest phone',
        device_public_key: guestKey.publicKey,
        key_fingerprint: guestKey.fingerprint,
        challenge_id: regChallenge.challengeId,
        signature: signatureFor(guestKey, regChallenge.payload),
      }),
    })).json();

    const stranger = makeDeviceKey();
    const pending = await loginWithKey(s, 'guest2', 'password123', stranger);
    assert.equal(pending.res.status, 202);
    const rejected = await s.api(`/auth/device-approvals/${pending.body.approvalId}/reject`, {
      token: reg.accessToken,
      method: 'POST',
      body: '{}',
    });
    assert.equal(rejected.status, 200);
    const status = await (await s.api(
      `/auth/device-approvals/${pending.body.approvalId}/status?token=${encodeURIComponent(pending.body.approvalToken)}`,
    )).json();
    assert.equal(status.status, 'rejected');

    const bruteKey = makeDeviceKey();
    const brute = await loginWithKey(s, 'guest2', 'password123', bruteKey);
    assert.equal(brute.res.status, 202);
    const bruteWrong = brute.body.verificationCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) {
      const failed = await s.api(`/auth/device-approvals/${brute.body.approvalId}/approve`, {
        token: reg.accessToken,
        method: 'POST',
        body: JSON.stringify({ verification_code: bruteWrong }),
      });
      assert.equal(failed.status, 403);
    }
    const fifth = await s.api(`/auth/device-approvals/${brute.body.approvalId}/approve`, {
      token: reg.accessToken,
      method: 'POST',
      body: JSON.stringify({ verification_code: bruteWrong }),
    });
    assert.equal(fifth.status, 409);
    assert.equal((await fifth.json()).error.code, 'device-approval-rejected');
    const bruteStatus = await (await s.api(
      `/auth/device-approvals/${brute.body.approvalId}/status?token=${encodeURIComponent(brute.body.approvalToken)}`,
    )).json();
    assert.equal(bruteStatus.status, 'rejected');

    const expiredKey = makeDeviceKey();
    const expired = await loginWithKey(s, 'guest2', 'password123', expiredKey);
    assert.equal(expired.res.status, 202);
    s.db.prepare('UPDATE device_approvals SET expires_at = ? WHERE id = ?')
      .run('2000-01-01T00:00:00.000Z', expired.body.approvalId);
    const expiredApprove = await s.api(
      `/auth/device-approvals/${expired.body.approvalId}/approve`,
      {
        token: reg.accessToken,
        method: 'POST',
        body: JSON.stringify({ verification_code: expired.body.verificationCode }),
      },
    );
    assert.equal(expiredApprove.status, 409);

    const resetRes = await s.api(`/auth/users/${reg.userId}/reset-devices`, {
      token: admin.token,
      method: 'POST',
      body: '{}',
    });
    assert.equal(resetRes.status, 200);
    const reset = await resetRes.json();
    assert.match(reset.resetCode, /^\d{8}$/);

    assert.equal((await s.api('/auth/me', { token: reg.accessToken })).status, 401);
    const noCode = await loginWithKey(s, 'guest2', 'password123', makeDeviceKey());
    assert.equal(noCode.res.status, 409);
    assert.equal(noCode.body.error.code, 'device-reset-required');

    const reboundKey = makeDeviceKey();
    const rebound = await loginWithKey(s, 'guest2', 'password123', reboundKey, {
      resetCode: reset.resetCode,
    });
    assert.equal(rebound.res.status, 200);
    assert.ok(rebound.body.accessToken);
  } finally {
    await s.close();
  }
});

test('老 session 可登记当前设备公钥，避免升级锁死', async () => {
  const s = await makeServer({ deviceTrustRequired: false });
  try {
    const login = await (await s.api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'password123', device_name: 'legacy' }),
    })).json();
    assert.ok(login.accessToken);
    const key = makeDeviceKey();
    const ch = await challenge(s, 'admin', key, 'enroll');
    const enrolled = await s.api('/auth/device/enroll-existing', {
      token: login.accessToken,
      method: 'POST',
      body: JSON.stringify({
        username: 'admin',
        password: 'password123',
        device_public_key: key.publicKey,
        key_fingerprint: key.fingerprint,
        challenge_id: ch.challengeId,
        signature: signatureFor(key, ch.payload),
        device_name: 'legacy',
      }),
    });
    assert.equal(enrolled.status, 200);
    const body = await enrolled.json();
    assert.ok(body.trustedDeviceId);
    const row = s.db.prepare('SELECT trusted_device_id FROM devices WHERE id = ?')
      .get(login.deviceId);
    assert.equal(row.trusted_device_id, body.trustedDeviceId);

    const secondKey = makeDeviceKey();
    const ch2 = await challenge(s, 'admin', secondKey, 'enroll');
    const wrongPassword = await s.api('/auth/device/enroll-existing', {
      token: login.accessToken,
      method: 'POST',
      body: JSON.stringify({
        username: 'admin',
        password: 'wrong-password',
        device_public_key: secondKey.publicKey,
        key_fingerprint: secondKey.fingerprint,
        challenge_id: ch2.challengeId,
        signature: signatureFor(secondKey, ch2.payload),
      }),
    });
    assert.equal(wrongPassword.status, 401);

    for (let i = 0; i < 4; i++) {
      const repeat = await s.api('/auth/device/enroll-existing', {
        token: login.accessToken,
        method: 'POST',
        body: JSON.stringify({
          username: 'admin',
          password: 'wrong-password',
          device_public_key: secondKey.publicKey,
          key_fingerprint: secondKey.fingerprint,
          challenge_id: ch2.challengeId,
          signature: signatureFor(secondKey, ch2.payload),
        }),
      });
      assert.equal(repeat.status, 401);
    }
    const throttled = await s.api('/auth/device/enroll-existing', {
      token: login.accessToken,
      method: 'POST',
      body: JSON.stringify({
        username: 'admin',
        password: 'wrong-password',
        device_public_key: secondKey.publicKey,
        key_fingerprint: secondKey.fingerprint,
        challenge_id: ch2.challengeId,
        signature: signatureFor(secondKey, ch2.payload),
      }),
    });
    assert.equal(throttled.status, 429);
  } finally {
    await s.close();
  }
});

test('管理员 CLI 可重置自己的设备信任并输出一次性重绑码', async () => {
  const s = await makeServer();
  try {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const result = spawnSync(
      process.execPath,
      ['gateway/scripts/reset-device-trust.mjs', 'admin'],
      {
        cwd: root,
        env: {
          ...process.env,
          TIDE_DB_PATH: path.join(s.dir, 'gw.db'),
          TIDE_JWT_SECRET: 'device-test-secret-device-test-secret',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /一次性重绑码: \d{8}/);
    assert.equal(
      s.db.prepare('SELECT COUNT(*) AS n FROM device_reset_codes WHERE user_id = ?')
        .get(s.admin.id).n,
      1,
    );
  } finally {
    await s.close();
  }
});

test('老设备的登记过渡期结束后，未绑定 session 不再放行', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-device-deadline-'));
  const dbPath = path.join(dir, 'gw.db');
  const options = {
    agentSecret: 'test-secret',
    dbPath,
    workspaceRoot: path.join(dir, 'workspaces'),
    jwtSecret: 'device-test-secret-device-test-secret',
    startRebuildWorker: false,
    startSocial: false,
    logger: silent,
  };
  const first = await createGateway({ ...options, deviceTrustRequired: false });
  await first.authService.createUser({
    username: 'legacy',
    password: 'password123',
    role: 'admin',
  });
  await new Promise((resolve) => first.server.listen(0, '127.0.0.1', resolve));
  const firstBase = `http://127.0.0.1:${first.server.address().port}`;
  const login = await (await fetch(`${firstBase}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'legacy', password: 'password123' }),
  })).json();
  await new Promise((resolve) => first.server.close(resolve));

  const second = await createGateway({
    ...options,
    deviceTrustRequired: true,
    deviceTrustEnrollDeadline: '2000-01-01T00:00:00Z',
  });
  await new Promise((resolve) => second.server.listen(0, '127.0.0.1', resolve));
  const secondBase = `http://127.0.0.1:${second.server.address().port}`;
  try {
    const me = await fetch(`${secondBase}/auth/me`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    assert.equal(me.status, 401);
    assert.equal((await me.json()).error.code, 'device-trust-required');
    const refreshed = await fetch(`${secondBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: login.refreshToken }),
    });
    assert.equal(refreshed.status, 401);
    assert.equal((await refreshed.json()).error.code, 'device-trust-required');
  } finally {
    second.closeSse();
    await new Promise((resolve) => second.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
