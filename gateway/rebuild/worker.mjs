// rebuild_queue 的消费者 —— 按计划 10.16 实现。
//
// 一条队列行 = 一次待执行的重建：
//   cancel 在途 turn → 等 turn/end（超时继续）→ 轮换 agent_token
//   → 按 reason 选 preset 重建 session → best-effort recap → 删行
//
// 失败不自动回滚 conversation.policy：回滚只会让"库说 A、DSH 跑 B"更糟。
// 失败行进退避，第 5 次置 failed 留给人工。

import { randomBytes } from 'node:crypto';
import { advanceCursorAfterRecap } from '../dsh/session-cursor.mjs';
import { writeEvent } from '../events-store.mjs';

const BACKOFF_MS = [5_000, 15_000, 45_000, 120_000];
const MAX_ATTEMPTS = 5;
const TURN_END_TIMEOUT_MS = 30_000;

const presetFor = (reason) => (reason === 'policy:owner' ? 'tide-owner' : 'tide');

/**
 * 只有"会话真的不存在"才算 null。DSH 短暂抖动抛的错必须往上传，
 * 否则 worker 会以为没有旧会话、再建一个，留下两个 session（旧的可能还是 owner 档）。
 */
function isSessionNotFound(error) {
  if (!error) return false;
  if (error.code === 'session/not-found' || error.code === 'not-found') return true;
  if (error.status === 404) return true;
  return /session\/not-found|session not found/i.test(String(error.message ?? ''));
}

/**
 * @typedef {object} DshClient
 * @property {(sessionId: string) => Promise<{ agentPreset?: string } | null>} getSession
 *   会话不存在时应返回 null（或抛带 404 的错误，worker 会当成 null）
 * @property {(sessionId: string) => Promise<void>} cancel
 * @property {(sessionId: string, timeoutMs: number) => Promise<boolean>} waitTurnEnd
 *   收到 turn/end 返回 true，超时返回 false；不应抛错
 * @property {(opts: { preset: string, workspaceId?: string }) => Promise<{ sessionId: string }>} createSession
 * @property {(sessionId: string) => Promise<{ sent?: boolean } | void>} recap
 */

export function createRebuildWorker({
  db,
  dsh,
  events = null,
  now = () => Date.now(),
  logger = console,
  turnEndTimeoutMs = TURN_END_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
  backoffMs = BACKOFF_MS,
}) {
  let busy = false;
  let stopped = true; // 只控制 start() 起的循环；手动 tick() 不受它影响
  let stopping = false;
  let timer = null;

  /** NULL 陷阱：next_attempt_at 可能是 NULL，必须 COALESCE 兜底 */
  function claimNext() {
    return db
      .prepare(
        `SELECT id, conversation_id, reason, attempts
           FROM rebuild_queue
          WHERE state = 'pending'
            AND COALESCE(next_attempt_at, 0) <= ?
          ORDER BY id
          LIMIT 1`,
      )
      .get(now());
  }

  async function safeGetSession(sessionId) {
    try {
      return await dsh.getSession(sessionId);
    } catch (error) {
      if (isSessionNotFound(error)) return null;
      throw error; // DSH 抖动 → 这一行进退避，不当作"没有旧会话"
    }
  }

  function dropRow(id) {
    db.prepare('DELETE FROM rebuild_queue WHERE id = ?').run(id);
  }

  /**
   * 记一次失败。必须带 `AND state = 'pending'`：人工把行改成 failed 之后，
   * 一条迟到的失败不该把它改回 pending。
   */
  function recordFailure(row, error) {
    const attempts = row.attempts + 1;
    const message = String(error?.message ?? error ?? 'unknown').slice(0, 500);

    const atLimit = attempts >= maxAttempts;
    const delay = backoffMs[attempts - 1] ?? backoffMs[backoffMs.length - 1];
    const nextAttemptAt = atLimit ? null : now() + delay;
    // 只写这两个字面量之一；旧库的 state 列没有 CHECK，所以不指望 DB 拦
    const state = atLimit ? 'failed' : 'pending';

    const result = db
      .prepare(
        `UPDATE rebuild_queue
            SET attempts = ?, last_error = ?, state = ?, next_attempt_at = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(attempts, message, state, nextAttemptAt, row.id);

    if (result.changes !== 1) {
      logger.warn(
        `[rebuild] 队列行 ${row.id} 已被外部改动（state 不再是 pending），本次失败不写回`,
      );
      return { attempts: row.attempts, state: 'unknown', nextAttemptAt: null, skipped: true };
    }
    return { attempts, state, nextAttemptAt };
  }

  async function processRow(row) {
    const conv = db
      .prepare(
        'SELECT id, dsh_session_id, dsh_workspace_id, recap_at FROM conversation WHERE id = ?',
      )
      .get(row.conversation_id);

    // 会话被删时 CASCADE 应当已清掉队列行；这里只是防御
    if (!conv) {
      dropRow(row.id);
      return { status: 'dropped', conversationId: row.conversation_id };
    }

    // 没有 workspace 就不建 session —— 落到 DSH 默认 workspace 会破坏
    // 10.5 的"一对话一 workspace"，而且这种事在别处很难再发现。
    if (!conv.dsh_workspace_id) {
      throw new Error('conversation 缺少 dsh_workspace_id，拒绝落到共享 workspace');
    }

    const targetPreset = presetFor(row.reason);

    // 崩溃窗口：session/create 成功但没来得及删行。
    // 先认已有会话是不是已经是目标档，是就直接收工，别盲目再建一个。
    if (conv.dsh_session_id) {
      const existing = await safeGetSession(conv.dsh_session_id);
      if (existing && existing.agentPreset === targetPreset) {
        // recap 缺了就补一次：崩溃点可能落在 UPDATE dsh_session_id 与 recap 之间，
        // 新 session 还是空的。
        if (conv.recap_at === null) {
          try {
            await dsh.recap(conv.dsh_session_id);
            db.prepare('UPDATE conversation SET recap_at = ? WHERE id = ?').run(now(), conv.id);
          } catch (error) {
            logger.warn(`[rebuild] ${conv.id} 采纳时补 recap 失败: ${error?.message ?? error}`);
          }
        }
        dropRow(row.id);
        logger.log(`[rebuild] ${conv.id} 已是 ${targetPreset}，采纳现有会话并删队列行`);
        return { status: 'adopted', conversationId: conv.id, sessionId: conv.dsh_session_id };
      }
    }

    // 步骤 2-3：cancel 并等 turn/end。cancel 失败、等超时都继续往下走 ——
    // 卡在 draining 比"旧 turn 的 tool 调用 403"更危险。
    if (conv.dsh_session_id) {
      try {
        await dsh.cancel(conv.dsh_session_id);
      } catch (error) {
        logger.warn(`[rebuild] ${conv.id} cancel 失败，继续: ${error?.message ?? error}`);
      }
      try {
        await dsh.waitTurnEnd(conv.dsh_session_id, turnEndTimeoutMs);
      } catch (error) {
        logger.warn(`[rebuild] ${conv.id} 等 turn/end 出错，继续: ${error?.message ?? error}`);
      }
    }

    // 步骤 4：轮换 token。旧 turn 手里那个从此 403。
    const newToken = randomBytes(24).toString('hex');
    db.prepare('UPDATE conversation SET agent_token = ? WHERE id = ?').run(newToken, conv.id);

    // 步骤 5：重建。recap_at 先清空 —— 新 session 是空的，等 recap 成功再写。
    const created = await dsh.createSession({
      preset: targetPreset,
      workspaceId: conv.dsh_workspace_id,
    });
    if (!created?.sessionId) throw new Error('session/create 没有返回 sessionId');
    db.prepare(
      `UPDATE conversation
          SET dsh_session_id = ?, recap_at = NULL, dsh_after_seq = 0,
              epoch = epoch + 1
        WHERE id = ?`,
    ).run(created.sessionId, conv.id);

    const epoch = db.prepare(
      'SELECT epoch FROM conversation WHERE id = ?',
    ).get(conv.id).epoch;
    const latestSeq = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS m FROM message WHERE conversation_id = ?',
    ).get(conv.id).m;
    try {
      events?.publish?.(conv.id, {
        v: 1,
        type: 'conversation.rebuilt',
        conversationId: conv.id,
        epoch,
        seq: latestSeq,
        reason: row.reason,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn(`[rebuild] ${conv.id} 发送 rebuilt 事件失败: ${error?.message ?? error}`);
    }

    // recap 是 best-effort：session 建好就算重建成功，recap 挂了不重试整条，
    // 否则会重复建 session。recap_at 留 NULL，下次采纳时会补。
    try {
      const recap = await dsh.recap(created.sessionId);
      db.prepare('UPDATE conversation SET recap_at = ? WHERE id = ?').run(now(), conv.id);
      // 新会话的 DSH 日志从 0 开始；recap 的哨兵回复必须先越过，否则下一轮
      // pullAssistantMessages 会把「已恢复」当成正文捞进聊天记录。
      await advanceCursorAfterRecap({
        dsh,
        db,
        conversationId: conv.id,
        sessionId: created.sessionId,
        recapSent: recap?.sent === true,
        logger,
        shouldStop: () => stopping,
      });
    } catch (error) {
      logger.warn(`[rebuild] ${conv.id} recap 失败（不重试）: ${error?.message ?? error}`);
    }

    // 步骤 6：删行
    dropRow(row.id);
    return { status: 'rebuilt', conversationId: conv.id, sessionId: created.sessionId };
  }

  async function tick() {
    if (busy) return { status: 'skipped' };
    busy = true;
    try {
      const row = claimNext();
      if (!row) return { status: 'idle' };
      try {
        const result = await processRow(row);
        writeEvent(db, {
          kind: 'session.rebuild',
          conversationId: row.conversation_id,
          detail: {
            status: result.status,
            reason: row.reason,
            sessionId: result.sessionId ?? null,
          },
        });
        return result;
      } catch (error) {
        const result = recordFailure(row, error);
        logger.warn(
          `[rebuild] ${row.conversation_id} 重建失败 ${result.attempts}/${maxAttempts}: ${
            error?.message ?? error
          }`,
        );
        writeEvent(db, {
          level: 'error',
          kind: 'session.rebuild',
          conversationId: row.conversation_id,
          detail: {
            status: 'failed',
            reason: row.reason,
            attempts: result.attempts,
            message: String(error?.message ?? error).slice(0, 200),
          },
        });
        return { status: 'failed', conversationId: row.conversation_id, ...result, error };
      }
    } finally {
      busy = false;
    }
  }

  /** 一直处理到队列空或没有到期的行 */
  async function drain(maxRounds = 100) {
    const results = [];
    for (let i = 0; i < maxRounds; i += 1) {
      const result = await tick();
      if (result.status === 'idle' || result.status === 'skipped') break;
      results.push(result);
    }
    return results;
  }

  function start(intervalMs = 2_000) {
    if (!stopped) return;
    stopped = false;
    const loop = async () => {
      if (stopped) return;
      try {
        await drain();
      } catch (error) {
        logger.error(`[rebuild] worker 循环异常: ${error?.message ?? error}`);
      }
      if (!stopped) timer = setTimeout(loop, intervalMs);
      if (timer?.unref) timer.unref();
    };
    void loop();
  }

  function stop() {
    stopped = true;
    stopping = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { tick, drain, start, stop, claimNext };
}
