/** 控制台 API 的统一响应头与审计事件。 */

import { writeEvent } from '../events-store.mjs';

export function sendConsoleJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

export function sendConsoleError(res, status, code, message, extra) {
  sendConsoleJson(res, status, {
    error: {
      code,
      message,
      ...(extra && typeof extra === 'object' ? extra : {}),
    },
  });
}

export function writeConsoleChange(ctx, action, target = null, extra = {}) {
  writeEvent(ctx.dbState.db, {
    kind: 'console.change',
    detail: {
      action,
      target: target ?? null,
      ...extra,
    },
  });
}
