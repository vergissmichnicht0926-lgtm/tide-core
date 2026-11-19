// 给 rebuild-worker / prompt 投递用的假 DSH。行为可控，记录调用序列，不碰网络。
//
// 除了「会话管理」那六个方法，这里还模拟了消息日志：`prompt` 会追加一条 user 消息，
// 并按 `autoReply` 追加一条 assistant 正文；`readMessages` 按 seq 游标返回。
// 没有这层，网关「turn 结束后把 assistant 正文捞回本地库」那条路径就测不到。

export function createFakeDsh(options = {}) {
  const sessions = new Map(); // sessionId -> { agentPreset }
  const logs = new Map(); // sessionId -> [{ seq, role, id, text }]
  let seq = 0;
  let promptSeq = 0;
  let messageSeq = 0;
  const calls = [];

  const state = {
    turnEndMode: options.turnEndMode ?? 'respond', // respond | timeout | throw
    createFailTimes: options.createFailTimes ?? 0,
    createFailMessage: options.createFailMessage ?? 'session/create 炸了',
    recapFails: options.recapFails ?? false,
    recapSent: options.recapSent ?? false,
    recapReplyText: options.recapReplyText ?? '已恢复',
    autoReply: options.autoReply ?? true,
    autoReplyChatSent: options.autoReplyChatSent ?? false,
    replyText: options.replyText ?? '收到。',
    readFails: options.readFails ?? false,
    promptFailTimes: options.promptFailTimes
      ?? (options.promptFails ? Number.POSITIVE_INFINITY : 0),
    promptFailMessage: options.promptFailMessage ?? 'session/prompt 炸了',
    promptFailCode: options.promptFailCode ?? null,
    cancelThrows: options.cancelThrows ?? false,
    listThrows: options.listThrows ?? false,
  };

  function logOf(sessionId) {
    if (!logs.has(sessionId)) logs.set(sessionId, []);
    return logs.get(sessionId);
  }

  function append(sessionId, role, text, extra = {}) {
    messageSeq += 1;
    const row = {
      seq: messageSeq,
      role,
      id: `dsh-msg-${messageSeq}`,
      text,
      turn: extra.turn ?? messageSeq,
      chatSent: extra.chatSent === true,
    };
    logOf(sessionId).push(row);
    return row;
  }

  return {
    state,
    sessions,
    logs,
    calls,
    getCallCount(name) {
      return calls.filter((c) => c.name === name).length;
    },
    /** 测试直接往某个会话里塞一条消息，用来模拟「turn 跑完才产出正文」。 */
    pushMessage(sessionId, role, text, extra = {}) {
      return append(sessionId, role, text, extra);
    },

    async getSession(sessionId) {
      calls.push({ name: 'getSession', sessionId });
      if (state.listThrows) throw new Error('session/list 不可用');
      const s = sessions.get(sessionId);
      if (!s) return null;
      const log = logOf(sessionId);
      const asOfSeq = log.length > 0 ? log[log.length - 1].seq : 0;
      return { ...s, asOfSeq };
    },

    async readMessages(sessionId, { afterSeq = 0 } = {}) {
      calls.push({ name: 'readMessages', sessionId, afterSeq });
      if (state.readFails) throw new Error('session/page 不可用');
      return logOf(sessionId)
        .filter((row) => row.seq > afterSeq)
        .map((row) => ({ ...row }));
    },

    async cancel(sessionId) {
      calls.push({ name: 'cancel', sessionId });
      if (state.cancelThrows) throw new Error('cancel 请求失败');
    },

    async createWorkspace({ conversationId, path: workspacePath }) {
      calls.push({ name: 'createWorkspace', conversationId, path: workspacePath });
      return { workspaceId: `ws-${String(conversationId).slice(0, 8)}` };
    },

    async waitTurnEnd(sessionId, timeoutMs) {
      calls.push({ name: 'waitTurnEnd', sessionId, timeoutMs });
      if (state.turnEndMode === 'throw') throw new Error('事件流断了');
      return state.turnEndMode === 'respond';
    },

    async createSession({ preset }) {
      calls.push({ name: 'createSession', preset });
      if (state.createFailTimes > 0) {
        state.createFailTimes -= 1;
        throw new Error(state.createFailMessage);
      }
      seq += 1;
      const sessionId = `sess-${seq}`;
      sessions.set(sessionId, { agentPreset: preset });
      return { sessionId };
    },

    async recap(sessionId) {
      calls.push({ name: 'recap', sessionId });
      if (state.recapFails) throw new Error('recap 挂了');
      if (!state.recapSent) return { sent: false };
      append(sessionId, 'assistant', state.recapReplyText);
      return { sent: true };
    },

    async prompt(sessionId, content, { mode = 'queue' } = {}) {
      calls.push({ name: 'prompt', sessionId, content, mode });
      if (state.promptFailTimes > 0) {
        state.promptFailTimes -= 1;
        const error = new Error(state.promptFailMessage);
        if (state.promptFailCode) error.code = state.promptFailCode;
        throw error;
      }
      promptSeq += 1;
      const text = Array.isArray(content)
        ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : String(content ?? '');
      append(sessionId, 'user', text);
      if (state.autoReply) {
        // `autoReplyChatSent` 模拟「这一 turn 已经用 chat_send 发出去过」：
        // 随后那条 assistant 文本只是模型收尾旁白，网关不该搬进聊天记录。
        append(sessionId, 'assistant', state.replyText, { chatSent: state.autoReplyChatSent });
      }
      return { requestId: `req-${promptSeq}` };
    },
  };
}
