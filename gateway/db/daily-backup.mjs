import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { backupDatabase } from './backup.mjs';

export function runDailyBackup({
  dbPath,
  outDir,
  keep = 7,
  now = new Date(),
  logPath = null,
  offsite = null,
  runCommand = runCommandOrThrow,
}) {
  if (!dbPath || !outDir) throw new Error('dbPath 与 outDir 必填');
  const keepCount = Number.isSafeInteger(keep) && keep > 0 ? keep : 7;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const tempPath = path.join(outDir, `.tide-${stamp}.db`);
  const backupPath = path.join(outDir, `tide-${stamp}.db.gz`);
  fs.mkdirSync(outDir, { recursive: true });

  let result;
  let compressed;
  try {
    result = backupDatabase({ dbPath, destPath: tempPath });
    if (!result.ok) throw new Error('备份完整性校验失败');
    compressed = gzipSync(fs.readFileSync(tempPath), { level: 9 });
    fs.writeFileSync(backupPath, compressed);
    fs.rmSync(tempPath, { force: true });
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    fs.rmSync(backupPath, { force: true });
    appendLog(logPath, {
      ok: false,
      at: now.toISOString(),
      error: error?.message ?? String(error),
    });
    throw error;
  }

  let offsiteResult = null;
  if (offsite) {
    try {
      offsiteResult = uploadOffsite({ backupPath, ...offsite, runCommand });
    } catch (error) {
      appendLog(logPath, {
        ok: false,
        at: now.toISOString(),
        backup: backupPath,
        bytes: compressed.length,
        error: `离机备份失败: ${error?.message ?? String(error)}`,
      });
      throw error;
    }
  }

  const pruned = pruneBackups(outDir, keepCount, backupPath);
  const entry = {
    ok: true,
    at: now.toISOString(),
    backup: backupPath,
    bytes: compressed.length,
    source: result.source,
    backupSummary: result.backup,
    offsite: offsiteResult,
    pruned,
  };
  appendLog(logPath, entry);
  return entry;
}

export function uploadOffsite({
  backupPath,
  keyPath,
  remote,
  scpExe = 'scp',
  sshExe = 'ssh',
  runCommand = runCommandOrThrow,
}) {
  if (!fs.existsSync(backupPath)) throw new Error(`本地备份不存在: ${backupPath}`);
  if (!keyPath || !fs.existsSync(keyPath)) throw new Error(`SSH key 不存在: ${keyPath}`);
  const split = String(remote ?? '').indexOf(':');
  if (split < 1) throw new Error('远端地址必须是 user@host:/dir');
  const host = remote.slice(0, split);
  const remoteDir = remote.slice(split + 1).replace(/\/+$/, '');
  const remotePath = `${remoteDir}/${path.basename(backupPath)}`;
  const sshOptions = [
    '-i', keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
  ];
  runCommand(sshExe, [
    ...sshOptions,
    host,
    `mkdir -p ${shellQuote(remoteDir)}`,
  ]);
  runCommand(scpExe, [
    ...sshOptions,
    backupPath,
    `${host}:${remotePath}`,
  ]);
  const localHash = createHash('sha256')
    .update(fs.readFileSync(backupPath))
    .digest('hex');
  const remoteHashLine = runCommand(sshExe, [
    ...sshOptions,
    host,
    `sha256sum ${shellQuote(remotePath)}`,
  ]);
  const remoteHash = remoteHashLine.trim().split(/\s+/)[0];
  if (remoteHash !== localHash) {
    throw new Error(`远端哈希不一致: local=${localHash} remote=${remoteHash}`);
  }
  runCommand(sshExe, [
    ...sshOptions,
    host,
    `cd ${shellQuote(remoteDir)} && ls -1t tide-*.db.gz 2>/dev/null | tail -n +8 | xargs -r rm -f`,
  ]);
  return { host, remotePath, sha256: remoteHash };
}

export function runCommandOrThrow(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} 退出码 ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

export function pruneBackups(outDir, keep, currentPath = null) {
  const keepCount = Number.isSafeInteger(keep) && keep > 0 ? keep : 7;
  const files = fs.readdirSync(outDir)
    .filter((name) => /^tide-.*\.db\.gz$/.test(name))
    .sort()
    .reverse();
  const keepSet = new Set(files.slice(0, keepCount));
  if (currentPath) keepSet.add(path.basename(currentPath));
  const removed = [];
  for (const name of files) {
    if (keepSet.has(name)) continue;
    fs.rmSync(path.join(outDir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

function appendLog(logPath, entry) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
