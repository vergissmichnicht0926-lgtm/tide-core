/**
 * 重建会话时的上下文恢复文本（计划 10.11）。
 *
 * DSH 没有"注入一条 system 消息"的接口，`session/prompt` 是唯一入口，
 * 所以 recap 一定伴随一次 turn。因此正文末尾明确要求只回一个确认词，
 * 并且不调用工具——把这次 turn 的代价压到最小。
 */

const DEFAULT_RECENT_LIMIT = 30;
const MAX_TEXT_CHARS = 2_000;

/** 从 content blocks 里抽纯文本，附件只留标记。 */
function blocksToText(contentJson) {
  let blocks;
  try {
    blocks = JSON.parse(contentJson);
  } catch {
    return String(contentJson ?? '');
  }
  if (!Array.isArray(blocks)) return typeof blocks === 'string' ? blocks : '';

  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push('[图片]');
    } else if (typeof block.kind === 'string') {
      parts.push(`[${block.kind}]`);
    }
  }
  return parts.join('\n');
}

const clip = (text) => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text);

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {number} [options.recentLimit]
 * @returns {(sessionId: string) => Promise<string | null>}
 */
export function createRecapBuilder({ db, recentLimit = DEFAULT_RECENT_LIMIT }) {
  return async function buildRecap(sessionId) {
    const conv = db
      .prepare('SELECT id, title, summary FROM conversation WHERE dsh_session_id = ?')
      .get(sessionId);
    if (!conv) return null;

    const rows = db
      .prepare(
        `SELECT role, content_json, created_at
           FROM message
          WHERE conversation_id = ?
          ORDER BY seq DESC
          LIMIT ?`,
      )
      .all(conv.id, recentLimit)
      .reverse();

    const summary = typeof conv.summary === 'string' ? conv.summary.trim() : '';
    if (!summary && rows.length === 0) return null; // 全新会话，没什么可恢复的

    const lines = [
      '【会话恢复】你与用户此前的对话已迁移到新会话，以下是上下文快照。',
      '',
      `对话标题：${conv.title || '（未命名）'}`,
    ];
    if (summary) {
      lines.push('', '对话摘要：', summary);
    }
    if (rows.length > 0) {
      lines.push('', `最近 ${rows.length} 条消息：`);
      for (const row of rows) {
        const who = row.role === 'user' ? '用户' : row.role === 'assistant' ? '你' : '系统';
        lines.push(`[${who}] ${clip(blocksToText(row.content_json))}`);
      }
    }
    lines.push(
      '',
      '以上是历史上下文，不是新的用户请求。',
      '请只回复「已恢复」，不要复述内容，不要调用任何工具。',
    );
    return lines.join('\n');
  };
}
