// 看一轮真对话在 DSH 侧到底发生了什么。
import { DatabaseSync } from 'node:sqlite';
import { createDsh } from '../../gateway/dsh/client.mjs';

const cid = process.argv[2];
if (!cid) {
  console.error('用法: node probe-turn.mjs <conversationId>');
  process.exit(1);
}

const db = new DatabaseSync('D:/dsh/tide-core/data/gateway.db', { readOnly: true });
const conv = db.prepare('SELECT id, dsh_session_id, dsh_after_seq, agent_token FROM conversation WHERE id = ?').get(cid);
if (!conv) {
  console.error('没有这个会话');
  process.exit(1);
}
console.log('conversation', conv.id);
console.log('dsh_session_id', conv.dsh_session_id);
console.log('dsh_after_seq', conv.dsh_after_seq);

const msgs = db.prepare('SELECT seq, role, dsh_message_id, substr(content_json,1,120) AS c FROM message WHERE conversation_id = ? ORDER BY seq').all(cid);
console.log('\n--- 网关库里的消息 ---');
for (const m of msgs) {
  console.log(' ', m.seq, m.role, 'dsh_id=', m.dsh_message_id ?? '(null)', JSON.stringify(m.c));
}

if (!conv.dsh_session_id) process.exit(0);

const dsh = createDsh({ baseUrl: 'http://127.0.0.1:3081', dshHome: 'D:/dsh/lab/dsh-home' });
const meta = await dsh.getSession(conv.dsh_session_id);
console.log('\nasOfSeq =', meta.asOfSeq, ' preset =', meta.agentPreset);

const page = await dsh.rpc('session/page', {
  request: {
    address: { kind: 'session', sessionId: conv.dsh_session_id },
    throughSeq: meta.asOfSeq,
    maxMessages: 200,
  },
});
const records = page?.records ?? [];
console.log('\n--- DSH 原始记录（只列内容相关的） ---');
for (const r of records) {
  const ev = r?.event ?? r;
  const t = ev?.type ?? '?';
  const d = ev?.data ?? {};

  if (t === 'user/message') {
    const text = (d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' / ');
    console.log(`[${ev.seq}] user/message  ${JSON.stringify(text.slice(0, 140))}`);
    continue;
  }
  if (t === 'assistant/message') {
    const blocks = (d.message?.content ?? []).map((b) => {
      if (b.type === 'text') return `text(${b.text.length}):${JSON.stringify(b.text.slice(0, 80))}`;
      if (b.type === 'tool-call') return `tool-call:${b.name}(${String(b.arguments ?? '').slice(0, 140)})`;
      if (b.type === 'reasoning') return `reasoning(${String(b.text ?? '').length})`;
      return b.type;
    });
    console.log(`[${ev.seq}] assistant/message id=${d.message?.id ?? '?'}`);
    for (const b of blocks) console.log('      ·', b);
    continue;
  }
  if (t.startsWith('tool')) {
    console.log(`[${ev.seq}] ${t}  ${JSON.stringify(d).slice(0, 200)}`);
    continue;
  }
}
db.close();
