// 端到端：登录 → 建会话 → 发 prompt → 等 assistant 落库 → 读回来。
const base = 'http://127.0.0.1:3099';

async function json(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

const login = await json('POST', '/auth/login', { username: 'owner', password: 'tidepass123', device_name: 'smoke-e2e' });
console.log('login', login.status, login.body?.user?.username);
const token = login.body.accessToken;

const conv = await json('POST', '/conversations', { title: 'assistant 回显' }, token);
console.log('conversation', conv.status, conv.body.id, 'ws=', conv.body.dsh_workspace_id);
const cid = conv.body.id;

const prompt = await json('POST', `/conversations/${cid}/prompt`, {
  client_msg_id: 'e2e-' + Date.now(),
  text: '只回复四个字：我收到了。不要调用任何工具。',
}, token);
console.log('prompt', prompt.status, JSON.stringify(prompt.body));

const deadline = Date.now() + 90_000;
let last = 0;
let msgs = [];
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const m = await json('GET', `/conversations/${cid}/messages?limit=50`, undefined, token);
  msgs = m.body.messages ?? [];
  if (msgs.length !== last) {
    last = msgs.length;
    console.log(`  ${Math.round((90_000 - (deadline - Date.now())) / 1000)}s: ${msgs.length} 条`);
  }
  if (msgs.some((x) => x.role === 'assistant')) break;
}

console.log('--- 最终消息 ---');
for (const m of msgs) {
  const t = typeof m.content === 'object' ? (m.content.text ?? JSON.stringify(m.content)) : String(m.content);
  console.log(' ', m.seq, m.role, JSON.stringify(String(t).slice(0, 90)));
}
const ok = msgs.some((m) => m.role === 'assistant');
console.log(ok ? 'PASS assistant 落库' : 'FAIL 没有 assistant 消息');
process.exit(ok ? 0 : 1);
