/** 管理台 P5 运维块：探活状态、备份、网关与数据库（只读）。 */

import fs from 'node:fs';
import path from 'node:path';

const PROBE_STALE_MS = 10 * 60 * 1000;

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function probeBlock(dataDir, now) {
  const file = path.join(dataDir, 'probe-status.json');
  const empty = {
    status: 'missing',
    lastCheckAt: null,
    ageSec: null,
    lastResult: null,
    lastRestartAt: null,
    restartMs: null,
    targetPid: null,
    reason: null,
    error: null,
  };
  if (!fs.existsSync(file)) return empty;
  const data = readJson(file);
  if (!data || typeof data !== 'object') return empty;

  const parsed = Date.parse(data.lastCheckAt || '');
  const ageMs = Number.isFinite(parsed) ? now - parsed : null;
  const base = {
    lastCheckAt: data.lastCheckAt ?? null,
    ageSec: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
    lastResult: data.lastResult ?? null,
    lastRestartAt: data.lastRestartAt ?? null,
    restartMs: data.restartMs == null || !Number.isFinite(Number(data.restartMs))
      ? null
      : Number(data.restartMs),
    targetPid: data.targetPid == null || !Number.isFinite(Number(data.targetPid))
      ? null
      : Number(data.targetPid),
    reason: data.reason ?? null,
    error: data.error ?? null,
  };
  if (ageMs === null) return { ...empty, ...base, status: 'missing' };
  if (ageMs > PROBE_STALE_MS) return { ...base, status: 'stale' };
  if (data.lastResult === 'failed') return { ...base, status: 'failed' };
  return { ...base, status: 'ok' };
}

function lastBackupEntry(dataDir) {
  try {
    const lines = fs.readFileSync(path.join(dataDir, 'backup.log'), 'utf8')
      .split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const row = JSON.parse(lines[i]);
        if (row && row.ok === true && row.at) return row;
      } catch {
        // 跳过坏行
      }
    }
  } catch {
    // 没有 backup.log
  }
  return null;
}

function backupBlock(ctx, now) {
  const entry = lastBackupEntry(path.dirname(ctx.dbPath));
  if (entry) {
    const parsed = Date.parse(entry.at);
    const ageSec = Number.isFinite(parsed) ? Math.max(0, Math.round((now - parsed) / 1000)) : null;
    const offsite = entry.offsite && typeof entry.offsite === 'object'
      ? {
          ok: true,
          remotePath: entry.offsite.remotePath ?? null,
          sha256: entry.offsite.sha256 ?? null,
        }
      : { ok: false, remotePath: null, sha256: null };
    return {
      ok: ageSec !== null && ageSec <= 48 * 3600,
      lastAt: entry.at,
      ageSec,
      bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : null,
      fileName: entry.backup ? path.basename(String(entry.backup)) : null,
      offsite,
    };
  }

  // 回退：扫 daily 目录最新 mtime
  let newest = 0;
  let fileName = null;
  try {
    const dir = path.join(path.dirname(ctx.dbPath), 'backups', 'daily');
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.gz'))) {
      const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        fileName = name;
      }
    }
  } catch {
    // 目录不存在
  }
  if (!newest) {
    return {
      ok: false, lastAt: null, ageSec: null, bytes: null, fileName: null,
      offsite: { ok: false, remotePath: null, sha256: null },
    };
  }
  const ageSec = Math.max(0, Math.round((now - newest) / 1000));
  return {
    ok: ageSec <= 48 * 3600,
    lastAt: new Date(newest).toISOString(),
    ageSec,
    bytes: null,
    fileName,
    offsite: { ok: false, remotePath: null, sha256: null },
  };
}

export function buildOps(ctx, version, now = Date.now()) {
  const dataDir = path.dirname(ctx.dbPath);
  return {
    at: new Date(now).toISOString(),
    probe: probeBlock(dataDir, now),
    gateway: {
      ok: true,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      version: String(version || ''),
    },
    db: {
      ok: true,
      readonly: Boolean(ctx.dbState.readOnly),
      sizeBytes: fileSize(ctx.dbPath),
      walBytes: fileSize(`${ctx.dbPath}-wal`),
    },
    backup: backupBlock(ctx, now),
  };
}
