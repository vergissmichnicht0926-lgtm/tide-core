-- 汐语（Tide）网关 —— 鉴权相关的表
-- 由 auth 模块拥有；migrate 时排在 db/schema.sql 之后执行。
-- 约定：所有时间列都是 ISO 8601 字符串（UTC），便于直接比较与回放。

PRAGMA foreign_keys = ON;

-- 用户。单用户部署时也走这张表，不自造特例。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'guest'
                CHECK (role IN ('admin','guest')),
  display_name  TEXT,
  -- 头像 data URI（小尺寸 JPEG/PNG）。对外只暴露 has_avatar/avatar_version 和 /users/:id/avatar。
  avatar        TEXT,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

-- 设备信任：一次注册/批准对应一个稳定的设备公钥。
CREATE TABLE IF NOT EXISTS trusted_devices (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key             TEXT NOT NULL,
  key_fingerprint        TEXT NOT NULL,
  name                   TEXT NOT NULL DEFAULT '',
  created_at             TEXT NOT NULL,
  last_seen_at           TEXT,
  trusted_by_device_id   TEXT,
  revoked_at             TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_fingerprint
  ON trusted_devices(user_id, key_fingerprint)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

-- 设备 = 一次登录取到的一条 refresh 链。
-- refresh_hash 存 sha256(token)，token 本身只在响应里出现一次。
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  refresh_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  trusted_device_id TEXT REFERENCES trusted_devices(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_refresh ON devices(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- 登录尝试，只用于审计与「最近失败」展示；限流本身在内存里做。
CREATE TABLE IF NOT EXISTS login_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip       TEXT,
  ok       INTEGER NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, at);

CREATE TABLE IF NOT EXISTS device_challenges (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_challenges_expiry
  ON device_challenges(expires_at);

CREATE TABLE IF NOT EXISTS device_approvals (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key             TEXT NOT NULL,
  key_fingerprint        TEXT NOT NULL,
  name                   TEXT NOT NULL DEFAULT '',
  request_ip             TEXT,
  verification_code_hash TEXT NOT NULL,
  poll_token_hash        TEXT NOT NULL,
  failed_attempts        INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','approved','rejected','expired','consumed')),
  created_at             TEXT NOT NULL,
  expires_at             TEXT NOT NULL,
  decided_by_device_id   TEXT,
  decided_at             TEXT,
  consumed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_approvals_user
  ON device_approvals(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS device_reset_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_reset_codes_user
  ON device_reset_codes(user_id, created_at DESC);
