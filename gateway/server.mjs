import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth/service.mjs';
import { unauthorized } from './auth/errors.mjs';
import { newSecret } from './auth/jwt.mjs';
import { closeDatabase, openDatabase } from './db/index.mjs';
import { createDsh } from './dsh/client.mjs';
import { createRecapBuilder } from './dsh/recap.mjs';
import { createEventBus } from './events.mjs';
import { readJson, sendError, sendJson } from './http.mjs';
import { handleLanding } from './routes/landing.mjs';
import {
  parseRealtimeConfig,
  realtimeModeForUser,
  STREAM_REPLAY_LIMIT,
} from './realtime-config.mjs';
import { loadBotSettings } from './settings.mjs';
import { createAuthRoutes } from './routes/auth.mjs';
import { handleAdmin } from './routes/admin.mjs';
import { handleAgent } from './routes/agent.mjs';
import {
  createConversationForUser,
  handleAttachmentDownload,
  handleConversations,
  handleUserStream,
} from './routes/conversations.mjs';
import { handleHealth } from './routes/health.mjs';
import { handleMoments } from './routes/moments.mjs';
import { handleStickers } from './routes/stickers.mjs';
import { handleGroups, handleInvites, handleRequests } from './routes/requests.mjs';
import { handleUserAvatar } from './routes/users.mjs';
import { handleConsole } from './routes/console.mjs';
import { writeEvent } from './events-store.mjs';
import { createRebuildWorker } from './rebuild/worker.mjs';
import { createSocialEngine } from './social/engine.mjs';

function bearer(req) {
  const raw = req.headers.authorization || '';
  const match = typeof raw === 'string' ? raw.match(/^Bearer\s+(.+)$/i) : null;
  return match ? match[1].trim() : null;
}

function routeMatch(pattern, pathname) {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(':')) {
      params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    } else if (expected[i] !== actual[i]) {
      return null;
    }
  }
  return params;
}

async function handleAuth(req, res, url, ctx) {
  // route.public 目前只作文档标记：/auth/* 不经过 Bearer 中间件，
  // 需要登录的 handler（devices/me）自己调用 service.authenticate。
  for (const route of ctx.authRoutes || []) {
    const params = routeMatch(route.path, url.pathname);
    if (!params || route.method !== req.method) continue;
    const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
    const result = await route.handle({
      body,
      params,
      headers: req.headers,
      url,
      ctx,
    });
    return sendJson(res, result.status || 200, result.body);
  }
  return sendError(res, 404, 'not-found', 'auth route not found');
}

export async function createGateway(options = {}) {
  const dbPath = path.resolve(options.dbPath || process.env.TIDE_DB_PATH || './data/gateway.db');
  const workspaceRoot = path.resolve(
    options.workspaceRoot
      || process.env.TIDE_WORKSPACE_ROOT
      || path.join(path.dirname(dbPath), 'workspaces'),
  );
  const dshBaseUrl = options.dshBaseUrl ?? process.env.TIDE_DSH_BASE_URL ?? '';
  const ownerIds = options.ownerIds
    ?? (process.env.TIDE_OWNER_IDS
      ? process.env.TIDE_OWNER_IDS.split(',').map((s) => s.trim()).filter(Boolean)
      : []);
  const agentSecret = options.agentSecret !== undefined
    ? options.agentSecret
    : (process.env.TIDE_AGENT_SECRET || null);
  const uploadMaxBytes = Number(
    options.uploadMaxBytes ?? process.env.TIDE_UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024,
  );
  const conversationMaxBytes = Number(
    options.conversationMaxBytes
      ?? process.env.TIDE_CONVERSATION_MAX_BYTES
      ?? 200 * 1024 * 1024,
  );
  const publicBaseUrl = String(
    options.publicBaseUrl ?? process.env.TIDE_PUBLIC_BASE_URL ?? '',
  ).trim().replace(/\/+$/, '');
  const deviceTrustRequired = options.deviceTrustRequired
    ?? process.env.TIDE_DEVICE_TRUST_REQUIRED === '1';
  const deviceTrustEnrollDeadline = options.deviceTrustEnrollDeadline
    ?? process.env.TIDE_DEVICE_TRUST_ENROLL_DEADLINE
    ?? null;
  const dbState = openDatabase(dbPath);
  const jwtSecret = options.jwtSecret || process.env.TIDE_JWT_SECRET || newSecret();
  if (!options.jwtSecret && !process.env.TIDE_JWT_SECRET) {
    console.warn('[tide-gateway] TIDE_JWT_SECRET 未设置，使用临时 secret；重启后 access/refresh 全部失效');
  }
  const authService = options.authService || createAuthService({
    db: dbState.db,
    secret: jwtSecret,
    deviceTrustRequired,
    deviceTrustEnrollDeadline,
  });
  const authRoutes = options.authRoutes || createAuthRoutes({ service: authService });
  const logger = options.logger || console;
  const realtime = parseRealtimeConfig(options);
  const events = options.events ?? createEventBus({
    logger,
    lookupConversation(conversationId) {
      const epochRow = dbState.db
        .prepare('SELECT epoch FROM conversation WHERE id = ?')
        .get(conversationId);
      const members = dbState.db
        .prepare(
          `SELECT m.user_id
             FROM conversation_member m
             JOIN users u ON u.id = m.user_id
            WHERE m.conversation_id = ? AND u.disabled_at IS NULL`,
        )
        .all(conversationId);
      return {
        epoch: epochRow?.epoch ?? 1,
        userIds: members.map((row) => row.user_id),
      };
    },
  });
  const dsh = options.dsh
    ?? (typeof options.createDsh === 'function'
      ? await options.createDsh({ dbState, dshBaseUrl })
      : null);
  const rebuildWorker = options.rebuildWorker
    ?? (dsh
      ? createRebuildWorker({
          ...(options.rebuildWorkerOptions || {}),
          db: dbState.db,
          dsh,
          events,
          logger: options.logger || console,
        })
      : null);
  if (rebuildWorker && options.startRebuildWorker !== false) {
    rebuildWorker.start(options.rebuildWorkerIntervalMs ?? 2_000);
  }
  const auth = options.auth || {
    async authenticate(req) {
      const token = bearer(req);
      if (!token) throw unauthorized('token-missing', '缺少 Authorization: Bearer <access token>');
      return authService.authenticate(token);
    },
  };
  const ctx = {
    dbState,
    dshBaseUrl,
    workspaceRoot,
    uploadMaxBytes: Number.isSafeInteger(uploadMaxBytes) && uploadMaxBytes > 0
      ? uploadMaxBytes
      : 20 * 1024 * 1024,
    conversationMaxBytes: Number.isSafeInteger(conversationMaxBytes) && conversationMaxBytes > 0
      ? conversationMaxBytes
      : 200 * 1024 * 1024,
    publicBaseUrl: /^https:\/\/[^/]+\/[^?#]+$/i.test(publicBaseUrl) ? publicBaseUrl : '',
    dbPath,
    realtime,
    deviceTrustRequired,
    deviceTrustEnrollDeadline,
    realtimeModeForUser: (userId) => realtimeModeForUser(realtime, userId),
    sseConnections: new Set(),
    sseMemberConnections: new Map(),
    sseUserConnections: new Map(),
    realtimeStats: {
      connectionsOpened: 0,
      connectionsClosed: 0,
      catchUpRequests: 0,
      replayEvents: 0,
      replaySkipped: 0,
      epochChanged: 0,
      cursorAhead: 0,
    },
    stopping: false,
    events,
    logger,
    dsh,
    rebuildWorker,
    auth,
    authService,
    authRoutes,
    config: {
      ownerIds,
      social: options.socialConfig,
      agentSecret,
      sendRescue: options.sendRescue === true,
    },
  };
  ctx.createDirectConversation = async ({ userId, title = '汐语' }) => {
    const conversation = await createConversationForUser(ctx, {
      userId,
      title,
      kind: 'direct',
      enforceQuota: true,
    });
    return conversation.id;
  };
  if (ownerIds.length > 0) {
    const placeholders = ownerIds.map(() => '?').join(',');
    dbState.db.prepare(
      `UPDATE users SET role = 'admin' WHERE id IN (${placeholders})`,
    ).run(...ownerIds);
  }
  ctx.social = options.social ?? createSocialEngine(ctx);
  if (options.startSocial !== false) ctx.social.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (url.pathname.startsWith('/j/')) return await handleLanding(req, res, url, ctx);
      if (url.pathname === '/health') return handleHealth(req, res, ctx);
      if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
        return await handleConsole(req, res, url, ctx);
      }
      if (url.pathname === '/realtime/config') {
        const authResult = await ctx.auth.authenticate(req);
        return sendJson(res, 200, {
          mode: ctx.realtimeModeForUser(authResult.userId),
          streamEnabled: realtime.streamEnabled,
          streamPath: realtime.streamEnabled ? '/stream' : null,
          fallbackPath: '/conversations/:id/stream',
          contractVersion: 1,
          replayLimit: STREAM_REPLAY_LIMIT,
        });
      }
      if (url.pathname === '/bot/profile') {
        await ctx.auth.authenticate(req);
        const settings = loadBotSettings(ctx.dbState.db);
        return sendJson(res, 200, {
          profile: {
            name: settings.aiName || '汐语',
            signature: settings.aiSignature || '',
            avatar: settings.aiAvatar || '',
          },
        });
      }
      if (url.pathname === '/requests' || url.pathname.startsWith('/requests/')) {
        return await handleRequests(req, res, url, ctx);
      }
      if (url.pathname.startsWith('/invites/')) {
        return await handleInvites(req, res, url, ctx);
      }
      if (url.pathname === '/groups/joinable') {
        return await handleGroups(req, res, url, ctx);
      }
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        return await handleAdmin(req, res, url, ctx);
      }
      if (url.pathname.startsWith('/attachments/')) {
        return await handleAttachmentDownload(req, res, url, ctx);
      }
      if (url.pathname === '/stickers' || url.pathname.startsWith('/stickers/')) {
        return await handleStickers(req, res, url, ctx);
      }
      if (url.pathname.startsWith('/users/') && url.pathname.endsWith('/avatar')) {
        return await handleUserAvatar(req, res, url, ctx);
      }
      if (url.pathname === '/stream') {
        return await handleUserStream(req, res, url, ctx);
      }
      if (url.pathname === '/conversations' || url.pathname.startsWith('/conversations/')) {
        return await handleConversations(req, res, url, ctx);
      }
      if (url.pathname === '/moments' || url.pathname.startsWith('/moments/')) {
        return await handleMoments(req, res, url, ctx);
      }
      if (url.pathname === '/auth' || url.pathname.startsWith('/auth/')) {
        return await handleAuth(req, res, url, ctx);
      }
      if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) {
        return await handleAgent(req, res, url, ctx);
      }
      return sendError(res, 404, 'not-found', 'route not found');
    } catch (error) {
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      const status = Number(error?.status) || 500;
      const body = {
        error: {
          code: error?.code || 'internal',
          message: error?.message || 'internal error',
          ...(error?.extra && typeof error.extra === 'object' ? error.extra : {}),
        },
      };
      return sendJson(res, status, body);
    }
  });

  server.once('listening', () => {
    writeEvent(ctx.dbState.db, {
      kind: 'gateway.start',
      detail: {
        db: dbPath,
        version: ctx.dbState.version,
        port: server.address()?.port ?? null,
      },
    });
  });

  const adminSessionPrune = setInterval(() => {
    try {
      ctx.dbState.db.prepare('DELETE FROM admin_session WHERE expires_at < ?')
        .run(new Date().toISOString());
    } catch {
      // 控制台会话清理失败不影响网关
    }
  }, 60 * 60 * 1000);
  adminSessionPrune.unref?.();

  function closeSse() {
    ctx.stopping = true;
    for (const set of ctx.sseUserConnections?.values() ?? []) {
      for (const cleanup of [...set]) cleanup();
    }
    ctx.sseUserConnections.clear();
    for (const cleanup of [...ctx.sseConnections]) cleanup();
    ctx.sseConnections.clear();
    ctx.sseMemberConnections.clear();
  }

  server.on('close', () => {
    clearInterval(adminSessionPrune);
    closeSse();
    events.close();
    rebuildWorker?.stop();
    ctx.social?.stop();
    closeDatabase(dbState);
  });
  return {
    server,
    dbState,
    events,
    realtime,
    closeSse,
    dsh,
    rebuildWorker,
    workspaceRoot,
    auth,
    authService,
    authRoutes,
    social: ctx.social,
    ctx,
  };
}

export async function startGateway() {
  const port = Number(process.env.TIDE_GATEWAY_PORT || 8080);
  const host = process.env.TIDE_GATEWAY_HOST || '127.0.0.1';
  const dshBaseUrl = process.env.TIDE_DSH_BASE_URL || 'http://127.0.0.1:3080';

  const gateway = await createGateway({
    dshBaseUrl,
    createDsh: ({ dbState }) =>
      createDsh({
        baseUrl: dshBaseUrl,
        dshHome: process.env.DSH_HOME,
        buildRecap: createRecapBuilder({ db: dbState.db }),
        logger: console,
      }),
    // 对齐 QQbridge reserved2：默认不补发、不强迫模型再说一遍。
    // 排障时可显式设 TIDE_SEND_RESCUE=1 打开一次性纠错。
    sendRescue: process.env.TIDE_SEND_RESCUE === '1',
    startRebuildWorker: true,
  });

  if (!gateway.dsh) {
    console.error('[tide-gateway] DSH client 未创建，重建队列不会消费；检查 TIDE_DSH_BASE_URL 与 DSH_HOME');
  } else if (gateway.dshBaseUrl && !(await gateway.dsh.ping())) {
    console.warn(`[tide-gateway] DSH 实例不可达: ${dshBaseUrl}（网关照常启动，重建队列会重试）`);
  }

  await new Promise((resolve, reject) => {
    gateway.server.once('error', reject);
    gateway.server.listen(port, host, resolve);
  });
  console.log(
    `[tide-gateway] listening http://${host}:${port} db=${gateway.dbState.readOnly ? 'readonly' : 'ok'} dsh=${dshBaseUrl}`,
  );
  const stop = () => {
    gateway.closeSse();
    gateway.server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startGateway();
}
