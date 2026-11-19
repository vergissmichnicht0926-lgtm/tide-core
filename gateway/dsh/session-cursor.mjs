/**
 * DSH 会话日志游标工具。
 *
 * recap 的 prompt 只是被 DSH 受理，回复是异步产生的；`waitTurnEnd` 轮询 `running`
 * 时 turn 可能还没起来，会被误判成「已空闲」。所以 recap 的哨兵回复只能直接盯
 * `readMessages`，等它真的落地，再把 `dsh_after_seq` 推过去。
 */

export async function waitForAssistantAppear(
  dsh,
  sessionId,
  timeoutMs = 30_000,
  { shouldStop } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldStop?.()) return false;
    try {
      const rows = await dsh.readMessages(sessionId, { maxMessages: 5 });
      if (rows.some((row) => row.role === 'assistant')) return true;
    } catch {
      // 读失败只当没读到，继续等；超时由调用方决定是否继续重建
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function advanceCursorAfterRecap({
  dsh,
  db,
  conversationId,
  sessionId,
  recapSent,
  logger,
  shouldStop,
}) {
  if (recapSent) {
    await waitForAssistantAppear(dsh, sessionId, 30_000, { shouldStop });
  }
  try {
    const cursor = await dsh.getSession(sessionId);
    if (cursor && Number.isFinite(cursor.asOfSeq)) {
      db.prepare('UPDATE conversation SET dsh_after_seq = ? WHERE id = ?')
        .run(cursor.asOfSeq, conversationId);
      return cursor.asOfSeq;
    }
  } catch (error) {
    logger?.warn?.(`[dsh] 读 recap 游标失败: ${error?.message ?? error}`);
  }
  return null;
}
