import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, nextSeq, openDatabase } from '../db/index.mjs';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-db-'));
  return { dir, dbPath: path.join(dir, 'gateway.db') };
}

function seedConversation(db, id = 'c1', token = 'a'.repeat(48)) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO conversation
       (id, user_id, title, created_at, updated_at, agent_token, policy, policy_hash)
     VALUES (?, 'u1', 'test', ?, ?, ?, 'restricted', 'hash')`,
  ).run(id, now, now, token);
}

test('schema, constraints, seq and cascade', () => {
  const { dir, dbPath } = tempDb();
  const state = openDatabase(dbPath);
  const { db } = state;
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const name of [
      'conversation', 'conversation_member', 'message', 'attachment', 'seen_seq', 'message_batch',
      'agent_memory', 'pending_wake', 'send_queue', 'rebuild_queue', 'users', 'devices',
      'login_attempts',
    ]) {
      assert.ok(tables.includes(name), `missing table ${name}`);
    }
    seedConversation(db);
    const conv = db.prepare(
      'SELECT kind, wake_config_json, social_state_json, epoch, dsh_after_seq FROM conversation WHERE id = ?',
    ).get('c1');
    assert.equal(conv.kind, 'direct');
    assert.equal(conv.epoch, 1);
    assert.equal(conv.dsh_after_seq, 0);
    const wake = JSON.parse(conv.wake_config_json);
    assert.equal(wake.mode, 'diving');
    assert.equal(wake.triggers.atMention, true);
    assert.equal(wake.confirmedBy, 'default');
    assert.equal(conv.social_state_json, '{}');
    db.prepare(
      `INSERT INTO conversation_member
         (conversation_id, user_id, display_name, role, joined_at, last_read_seq)
       VALUES ('c1', 'u1', 'u1', 'owner', ?, 0)`,
    ).run(Date.now());
    assert.throws(() => db.prepare(
      `INSERT INTO conversation_member
         (conversation_id, user_id, display_name, role, joined_at, last_read_seq)
       VALUES ('c1', 'u2', 'u2', 'owner', ?, 0)`,
    ).run(Date.now()), /UNIQUE/);
    assert.equal(nextSeq(db, 'c1'), 1);
    db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq, client_msg_id)
       VALUES ('m1', 'c1', 'user', '{}', ?, 1, 'cm1')`,
    ).run(Date.now());
    assert.throws(() => db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq, client_msg_id)
       VALUES ('m2', 'c1', 'user', '{}', ?, 1, 'cm2')`,
    ).run(Date.now()), /UNIQUE/);
    assert.throws(() => db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq, client_msg_id)
       VALUES ('m3', 'c1', 'user', '{}', ?, 2, 'cm1')`,
    ).run(Date.now()), /UNIQUE/);
    db.prepare('DELETE FROM conversation WHERE id = ?').run('c1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message').get().n, 0);
    const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
    assert.equal(String(mode).toLowerCase(), 'wal');
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only connection rejects writes', () => {
  const { dir, dbPath } = tempDb();
  const state = openDatabase(dbPath);
  closeDatabase(state);
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.throws(() => ro.exec('CREATE TABLE nope(x)'));
  } finally {
    ro.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('message_batch and seen_seq primary keys', () => {
  const { dir, dbPath } = tempDb();
  const state = openDatabase(dbPath);
  const { db } = state;
  try {
    seedConversation(db);
    db.prepare(
      `INSERT INTO message_batch(conversation_id, client_batch_id, payload_hash, message_ids_json, created_at)
       VALUES ('c1', 'b1', 'h', '[]', ?)`,
    ).run(Date.now());
    assert.throws(() => db.prepare(
      `INSERT INTO message_batch(conversation_id, client_batch_id, payload_hash, message_ids_json, created_at)
       VALUES ('c1', 'b1', 'h2', '[]', ?)`,
    ).run(Date.now()), /UNIQUE/);
    db.prepare("INSERT INTO seen_seq(conversation_id, viewer, seq) VALUES ('c1', 'agent', 1)").run();
    assert.throws(() => db.prepare(
      "INSERT INTO seen_seq(conversation_id, viewer, seq) VALUES ('c1', 'agent', 1)",
    ).run(), /UNIQUE/);
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuild_queue 旧库打开时补 attempts / state 等四列', () => {
  const { dir, dbPath } = tempDb();
  const createdAt = Date.now();
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE rebuild_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    legacy.prepare(
      'INSERT INTO rebuild_queue(conversation_id, reason, created_at) VALUES (?, ?, ?)',
    ).run('c-legacy', 'policy:owner', createdAt);
  } finally {
    legacy.close();
  }

  // 只读连接不会执行 additive migration：老库在只读进程里没有 epoch。
  const readOnly = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = new Set(
      readOnly.prepare('PRAGMA table_info(conversation)').all().map((c) => c.name),
    );
    assert.equal(columns.has('epoch'), false);
  } finally {
    readOnly.close();
  }

  const state = openDatabase(dbPath);
  try {
    const columns = new Set(
      state.db.prepare('PRAGMA table_info(rebuild_queue)').all().map((c) => c.name),
    );
    for (const name of ['attempts', 'last_error', 'state', 'next_attempt_at']) {
      assert.ok(columns.has(name), `missing column ${name}`);
    }
    const row = state.db.prepare(
      `SELECT attempts, last_error, state, created_at, next_attempt_at
         FROM rebuild_queue WHERE conversation_id = ?`,
    ).get('c-legacy');
    assert.equal(row.attempts, 0);
    assert.equal(row.last_error, null);
    assert.equal(row.state, 'pending');
    assert.equal(row.created_at, createdAt);
    assert.equal(row.next_attempt_at, createdAt);
    const claimed = state.db.prepare(
      `SELECT id FROM rebuild_queue
        WHERE conversation_id = ? AND state = 'pending'
          AND COALESCE(next_attempt_at, 0) <= ?`,
    ).all('c-legacy', Date.now());
    assert.equal(claimed.length, 1);
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conversation 旧库打开时补 epoch 和 dsh_after_seq，epoch 默认 1', () => {
  const { dir, dbPath } = tempDb();
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE conversation (
        id TEXT PRIMARY KEY,
        legacy_key TEXT UNIQUE,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'direct',
        title TEXT NOT NULL,
        avatar TEXT,
        summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        dsh_session_id TEXT,
        dsh_workspace_id TEXT,
        agent_token TEXT NOT NULL,
        policy TEXT NOT NULL DEFAULT 'restricted',
        policy_hash TEXT NOT NULL,
        user_read_seq INTEGER NOT NULL DEFAULT 0,
        agent_read_seq INTEGER NOT NULL DEFAULT 0,
        recap_at INTEGER,
        wake_config_json TEXT NOT NULL DEFAULT '{}',
        social_state_json TEXT NOT NULL DEFAULT '{}'
      )
    `);
    legacy.prepare(
      `INSERT INTO conversation
         (id, user_id, title, created_at, updated_at, agent_token, policy, policy_hash)
       VALUES (?, 'u-legacy', 'legacy', ?, ?, ?, 'restricted', 'hash')`,
    ).run('c-legacy', Date.now(), Date.now(), 'a'.repeat(48));
  } finally {
    legacy.close();
  }

  const state = openDatabase(dbPath);
  try {
    const columns = new Set(
      state.db.prepare('PRAGMA table_info(conversation)').all().map((c) => c.name),
    );
    assert.ok(columns.has('dsh_after_seq'));
    assert.ok(columns.has('epoch'));
    const row = state.db.prepare(
      'SELECT epoch, dsh_after_seq FROM conversation WHERE id = ?',
    ).get('c-legacy');
    assert.equal(row.epoch, 1);
    assert.equal(row.dsh_after_seq, 0);
  } finally {
    closeDatabase(state);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
