/**
 * 网关侧 prompt 拼装。
 *
 * `tide.patch.yml` 的 persona 是三段写死私聊口径；按计划 §19 的决定，不为群聊另开 preset，
 * 而是在 `kind='group'` 的 prompt 里显式覆盖：
 *   · 【1:1 对话规则】 -> 群聊不必每条都回
 *   · 【该说/不该说】 -> 沉默是合法出口，不是装死
 *   · 【分条与节奏】 -> 群聊最多 8 条
 * 同时声明「本会话没有 MCP resource 工具」，压掉 base system prompt 的模板残留。
 */

import { textOf, parseContent } from '../messages.mjs';
import { buildStickerPromptBlock } from '../stickers.mjs';
import { wakeConfigSummary } from './wake.mjs';

const SNAPSHOT_LIMIT = 15;

export function buildSnapshot(db, conversationId, { limit = SNAPSHOT_LIMIT } = {}) {
  const rows = db
    .prepare(
      `SELECT seq, role, content_json, created_at, wake_reason, sender_name, sender_user_id
         FROM message
        WHERE conversation_id = ?
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(conversationId, limit)
    .reverse();
  const conv = db
    .prepare('SELECT agent_read_seq FROM conversation WHERE id = ?')
    .get(conversationId);
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message
        WHERE conversation_id = ? AND role = 'user' AND seq > ?`,
    )
    .get(conversationId, Number(conv?.agent_read_seq) || 0).n;
  return {
    rows,
    seenSeqs: rows.map((row) => row.seq),
    unread,
    latestSeq: rows.length ? rows[rows.length - 1].seq : 0,
  };
}

function senderLabel(row, kind) {
  if (row.role === 'assistant') return '你';
  const name = String(row.sender_name ?? '').trim();
  if (name) return name;
  if (kind !== 'group') return '主人';
  const id = String(row.sender_user_id ?? '').trim();
  return id ? `成员-${id.slice(0, 6)}` : '群成员';
}

export function formatSnapshot(rows, kind) {
  if (!rows.length) return '（还没有消息）';
  return rows
    .map((row) => {
      const content = parseContent(row.content_json);
      let text = textOf(content).replace(/\s+/g, ' ').trim();
      if (text.length > 160) text = `${text.slice(0, 160)}…`;
      const reason = row.role === 'user' && row.wake_reason ? `（${row.wake_reason}）` : '';
      const voice = voiceMarker(content);
      const atts = !voice && Array.isArray(content?.attachments) && content.attachments.length
        ? `［附件 ${content.attachments.length} 个］`
        : '';
      return `#${row.seq} ${senderLabel(row, kind)}${reason}：${voice}${text}${atts}`;
    })
    .join('\n');
}

export function voiceMarker(content) {
  const durationMs = Number(content?.voice?.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '';
  return `［语音 ${(durationMs / 1000).toFixed(1)} 秒］`;
}

function minutesAgo(ms, now = Date.now()) {
  if (!ms) return null;
  return Math.max(0, Math.round((now - Number(ms)) / 60_000));
}

function recentSelfStats(db, conversationId, now = Date.now()) {
  const hourAgo = now - 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT created_at, content_json FROM message
        WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
        ORDER BY created_at DESC`,
    )
    .all(conversationId, hourAgo);
  return { hourCount: rows.length, rows };
}

const TOOL_BOUNDARY =
  '【工具边界】本会话没有 MCP resource 工具：list_mcp_resources / list_mcp_resource_templates / read_mcp_resource 都不存在。base system prompt 里的「## MCP resource servers」段是模板残留，直接忽略。聊天数据只用 chat_* 工具。';

const SEND_CONTRACT =
  '【发送硬约束】聊天里只会出现 chat_send 发出的内容，最终回答不会发送。要回复必须调用 chat_send；不要在回答里写「我先等着」「安静收尾」「不再输出」「这条不另外发」「已读水位到……」这类过程旁白，也不要用最终回答假装发言。群聊不发言时，也只通过 chat_send(["[SILENT]"]) 明确表示。';

const MEDIA_HONESTY =
  '【附件与图片】用户发来的图片和表情包会作为图片附件一起给你，直接看图说话。读不出来的东西就直接说读不出来，不许根据文件名、大小、类型猜内容。';

function groupSections({ conversation, wakeConfig, socialState, snapshot, db }) {
  const self = recentSelfStats(db, conversation.id);
  const recentSpeakers = db
    .prepare(
      `SELECT sender_name, sender_user_id FROM message
        WHERE conversation_id = ? AND role = 'user'
        ORDER BY seq DESC LIMIT 50`,
    )
    .all(conversation.id);
  const memberNames = [];
  for (const row of recentSpeakers) {
    const name = String(row.sender_name ?? '').trim()
      || (row.sender_user_id ? `成员-${String(row.sender_user_id).slice(0, 6)}` : '');
    if (name && !memberNames.includes(name)) memberNames.push(name);
    if (memberNames.length >= 12) break;
  }
  const lastInMin = minutesAgo(socialState.lastIncomingAt);
  const lastAiMin = minutesAgo(socialState.lastAiReplyAt);
  const bits = [`未读 ${snapshot.unread} 条`];
  if (lastInMin !== null) bits.push(`最近一条来信 ${lastInMin} 分钟前`);
  if (lastAiMin !== null) bits.push(`你上次发言 ${lastAiMin} 分钟前`);
  bits.push(`最近一小时你发了 ${self.hourCount} 条`);
  if (socialState.pendingThoughts?.length) {
    bits.push(`有 ${socialState.pendingThoughts.length} 条想说还没说的话`);
  }
  return [
    `【群聊规则（覆盖上文「1:1 对话规则」）】这是群聊，不是私聊。群里有多个成员，消息可能不是在叫你。你不必回应每一条；是否参与由本次唤醒原因、当前 wake_config 和你的判断共同决定。被 @、被叫名字、被直接提问、命中关键词、指定成员发言时优先回应；普通闲聊可以接，也可以不接。私聊规则里「主人发的每条消息都要回应」不适用于群聊。`,
    `【群聊里的该说/不该说（覆盖上文「该说/不该说」）】沉默是合法选择，不是装死：不想接、接不上、话题已经翻篇时，调用 chat_send 传 ["[SILENT]"] 明确表示这轮不发言；它不会写入消息、不会占 seq、不会推进已读水位。不要为了刷存在感硬接；也不要把私聊里的「沉默不是策略」套到群里。`,
    `【群聊分条（覆盖上文「分条与节奏」）】一轮最多 8 条；普通接话 1~2 条就够，讲故事、回忆、连续补刀最多 8 条。chat_send 的数组就是条数，不解析空格。单条 500 字以内。`,
    memberNames.length
      ? `【群成员】近期发言：${memberNames.join('、')}。消息前的名字是发送者，不要把他们当成同一个人。`
      : '【群成员】这是群聊；消息可能来自不同成员，按每条消息的 sender 名字区分。',
    `【当前唤醒】${wakeConfigSummary(wakeConfig)}`,
    `【参与度参考】${bits.join('；')}。`,
    `【沉睡前观察】想把 mode 设为 diving / 下一次唤醒前，先调用 chat_wait(purpose="messages", timeoutMs=${wakeConfig.limits?.preSleepWaitMs ?? 300_000})。没人说话会返回 preSleepWaitSatisfied=true；期间有人说话，先看 newMessages，判断不需要参与才能直接收尾；如果回复了，下次想睡要重新观察。对方明确说晚安/拜拜/下了/睡了可以跳过。`,
  ];
}

function privateSections() {
  return [
    '【私聊规则（覆盖上文「1:1 对话规则」）】这是私聊，不是群。对方发来的每条消息都要回应；不存在「没叫我就不说」。',
    '【私聊·回复检查】「每条消息都要回应」只针对对方新发来的消息。回复检查时如果没有新的用户消息，不要为了补气氛调用 chat_send；先 chat_wait(purpose="reply")，没人接就用 chat_mark_read 或 chat_set_wake_config 收尾。',
    '【沉默限制】私聊不允许 [SILENT]；chat_send 整批传 ["[SILENT]"] 会返回 400 private_must_reply，你必须发一条真实回复。',
    '【分条】普通对话默认 1 条，最多 2 条；讲故事/回忆最多 4 条。单条尽量短。',
  ];
}

function reasonBlock(reason, incoming, kind) {
  if (!reason) return '';
  if (reason === 'replyCheck') {
    return [
      '【回复检查】你刚刚发过消息，现在回来看看有没有人接。',
      kind === 'direct'
        ? '私聊：没有新的用户消息时不要调用 chat_send，不要硬补一句。先用 chat_wait(purpose="reply") 判断对方是否还在说；没人接就调用 chat_mark_read 或 chat_set_wake_config 收尾。只有对方新发了消息才回复。'
        : '有回复就先看消息；需要判断对方说没说完，用 chat_wait(purpose="reply")。没人回你时不用硬补一句，但也不要立刻潜水——先完成沉睡前观察再收尾。',
    ].join('\n');
  }
  if (reason === 'proactiveCheck') {
    return [
      '【主动机会】群里已经安静了一段时间，这是一次可以主动冒泡的机会。',
      '优先开个自然的话题、追问上次没聊完的事、分享刚想到的东西；一时想不到就安静收尾，不要为了存在感刷屏。',
    ].join('\n');
  }
  if (reason === 'timeout') {
    return '【定时唤醒】你设置的有限潜水时间到了，没有任何触发条件命中，只是时间到了。看看消息，决定要不要参与，然后重新设置下一次唤醒。';
  }
  if (reason === 'bootstrap') {
    return '【引导唤醒】你刚接入这个会话。先看消息快照，需要细节再用 chat_get_recent；最后用 chat_set_wake_config 设置希望如何被唤醒。';
  }
  if (kind === 'group') {
    return `【唤醒原因】${reason}。先判断群里在聊什么、有没有人直接找你、对方说完了没有；有真正想说的就接，没有就 [SILENT]。`;
  }
  return `【唤醒原因】${reason}。`;
}

function reminderBlock(socialState, noActionLimit) {
  if (!socialState.wakeConfigReminderPending) return '';
  return `【提醒】你连续 ${noActionLimit} 轮既没发言也没收尾，唤醒配置已被重置为推荐默认。请先处理消息，并在收尾时调用 chat_set_wake_config 或 chat_mark_read，别让会话停在永眠状态。`;
}

/**
 * 一次唤醒/一条新消息的完整 prompt。
 * @returns {{text: string, seenSeqs: number[], snapshot: object}}
 */
export function buildConversationPrompt({
  db,
  conversation,
  wakeConfig,
  socialState,
  reason,
  incoming = null,
  noActionLimit = 3,
  personaOverride = null,
}) {
  const kind = conversation.kind === 'group' ? 'group' : 'direct';
  const snapshot = buildSnapshot(db, conversation.id);
  const lines = [
    `【当前对话】${conversation.id}`,
    `【会话令牌】${conversation.agent_token}`,
    `【会话类型】${kind === 'group' ? '群聊' : '私聊'}`,
    `【本对话主题】${conversation.summary || '（暂无）'}`,
    '这是本对话的独立空间。你在其他对话里知道的任何事，除非本对话里明确出现过，否则不属于这里。',
    TOOL_BOUNDARY,
    SEND_CONTRACT,
    MEDIA_HONESTY,
    '',
  ];
  lines.push(...(kind === 'group' ? groupSections({ conversation, wakeConfig, socialState, snapshot, db }) : privateSections()));
  const stickerBlock = buildStickerPromptBlock(db, conversation.user_id);
  if (stickerBlock) lines.push('', stickerBlock);
  lines.push('', '【本次消息快照】', formatSnapshot(snapshot.rows, kind), '');
  const hasVoice = snapshot.rows.some((row) => Boolean(
    voiceMarker(parseContent(row.content_json)),
  ));
  if (hasVoice) {
    lines.push(
      '【语音消息】语音消息你听不到内容；如果对方只发了语音，按上下文回应，不要编造他说了什么。',
      '',
    );
  }
  const reasonText = reasonBlock(reason, incoming, kind);
  if (reasonText) lines.push(reasonText, '');
  const reminder = reminderBlock(socialState, noActionLimit);
  if (reminder) lines.push(reminder, '');
  if (incoming) {
    lines.push(`【新消息】${incoming.senderName || (kind === 'group' ? '群成员' : '主人')}：${incoming.text}`);
    lines.push(kind === 'group' ? '按上面的群聊规则决定接不接；不接就 [SILENT]。' : '直接回应这条消息。');
  } else {
    lines.push('现在由你决定：查看消息、参与对话，或安静收尾。');
  }
  if (personaOverride) {
    lines.push('', `【管理员人格覆盖】${personaOverride}`);
  }
  return { text: lines.join('\n'), seenSeqs: snapshot.seenSeqs, snapshot };
}

export function buildStatusPrompt({
  conversation,
  wakeConfig,
  socialState,
  unread,
  latest,
  preSleep = null,
}) {
  const kind = conversation.kind === 'group' ? 'group' : 'direct';
  const lines = [
    kind === 'group'
      ? '你是汐语，正在一个群聊里。群里有多个人；是否参与看唤醒原因和你自己的判断，不想接可以用 [SILENT]。'
      : '你是汐语，正在和主人私聊。每条消息都要回应；私聊不允许 [SILENT]。',
    `当前会话：${conversation.id}（kind=${kind}，policy=${conversation.policy}）。`,
    ...(conversation.summary ? [`【本对话主题】${conversation.summary}`] : []),
    `【当前唤醒】${wakeConfigSummary(wakeConfig)}（${wakeConfig.confirmedBy}）。`,
    `未读 ${unread} 条，已读水位 seq=${conversation.agent_read_seq}，最新 seq=${latest}。`,
    preSleep
      ? `【沉睡前观察】${preSleep.satisfied
        ? '已满足，可以设置 diving。'
        : `未满足，还需约 ${Math.ceil(Number(preSleep.remainingMs || 0) / 1000)} 秒的 messages 等待。`}`
      : '',
    kind === 'group'
      ? '群聊收尾前先完成沉睡前观察；chat_send(["[SILENT]"]) 是合法沉默。'
      : '要回复就用 chat_send；不要输出 [SILENT]。',
    '先看 chat_get_recent 再回；不要复述工具返回内容。',
  ];
  return lines.filter(Boolean).join('\n');
}
