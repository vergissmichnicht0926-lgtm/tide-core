import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { closeDatabase, openDatabase } from '../db/index.mjs';
import { backupDatabase, verifyBackup } from '../db/backup.mjs';
import { runDailyBackup } from '../db/daily-backup.mjs';

test('VACUUM INTO 备份保留 conversation / message / 水位并可校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-backup-'));
  const dbPath = path.join(dir, 'gateway.db');
  const state = openDatabase(dbPath);
  const db = state.db;
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO conversation
        (id, user_id, kind, title, created_at, updated_at, agent_token, policy_hash, agent_read_seq)
       VALUES ('c-backup', 'u-1', 'direct', '备份测试', ?, ?, 'tok-backup', 'hash', 1)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq)
       VALUES ('m-1', 'c-backup', 'user', ?, ?, 1)`,
    ).run(JSON.stringify({ type: 'text', text: 'hello' }), now);
    db.prepare(
      `INSERT INTO message(id, conversation_id, role, content_json, created_at, seq)
       VALUES ('m-2', 'c-backup', 'assistant', ?, ?, 2)`,
    ).run(JSON.stringify({ type: 'text', text: 'hi' }), now + 1);
  } finally {
    closeDatabase(state);
  }

  const dest = path.join(dir, 'backup.db');
  const result = backupDatabase({ dbPath, destPath: dest });
  assert.equal(result.ok, true);
  assert.equal(result.source.conversations, 1);
  assert.equal(result.source.messages, 2);
  assert.ok(result.bytes > 0);
  assert.equal(verifyBackup(dbPath, dest).ok, true);
  assert.throws(() => backupDatabase({ dbPath, destPath: dest }), /已存在/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('每日备份压缩、保留七天并写成功日志', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-daily-backup-'));
  const dbPath = path.join(dir, 'gateway.db');
  const outDir = path.join(dir, 'daily');
  const logPath = path.join(dir, 'backup.log');
  const state = openDatabase(dbPath);
  try {
    state.db.prepare(
      `INSERT INTO conversation
        (id, user_id, kind, title, created_at, updated_at, agent_token, policy_hash)
       VALUES ('c-daily', 'u-1', 'direct', '每日备份', ?, ?, 'tok', 'hash')`,
    ).run(Date.now(), Date.now());
  } finally {
    closeDatabase(state);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < 9; i += 1) {
    fs.writeFileSync(path.join(outDir, `tide-2020-01-0${i}.db.gz`), 'old');
  }

  try {
    const result = runDailyBackup({
      dbPath,
      outDir,
      keep: 7,
      now: new Date('2026-11-13T19:00:00.000Z'),
      logPath,
    });
    assert.equal(result.ok, true);
    assert.equal(result.source.conversations, 1);
    assert.equal(result.pruned.length, 3);
    assert.ok(fs.existsSync(result.backup));
    const sqlite = gunzipSync(fs.readFileSync(result.backup));
    assert.equal(sqlite.subarray(0, 16).toString(), 'SQLite format 3\u0000');
    const files = fs.readdirSync(outDir).filter((name) => name.endsWith('.db.gz'));
    assert.equal(files.length, 7);
    const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('每日备份上传离机副本并双向校验哈希', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-offsite-backup-'));
  const dbPath = path.join(dir, 'gateway.db');
  const outDir = path.join(dir, 'daily');
  const keyPath = path.join(dir, 'bot_key');
  fs.writeFileSync(keyPath, 'test-key');
  const state = openDatabase(dbPath);
  try {
    state.db.prepare(
      `INSERT INTO conversation
        (id, user_id, kind, title, created_at, updated_at, agent_token, policy_hash)
       VALUES ('c-offsite', 'u-1', 'direct', '离机备份', ?, ?, 'tok', 'hash')`,
    ).run(Date.now(), Date.now());
  } finally {
    closeDatabase(state);
  }

  const calls = [];
  let uploadedHash = '';
  const runCommand = (command, args) => {
    calls.push({ command, args });
    if (command === 'scp') {
      const source = args[args.length - 2];
      uploadedHash = createHash('sha256')
        .update(fs.readFileSync(source))
        .digest('hex');
      return '';
    }
    if (command === 'ssh' && args.at(-1).startsWith('sha256sum ')) {
      return `${uploadedHash}  remote.db.gz`;
    }
    return '';
  };

  try {
    const result = runDailyBackup({
      dbPath,
      outDir,
      now: new Date('2026-11-13T20:00:00.000Z'),
      offsite: {
        keyPath,
        remote: 'admin@example.test:/home/admin/tide/backup',
      },
      runCommand,
    });
    assert.equal(result.ok, true);
    assert.equal(result.offsite.sha256, uploadedHash);
    assert.ok(calls.some((call) => call.command === 'scp'));
    assert.ok(calls.some((call) => call.args.at(-1).includes('mkdir -p')));
    assert.ok(calls.some((call) => call.args.at(-1).includes('tail -n +8')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
