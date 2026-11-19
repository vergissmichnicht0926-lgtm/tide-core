/**
 * 进程内事件总线：把网关自己产生的事件扇出给同进程的 SSE 连接。
 *
 * 两套订阅：
 *  - subscribe(conversationId, listener)：旧 per-conversation SSE
 *  - subscribeUser(userId, listener)：用户级 inbox，事件按 conversation_member 展开
 *
 * 消息正文以 DB 为准；断线后客户端用 since/after_seq 从库里补，不依赖 bus 持久化。
 */

function addListener(map, key, listener) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) map.delete(key);
  };
}

function envelope(conversationId, event, meta) {
  const createdAt = event?.createdAt ?? event?.at ?? new Date().toISOString();
  return {
    ...(event ?? {}),
    v: event?.v ?? 1,
    conversationId: conversationId ?? event?.conversationId ?? null,
    epoch: event?.epoch ?? meta?.epoch ?? 1,
    seq: event?.seq ?? event?.message?.seq ?? null,
    messageId: event?.messageId ?? event?.message?.id ?? null,
    createdAt,
    at: event?.at ?? createdAt,
  };
}

export function createEventBus({
  logger = console,
  lookupConversation = null,
} = {}) {
  const byConversation = new Map();
  const byUser = new Map();
  let closed = false;

  function subscribe(conversationId, listener) {
    if (closed) return () => {};
    return addListener(byConversation, conversationId, listener);
  }

  function subscribeUser(userId, listener) {
    if (closed) return () => {};
    return addListener(byUser, userId, listener);
  }

  function deliver(targets, payload) {
    let delivered = 0;
    for (const listener of targets) {
      try {
        listener(payload);
        delivered += 1;
      } catch (error) {
        logger.warn?.(`[events] listener 失败: ${error?.message ?? error}`);
      }
    }
    return delivered;
  }

  function publish(conversationId, event) {
    if (closed) return 0;
    const conversationListeners = byConversation.get(conversationId);
    const hasUserListeners = byUser.size > 0;
    if ((!conversationListeners || conversationListeners.size === 0) && !hasUserListeners) {
      return 0;
    }

    let meta = null;
    if (hasUserListeners && lookupConversation) {
      try {
        meta = lookupConversation(conversationId);
      } catch (error) {
        logger.warn?.(`[events] 查询成员失败: ${error?.message ?? error}`);
      }
    }

    const payload = envelope(conversationId, event, meta);
    const targets = new Set(conversationListeners ?? []);
    for (const userId of meta?.userIds ?? []) {
      for (const listener of byUser.get(userId) ?? []) targets.add(listener);
    }
    return deliver(targets, payload);
  }

  function publishUser(userId, event) {
    if (closed) return 0;
    const listeners = byUser.get(userId);
    if (!listeners || listeners.size === 0) return 0;
    const payload = envelope(event?.conversationId ?? null, event, null);
    return deliver(new Set(listeners), payload);
  }

  function close() {
    closed = true;
    byConversation.clear();
    byUser.clear();
  }

  return { subscribe, subscribeUser, publish, publishUser, close };
}
