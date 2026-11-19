/** 0.26 控制台测试发送：走 App 的真实发消息入口。 */

import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { postPrompt } from '../routes/conversations.mjs';
import { writeConsoleChange } from './http.mjs';

export async function postTestMessage(ctx, req, session, conversationId) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'bad-request', 'body 必须是 JSON 对象');
  }
  if (typeof body.text !== 'string') {
    throw new ApiError(400, 'bad-request', 'text 必须是字符串');
  }
  const text = body.text.trim();
  if (!text) throw new ApiError(400, 'bad-request', 'text 不能为空');
  if (text.length > 500) throw new ApiError(400, 'bad-request', 'text 最多 500 字');

  const result = await postPrompt(
    ctx,
    session.user.userId,
    conversationId,
    { text },
  );
  const message = result?.message;
  if (!message) {
    throw new ApiError(500, 'send-failed', '网关没有返回消息回执');
  }
  const wakeReason = message.wakeReason ?? message.wake_reason ?? null;
  writeConsoleChange(ctx, 'conversation.test.send', conversationId, {
    seq: message.seq,
    wakeReason,
  });
  return {
    ok: true,
    messageId: message.id,
    seq: message.seq,
    wakeReason,
  };
}
