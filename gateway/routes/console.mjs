/**
 * P0 管理台：/console 静态页 + /console/api/*。
 *
 * 与 App 的 /admin/* 完全分离：这里只用 cookie + CSRF，/admin/* 继续 Bearer。
 * 浏览器路径是 /tide/console（nginx 会剥掉 /tide），网关只认 /console。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { writeEvent } from '../events-store.mjs';
import { sendConsoleError, sendConsoleJson } from '../console/http.mjs';
import { getBot, getBotAvatar, patchBot } from '../console/bot.mjs';
import {
  getWake, listTools, patchLimits, patchWake,
} from '../console/config.mjs';
import {
  getConversationWake,
  patchConversationWake,
  resetConversationWake,
} from '../console/conversation-wake.mjs';
import {
  addConversationMember,
  changeConversationMemberRole,
  getMembers,
  removeConversationMember,
} from '../console/members.mjs';
import { postTestMessage } from '../console/test-send.mjs';
import { listInvites, postInvite, revokeInvite } from '../console/invites.mjs';
import { getDevices, getUsers, revokeDevice } from '../console/users.mjs';
import { listAudit, listLoginAttempts } from '../console/security.mjs';
import { buildOps } from '../console/ops.mjs';
import { currentSilence, patchSilence } from '../console/silence.mjs';
import { getSend, patchSend } from '../console/send.mjs';
import { getUsage, patchPrice } from '../console/usage.mjs';
import { loadBotSettings } from '../settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_DIR = path.join(HERE, '..', 'public', 'console');
const COOKIE = 'tide_admin';
const COOKIE_PATH = '/tide/console';
const SESSION_MS = 24 * 60 * 60 * 1000;
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const STATIC_FILES = new Map([
  ['/console/', ['index.html', 'text/html; charset=utf-8']],
  ['/console/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/console/admin.js', ['admin.js', 'application/javascript; charset=utf-8']],
  ['/console/core.js', ['core.js', 'application/javascript; charset=utf-8']],
  ['/console/views/overview.js', ['views/overview.js', 'application/javascript; charset=utf-8']],
  ['/console/views/conversations.js', ['views/conversations.js', 'application/javascript; charset=utf-8']],
  ['/console/views/simulation.js', ['views/simulation.js', 'application/javascript; charset=utf-8']],
  ['/console/views/persona.js', ['views/persona.js', 'application/javascript; charset=utf-8']],
  ['/console/views/invites.js', ['views/invites.js', 'application/javascript; charset=utf-8']],
  ['/console/views/usage.js', ['views/usage.js', 'application/javascript; charset=utf-8']],
  ['/console/views/security.js', ['views/security.js', 'application/javascript; charset=utf-8']],
  ['/console/views/tools.js', ['views/tools.js', 'application/javascript; charset=utf-8']],
  ['/console/tools.json', ['tools.json', 'application/json; charset=utf-8']],
]);

const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
})();

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader(
    'set-cookie',
    `${COOKIE}=${token}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`,
  );
}

function isLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/i, '');
  return value === '127.0.0.1' || value === '::1';
}

function clientIp(req) {
  const remote = req.socket?.remoteAddress ?? null;
  // 只采信本机反代写的 x-real-ip；局域网直连不能用头伪造来源。
  if (isLoopback(remote)) {
    const real = req.headers['x-real-ip'];
    if (typeof real === 'string' && real.trim()) return real.trim();
  }
  return remote;
}

function createAdminSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_MS);
  db.prepare(
    `INSERT INTO admin_session
       (id, user_id, token_hash, csrf_hash, created_at, expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    userId,
    sha(token),
    sha(csrf),
    created.toISOString(),
    expires.toISOString(),
    created.toISOString(),
  );
  db.prepare('DELETE FROM admin_session WHERE expires_at < ?').run(created.toISOString());
  return { token, csrf };
}

function readAdminSession(ctx, req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const db = ctx.dbState.db;
  const row = db.prepare(
    `SELECT s.id, s.user_id, s.token_hash, s.csrf_hash, s.expires_at, s.last_seen,
            u.username, u.display_name, u.role, u.disabled_at
       FROM admin_session s
       LEFT JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).get(sha(raw));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM admin_session WHERE id = ?').run(row.id);
    return null;
  }
  if (!row.username || row.disabled_at || row.role !== 'admin') {
    db.prepare('DELETE FROM admin_session WHERE id = ?').run(row.id);
    return null;
  }
  const lastSeen = row.last_seen ? Date.parse(row.last_seen) : 0;
  if (Date.now() - lastSeen > 60_000) {
    db.prepare('UPDATE admin_session SET last_seen = ? WHERE id = ?').run(nowIso(), row.id);
  }
  return {
    row,
    user: {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name || row.username,
    },
  };
}

function requireSession(ctx, req) {
  const session = readAdminSession(ctx, req);
  if (!session) {
    throw new ApiError(401, 'console-unauthorized', '请先登录管理台');
  }
  return session;
}

function requireCsrf(req, session) {
  const provided = req.headers['x-tide-csrf'];
  if (typeof provided !== 'string' || sha(provided) !== session.row.csrf_hash) {
    throw new ApiError(403, 'csrf-invalid', 'CSRF token 无效');
  }
}

function serveStatic(req, res, url) {
  const entry = STATIC_FILES.get(url.pathname);
  if (!entry) return false;
  const [file, type] = entry;
  let body;
  try {
    body = fs.readFileSync(path.join(CONSOLE_DIR, file));
  } catch {
    sendConsoleError(res, 404, 'not-found', 'console asset missing');
    return true;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'content-security-policy': CSP,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function activeUserConnections(ctx) {
  let count = 0;
  for (const connections of ctx.sseUserConnections?.values() ?? []) {
    count += connections.size;
  }
  return count;
}

async function pingDsh(dsh) {
  if (!dsh || typeof dsh.ping !== 'function') {
    return { configured: false, ok: false };
  }
  const ok = await Promise.race([
    dsh.ping().then((value) => Boolean(value)).catch(() => false),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 2000);
      timer.unref?.();
    }),
  ]);
  return { configured: true, ok };
}

async function checkTunnel(ctx) {
  if (!ctx.publicBaseUrl) return { ok: null, latencyMs: null };
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  timer.unref?.();
  try {
    const response = await fetch(`${ctx.publicBaseUrl}/health`, {
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok && body?.ok === true,
      latencyMs: Date.now() - started,
    };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

function checkCert(publicBaseUrl) {
  if (!publicBaseUrl) return Promise.resolve({ ok: null, daysLeft: null, notAfter: null });
  let url;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    return Promise.resolve({ ok: null, daysLeft: null, notAfter: null });
  }
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const socket = tls.connect({
      host,
      port,
      rejectUnauthorized: false,
      ...(isIp ? {} : { servername: host }),
    }, () => {
      try {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          finish({ ok: false, daysLeft: null, notAfter: null });
          return;
        }
        const notAfter = new Date(cert.valid_to);
        const daysLeft = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
        const validFrom = new Date(cert.valid_from);
        const lifetimeDays = Number.isNaN(validFrom.getTime())
          ? null
          : (notAfter.getTime() - validFrom.getTime()) / 86_400_000;
        // 6 天短证书（IP 入口）按短寿命阈值，避免永久红灯。
        const shortLived = lifetimeDays !== null && lifetimeDays <= 14;
        const redBelow = shortLived ? 1 : 7;
        finish({
          ok: daysLeft >= redBelow,
          daysLeft,
          notAfter: notAfter.toISOString(),
          shortLived,
        });
      } catch {
        finish({ ok: false, daysLeft: null, notAfter: null });
      }
    });
    socket.setTimeout(3000, () => {
      socket.destroy();
      finish({ ok: false, daysLeft: null, notAfter: null });
    });
    socket.on('error', () => finish({ ok: false, daysLeft: null, notAfter: null }));
  });
}

function backupLight(ctx) {
  const db = ctx.dbState.db;
  const row = db.prepare(
    "SELECT at FROM event_log WHERE kind = 'backup.ok' ORDER BY id DESC LIMIT 1",
  ).get();
  let lastAt = row?.at ?? null;
  if (!lastAt && ctx.dbPath) {
    try {
      const dir = path.join(path.dirname(ctx.dbPath), 'backups', 'daily');
      const files = fs.readdirSync(dir).filter((name) => name.endsWith('.gz'));
      let newest = 0;
      for (const name of files) {
        const mtime = fs.statSync(path.join(dir, name)).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
      if (newest > 0) lastAt = new Date(newest).toISOString();
    } catch {
      // 目录不存在就当作没有备份数据
    }
  }
  if (!lastAt) return { ok: null, lastAt: null, ageHours: null };
  const ageHours = (Date.now() - Date.parse(lastAt)) / 3_600_000;
  return {
    ok: ageHours <= 72,
    warn: ageHours > 36 && ageHours <= 72,
    lastAt,
    ageHours: Math.round(ageHours * 10) / 10,
  };
}

async function buildOverview(ctx) {
  const db = ctx.dbState.db;
  const realtime = ctx.realtime ?? {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const todayIso = today.toISOString();
  const dsh = await pingDsh(ctx.dsh);
  const [tunnel, cert] = await Promise.all([
    checkTunnel(ctx),
    checkCert(ctx.publicBaseUrl),
  ]);
  const countEvent = (kind) => db.prepare(
    'SELECT COUNT(*) AS n FROM event_log WHERE kind = ? AND at >= ?',
  ).get(kind, todayIso).n;
  const events = db.prepare(
    `SELECT at, level, kind, conversation_id, detail
       FROM event_log ORDER BY id DESC LIMIT 50`,
  ).all().map((row) => ({
    at: row.at,
    level: row.level,
    kind: row.kind,
    conversationId: row.conversation_id,
    detail: row.detail,
  }));
  return {
    at: nowIso(),
    mode: realtime.mode ?? 'legacy',
    version: APP_VERSION,
    silentUntil: loadBotSettings(db).silentUntil,
    dbVersion: String(ctx.dbState.version ?? ''),
    lights: {
      gateway: { ok: true, uptimeSec: Math.round(process.uptime()) },
      db: { ok: true, readonly: Boolean(ctx.dbState.readOnly) },
      dsh,
      tunnel,
      cert,
      backup: backupLight(ctx),
    },
    metrics: {
      activeUserConnections: activeUserConnections(ctx),
      todayMessages: db.prepare(
        'SELECT COUNT(*) AS n FROM message WHERE created_at >= ?',
      ).get(todayMs).n,
      todayFailed: countEvent('message.failed'),
      cursorAhead: ctx.realtimeStats?.cursorAhead ?? 0,
      replaySkipped: ctx.realtimeStats?.replaySkipped ?? 0,
      epochChanged: ctx.realtimeStats?.epochChanged ?? 0,
      conversationCount: db.prepare(
        'SELECT COUNT(*) AS n FROM conversation WHERE deleted_at IS NULL',
      ).get().n,
      sessionRebuilds: countEvent('session.rebuild'),
      uptimeSec: Math.round(process.uptime()),
    },
    events,
  };
}

function buildConversations(ctx) {
  const membersOf = ctx.dbState.db.prepare(
    `SELECT m.user_id, m.display_name, m.role, m.is_admin,
            u.username, u.display_name AS user_display_name
       FROM conversation_member m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END, m.joined_at ASC
      LIMIT 50`,
  );
  const rows = ctx.dbState.db.prepare(
    `SELECT c.id, c.kind, c.title, c.updated_at, c.epoch,
            c.dsh_session_id, c.dsh_workspace_id,
            (SELECT COUNT(*) FROM conversation_member m
              WHERE m.conversation_id = c.id) AS members,
            (SELECT COALESCE(MAX(seq), 0) FROM message msg
              WHERE msg.conversation_id = c.id) AS latest_seq,
            (SELECT state FROM rebuild_queue r
              WHERE r.conversation_id = c.id
              ORDER BY CASE r.state WHEN 'pending' THEN 0 ELSE 1 END
              LIMIT 1) AS rebuild_state
       FROM conversation c
      WHERE c.deleted_at IS NULL
      ORDER BY c.updated_at DESC
      LIMIT 200`,
  ).all();
  return {
    conversations: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      members: row.members,
      latestSeq: row.latest_seq,
      epoch: row.epoch,
      dshSessionId: row.dsh_session_id ?? null,
      dshWorkspaceId: row.dsh_workspace_id ?? null,
      updatedAt: new Date(row.updated_at).toISOString(),
      rebuildState: row.rebuild_state ?? null,
      membersDetail: membersOf.all(row.id).map((member) => ({
        userId: member.user_id,
        name: member.display_name
          || member.user_display_name
          || member.username
          || member.user_id,
        role: member.role === 'owner'
          ? 'owner'
          : (member.is_admin ? 'admin' : 'member'),
      })),
    })),
  };
}

function listConversationEvents(ctx, conversationId, url) {
  const parsed = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(parsed) && parsed > 0 ? Math.min(50, parsed) : 5;
  const events = ctx.dbState.db.prepare(
    `SELECT id, at, level, kind, conversation_id, detail
       FROM event_log
      WHERE conversation_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  ).all(conversationId, limit).map((row) => ({
    id: row.id,
    at: row.at,
    level: row.level,
    kind: row.kind,
    conversationId: row.conversation_id,
    detail: row.detail,
  }));
  return { conversationId, events };
}

function isJson(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  return type.startsWith('application/json');
}

async function postSession(ctx, req, res) {
  if (!isJson(req)) {
    return sendConsoleError(res, 415, 'unsupported-media-type', 'content-type 必须是 application/json');
  }
  const body = await readJson(req);
  const ip = clientIp(req);
  let user;
  try {
    user = await ctx.authService.authenticateAdmin({
      username: body?.username,
      password: body?.password,
      ip,
    });
  } catch (error) {
    writeEvent(ctx.dbState.db, {
      level: 'warn',
      kind: 'console.login',
      detail: { ok: false, username: String(body?.username ?? ''), ip, reason: error?.code ?? 'error' },
    });
    throw error;
  }
  const session = createAdminSession(ctx.dbState.db, user.userId);
  writeEvent(ctx.dbState.db, {
    level: 'info',
    kind: 'console.login',
    detail: { ok: true, username: user.username, ip },
  });
  setSessionCookie(res, session.token, Math.floor(SESSION_MS / 1000));
  return sendConsoleJson(res, 200, {
    ok: true, user, csrfToken: session.csrf, version: APP_VERSION,
  });
}

function getSession(ctx, req, res) {
  const session = requireSession(ctx, req);
  const csrf = randomBytes(32).toString('base64url');
  ctx.dbState.db.prepare(
    'UPDATE admin_session SET csrf_hash = ?, last_seen = ? WHERE id = ?',
  ).run(sha(csrf), nowIso(), session.row.id);
  return sendConsoleJson(res, 200, {
    ok: true, user: session.user, csrfToken: csrf, version: APP_VERSION,
  });
}

function deleteSession(ctx, req, res) {
  const session = requireSession(ctx, req);
  requireCsrf(req, session);
  ctx.dbState.db.prepare('DELETE FROM admin_session WHERE id = ?').run(session.row.id);
  setSessionCookie(res, '', 0);
  return sendConsoleJson(res, 200, { ok: true });
}

export async function handleConsole(req, res, url, ctx) {
  try {
    return await routeConsole(req, res, url, ctx);
  } catch (error) {
    if (res.headersSent) {
      try { res.end(); } catch {}
      return;
    }
    const status = Number(error?.status) || 500;
    return sendConsoleError(
      res,
      status,
      error?.code || 'internal',
      error?.message || 'internal error',
      error?.extra,
    );
  }
}

async function routeConsole(req, res, url, ctx) {
  if (String(process.env.TIDE_CONSOLE ?? '1').trim() === '0') {
    return sendConsoleError(res, 404, 'not-found', 'console disabled');
  }
  if (url.pathname === '/console') {
    // 相对跳转：浏览器在 /tide/console 时会落到 /tide/console/，直连 /console 也能落对。
    res.writeHead(301, { location: 'console/' });
    res.end();
    return;
  }
  if (STATIC_FILES.has(url.pathname)) {
    serveStatic(req, res, url);
    return;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] !== 'api') {
    return sendConsoleError(res, 404, 'not-found', 'console route not found');
  }
  const api = parts.slice(2).join('/');

  if (api === 'session') {
    if (req.method === 'POST') return postSession(ctx, req, res);
    if (req.method === 'GET') return getSession(ctx, req, res);
    if (req.method === 'DELETE') return deleteSession(ctx, req, res);
    return sendConsoleError(res, 405, 'method-not-allowed', 'method not allowed');
  }

  const session = requireSession(ctx, req);
  if (api === 'overview' && req.method === 'GET') {
    return sendConsoleJson(res, 200, await buildOverview(ctx));
  }
  if (api === 'conversations' && req.method === 'GET') {
    return sendConsoleJson(res, 200, buildConversations(ctx));
  }
  let match = /^conversations\/([^/]+)\/events$/.exec(api);
  if (match && req.method === 'GET') {
    return sendConsoleJson(
      res,
      200,
      listConversationEvents(ctx, decodeURIComponent(match[1]), url),
    );
  }
  match = /^conversations\/([^/]+)\/wake$/.exec(api);
  if (match && req.method === 'GET') {
    return sendConsoleJson(
      res,
      200,
      getConversationWake(ctx, decodeURIComponent(match[1])),
    );
  }
  if (match && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      await patchConversationWake(ctx, req, session, decodeURIComponent(match[1])),
    );
  }
  match = /^conversations\/([^/]+)\/wake\/reset$/.exec(api);
  if (match && req.method === 'POST') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      resetConversationWake(ctx, session, decodeURIComponent(match[1])),
    );
  }
  match = /^conversations\/([^/]+)\/members$/.exec(api);
  if (match && req.method === 'GET') {
    return sendConsoleJson(
      res,
      200,
      getMembers(ctx, session, decodeURIComponent(match[1])),
    );
  }
  if (match && req.method === 'POST') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      await addConversationMember(ctx, req, session, decodeURIComponent(match[1])),
    );
  }
  match = /^conversations\/([^/]+)\/members\/([^/]+)$/.exec(api);
  if (match && req.method === 'DELETE') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      removeConversationMember(
        ctx,
        session,
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      ),
    );
  }
  match = /^conversations\/([^/]+)\/members\/([^/]+)\/role$/.exec(api);
  if (match && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      await changeConversationMemberRole(
        ctx,
        req,
        session,
        decodeURIComponent(match[1]),
        decodeURIComponent(match[2]),
      ),
    );
  }
  match = /^conversations\/([^/]+)\/test-message$/.exec(api);
  if (match && req.method === 'POST') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      await postTestMessage(ctx, req, session, decodeURIComponent(match[1])),
    );
  }

  if (api === 'bot' && req.method === 'GET') {
    return sendConsoleJson(res, 200, getBot(ctx));
  }
  if (api === 'bot' && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, await patchBot(ctx, req, session));
  }
  if (api === 'bot/avatar' && req.method === 'GET') {
    return getBotAvatar(ctx, res);
  }
  if (api === 'bot/wake' && req.method === 'GET') {
    return sendConsoleJson(res, 200, getWake(ctx));
  }
  if (api === 'bot/wake' && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, await patchWake(ctx, req, session));
  }
  if (api === 'bot/limits' && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, await patchLimits(ctx, req, session));
  }
  if (api === 'bot/silence' && req.method === 'GET') {
    return sendConsoleJson(res, 200, { ok: true, ...currentSilence(ctx) });
  }
  if (api === 'bot/silence' && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, await patchSilence(ctx, req, session));
  }
  if (api === 'bot/send' && req.method === 'GET') {
    return sendConsoleJson(res, 200, { ok: true, ...getSend(ctx) });
  }
  if (api === 'bot/send' && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, await patchSend(ctx, req, session));
  }
  if (api === 'bot/price' && req.method === 'PATCH') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, await patchPrice(ctx, req, session));
  }
  if (api === 'usage' && req.method === 'GET') {
    return sendConsoleJson(res, 200, getUsage(ctx, url));
  }
  if (api === 'tools' && req.method === 'GET') {
    return sendConsoleJson(res, 200, listTools());
  }
  if (api === 'ops' && req.method === 'GET') {
    return sendConsoleJson(res, 200, buildOps(ctx, APP_VERSION));
  }

  if (api === 'invites' && req.method === 'GET') {
    return sendConsoleJson(res, 200, listInvites(ctx));
  }
  if (api === 'invites' && req.method === 'POST') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 201, await postInvite(ctx, req, session));
  }
  match = /^invites\/([^/]+)\/revoke$/.exec(api);
  if (match && req.method === 'POST') {
    requireCsrf(req, session);
    return sendConsoleJson(res, 200, revokeInvite(ctx, session, decodeURIComponent(match[1])));
  }

  if (api === 'users' && req.method === 'GET') {
    return sendConsoleJson(res, 200, getUsers(ctx, url));
  }
  match = /^users\/([^/]+)\/devices$/.exec(api);
  if (match && req.method === 'GET') {
    return sendConsoleJson(res, 200, getDevices(ctx, decodeURIComponent(match[1])));
  }
  match = /^users\/([^/]+)\/devices\/([^/]+)\/revoke$/.exec(api);
  if (match && req.method === 'POST') {
    requireCsrf(req, session);
    return sendConsoleJson(
      res,
      200,
      revokeDevice(ctx, session, decodeURIComponent(match[1]), decodeURIComponent(match[2])),
    );
  }

  if (api === 'audit' && req.method === 'GET') {
    return sendConsoleJson(res, 200, listAudit(ctx, url));
  }
  if (api === 'login-attempts' && req.method === 'GET') {
    return sendConsoleJson(res, 200, listLoginAttempts(ctx, url));
  }

  return sendConsoleError(res, 404, 'not-found', 'console api not found');
}
