// 连发两条：第一条收到回复后、模型大概正卡在 chat_wait 里，再发第二条。
// 看它会不会醒、会不会重复落库。
import { DatabaseSync } from 'node:sqlite';

const base = 'http://127.0.0.1:7800';

async function json(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

const login = await json('POST', '/auth/login', { username: 'owner', password: 'tidepass123', device_name: 'two-turn' });
const token = login.body.accessToken;
const conv = await json('POST', '/conversations', { title: '连发两条' }, token);
const cid = conv.body.id;
console.log('conversation', cid);

async function dump(tag) {
  const m = await json('GET', `/conversations/${cid}/messages?limit=50`, undefined, token);
  const msgs = m.body.messages ?? [];
  console.log(`\n[${tag}] ${msgs.length} 条`);
  for (const x of msgs) {
    const t = typeof x.content === 'object' ? (x.content?.text ?? '') : String(x.content);
    console.log(' ', x.seq, x.role, JSON.stringify(String(t).slice(0, 90)));
  }
  return msgs;
}

// 第一句
await json('POST', `/conversations/${cid}/prompt`, { client_msg_id: 'two-1', text: '第一句：你今天吃了吗' }, token);
let t0 = Date.now();
while (Date.now() - t0 < 120_000) {
  await new Promise((r) => setTimeout(r, 2000));
  const msgs = (await json('GET', `/conversations/${cid}/messages?limit=50`, undefined, token)).body.messages ?? [];
  if (msgs.filter((x) => x.role === 'assistant').length >= 1) break;
}
await dump('第一轮之后');

// 隔 5 秒再发——这时模型多半正在 chat_wait 里挂着
await new Promise((r) => setTimeout(r, 5000));
console.log('\nsent 第二句');
await json('POST', `/conversations/${cid}/prompt`, { client_msg_id: 'two-2', text: '第二句：那你想吃什么' }, token);

// 等第二个 assistant
t0 = Date.now();
while (Date.now() - t0 < 180_000) {
  await new Promise((r) => setTimeout(r, 3000));
  const msgs = (await json('GET', `/conversations/${cid}/messages?limit=50`, undefined, token)).body.messages ?? [];
  const n = msgs.filter((x) => x.role === 'assistant').length;
  if (n >= 2) break;
}
const finalMsgs = await dump('第二轮之后');
console.log('\n结果：assistant 共', finalMsgs.filter((x) => x.role === 'assistant').length, '条');

// 库里看 dsh 侧
const db = new DatabaseSync('D:/dsh/tide-core/data/gateway.db', { readOnly: true });
const row = db.prepare('SELECT dsh_session_id, dsh_after_seq FROM conversation WHERE id = ?').get(cid);
console.log('dsh_session_id', row?.dsh_session_id, ' 水位', row?.dsh_after_seq);
db.close();
