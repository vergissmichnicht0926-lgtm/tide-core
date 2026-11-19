// 鉴权业务逻辑 —— 纯函数式，不碰 HTTP。
// routes/auth.mjs 只做「解析请求 → 调这里 → 拼响应」，方便单测。
//
// DB 传进来的就是 node:sqlite 的 DatabaseSync（或任何有 prepare().get()/run() 的对象）。
// 表结构见 auth/schema.sql。

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.mjs';
import { signJwt, verifyJwt } from './jwt.mjs';
import { createRateLimiter } from './rate-limit.mjs';
import { ApiError, badRequest, unauthorized, tooMany } from './errors.mjs';
import {
  DEVICE_PAYLOAD_VERSION,
  DEVICE_SIGNATURE_ALGORITHM,
  buildDevicePayload,
  fingerprintPublicKey,
  normalizeFingerprint,
  verifyDeviceSignature,
} from './device.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const newId = (prefix) => `${prefix}_${randomBytes(12).toString('base64url')}`;
const newRefresh = () => randomBytes(32).toString('base64url');
const newPollToken = () => randomBytes(32).toString('base64url');
const newVerificationCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const newResetCode = () => String(randomInt(0, 100_000_000)).padStart(8, '0');
const iso = (ms) => new Date(ms).toISOString();

// 用户不存在时也要跑一次等价耗时的 scrypt，免得靠响应时间判断账号是否存在。
// 这是固定的假哈希（密码是随机的，永远验不过）。
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function capabilitiesFor(role) {
  return role === 'admin'
    ? ['chat', 'upload', 'admin']
    : ['chat', 'upload'];
}

/**
 * @param {{
 *   db: any,
 *   secret: string,
 *   accessTtlSec?: number,
 *   refreshTtlDays?: number,
 *   deviceTrustRequired?: boolean,
 *   limiter?: ReturnType<typeof createRateLimiter>,
 *   now?: () => number,
 * }} opts
 */
export function createAuthService({
  db,
  secret,
  accessTtlSec = 900,
  refreshTtlDays = 30,
  deviceTrustRequired = false,
  deviceTrustEnrollDeadline = null,
  limiter = createRateLimiter(),
  now = Date.now,
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('auth 需要一个 DatabaseSync 实例');
  if (!secret) throw new Error('auth 需要 jwt secret');

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userCreate: db.prepare(
      `INSERT INTO users (id, username, password_hash, role, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    inviteByCode: db.prepare('SELECT * FROM invite WHERE code = ?'),
    inviteUse: db.prepare(
      `UPDATE invite SET used_count = used_count + 1
        WHERE id = ? AND revoked_at IS NULL AND used_count < max_uses`,
    ),
    deviceInsert: db.prepare(
      `INSERT INTO devices
         (id, user_id, name, refresh_hash, created_at, last_seen_at, expires_at, trusted_device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    deviceByTrusted: db.prepare(
      `SELECT * FROM devices
        WHERE user_id = ? AND trusted_device_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ),
    deviceLinkTrusted: db.prepare(
      'UPDATE devices SET trusted_device_id = ? WHERE id = ?',
    ),
    deviceByHash: db.prepare('SELECT * FROM devices WHERE refresh_hash = ?'),
    deviceById: db.prepare('SELECT * FROM devices WHERE id = ?'),
    deviceRotate: db.prepare(
      'UPDATE devices SET refresh_hash = ?, last_seen_at = ?, expires_at = ? WHERE id = ?',
    ),
    deviceTouch: db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
    deviceRevoke: db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?'),
    devicesByUser: db.prepare(
      `SELECT id, name, created_at, last_seen_at, expires_at, revoked_at, trusted_device_id
         FROM devices WHERE user_id = ? ORDER BY created_at DESC`,
    ),
    attemptLog: db.prepare(
      'INSERT INTO login_attempts (username, ip, ok, at) VALUES (?, ?, ?, ?)',
    ),
    challengeInsert: db.prepare(
      `INSERT INTO device_challenges
         (id, username, key_fingerprint, purpose, nonce, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    challengeById: db.prepare('SELECT * FROM device_challenges WHERE id = ?'),
    challengeUse: db.prepare(
      'UPDATE device_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL',
    ),
    trustedByFingerprint: db.prepare(
      `SELECT * FROM trusted_devices
        WHERE user_id = ? AND key_fingerprint = ? AND revoked_at IS NULL`,
    ),
    trustedById: db.prepare('SELECT * FROM trusted_devices WHERE id = ?'),
    trustedCount: db.prepare(
      'SELECT COUNT(*) AS n FROM trusted_devices WHERE user_id = ? AND revoked_at IS NULL',
    ),
    trustedInsert: db.prepare(
      `INSERT INTO trusted_devices
         (id, user_id, public_key, key_fingerprint, name, created_at, last_seen_at,
          trusted_by_device_id, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ),
    trustedTouch: db.prepare(
      'UPDATE trusted_devices SET last_seen_at = ? WHERE id = ?',
    ),
    trustedRevokeAll: db.prepare(
      'UPDATE trusted_devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ),
    approvalInsert: db.prepare(
      `INSERT INTO device_approvals
         (id, user_id, public_key, key_fingerprint, name, request_ip,
          verification_code_hash, poll_token_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ),
    approvalById: db.prepare('SELECT * FROM device_approvals WHERE id = ?'),
    approvalsByUser: db.prepare(
      `SELECT * FROM device_approvals
        WHERE user_id = ? AND status = 'pending'
        ORDER BY created_at DESC`,
    ),
    approvalDecide: db.prepare(
      `UPDATE device_approvals
          SET status = ?, decided_by_device_id = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'`,
    ),
    approvalExpire: db.prepare(
      "UPDATE device_approvals SET status = 'expired' WHERE id = ? AND status = 'pending'",
    ),
    approvalConsume: db.prepare(
      `UPDATE device_approvals SET status = 'consumed', consumed_at = ?
        WHERE id = ? AND status = 'approved'`,
    ),
    approvalFail: db.prepare(
      `UPDATE device_approvals
          SET failed_attempts = failed_attempts + 1,
              status = CASE WHEN failed_attempts + 1 >= 5 THEN 'rejected' ELSE status END,
              decided_at = CASE WHEN failed_attempts + 1 >= 5 THEN ? ELSE decided_at END
        WHERE id = ? AND status = 'pending'`,
    ),
    approvalsRevokePending: db.prepare(
      `UPDATE device_approvals
          SET status = 'rejected', decided_at = ?
        WHERE user_id = ? AND status IN ('pending','approved')`,
    ),
    resetInsert: db.prepare(
      `INSERT INTO device_reset_codes
         (id, user_id, code_hash, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    resetLatest: db.prepare(
      `SELECT * FROM device_reset_codes
        WHERE user_id = ? AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ),
    resetUse: db.prepare(
      'UPDATE device_reset_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
    ),
    devicesRevokeUser: db.prepare(
      'UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    ),
  };

  const refreshTtlMs = refreshTtlDays * 24 * 60 * 60 * 1000;
  const enrollDeadlineMs = deviceTrustEnrollDeadline == null
    ? null
    : Date.parse(String(deviceTrustEnrollDeadline));
  if (deviceTrustEnrollDeadline != null && !Number.isFinite(enrollDeadlineMs)) {
    throw new Error('deviceTrustEnrollDeadline 不是合法时间');
  }

  function issueTokens(userId, deviceId) {
    const accessToken = signJwt({ sub: userId, dev: deviceId }, { secret, expiresInSec: accessTtlSec, now });
    return { accessToken, expiresIn: accessTtlSec };
  }

  function normalizeDeviceName(value) {
    return typeof value === 'string' && value.trim()
      ? value.trim().slice(0, 60)
      : '';
  }

  function createDeviceSession(userId, deviceName = '', trustedDeviceId = null) {
    const name = normalizeDeviceName(deviceName);
    const refreshToken = newRefresh();
    const at = iso(now());
    const expiresAt = iso(now() + refreshTtlMs);
    let device = trustedDeviceId ? q.deviceByTrusted.get(userId, trustedDeviceId) : null;
    let deviceId;
    if (device && !device.revoked_at && Date.parse(device.expires_at) > now()) {
      deviceId = device.id;
      q.deviceRotate.run(sha256(refreshToken), at, expiresAt, deviceId);
      if (name && name !== device.name) {
        db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, deviceId);
      }
    } else {
      deviceId = newId('dev');
      q.deviceInsert.run(
        deviceId,
        userId,
        name,
        sha256(refreshToken),
        at,
        at,
        expiresAt,
        trustedDeviceId,
      );
    }
    const { accessToken, expiresIn } = issueTokens(userId, deviceId);
    return { deviceId, deviceName: name, refreshToken, accessToken, expiresIn, expiresAt };
  }

  function createTrustedDevice({ userId, publicKey, keyFingerprint, name, trustedByDeviceId = null }) {
    const fingerprint = normalizeFingerprint(keyFingerprint);
    const actual = fingerprintPublicKey(publicKey);
    if (actual !== fingerprint) throw badRequest('设备公钥指纹不匹配');
    const existing = q.trustedByFingerprint.get(userId, fingerprint);
    if (existing) return existing;
    const id = newId('td');
    const at = iso(now());
    q.trustedInsert.run(
      id,
      userId,
      publicKey,
      fingerprint,
      normalizeDeviceName(name),
      at,
      at,
      trustedByDeviceId,
    );
    return q.trustedById.get(id);
  }

  function issueDeviceChallenge({ username, keyFingerprint, purpose = 'login' } = {}) {
    if (typeof username !== 'string' || !username.trim()) throw badRequest('username 必填');
    const allowed = new Set(['login', 'register', 'enroll', 'reset']);
    if (!allowed.has(purpose)) throw badRequest('purpose 不合法');
    const user = username.trim();
    const fingerprint = normalizeFingerprint(keyFingerprint);
    const challengeId = newId('dc');
    const nonce = randomBytes(24).toString('base64url');
    const payload = buildDevicePayload({
      challengeId,
      username: user,
      keyFingerprint: fingerprint,
      purpose,
      nonce,
    });
    const at = iso(now());
    const expiresAt = iso(now() + 5 * 60 * 1000);
    q.challengeInsert.run(
      challengeId,
      user,
      fingerprint,
      purpose,
      nonce,
      payload,
      at,
      expiresAt,
    );
    return {
      challengeId,
      payload,
      expiresAt,
      algorithm: DEVICE_SIGNATURE_ALGORITHM,
      version: DEVICE_PAYLOAD_VERSION,
    };
  }

  function verifyDeviceProof({
    username,
    devicePublicKey,
    keyFingerprint,
    challengeId,
    signature,
    purpose,
  }) {
    if (typeof username !== 'string' || !username.trim()) throw badRequest('username 必填');
    if (typeof challengeId !== 'string' || !challengeId) {
      throw new ApiError(401, 'device-challenge-required', '缺少设备挑战，请重新登录');
    }
    const row = q.challengeById.get(challengeId);
    if (!row) throw new ApiError(401, 'device-challenge-invalid', '设备挑战不存在或已使用');
    if (row.used_at) throw new ApiError(401, 'device-challenge-used', '设备挑战已使用');
    if (Date.parse(row.expires_at) <= now()) {
      throw new ApiError(401, 'device-challenge-expired', '设备挑战已过期');
    }
    if (row.purpose !== purpose || row.username.toLowerCase() !== username.trim().toLowerCase()) {
      throw new ApiError(401, 'device-challenge-invalid', '设备挑战与登录请求不匹配');
    }
    const fingerprint = normalizeFingerprint(keyFingerprint);
    if (row.key_fingerprint !== fingerprint) {
      throw new ApiError(401, 'device-key-mismatch', '设备公钥指纹与挑战不匹配');
    }
    const actual = fingerprintPublicKey(devicePublicKey);
    if (actual !== fingerprint) {
      throw new ApiError(401, 'device-key-mismatch', '设备公钥指纹不匹配');
    }
    let valid = false;
    try {
      valid = verifyDeviceSignature({
        publicKey: devicePublicKey,
        payload: row.payload,
        signature,
      });
    } catch (error) {
      throw new ApiError(401, 'device-proof-invalid', error.message);
    }
    if (!valid) throw new ApiError(401, 'device-proof-invalid', '设备签名无效');
    const used = q.challengeUse.run(iso(now()), challengeId);
    if (used.changes !== 1) {
      throw new ApiError(401, 'device-challenge-used', '设备挑战已使用');
    }
    return { publicKey: devicePublicKey, keyFingerprint: fingerprint };
  }

  function deviceProofInput(body = {}) {
    return {
      username: body.username,
      devicePublicKey: body.devicePublicKey ?? body.device_public_key,
      keyFingerprint: body.keyFingerprint ?? body.key_fingerprint,
      challengeId: body.challengeId ?? body.challenge_id,
      signature: body.signature,
      purpose: 'login',
    };
  }

  function hasDeviceProof(body = {}) {
    return Boolean(
      body.devicePublicKey
      || body.device_public_key
      || body.challengeId
      || body.challenge_id,
    );
  }

  function legacySessionClosed() {
    return deviceTrustRequired
      && enrollDeadlineMs != null
      && now() > enrollDeadlineMs;
  }

  function assertLegacySessionAllowed(device) {
    if (!device.trusted_device_id && legacySessionClosed()) {
      throw unauthorized(
        'device-trust-required',
        '旧设备 session 未登记设备公钥，过渡期已结束，请重新登录或联系管理员',
      );
    }
  }

  function verifyResetCode(userId, code) {
    if (typeof code !== 'string' || !/^\d{8}$/.test(code.trim())) return null;
    const row = q.resetLatest.get(userId);
    if (!row || row.used_at || Date.parse(row.expires_at) <= now()) return null;
    const left = Buffer.from(row.code_hash, 'hex');
    const right = Buffer.from(sha256(code.trim()), 'hex');
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    return row;
  }

  function sessionPayload(user, session, extra = {}) {
    const role = user.role || 'guest';
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: session.expiresIn,
      userId: user.id,
      username: user.username,
      role,
      displayName: user.display_name || user.username,
      capabilities: capabilitiesFor(role),
      user: {
        id: user.id,
        username: user.username,
        role,
        displayName: user.display_name || user.username,
      },
      deviceId: session.deviceId,
      device: {
        id: session.deviceId,
        name: session.deviceName,
        expiresAt: session.expiresAt,
      },
      ...extra,
    };
  }

  function createDeviceApproval({ user, proof, deviceName, ip }) {
    const id = newId('appr');
    const verificationCode = newVerificationCode();
    const pollToken = newPollToken();
    const at = iso(now());
    const expiresAt = iso(now() + 10 * 60 * 1000);
    q.approvalInsert.run(
      id,
      user.id,
      proof.publicKey,
      proof.keyFingerprint,
      normalizeDeviceName(deviceName),
      ip,
      sha256(verificationCode),
      sha256(pollToken),
      at,
      expiresAt,
    );
    return {
      approvalRequired: true,
      approvalId: id,
      approvalToken: pollToken,
      verificationCode,
      expiresAt,
    };
  }

  function approvalView(row, includeCode = false) {
    return {
      id: row.id,
      name: row.name,
      keyFingerprint: row.key_fingerprint,
      requestIp: row.request_ip,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      ...(includeCode ? { verificationCode: row.verification_code } : {}),
    };
  }

  function listDeviceApprovals({ userId } = {}) {
    if (!userId) throw badRequest('userId 必填');
    const at = iso(now());
    const rows = q.approvalsByUser.all(userId);
    for (const row of rows) {
      if (Date.parse(row.expires_at) <= now()) q.approvalExpire.run(row.id);
    }
    return {
      approvals: rows
        .filter((row) => Date.parse(row.expires_at) > now())
        .map((row) => approvalView(row)),
      serverTime: at,
    };
  }

  function decideDeviceApproval({
    userId,
    deviceId,
    approvalId,
    approve,
    verificationCode = null,
  } = {}) {
    if (!userId || !approvalId) throw badRequest('userId 与 approvalId 必填');
    const row = q.approvalById.get(approvalId);
    if (!row || row.user_id !== userId) {
      throw new ApiError(404, 'device-approval-not-found', '设备审批不存在');
    }
    if (row.status !== 'pending') {
      throw new ApiError(409, 'device-approval-decided', '设备审批已处理');
    }
    if (Date.parse(row.expires_at) <= now()) {
      q.approvalExpire.run(row.id);
      throw new ApiError(409, 'device-approval-expired', '设备审批已过期');
    }
    const at = iso(now());
    if (!approve) {
      const changed = q.approvalDecide.run('rejected', deviceId || null, at, row.id);
      if (changed.changes !== 1) throw new ApiError(409, 'device-approval-decided', '设备审批已处理');
      return { ok: true, status: 'rejected' };
    }
    const code = String(verificationCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, 'device-verification-code-required', '需要新设备显示的六位确认码');
    }
    const expectedCode = Buffer.from(row.verification_code_hash, 'hex');
    const actualCode = Buffer.from(sha256(code), 'hex');
    if (expectedCode.length !== actualCode.length
        || !timingSafeEqual(expectedCode, actualCode)) {
      q.approvalFail.run(at, row.id);
      const updated = q.approvalById.get(row.id);
      if (updated?.status === 'rejected') {
        throw new ApiError(
          409,
          'device-approval-rejected',
          '确认码错误次数过多，审批已作废，请让新设备重新发起登录',
        );
      }
      throw new ApiError(403, 'device-verification-code-invalid', '设备确认码不正确');
    }
    const user = q.userById.get(userId);
    if (!user || user.disabled_at) throw unauthorized('账号不可用');
    db.exec('BEGIN IMMEDIATE');
    try {
      const trusted = createTrustedDevice({
        userId,
        publicKey: row.public_key,
        keyFingerprint: row.key_fingerprint,
        name: row.name,
        trustedByDeviceId: deviceId || null,
      });
      const changed = q.approvalDecide.run('approved', deviceId || null, at, row.id);
      if (changed.changes !== 1) {
        throw new ApiError(409, 'device-approval-decided', '设备审批已处理');
      }
      db.exec('COMMIT');
      return { ok: true, status: 'approved', trustedDeviceId: trusted.id };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function deviceApprovalStatus({ approvalId, approvalToken } = {}) {
    if (!approvalId || !approvalToken) throw badRequest('approvalId 与 approvalToken 必填');
    const row = q.approvalById.get(approvalId);
    if (!row) throw new ApiError(404, 'device-approval-not-found', '设备审批不存在');
    const expected = Buffer.from(row.poll_token_hash, 'hex');
    const actual = Buffer.from(sha256(String(approvalToken)), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ApiError(403, 'device-approval-forbidden', '审批凭据无效');
    }
    if (row.status === 'pending' && Date.parse(row.expires_at) <= now()) {
      q.approvalExpire.run(row.id);
      return { status: 'expired', expiresAt: new Date(row.expires_at).toISOString() };
    }
    if (row.status !== 'approved') {
      return { status: row.status, expiresAt: new Date(row.expires_at).toISOString() };
    }
    const user = q.userById.get(row.user_id);
    if (!user || user.disabled_at) throw unauthorized('账号不可用');
    const trusted = q.trustedByFingerprint.get(row.user_id, row.key_fingerprint);
    if (!trusted) throw new ApiError(409, 'device-trust-missing', '受信设备记录丢失');
    const consumed = q.approvalConsume.run(iso(now()), row.id);
    if (consumed.changes !== 1) {
      return { status: row.status, expiresAt: new Date(row.expires_at).toISOString() };
    }
    const session = createDeviceSession(row.user_id, row.name, trusted.id);
    return {
      status: 'approved',
      ...sessionPayload(user, session, { trustedDeviceId: trusted.id }),
    };
  }

  async function enrollExistingDevice({
    userId,
    deviceId,
    username,
    password,
    devicePublicKey,
    keyFingerprint,
    challengeId,
    signature,
    deviceName,
  } = {}) {
    if (!userId || !deviceId) throw badRequest('缺少当前设备 session');
    if (legacySessionClosed()) {
      throw new ApiError(409, 'device-enrollment-closed', '老设备登记过渡期已结束');
    }
    const user = q.userById.get(userId);
    if (!user || user.disabled_at) throw unauthorized('账号不可用');
    const limiterKey = user.username;
    const rl = limiter.check(limiterKey);
    if (!rl.ok) {
      throw tooMany(
        `密码失败次数过多，${Math.ceil(rl.retryAfterMs / 1000)} 秒后再试`,
        rl.retryAfterMs,
      );
    }
    if (typeof password !== 'string' || !password) {
      throw new ApiError(401, 'device-password-required', '登记设备需要输入账号密码');
    }
    if (!(await verifyPassword(password, user.password_hash))) {
      limiter.fail(limiterKey);
      throw unauthorized('bad-credentials', '用户名或密码不对');
    }
    limiter.succeed(limiterKey);
    const proof = verifyDeviceProof({
      username,
      devicePublicKey,
      keyFingerprint,
      challengeId,
      signature,
      purpose: 'enroll',
    });
    const current = q.deviceById.get(deviceId);
    if (!current || current.user_id !== userId || current.revoked_at) {
      throw unauthorized('token-revoked', '当前设备 session 无效');
    }
    if (current.trusted_device_id) {
      return {
        ok: true,
        alreadyEnrolled: true,
        trustedDeviceId: current.trusted_device_id,
      };
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const trusted = createTrustedDevice({
        userId,
        publicKey: proof.publicKey,
        keyFingerprint: proof.keyFingerprint,
        name: deviceName || current.name,
        trustedByDeviceId: null,
      });
      q.deviceLinkTrusted.run(trusted.id, deviceId);
      db.exec('COMMIT');
      return { ok: true, trustedDeviceId: trusted.id };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function resetDeviceTrust({ userId, actorUserId = null } = {}) {
    if (!userId) throw badRequest('userId 必填');
    const user = q.userById.get(userId);
    if (!user) throw new ApiError(404, 'user-not-found', '用户不存在');
    const code = newResetCode();
    const at = iso(now());
    const expiresAt = iso(now() + 10 * 60 * 1000);
    db.exec('BEGIN IMMEDIATE');
    try {
      q.trustedRevokeAll.run(at, userId);
      q.devicesRevokeUser.run(at, userId);
      q.approvalsRevokePending.run(at, userId);
      q.resetInsert.run(
        newId('dreset'),
        userId,
        sha256(code),
        actorUserId,
        at,
        expiresAt,
      );
      try {
        db.prepare(
          `INSERT INTO audit_log(actor_user_id, action, target, detail_json, created_at)
           VALUES (?, 'auth.device-trust.reset', ?, ?, ?)`,
        ).run(actorUserId, userId, JSON.stringify({ expiresAt }), now());
      } catch {
        // audit_log 属于主库；单独模块测试时可以不存在。
      }
      db.exec('COMMIT');
      return { ok: true, resetCode: code, expiresAt };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  /**
   * 登录。
   * @returns {{accessToken: string, refreshToken: string, expiresIn: number, user: object, device: object}}
   */
  async function login({
    username,
    password,
    deviceName = '',
    ip = null,
    devicePublicKey = null,
    keyFingerprint = null,
    challengeId = null,
    signature = null,
    resetCode = null,
  } = {}) {
    if (typeof username !== 'string' || !username.trim()) throw badRequest('username 必填');
    if (typeof password !== 'string' || !password) throw badRequest('password 必填');

    const rl = limiter.check(username);
    if (!rl.ok) {
      throw tooMany(`登录失败次数过多，${Math.ceil(rl.retryAfterMs / 1000)} 秒后再试`, rl.retryAfterMs);
    }

    const row = q.userByName.get(username.trim());
    const storedHash = row?.password_hash ?? DUMMY_HASH;
    const passwordOk = await verifyPassword(password, storedHash);
    const usable = Boolean(row) && !row.disabled_at && passwordOk;

    if (!usable) {
      limiter.fail(username);
      q.attemptLog.run(username.trim(), ip, 0, iso(now()));
      throw unauthorized('bad-credentials', '用户名或密码不对');
    }

    limiter.succeed(username);
    q.attemptLog.run(username.trim(), ip, 1, iso(now()));

    const proofRequested = deviceTrustRequired || Boolean(devicePublicKey || challengeId);
    if (proofRequested && !devicePublicKey) {
      throw new ApiError(401, 'device-key-required', '需要设备密钥才能登录');
    }
    let proof = null;
    if (proofRequested) {
      proof = verifyDeviceProof({
        username: username.trim(),
        devicePublicKey,
        keyFingerprint,
        challengeId,
        signature,
        purpose: 'login',
      });
    }

    if (!proof) {
      const session = createDeviceSession(row.id, deviceName);
      return sessionPayload(row, session);
    }

    let trusted = q.trustedByFingerprint.get(row.id, proof.keyFingerprint);
    if (!trusted) {
      const resetRow = verifyResetCode(row.id, resetCode);
      if (resetRow) {
        db.exec('BEGIN IMMEDIATE');
        try {
          trusted = createTrustedDevice({
            userId: row.id,
            publicKey: proof.publicKey,
            keyFingerprint: proof.keyFingerprint,
            name: deviceName,
          });
          const used = q.resetUse.run(iso(now()), resetRow.id);
          if (used.changes !== 1) throw new ApiError(409, 'device-reset-code-used', '重绑码已使用');
          const session = createDeviceSession(row.id, deviceName, trusted.id);
          db.exec('COMMIT');
          return sessionPayload(row, session, { trustedDeviceId: trusted.id });
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
      }
      if (Number(q.trustedCount.get(row.id).n) === 0) {
        throw new ApiError(
          409,
          'device-reset-required',
          '这个账号还没有受信设备，需要管理员重置设备信任',
        );
      }
      return createDeviceApproval({
        user: row,
        proof,
        deviceName,
        ip,
      });
    }

    q.trustedTouch.run(iso(now()), trusted.id);
    const session = createDeviceSession(row.id, deviceName, trusted.id);
    return sessionPayload(row, session, { trustedDeviceId: trusted.id });
  }

  /**
   * 用 refresh token 换新的 access token，同时轮换 refresh token。
   * 旧 refresh 立刻失效（refresh_hash 被覆盖）——这是轮换式刷新该有的样子。
   */
  function refresh({ refreshToken } = {}) {
    if (typeof refreshToken !== 'string' || !refreshToken) throw badRequest('缺少 refresh token');

    const hash = sha256(refreshToken);
    const device = q.deviceByHash.get(hash);
    if (!device) throw unauthorized('token-invalid', 'refresh token 无效或已被轮换');

    if (device.revoked_at) throw unauthorized('token-revoked', '这个设备已被撤销');
    if (Date.parse(device.expires_at) <= now()) throw unauthorized('token-expired', 'refresh token 已过期');
    if (device.trusted_device_id) {
      const trusted = q.trustedById.get(device.trusted_device_id);
      if (!trusted || trusted.revoked_at) {
        throw unauthorized('token-revoked', '这个设备信任已被撤销');
      }
    } else {
      assertLegacySessionAllowed(device);
    }

    const user = q.userById.get(device.user_id);
    if (!user || user.disabled_at) throw unauthorized('token-invalid', '账号不可用');

    const nextRefresh = newRefresh();
    const at = iso(now());
    const expiresAt = iso(now() + refreshTtlMs);
    q.deviceRotate.run(sha256(nextRefresh), at, expiresAt, device.id);

    const { accessToken, expiresIn } = issueTokens(user.id, device.id);
    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresIn,
      user: {
        id: user.id,
        username: user.username,
        role: user.role || 'guest',
        displayName: user.display_name || user.username,
        capabilities: capabilitiesFor(user.role || 'guest'),
      },
      device: { id: device.id, name: device.name, expiresAt },
    };
  }

  /** 撤销这个 refresh token 所属的设备 */
  function logout({ refreshToken } = {}) {
    if (typeof refreshToken !== 'string' || !refreshToken) throw badRequest('缺少 refresh token');
    const device = q.deviceByHash.get(sha256(refreshToken));
    if (!device) return { ok: true, alreadyGone: true };
    q.deviceRevoke.run(iso(now()), device.id);
    return { ok: true, revokedDeviceId: device.id };
  }

  /** 校验 access token，返回 { userId, deviceId } */
  function authenticate(accessToken) {
    let payload;
    try {
      ({ payload } = verifyJwt(accessToken, { secret, now }));
    } catch (err) {
      if (err.code === 'expired') throw unauthorized('token-expired', 'access token 已过期');
      throw unauthorized('token-invalid', 'access token 无效');
    }

    const device = q.deviceById.get(payload.dev);
    if (!device) throw unauthorized('token-invalid', '设备不存在');
    if (device.revoked_at) throw unauthorized('token-revoked', '这个设备已被撤销');
    if (device.user_id !== payload.sub) throw unauthorized('token-invalid', '设备与用户不匹配');
    if (device.trusted_device_id) {
      const trusted = q.trustedById.get(device.trusted_device_id);
      if (!trusted || trusted.revoked_at) {
        throw unauthorized('token-revoked', '这个设备信任已被撤销');
      }
    } else {
      assertLegacySessionAllowed(device);
    }

    const user = q.userById.get(payload.sub);
    if (!user || user.disabled_at) throw unauthorized('token-invalid', '账号不可用');
    const role = user.role || 'guest';
    return {
      userId: payload.sub,
      deviceId: payload.dev,
      username: user.username,
      role,
      displayName: user.display_name || user.username,
      capabilities: capabilitiesFor(role),
    };
  }

  /** 改自己的公开资料：昵称写回 users，并同步所有群成员显示名。 */
  function updateProfile({ userId, displayName, avatar } = {}) {
    const user = q.userById.get(userId);
    if (!user || user.disabled_at) throw unauthorized('token-invalid', '账号不可用');
    let name = user.display_name || user.username;
    if (displayName !== undefined) {
      if (typeof displayName !== 'string') {
        throw badRequest('display_name 必须是字符串');
      }
      const value = displayName.trim();
      if (!value || value.length > 30) throw badRequest('昵称必须是 1~30 字');
      name = value;
    }
    let avatarValue = user.avatar ?? null;
    if (avatar !== undefined) {
      if (avatar === null || avatar === '') {
        avatarValue = null;
      } else {
        if (typeof avatar !== 'string') throw badRequest('avatar 必须是 data URI');
        if (avatar.length > 600_000) throw badRequest('头像太大（最多 600000 字符）');
        if (!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(avatar)) {
          throw badRequest('avatar 必须是 data:image/...;base64 字符串');
        }
        avatarValue = avatar;
      }
    }
    db.prepare('UPDATE users SET display_name = ?, avatar = ? WHERE id = ?')
      .run(name, avatarValue, userId);
    if (displayName !== undefined) {
      db.prepare('UPDATE conversation_member SET display_name = ? WHERE user_id = ?')
        .run(name, userId);
    }
    return {
      id: userId,
      username: user.username,
      displayName: name,
      hasAvatar: Boolean(avatarValue),
      avatarVersion: avatarValue ? sha256(avatarValue).slice(0, 12) : null,
    };
  }

  /**
   * 管理台登录：只认 role='admin'，不走设备信任。
   * 用户不存在 / 非管理员 / 密码错统一 401，减少账号探测。
   */
  async function authenticateAdmin({ username, password, ip = null } = {}) {
    if (typeof username !== 'string' || !username.trim() || typeof password !== 'string') {
      throw badRequest('username/password 必填');
    }
    const name = username.trim();
    // 按 username+IP 计数：陌生人只能锁住自己的 IP，不会把唯一管理员锁在门外。
    const limiterKey = `${name}|${ip || 'unknown'}`;
    const rl = limiter.check(limiterKey);
    if (!rl.ok) throw tooMany('尝试次数过多，请稍后再试', rl.retryAfterMs);

    const user = q.userByName.get(name);
    const storedHash = user?.password_hash ?? DUMMY_HASH;
    const passwordOk = await verifyPassword(password, storedHash);
    const usable = Boolean(user)
      && !user.disabled_at
      && (user.role || 'guest') === 'admin';

    q.attemptLog.run(name, ip, usable && passwordOk ? 1 : 0, iso(now()));
    if (!usable || !passwordOk) {
      limiter.fail(limiterKey);
      throw unauthorized('bad-credentials', '账号或密码不对');
    }
    limiter.succeed(limiterKey);
    return {
      userId: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
    };
  }

  function listDevices({ userId } = {}) {
    if (!userId) throw badRequest('userId 必填');
    return {
      devices: q.devicesByUser.all(userId).map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        expiresAt: d.expires_at,
        revokedAt: d.revoked_at,
        trustedDeviceId: d.trusted_device_id,
      })),
    };
  }

  /** 撤销某个设备；只能撤自己的 */
  function revokeDevice({ userId, deviceId } = {}) {
    if (!userId || !deviceId) throw badRequest('userId 与 deviceId 必填');
    const device = q.deviceById.get(deviceId);
    if (!device || device.user_id !== userId) throw new ApiError(404, 'not-found', '设备不存在');
    if (device.revoked_at) return { ok: true, alreadyRevoked: true };
    const at = iso(now());
    q.deviceRevoke.run(at, deviceId);
    if (device.trusted_device_id) {
      const trusted = q.trustedById.get(device.trusted_device_id);
      if (trusted && trusted.user_id === userId && !trusted.revoked_at) {
        db.prepare('UPDATE trusted_devices SET revoked_at = ? WHERE id = ?')
          .run(at, trusted.id);
      }
      db.prepare(
        `UPDATE devices SET revoked_at = ?
          WHERE user_id = ? AND trusted_device_id = ? AND revoked_at IS NULL`,
      ).run(at, userId, device.trusted_device_id);
    }
    return { ok: true, revokedDeviceId: deviceId };
  }

  /** 建用户（部署脚本/测试用；seed-user 显式传 role，HTTP 注册走 registerWithInvite） */
  async function createUser({ username, password, role = 'admin', displayName = null } = {}) {
    if (typeof username !== 'string' || !username.trim()) throw badRequest('username 必填');
    if (typeof password !== 'string' || password.length < 8) throw badRequest('password 至少 8 位');
    if (role !== 'admin' && role !== 'guest') throw badRequest('role 必须是 admin 或 guest');

    if (q.userByName.get(username.trim())) throw badRequest('用户名已存在');

    const id = newId('usr');
    const passwordHash = await hashPassword(password);
    const name = displayName ? String(displayName).trim().slice(0, 60) : username.trim();
    q.userCreate.run(id, username.trim(), passwordHash, role, name, iso(now()));
    return { id, username: username.trim(), role, displayName: name };
  }

  /**
   * 凭邀请码注册 guest。只接受 kind='bot'；群邀请码需要登录后兑换。
   * 设备语义与 login 完全一致：新建设备行，不按机型复用。
   */
  async function registerWithInvite({
    code,
    username,
    password,
    deviceName = '',
    ip = null,
    devicePublicKey = null,
    keyFingerprint = null,
    challengeId = null,
    signature = null,
  } = {}) {
    if (typeof code !== 'string' || !code.trim()) throw badRequest('code 必填');
    if (typeof username !== 'string' || !username.trim()) throw badRequest('username 必填');
    if (typeof password !== 'string' || password.length < 8) throw badRequest('password 至少 8 位');
    if (q.userByName.get(username.trim())) throw badRequest('用户名已存在');

    const codeText = code.trim();
    // 12 位新格式邀请码全大写字母/数字；旧码含 -/_ 且区分大小写，所以只对新格式做大小写回退。
    let invite = q.inviteByCode.get(codeText);
    if (!invite && /^[a-z2-9]{12}$/i.test(codeText)) {
      const upper = codeText.toUpperCase();
      if (upper !== codeText) invite = q.inviteByCode.get(upper);
    }
    if (!invite) throw new ApiError(400, 'invite-invalid', '邀请码不存在');
    if (invite.revoked_at) throw new ApiError(400, 'invite-revoked', '邀请码已撤销');
    if (Number(invite.expires_at) <= now()) throw new ApiError(400, 'invite-expired', '邀请码已过期');
    if (Number(invite.used_count) >= Number(invite.max_uses)) {
      throw new ApiError(400, 'invite-exhausted', '邀请码使用次数已满');
    }
    if (invite.kind !== 'bot') {
      throw new ApiError(400, 'group-invite-login-required', '群邀请码请登录后兑换');
    }
    if (invite.role !== 'guest') throw new ApiError(400, 'invite-role-invalid', '邀请码角色不合法');

    let proof = null;
    if (deviceTrustRequired || devicePublicKey || challengeId) {
      if (!devicePublicKey) throw new ApiError(401, 'device-key-required', '注册需要设备密钥');
      proof = verifyDeviceProof({
        username: username.trim(),
        devicePublicKey,
        keyFingerprint,
        challengeId,
        signature,
        purpose: 'register',
      });
    }

    const passwordHash = await hashPassword(password);
    const id = newId('usr');
    const name = username.trim();
    db.exec('BEGIN IMMEDIATE');
    try {
      const used = q.inviteUse.run(invite.id);
      if (used.changes !== 1) {
        throw new ApiError(400, 'invite-exhausted', '邀请码使用次数已满');
      }
      q.userCreate.run(id, name, passwordHash, 'guest', name, iso(now()));
      const trusted = proof
        ? createTrustedDevice({
            userId: id,
            publicKey: proof.publicKey,
            keyFingerprint: proof.keyFingerprint,
            name: deviceName,
          })
        : null;
      const session = createDeviceSession(id, deviceName, trusted?.id || null);
      db.exec('COMMIT');
      return sessionPayload({
        id,
        username: name,
        role: 'guest',
        display_name: name,
      }, session, {
        trustedDeviceId: trusted?.id || null,
        invite: { id: invite.id, kind: invite.kind },
      });
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function countUsers() {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  return {
    login,
    refresh,
    logout,
    authenticate,
    authenticateAdmin,
    updateProfile,
    listDevices,
    revokeDevice,
    createUser,
    registerWithInvite,
    issueDeviceChallenge,
    enrollExistingDevice,
    listDeviceApprovals,
    decideDeviceApproval,
    deviceApprovalStatus,
    resetDeviceTrust,
    countUsers,
    limiter,
  };
}
