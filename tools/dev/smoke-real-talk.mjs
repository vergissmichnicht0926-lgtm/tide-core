// 真对话冒烟：拿真模型跑一轮不带指令的自然对话，看模型到底走哪条路。
//
// 观察三件事：
//   1. 网关侧落了几条消息（用户 1 条 + 助手几条）
//   2. DSH 日志里有没有 tool-call，叫什么名字
//   3. 有没有重复（chat_send 落库 + pullAssistantMessages 回拉 各来一遍）
//
// 用法：node smoke-real-talk.mjs
// 前提：真网关在 7800（lab 的 TIDE_GATEWAY_URL 指向这里），DSH 在 3081。

import { createDsh } from '../../gateway/dsh/client.mjs';

const base = 'http://127.0.0.1:7800';
const dshBase = 'http://127.0.0.1:3081';
const dshHome = 'D:/dsh/lab/dsh-home';

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

// ── 1. 登录 + 建会话 ────────────────────────────────────────────────────
const login = await json('POST', '/auth/login', {
  username: 'owner', password: 'tidepass123', device_name: 'smoke-real',
});
if (!login.body?.accessToken) {
  console.error('登录失败', login.status, JSON.stringify(login.body));
  process.exit(1);
}
const token = login.body.accessToken;
console.log('login', login.status, login.body.user.username);

const conv = await json('POST', '/conversations', { title: '真对话' }, token);
if (conv.status !== 201) {
  console.error('建会话失败', conv.status, JSON.stringify(conv.body));
  process.exit(1);
}
const cid = conv.body.id;
console.log('conversation', conv.status, cid);

// ── 2. 发一条自然消息（不带任何「别调工具」指令） ──────────────────────
const say = '在吗？随便跟我说句话。';
console.log('prompt →', JSON.stringify(say));
const prompt = await json('POST', `/conversations/${cid}/prompt`, {
  client_msg_id: 'real-' + Date.now(),
  text: say,
}, token);
console.log('prompt', prompt.status, JSON.stringify(prompt.body));

// ── 3. 等落库 ──────────────────────────────────────────────────────────
const deadline = Date.now() + 150_000;
let msgs = [];
let last = -1;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const m = await json('GET', `/conversations/${cid}/messages?limit=50`, undefined, token);
  msgs = m.body.messages ?? [];
  if (msgs.length !== last) {
    last = msgs.length;
    const el = Math.round((Date.now() - (deadline - 150_000)) / 1000);
    console.log(`  ${el}s: ${msgs.length} 条`);
  }
  if (msgs.filter((x) => x.role === 'assistant').length >= 1) break;
}

console.log('\n--- 网关里的消息 ---');
for (const m of msgs) {
  const c = m.content;
  const t = typeof c === 'object' ? (c?.text ?? JSON.stringify(c)) : String(c);
  console.log(' ', m.seq, m.role, JSON.stringify(String(t).slice(0, 100)));
}

// ── 4. 看 DSH 原始日志：模型有没有调工具、调了什么 ─────────────────────
const list = await json('GET', '/conversations?limit=50', undefined, token);
const row = (list.body.conversations ?? list.body.items ?? []).find((x) => x.id === cid);
const sessionId = row?.dsh_session_id;
console.log('\ndsh_session_id =', sessionId);

if (sessionId) {
  try {
    const dsh = createDsh({ baseUrl: dshBase, dshHome });
    const meta = await dsh.getSession(sessionId);
    const page = await dsh.rpc('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq: meta.asOfSeq,
        maxMessages: 200,
      },
    });
    const records = page?.records ?? [];
    console.log('DSH 记录数 =', records.length, ' asOfSeq =', meta.asOfSeq);

    const types = new Map();
    for (const r of records) {
      const t = r?.event?.type ?? r?.type ?? '?';
      types.set(t, (types.get(t) ?? 0) + 1);
    }
    console.log('\n记录类型：');
    for (const [t, n] of [...types].sort((a, b) => b[1] - a[1])) {
      console.log('  ', t, '×', n);
    }

    // 找所有工具调用
    const calls = [];
    for (const r of records) {
      const ev = r?.event ?? r;
      const data = ev?.data;
      const name = data?.name ?? data?.toolName ?? data?.tool?.name;
      if (name) calls.push({ type: ev.type, name });
      // assistant/message 里的 tool-call block
      const content = data?.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool-call') calls.push({ type: 'content/tool-call', name: b.name });
        }
      }
    }
    console.log('\n工具调用：');
    if (calls.length === 0) console.log('  （一次都没有）');
    for (const c of calls) console.log('  ', c.type, '→', c.name);
  } catch (e) {
    console.log('读 DSH 日志失败：', e?.code ?? '', e?.message ?? e);
  }
}

// ── 5. 判定 ────────────────────────────────────────────────────────────
const assistants = msgs.filter((x) => x.role === 'assistant');
console.log('\n--- 判定 ---');
console.log('assistant 条数 =', assistants.length);
if (assistants.length === 0) {
  console.log('FAIL 一条都没收到');
} else if (assistants.length === 1) {
  console.log('PASS 只收到一条');
} else {
  console.log('WARN 收到多条，可能是分条发送，也可能是重复落库');
}
