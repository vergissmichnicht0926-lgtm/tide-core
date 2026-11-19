import { sendError, sendJson } from '../http.mjs';

export function handleHealth(req, res, ctx) {
  if (req.method !== 'GET') return sendError(res, 405, 'method-not-allowed', '只支持 GET');
  let dbOk = false;
  try {
    ctx.dbState.db.prepare('SELECT 1 AS ok').get();
    dbOk = true;
  } catch {}
  let activeUserConnections = 0;
  for (const connections of ctx.sseUserConnections?.values() ?? []) {
    activeUserConnections += connections.size;
  }
  sendJson(res, dbOk ? 200 : 503, {
    ok: dbOk,
    db: dbOk ? (ctx.dbState.readOnly ? 'readonly' : 'ok') : 'error',
    dsh: ctx.dshBaseUrl ? 'configured' : 'unconfigured',
    agentSecret: Boolean(ctx.config?.agentSecret),
    realtime: {
      activeUserConnections,
      connectionsOpened: ctx.realtimeStats?.connectionsOpened ?? 0,
      connectionsClosed: ctx.realtimeStats?.connectionsClosed ?? 0,
      catchUpRequests: ctx.realtimeStats?.catchUpRequests ?? 0,
      replayEvents: ctx.realtimeStats?.replayEvents ?? 0,
      replaySkipped: ctx.realtimeStats?.replaySkipped ?? 0,
      epochChanged: ctx.realtimeStats?.epochChanged ?? 0,
      cursorAhead: ctx.realtimeStats?.cursorAhead ?? 0,
    },
    publicBaseUrl: ctx.publicBaseUrl || '',
    version: ctx.dbState.version,
  });
}
