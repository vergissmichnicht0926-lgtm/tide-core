import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { defaultWakeConfig, normalizeWakeConfig } from '../social/wake.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');
const AUTH_SCHEMA_PATH = path.join(HERE, '..', 'auth', 'schema.sql');
const SCHEMA_VERSION = '1';

const DEFAULT_WAKE_JSON = JSON.stringify(defaultWakeConfig());

export function nowMs() {
  return Date.now();
}

function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
  const authSql = fs.readFileSync(AUTH_SCHEMA_PATH, 'utf8');
  db.exec(authSql);
  ensureAuthColumns(db);
  ensureDeviceTrustColumns(db);
  ensureRebuildColumns(db);
  ensureConversationColumns(db);
  ensureSocialColumns(db);
  ensureMemberTable(db);
  ensureInviteColumns(db);
  ensureBotSettingsColumns(db);
  ensureUsageColumns(db);
  ensureStickerTable(db);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
}

function ensureStickerTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sticker (
      id            TEXT PRIMARY KEY,
      owner_user_id TEXT,
      name          TEXT NOT NULL,
      tags_json     TEXT NOT NULL DEFAULT '[]',
      usage_note    TEXT NOT NULL DEFAULT '',
      attachment_id TEXT NOT NULL,
      md5           TEXT NOT NULL DEFAULT '',
      use_count     INTEGER NOT NULL DEFAULT 0,
      last_used_at  TEXT,
      disabled_at   TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sticker_owner ON sticker(owner_user_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_md5 ON sticker(md5) WHERE md5 != '';
  `);
}

function ensureBotSettingsColumns(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(bot_settings)').all().map((c) => c.name),
  );
  if (!columns.has('ai_name')) db.exec('ALTER TABLE bot_settings ADD COLUMN ai_name TEXT');
  if (!columns.has('ai_signature')) {
    db.exec('ALTER TABLE bot_settings ADD COLUMN ai_signature TEXT');
  }
  if (!columns.has('ai_avatar')) db.exec('ALTER TABLE bot_settings ADD COLUMN ai_avatar TEXT');
  if (!columns.has('silent_until_ms')) {
    db.exec('ALTER TABLE bot_settings ADD COLUMN silent_until_ms INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('bubble_delay_ms')) {
    db.exec('ALTER TABLE bot_settings ADD COLUMN bubble_delay_ms INTEGER NOT NULL DEFAULT 1200');
  }
  if (!columns.has('price_in_per_1k')) {
    db.exec('ALTER TABLE bot_settings ADD COLUMN price_in_per_1k REAL NOT NULL DEFAULT 0');
  }
  if (!columns.has('price_out_per_1k')) {
    db.exec('ALTER TABLE bot_settings ADD COLUMN price_out_per_1k REAL NOT NULL DEFAULT 0');
  }
}

function ensureUsageColumns(db) {
  const columns = new Set(
    db.prepare('PRAGMA table_info(usage_daily)').all().map((c) => c.name),
  );
  if (!columns.has('turns')) {
    db.exec('ALTER TABLE usage_daily ADD COLUMN turns INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('chars_in')) {
    db.exec('ALTER TABLE usage_daily ADD COLUMN chars_in INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('chars_out')) {
    db.exec('ALTER TABLE usage_daily ADD COLUMN chars_out INTEGER NOT NULL DEFAULT 0');
  }
}

/**
 * conversation.dsh_after_seq：从 DSH 读 assistant 消息时的游标水位。
 *
 * 没有它，`/prompt` 每次拉最近 20 条会把建会话时 recap 那一问一答里的「已恢复」也当正文
 * 搬进聊天记录。水位在建会话/recap 结束时前推，之后只捞水位之上的 assistant 正文。
 */
function ensureConversationColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(conversation)').all().map((c) => c.name));
  if (!columns.has('dsh_after_seq')) {
    db.exec('ALTER TABLE conversation ADD COLUMN dsh_after_seq INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('epoch')) {
    db.exec('ALTER TABLE conversation ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.has('announcement')) {
    db.exec('ALTER TABLE conversation ADD COLUMN announcement TEXT');
  }
  if (!columns.has('deleted_at')) {
    db.exec('ALTER TABLE conversation ADD COLUMN deleted_at INTEGER');
  }
}

// auth/schema.sql 的 CREATE TABLE IF NOT EXISTS 不会给老库补列。
function ensureAuthColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!columns.has('role')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('admin','guest'))",
    );
  }
  if (!columns.has('display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!columns.has('avatar')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  }
}

function ensureDeviceTrustColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name));
  if (!columns.has('trusted_device_id')) {
    db.exec(
      'ALTER TABLE devices ADD COLUMN trusted_device_id TEXT REFERENCES trusted_devices(id) ON DELETE SET NULL',
    );
  }
  const approvalColumns = new Set(
    db.prepare('PRAGMA table_info(device_approvals)').all().map((c) => c.name),
  );
  if (approvalColumns.size > 0 && !approvalColumns.has('failed_attempts')) {
    db.exec(
      'ALTER TABLE device_approvals ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0',
    );
  }
}

/**
 * M4.5：老库补 kind / wake_config_json / social_state_json / message 的发送者与唤醒原因。
 *
 * wake_config_json 不能只加 DEFAULT '{}' 就完事 —— 这样的老会话永远不醒。
 * 列用完整默认值做 DEFAULT，再把已有行逐条归一化；坏 JSON 也回落到完整默认。
 */
function ensureSocialColumns(db) {
  const convCols = new Set(db.prepare('PRAGMA table_info(conversation)').all().map((c) => c.name));
  if (!convCols.has('kind')) {
    db.exec(
      "ALTER TABLE conversation ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct','group'))",
    );
  }
  if (!convCols.has('wake_config_json')) {
    db.exec(
      `ALTER TABLE conversation ADD COLUMN wake_config_json TEXT NOT NULL DEFAULT '${DEFAULT_WAKE_JSON}'`,
    );
  }
  if (!convCols.has('social_state_json')) {
    db.exec("ALTER TABLE conversation ADD COLUMN social_state_json TEXT NOT NULL DEFAULT '{}'");
  }

  db.prepare(
    `UPDATE conversation
        SET wake_config_json = ?
      WHERE wake_config_json IS NULL
         OR TRIM(wake_config_json) = ''
         OR TRIM(wake_config_json) = '{}'`,
  ).run(DEFAULT_WAKE_JSON);

  // 逐条归一化：老 wake_config（enabled/minInterval）或坏 JSON 都退回完整默认。
  const rows = db.prepare('SELECT id, wake_config_json FROM conversation').all();
  const update = db.prepare('UPDATE conversation SET wake_config_json = ? WHERE id = ?');
  for (const row of rows) {
    const normalized = JSON.stringify(normalizeWakeConfig(row.wake_config_json));
    if (normalized !== row.wake_config_json) update.run(normalized, row.id);
  }

  const msgCols = new Set(db.prepare('PRAGMA table_info(message)').all().map((c) => c.name));
  if (!msgCols.has('wake_reason')) {
    db.exec('ALTER TABLE message ADD COLUMN wake_reason TEXT');
  }
  if (!msgCols.has('sender_user_id')) {
    db.exec('ALTER TABLE message ADD COLUMN sender_user_id TEXT');
  }
  if (!msgCols.has('sender_name')) {
    db.exec('ALTER TABLE message ADD COLUMN sender_name TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversation_kind ON conversation(kind, updated_at DESC)');
}

/**
 * M7a：成员表与旧会话回填。
 *
 * 这一阶段只建立成员事实并双写用户已读，鉴权仍读 conversation.user_id，
 * 等群聊真正开放时再按 member 切换读路径。
 */
function ensureMemberTable(db) {
  const memberCols = new Set(
    db.prepare('PRAGMA table_info(conversation_member)').all().map((c) => c.name),
  );
  if (!memberCols.has('join_seq')) {
    db.exec('ALTER TABLE conversation_member ADD COLUMN join_seq INTEGER NOT NULL DEFAULT 0');
  }
  if (!memberCols.has('is_admin')) {
    db.exec('ALTER TABLE conversation_member ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare(
    `UPDATE conversation_member
        SET join_seq = last_read_seq
      WHERE role = 'member' AND join_seq = 0 AND last_read_seq > 0`,
  ).run();
  db.prepare(
    `INSERT INTO conversation_member
       (conversation_id, user_id, display_name, role, joined_at, last_read_seq)
     SELECT c.id, c.user_id, COALESCE(u.display_name, u.username), 'owner',
            c.created_at, c.user_read_seq
       FROM conversation c
       LEFT JOIN users u ON u.id = c.user_id
      WHERE NOT EXISTS (
        SELECT 1 FROM conversation_member m
         WHERE m.conversation_id = c.id AND m.role = 'owner'
      )
     ON CONFLICT(conversation_id, user_id) DO UPDATE SET
       display_name = COALESCE(conversation_member.display_name, excluded.display_name),
       role = 'owner',
       last_read_seq = MAX(conversation_member.last_read_seq, excluded.last_read_seq)`,
  ).run();

  const msgCols = new Set(db.prepare('PRAGMA table_info(message)').all().map((c) => c.name));
  if (!msgCols.has('mentions')) {
    db.exec('ALTER TABLE message ADD COLUMN mentions TEXT');
  }
  if (!msgCols.has('recalled_at')) {
    db.exec('ALTER TABLE message ADD COLUMN recalled_at INTEGER');
  }
  const attCols = new Set(db.prepare('PRAGMA table_info(attachment)').all().map((c) => c.name));
  if (!attCols.has('uploader_user_id')) {
    db.exec('ALTER TABLE attachment ADD COLUMN uploader_user_id TEXT');
  }
}

function ensureInviteColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(invite)').all().map((c) => c.name));
  if (!columns.has('group_id')) {
    db.exec('ALTER TABLE invite ADD COLUMN group_id TEXT REFERENCES conversation(id) ON DELETE CASCADE');
  }
}

// 旧库只跑 CREATE TABLE IF NOT EXISTS 不会补列；这里做一次轻量 additive migration。
function ensureRebuildColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(rebuild_queue)').all().map((c) => c.name));
  if (!columns.has('attempts')) {
    db.exec('ALTER TABLE rebuild_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('last_error')) {
    db.exec('ALTER TABLE rebuild_queue ADD COLUMN last_error TEXT');
  }
  if (!columns.has('state')) {
    db.exec("ALTER TABLE rebuild_queue ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!columns.has('next_attempt_at')) {
    db.exec('ALTER TABLE rebuild_queue ADD COLUMN next_attempt_at INTEGER');
  }
  // 旧库迁移出来的行没有 next_attempt_at；回填 created_at，保证立即可被 worker 扫到。
  db.prepare(
    `UPDATE rebuild_queue SET next_attempt_at = created_at
      WHERE next_attempt_at IS NULL AND state = 'pending'`,
  ).run();
}

function integrityOk(db) {
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    return row?.integrity_check === 'ok';
  } catch {
    return false;
  }
}

function currentSchemaVersion(db) {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null;
  } catch {
    return null;
  }
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  let db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    if (!integrityOk(db)) {
      db.close();
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');
      return { db, readOnly: true, version: SCHEMA_VERSION };
    }
    db.exec('PRAGMA journal_mode = WAL;');
    const existingVersion = currentSchemaVersion(db);
    if (existingVersion && existingVersion !== SCHEMA_VERSION) {
      throw new Error(`数据库 schema_version=${existingVersion}，代码要求 ${SCHEMA_VERSION}；请先迁移`);
    }
    applySchema(db);
    return { db, readOnly: false, version: SCHEMA_VERSION };
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function nextSeq(db, conversationId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM message WHERE conversation_id = ?',
  ).get(conversationId);
  return row.next;
}

export function closeDatabase(state) {
  try { state?.db?.close(); } catch {}
}
