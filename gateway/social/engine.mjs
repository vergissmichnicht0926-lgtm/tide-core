/**
 * M4.5 v2 运行时：合批唤醒、唤醒限频、replyCheck、proactiveCheck、
 * 沉睡前观察状态、忙时暂存、发送节流队列。
 *
 * 计时器都在内存里；可跨重启的状态（wake_config_json / social_state_json /
 * pending_wake / send_queue）都落库，所以重启后能从 DB 重排。
 */

import { randomUUID } from 'node:crypto';
import { nowMs, withTransaction } from '../db/index.mjs';
import { deliverWakePrompt } from '../dsh/delivery.mjs';
import { writeEvent } from '../events-store.mjs';
import {
  appendBatchMessageId,
  insertAssistantBatch,
  insertAssistantMessageTx,
  MAX_SEND_PER_HOUR,
  MAX_SEND_PER_MINUTE,
  publishAssistantMessages,
} from '../messages.mjs';
import {
  defaultWakeConfig,
  isTimerWakeReason,
  normalizeSocialState,
  normalizeWakeConfig,
  wakePriority,
} from './wake.mjs';
import { bumpUsageTurn, loadBotSettings, localDay } from '../settings.mjs';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const DEFAULT_SOCIAL_CONFIG = Object.freeze({
  maxWakePerMinute: 1,
  maxWakePerHour: 12,
  preSleepWaitMs: 300_000,
  noActionLimit: 3,
  maxWakeConfigReminders: 2,
  replyCheckMs: 30_000,
  proactiveMinMs: 30 * MINUTE,
  proactiveMaxMs: 90 * MINUTE,
  proactiveIdleMs: 15 * MINUTE,
  proactiveProbability: 0.4,
});

export function proactiveProbability({
  base = 0.4,
  pendingThoughts = 0,
  lastAiReplyAt = 0,
  hour = new Date().getHours(),
  ownCountLastHour = 0,
  now = nowMs(),
} = {}) {
  let prob = Math.min(1, Math.max(0, Number(base)));
  if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
  if (lastAiReplyAt && now - Number(lastAiReplyAt) < 30 * MINUTE) prob *= 0.5;
  if (hour >= 23 || hour < 8) prob *= 0.3;
  if (ownCountLastHour >= 5) prob *= 0.3;
  return prob;
}

export function replyCheckDelay(baseMs, recentSelfTexts = []) {
  let delay = Math.max(1000, Number(baseMs) || 30_000);
  if (recentSelfTexts.some((text) => /[?？吗呢怎么有没有能不能]/.test(String(text ?? '')))) {
    delay = Math.round(delay * 1.5);
  }
  if (recentSelfTexts.length >= 3) delay = Math.round(delay * 1.3);
  return delay;
}

export function wakeLimitRetry({
  wakeTimes = [],
  maxPerMinute = 1,
  maxPerHour = 12,
  now = nowMs(),
} = {}) {
  const minute = wakeTimes.filter((t) => now - t < MINUTE).sort((a, b) => a - b);
  const hour = wakeTimes.filter((t) => now - t < HOUR).sort((a, b) => a - b);
  let retry = 0;
  if (maxPerMinute > 0 && minute.length >= maxPerMinute) {
    retry = Math.max(retry, MINUTE - (now - minute[0]) + 500);
  }
  if (maxPerHour > 0 && hour.length >= maxPerHour) {
    retry = Math.max(retry, HOUR - (now - hour[0]) + 500);
  }
  return retry;
}

function stateOf(map, id) {
  if (!map.has(id)) {
    map.set(id, {
      busy: false,
      inflightWake: false,
      turnStartedAt: 0,
      pendingWakeTimer: null,
      pendingWakeReason: null,
      pendingWakeSeq: 0,
      replyCheckTimer: null,
      replyCheckPending: false,
      proactiveTimer: null,
      sleepTimer: null,
      rateLimitTimer: null,
      sendTimer: null,
      bubbleTimer: null,
      bubbleFlushing: false,
    });
  }
  return map.get(id);
}

export function createSocialEngine(ctx) {
  const db = ctx.dbState.db;
  const logger = ctx.logger;
  const cfg = { ...DEFAULT_SOCIAL_CONFIG, ...(ctx.config?.social || {}) };
  const timers = new Map();

  function log(message) {
    logger?.log?.(`[social] ${message}`);
  }

  function warn(message) {
    logger?.warn?.(`[social] ${message}`);
  }

  function silentNow(now = nowMs()) {
    return now < (Number(loadBotSettings(db).silentUntil) || 0);
  }

  function loadConversation(id) {
    return db
      .prepare(
        `SELECT id, kind, user_id, title, summary, created_at, updated_at, dsh_session_id,
                dsh_workspace_id, dsh_after_seq, agent_token, policy, agent_read_seq,
                wake_config_json, social_state_json
           FROM conversation WHERE id = ?`,
      )
      .get(id);
  }

  function loadWake(conversation) {
    return normalizeWakeConfig(conversation?.wake_config_json);
  }

  function loadSocial(conversation) {
    return normalizeSocialState(conversation?.social_state_json);
  }

  function saveSocial(id, state) {
    db.prepare('UPDATE conversation SET social_state_json = ? WHERE id = ?')
      .run(JSON.stringify(state), id);
  }

  function saveWake(id, wake) {
    db.prepare('UPDATE conversation SET wake_config_json = ? WHERE id = ?')
      .run(JSON.stringify(wake), id);
  }

  function clearTimer(st, name) {
    if (st[name]) {
      clearTimeout(st[name]);
      st[name] = null;
    }
  }

  function isBusy(id) {
    return stateOf(timers, id).busy || stateOf(timers, id).inflightWake;
  }

  function beginTurn(id) {
    const st = stateOf(timers, id);
    st.busy = true;
    st.turnStartedAt = nowMs();
    clearTimer(st, 'replyCheckTimer');
    st.replyCheckPending = false;
    log(`${id} 回合开始`);
  }

  function endTurn(id) {
    const st = stateOf(timers, id);
    st.busy = false;
    st.inflightWake = false;
  }

  function noteIncoming(id) {
    const conv = loadConversation(id);
    if (!conv) return;
    const social = loadSocial(conv);
    social.lastIncomingAt = nowMs();
    saveSocial(id, social);
  }

  function noteAction(id) {
    cancelReplyCheck(id);
    const conv = loadConversation(id);
    if (!conv) return;
    const social = loadSocial(conv);
    social.lastActionAt = nowMs();
    social.noActionCount = 0;
    saveSocial(id, social);
  }

  function clearReminder(id) {
    const conv = loadConversation(id);
    if (!conv) return;
    const social = loadSocial(conv);
    if (!social.wakeConfigReminderPending) return;
    social.wakeConfigReminderPending = false;
    saveSocial(id, social);
  }

  function noteSent(id, count = 1) {
    const conv = loadConversation(id);
    if (!conv) return;
    const social = loadSocial(conv);
    const now = nowMs();
    social.lastAiReplyAt = now;
    for (let i = 0; i < count; i += 1) social.sendTimes.push(now);
    social.sendTimes = social.sendTimes.slice(-200);
    // 参与了就代表这次沉睡前观察作废，下次想睡要重新等窗口。
    social.preSleepWaitSatisfiedAt = 0;
    social.preSleepWaitObservedAt = 0;
    saveSocial(id, social);
    stateOf(timers, id).replyCheckPending = true;
    scheduleReplyCheck(id);
  }

  function addPendingThought(id, text) {
    const conv = loadConversation(id);
    if (!conv) return;
    const social = loadSocial(conv);
    const now = nowMs();
    social.pendingThoughts.push({
      text: String(text).slice(0, 500),
      createdAt: now,
      expiresAt: now + 24 * HOUR,
    });
    social.pendingThoughts = social.pendingThoughts.slice(-20);
    saveSocial(id, social);
  }

  function enqueuePendingWake(id, reason, seq = 0) {
    if (silentNow()) {
      log(`${id} 静默中，不排队唤醒 ${reason} (silent)`);
      return;
    }
    const exists = db
      .prepare(
        'SELECT id FROM pending_wake WHERE conversation_id = ? AND reason = ? AND COALESCE(seq, 0) = ?',
      )
      .get(id, reason, Number(seq) || 0);
    if (exists) return;
    db.prepare(
      'INSERT INTO pending_wake(conversation_id, reason, seq, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, reason, Number(seq) || null, nowMs());
    const extra = db
      .prepare('SELECT COUNT(*) AS n FROM pending_wake WHERE conversation_id = ?')
      .get(id).n;
    if (extra > 20) {
      db.prepare(
        `DELETE FROM pending_wake WHERE id IN (
           SELECT id FROM pending_wake WHERE conversation_id = ?
            ORDER BY id ASC LIMIT ?
         )`,
      ).run(id, extra - 20);
    }
  }

  function replayPendingWake(id, { max = 5 } = {}) {
    const actions = [];
    if (silentNow()) {
      log(`${id} 静默中，暂不重放 pending_wake (silent)`);
      return actions;
    }
    for (let i = 0; i < max; i += 1) {
      const row = db
        .prepare(
          'SELECT id, reason, seq FROM pending_wake WHERE conversation_id = ? ORDER BY id ASC LIMIT 1',
        )
        .get(id);
      if (!row) break;
      db.prepare('DELETE FROM pending_wake WHERE id = ?').run(row.id);
      if (isTimerWakeReason(row.reason)) {
        if (row.reason === 'replyCheck') {
          scheduleReplyCheck(id);
        } else if (row.reason === 'proactiveCheck') {
          log(`${id} 繁忙期间的主动机会已过期，跳过`);
        } else if (row.reason === 'timeout') {
          ensureSleepTimer(id);
        } else {
          scheduleWake(id, row.reason, row.seq);
        }
        actions.push({ reason: row.reason, action: 'timer' });
        continue;
      }
      const stillUnread = db
        .prepare(
          `SELECT 1 AS ok FROM message m
            JOIN conversation c ON c.id = m.conversation_id
           WHERE m.conversation_id = ? AND m.seq = ? AND m.role = 'user'
             AND m.seq > c.agent_read_seq`,
        )
        .get(id, Number(row.seq) || 0);
      if (stillUnread) {
        scheduleWake(id, row.reason, row.seq);
        actions.push({ reason: row.reason, action: 'replayed' });
      } else {
        actions.push({ reason: row.reason, action: 'skipped' });
      }
    }
    return actions;
  }

  function wakeLimitRetryMs(social, wake, now = nowMs()) {
    const limits = wake?.limits || {};
    const maxPerMinute = Number.isFinite(Number(limits.maxWakePerMinute))
      ? Number(limits.maxWakePerMinute)
      : cfg.maxWakePerMinute;
    const maxPerHour = Number.isFinite(Number(limits.maxWakePerHour))
      ? Number(limits.maxWakePerHour)
      : cfg.maxWakePerHour;
    return wakeLimitRetry({
      wakeTimes: social.wakeTimes,
      maxPerMinute,
      maxPerHour,
      now,
    });
  }

  async function deliverWake(id, reason, { skipMessageCheck = false, seq = 0 } = {}) {
    if (silentNow()) {
      log(`${id} 静默中，跳过唤醒 ${reason} (silent)`);
      return;
    }
    const st = stateOf(timers, id);
    if (st.busy || st.inflightWake) {
      enqueuePendingWake(id, reason, seq);
      return;
    }
    const conv = loadConversation(id);
    if (!conv) return;
    if (!skipMessageCheck && !isTimerWakeReason(reason)) {
      const unread = db
        .prepare(
          `SELECT 1 AS ok FROM message m
            JOIN conversation c ON c.id = m.conversation_id
           WHERE m.conversation_id = ? AND m.role = 'user' AND m.seq > c.agent_read_seq
           LIMIT 1`,
        )
        .get(id);
      if (!unread) {
        log(`${id} 唤醒 ${reason} 前发现没有未读，跳过`);
        return;
      }
    }
    const social = loadSocial(conv);
    const wake = loadWake(conv);
    const prevSleepUntil = wake.sleepUntil;
    const prevInfinite = wake.infinite;
    const retryMs = wakeLimitRetryMs(social, wake);
    if (retryMs > 0) {
      const waitMs = Math.min(60_000, Math.max(1000, Math.round(retryMs)));
      // 超限不能丢唤醒：先落 pending_wake，到窗口腾出后统一 replay。
      enqueuePendingWake(id, reason, seq);
      if (!st.rateLimitTimer) {
        st.rateLimitTimer = setTimeout(() => {
          st.rateLimitTimer = null;
          replayPendingWake(id);
        }, waitMs);
        st.rateLimitTimer.unref?.();
      }
      log(`${id} 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${reason}`);
      return;
    }

    clearTimer(st, 'replyCheckTimer');
    st.replyCheckPending = false;
    clearTimer(st, 'sleepTimer');
    st.inflightWake = true;
    const wakeTime = nowMs();
    social.wakeTimes.push(wakeTime);
    social.wakeTimes = social.wakeTimes.slice(-200);
    social.lastWakeReason = reason;
    social.preSleepWaitSatisfiedAt = 0;
    social.preSleepWaitObservedAt = 0;
    wake.lastWakeAt = wakeTime;
    wake.wakeCount = (Number(wake.wakeCount) || 0) + 1;
    wake.sleepUntil = null;
    saveSocial(id, social);
    saveWake(id, wake);
    log(`${id} 唤醒 ${reason}`);
    const restoreFiniteSleep = () => {
      if (!prevInfinite && prevSleepUntil) {
        wake.infinite = false;
        wake.sleepUntil = prevSleepUntil;
        saveWake(id, wake);
        ensureSleepTimer(id);
      }
    };
    try {
      const result = await deliverWakePrompt(ctx, conv, reason);
      if (result?.ok === false) {
        st.inflightWake = false;
        social.wakeTimes = social.wakeTimes.filter((t) => t !== wakeTime);
        saveSocial(id, social);
        restoreFiniteSleep();
      }
    } catch (error) {
      st.inflightWake = false;
      social.wakeTimes = social.wakeTimes.filter((t) => t !== wakeTime);
      saveSocial(id, social);
      restoreFiniteSleep();
      warn(`${id} 唤醒投递失败 ${reason}: ${error?.message ?? error}`);
    }
  }

  function scheduleWake(id, reason, seq = 0) {
    if (silentNow()) {
      log(`${id} 静默中，跳过唤醒排程 ${reason} (silent)`);
      return;
    }
    const st = stateOf(timers, id);
    const conv = loadConversation(id);
    if (!conv) return;
    if (st.busy || st.inflightWake) {
      enqueuePendingWake(id, reason, seq);
      return;
    }
    if (st.pendingWakeTimer) {
      const cur = st.pendingWakeReason || reason;
      if (wakePriority(reason) > wakePriority(cur)) {
        st.pendingWakeReason = reason;
        log(`${id} 合批窗口内升级唤醒原因 ${cur} -> ${reason}`);
      }
      if (seq) st.pendingWakeSeq = Math.max(Number(st.pendingWakeSeq) || 0, Number(seq) || 0);
      return;
    }
    const wake = loadWake(conv);
    const batchMs = Math.max(1000, Number(wake.batchWindowMs) || 8000);
    st.pendingWakeReason = reason;
    st.pendingWakeSeq = Number(seq) || 0;
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      const finalSeq = st.pendingWakeSeq || 0;
      st.pendingWakeReason = null;
      st.pendingWakeSeq = 0;
      void deliverWake(id, finalReason, { seq: finalSeq });
    }, batchMs);
    st.pendingWakeTimer.unref?.();
    log(`${id} 计划唤醒 ${reason}，${Math.round(batchMs / 1000)}s 后发送`);
  }

  function scheduleReplyCheck(id) {
    if (silentNow()) {
      log(`${id} 静默中，跳过回复检查 (silent)`);
      return;
    }
    const st = stateOf(timers, id);
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer || st.busy || st.inflightWake) {
      return;
    }
    const conv = loadConversation(id);
    if (!conv) return;
    const recent = db
      .prepare(
        `SELECT content_json FROM message
          WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
          ORDER BY created_at DESC`,
      )
      .all(id, nowMs() - 15_000);
    const texts = recent.map((row) => {
      try {
        return String(JSON.parse(row.content_json)?.text ?? '');
      } catch {
        return '';
      }
    });
    const delay = replyCheckDelay(cfg.replyCheckMs, texts);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void deliverWake(id, 'replyCheck', { skipMessageCheck: true });
    }, delay);
    st.replyCheckPending = false;
    st.replyCheckTimer.unref?.();
    log(`${id} 已安排回复检查，${Math.round(delay / 1000)}s 后`);
  }

  function cancelReplyCheck(id) {
    const st = stateOf(timers, id);
    clearTimer(st, 'replyCheckTimer');
    st.replyCheckPending = false;
  }

  function pendingThoughtCount(social) {
    const now = nowMs();
    return social.pendingThoughts.filter(
      (item) => !item.expiresAt || now < Number(item.expiresAt),
    ).length;
  }

  function scheduleProactiveCheck(id) {
    if (silentNow()) {
      log(`${id} 静默中，跳过主动检查 (silent)`);
      return;
    }
    const st = stateOf(timers, id);
    if (st.proactiveTimer) return;
    const conv = loadConversation(id);
    if (!conv || conv.kind !== 'group') return;
    const min = Math.max(1000, Number(cfg.proactiveMinMs) || 30 * MINUTE);
    const max = Math.max(min, Number(cfg.proactiveMaxMs) || 90 * MINUTE);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      if (silentNow()) {
        log(`${id} 静默中，主动机会作废 (silent)`);
        return;
      }
      const fresh = loadConversation(id);
      if (fresh?.kind === 'group') {
        const social = loadSocial(fresh);
        const idle = !social.lastIncomingAt || nowMs() - social.lastIncomingAt >= cfg.proactiveIdleMs;
        const own = db
          .prepare(
            `SELECT COUNT(*) AS n FROM message
              WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?`,
          )
          .get(id, nowMs() - HOUR).n;
        const prob = proactiveProbability({
          base: cfg.proactiveProbability,
          pendingThoughts: pendingThoughtCount(social),
          lastAiReplyAt: social.lastAiReplyAt,
          hour: new Date().getHours(),
          ownCountLastHour: own,
        });
        if (idle && !isBusy(id) && Math.random() < prob) {
          log(`${id} 主动机会命中（idle=${Math.round((nowMs() - (social.lastIncomingAt || 0)) / 60000)}m, p=${prob.toFixed(2)}）`);
          void deliverWake(id, 'proactiveCheck', { skipMessageCheck: true });
        }
        scheduleProactiveCheck(id);
      }
    }, delay);
    st.proactiveTimer.unref?.();
    log(`${id} 已安排主动机会检查，约 ${Math.round(delay / 60000)}min 后`);
  }

  function ensureSleepTimer(id) {
    const st = stateOf(timers, id);
    clearTimer(st, 'sleepTimer');
    const conv = loadConversation(id);
    if (!conv) return;
    const wake = loadWake(conv);
    if (wake.infinite || !wake.sleepUntil) return;
    const until = Date.parse(wake.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - nowMs();
    if (delay <= 0) {
      void deliverWake(id, 'timeout', { skipMessageCheck: true });
      return;
    }
    const step = Math.min(delay, 100_000);
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      if (delay > 100_000) ensureSleepTimer(id);
      else void deliverWake(id, 'timeout', { skipMessageCheck: true });
    }, step);
    st.sleepTimer.unref?.();
  }

  function sendNotBefore(id, count, now = nowMs()) {
    const minuteTimes = db
      .prepare(
        `SELECT created_at FROM message
          WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
          ORDER BY created_at ASC`,
      )
      .all(id, now - MINUTE)
      .map((row) => row.created_at);
    const hourTimes = db
      .prepare(
        `SELECT created_at FROM message
          WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
          ORDER BY created_at ASC`,
      )
      .all(id, now - HOUR)
      .map((row) => row.created_at);
    let notBefore = now;
    if (minuteTimes.length + count > MAX_SEND_PER_MINUTE) {
      const overflow = minuteTimes.length + count - MAX_SEND_PER_MINUTE;
      const idx = Math.min(minuteTimes.length - 1, Math.max(0, overflow - 1));
      notBefore = Math.max(notBefore, minuteTimes[idx] + MINUTE + 250);
    }
    if (hourTimes.length + count > MAX_SEND_PER_HOUR) {
      const overflow = hourTimes.length + count - MAX_SEND_PER_HOUR;
      const idx = Math.min(hourTimes.length - 1, Math.max(0, overflow - 1));
      notBefore = Math.max(notBefore, hourTimes[idx] + HOUR + 250);
    }
    return notBefore;
  }

  function scheduleSendFlush(id) {
    const st = stateOf(timers, id);
    const next = db
      .prepare(
        `SELECT MIN(not_before) AS at FROM send_queue
          WHERE conversation_id = ? AND state = 'pending'`,
      )
      .get(id).at;
    if (!next) return;
    const delay = Math.max(0, Number(next) - nowMs());
    clearTimer(st, 'sendTimer');
    st.sendTimer = setTimeout(() => {
      st.sendTimer = null;
      flushSendQueue(id);
    }, delay);
    st.sendTimer.unref?.();
  }

  function enqueueSend(id, { list, replyTo = null, batchId = null, hash }) {
    const now = nowMs();
    if (batchId) {
      const prev = db
        .prepare(
          `SELECT id, payload_hash, not_before FROM send_queue
            WHERE conversation_id = ? AND client_batch_id = ? AND state = 'pending'
            LIMIT 1`,
        )
        .get(id, batchId);
      if (prev) {
        if (prev.payload_hash !== hash) {
          const error = new Error('clientBatchId 已被另一份 payload 使用');
          error.status = 409;
          error.code = 'batch-conflict';
          throw error;
        }
        return { queueId: prev.id, notBefore: prev.not_before, duplicated: true };
      }
    }
    const notBefore = sendNotBefore(id, list.length, now);
    const queueId = randomUUID();
    db.prepare(
      `INSERT INTO send_queue
         (id, conversation_id, messages_json, reply_to_message_id, client_batch_id,
          payload_hash, created_at, not_before, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(queueId, id, JSON.stringify(list), replyTo, batchId, hash, now, notBefore);
    scheduleSendFlush(id);
    return { queueId, notBefore };
  }

  function flushSendQueue(id) {
    const pending = db
      .prepare(
        `SELECT id, messages_json, reply_to_message_id, client_batch_id, payload_hash
           FROM send_queue
          WHERE conversation_id = ? AND state = 'pending'
          ORDER BY created_at ASC`,
      )
      .all(id);
    if (!pending.length) return;
    const published = [];
    for (const row of pending) {
      const list = JSON.parse(row.messages_json);
      const notBefore = sendNotBefore(id, list.length);
      if (notBefore > nowMs()) {
        db.prepare('UPDATE send_queue SET not_before = ? WHERE id = ?')
          .run(notBefore, row.id);
        break;
      }
      try {
        const inserted = insertAssistantBatch(db, id, list, {
          replyTo: row.reply_to_message_id,
          batchId: row.client_batch_id,
          hash: row.payload_hash,
        });
        db.prepare("UPDATE send_queue SET state = 'sent' WHERE id = ?").run(row.id);
        if (!inserted.duplicated) {
          published.push(...inserted.created);
        }
      } catch (error) {
        db.prepare("UPDATE send_queue SET state = 'failed', last_error = ? WHERE id = ?")
          .run(String(error?.message ?? error), row.id);
        warn(`${id} 发送队列落库失败: ${error?.message ?? error}`);
        writeEvent(db, {
          level: 'error',
          kind: 'message.failed',
          conversationId: id,
          detail: {
            source: 'send_queue',
            queueId: row.id,
            message: String(error?.message ?? error).slice(0, 200),
          },
        });
      }
    }
    if (published.length > 0) {
      // 多个排队批次合成一条时间线，避免两个批次各自「第一条立即」撞在一起。
      publishAssistantMessages(ctx, id, published, {
        onDone: () => noteSent(id, published.length),
      });
    }
    scheduleSendFlush(id);
  }

  function scheduleBubbleFlush(id) {
    const st = stateOf(timers, id);
    const next = db.prepare(
      `SELECT MIN(not_before_ms) AS at FROM bubble_queue
        WHERE conversation_id = ? AND state = 'pending'`,
    ).get(id).at;
    if (!next) return;
    const delay = Math.max(0, Number(next) - nowMs());
    clearTimer(st, 'bubbleTimer');
    st.bubbleTimer = setTimeout(() => {
      st.bubbleTimer = null;
      flushBubbleQueue(id);
    }, delay);
    st.bubbleTimer.unref?.();
  }

  function enqueueBubbles(id, { list, replyTo = null, batchId = null, hash = null }) {
    const delayMs = Number(loadBotSettings(db).bubbleDelayMs) || 0;
    if (!Array.isArray(list) || list.length < 2 || delayMs <= 0) return null;
    const now = nowMs();
    if (batchId) {
      const existing = db.prepare(
        `SELECT id, not_before_ms FROM bubble_queue
          WHERE conversation_id = ? AND client_batch_id = ?
          ORDER BY segment_index ASC`,
      ).all(id, batchId);
      if (existing.length > 0) {
        return {
          duplicated: true,
          queueIds: existing.map((row) => row.id),
          scheduledAt: new Date(existing[0].not_before_ms).toISOString(),
        };
      }
    }
    const queueIds = [];
    let at = now;
    const rows = list.map((text, index) => {
      if (index > 0) {
        const interval = Math.max(0, Math.round(delayMs + (Math.random() * 600 - 300)));
        at += interval;
      }
      const row = {
        id: randomUUID(),
        segmentIndex: index,
        text: String(text),
        notBefore: at,
      };
      queueIds.push(row.id);
      return row;
    });
    withTransaction(db, () => {
      if (batchId) {
        db.prepare(
          `INSERT OR IGNORE INTO message_batch
             (conversation_id, client_batch_id, payload_hash, message_ids_json, created_at)
           VALUES (?, ?, ?, '[]', ?)`,
        ).run(id, batchId, hash || '', now);
      }
      const insert = db.prepare(
        `INSERT INTO bubble_queue
           (id, conversation_id, client_batch_id, segment_index, text, reply_to,
            not_before_ms, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (const row of rows) {
        insert.run(
          row.id, id, batchId, row.segmentIndex, row.text,
          replyTo, row.notBefore, now,
        );
      }
    });
    scheduleBubbleFlush(id);
    return {
      duplicated: false,
      queueIds,
      scheduledAt: new Date(rows[0].notBefore).toISOString(),
    };
  }

  function flushBubbleQueue(id) {
    const st = stateOf(timers, id);
    if (st.bubbleFlushing) return;
    const row = db.prepare(
      `SELECT id, client_batch_id, text, reply_to, not_before_ms
         FROM bubble_queue
        WHERE conversation_id = ? AND state = 'pending' AND not_before_ms <= ?
        ORDER BY segment_index ASC, created_at ASC
        LIMIT 1`,
    ).get(id, nowMs());
    if (!row) {
      scheduleBubbleFlush(id);
      return;
    }
    st.bubbleFlushing = true;
    try {
      const created = withTransaction(db, () => {
        const message = insertAssistantMessageTx(db, id, row.text, {
          replyTo: row.reply_to,
          now: nowMs(),
        });
        db.prepare("UPDATE bubble_queue SET state = 'sent', last_error = NULL WHERE id = ?")
          .run(row.id);
        appendBatchMessageId(db, id, row.client_batch_id, message.id);
        return message;
      });
      publishAssistantMessages(ctx, id, [created], {
        onDone: () => noteSent(id, 1),
      });
    } catch (error) {
      db.prepare("UPDATE bubble_queue SET state = 'failed', last_error = ? WHERE id = ?")
        .run(String(error?.message ?? error).slice(0, 500), row.id);
      warn(`${id} 气泡落库失败: ${error?.message ?? error}`);
      writeEvent(db, {
        level: 'error',
        kind: 'message.failed',
        conversationId: id,
        detail: {
          source: 'bubble_queue',
          queueId: row.id,
          message: String(error?.message ?? error).slice(0, 200),
        },
      });
    } finally {
      st.bubbleFlushing = false;
      scheduleBubbleFlush(id);
    }
  }

  async function onTurnEnd(id) {
    const st = stateOf(timers, id);
    st.busy = false;
    st.inflightWake = false;
    const conv = loadConversation(id);
    if (conv) {
      bumpUsageTurn(db, conv.user_id, localDay());
      const social = loadSocial(conv);
      const wake = loadWake(conv);
      const limits = wake.limits || {};
      const noActionLimit = Number.isFinite(Number(limits.noActionLimit))
        ? Number(limits.noActionLimit)
        : cfg.noActionLimit;
      const maxReminders = Number.isFinite(Number(limits.maxWakeConfigReminders))
        ? Number(limits.maxWakeConfigReminders)
        : cfg.maxWakeConfigReminders;
      const acted = Number(social.lastActionAt) >= Number(st.turnStartedAt);
      if (acted) {
        social.noActionCount = 0;
      } else {
        social.noActionCount = (Number(social.noActionCount) || 0) + 1;
        if (social.noActionCount >= noActionLimit) {
          social.noActionCount = 0;
          const fresh = defaultWakeConfig();
          fresh.limits = { ...wake.limits };
          fresh.hint = wake.hint;
          saveWake(id, fresh);
          if (social.wakeConfigReminders < maxReminders) {
            social.wakeConfigReminders += 1;
            social.wakeConfigReminderPending = true;
          }
          log(`${id} 连续 ${noActionLimit} 轮无行动，唤醒配置已重置为默认（限制与建议保留）`);
        }
      }
      saveSocial(id, social);
    }
    replayPendingWake(id);
    if (st.replyCheckPending) scheduleReplyCheck(id);
    scheduleProactiveCheck(id);
    ensureSleepTimer(id);
    flushSendQueue(id);
    flushBubbleQueue(id);
  }

  function ensureTimers(id) {
    const conv = loadConversation(id);
    if (!conv) return;
    scheduleProactiveCheck(id);
    ensureSleepTimer(id);
    scheduleSendFlush(id);
    scheduleBubbleFlush(id);
  }

  function start() {
    const rows = db.prepare('SELECT id FROM conversation').all();
    let replayed = 0;
    for (const row of rows) {
      ensureTimers(row.id);
      const actions = replayPendingWake(row.id);
      replayed += actions.filter((item) => item.action === 'replayed' || item.action === 'timer').length;
    }
    // 重启时把 pending send queue 也接上
    const queued = db
      .prepare("SELECT DISTINCT conversation_id FROM send_queue WHERE state = 'pending'")
      .all();
    for (const row of queued) scheduleSendFlush(row.conversation_id);
    const bubbles = db
      .prepare("SELECT DISTINCT conversation_id FROM bubble_queue WHERE state = 'pending'")
      .all();
    for (const row of bubbles) scheduleBubbleFlush(row.conversation_id);
    log(`已加载 ${rows.length} 个会话的计时器，重放 pending_wake ${replayed} 条`);
  }

  function stop() {
    for (const st of timers.values()) {
      for (const key of [
        'pendingWakeTimer',
        'replyCheckTimer',
        'proactiveTimer',
        'sleepTimer',
        'rateLimitTimer',
        'sendTimer',
        'bubbleTimer',
      ]) {
        clearTimer(st, key);
      }
    }
    timers.clear();
  }

  return {
    start,
    stop,
    isBusy,
    beginTurn,
    endTurn,
    onTurnEnd,
    noteIncoming,
    noteAction,
    noteSent,
    cancelReplyCheck,
    clearReminder,
    addPendingThought,
    scheduleWake,
    deliverWake,
    scheduleReplyCheck,
    scheduleProactiveCheck,
    ensureTimers,
    hasTimer(id, name) {
      return Boolean(stateOf(timers, id)[name]);
    },
    sendNotBefore,
    enqueueSend,
    flushSendQueue,
    enqueueBubbles,
    flushBubbleQueue,
    config: cfg,
  };
}
