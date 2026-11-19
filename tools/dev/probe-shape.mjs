// 看 session/page 的原始记录结构：assistant/message 带不带 turn 信息。
import { createDsh } from '../../gateway/dsh/client.mjs';

const sessionId = process.argv[2];
const dsh = createDsh({ baseUrl: 'http://127.0.0.1:3081', dshHome: 'D:/dsh/lab/dsh-home' });
const meta = await dsh.getSession(sessionId);
const page = await dsh.rpc('session/page', {
  request: {
    address: { kind: 'session', sessionId },
    throughSeq: meta.asOfSeq,
    maxMessages: 200,
  },
});

for (const r of page.records ?? []) {
  const ev = r?.event ?? r;
  const t = ev?.type ?? '?';
  if (t !== 'assistant/message' && t !== 'tool/call' && t !== 'tool/result' && t !== 'turn/start' && t !== 'turn/end' && t !== 'user/message') continue;
  // 只打印顶层键 + turn 相关字段
  const d = ev?.data ?? {};
  const keys = Object.keys(ev).join(',');
  const dKeys = Object.keys(d).join(',');
  const turn = d.turn ?? d.turnSeq ?? d.turnIndex ?? '-';
  const step = d.step ?? '-';
  console.log(`[${ev.seq}] ${t.padEnd(18)} turn=${turn} step=${step}  ev.keys=${keys}  data.keys=${dKeys}`);
}
