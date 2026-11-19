// SSE 端到端：看一次「发消息 → 回复」在事件流上的完整序列。
const base = 'http://127.0.0.1:3099';

async function json(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const login = await json('POST', '/auth/login', { username: 'owner', password: 'tidepass123', device_name: 'sse-e2e' });
const token = login.body.accessToken;
const conv = await json('POST', '/conversations', { title: 'SSE 序列' }, token);
const cid = conv.body.id;
console.log('conversation', cid);

const ctrl = new AbortController();
const events = [];
const sse = await fetch(`${base}/conversations/${cid}/stream?since_seq=0`, {
  headers: { authorization: `Bearer ${token}` },
  signal: ctrl.signal,
});
console.log('sse', sse.status);
const reader = sse.body.getReader();
const dec = new TextDecoder();
let buf = '';
const pump = (async () => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:'));
      if (dataLines.length === 0) continue;
      const payload = dataLines.map((l) => l.slice(5).trim()).join('\n');
      try {
        const ev = JSON.parse(payload);
        events.push(ev);
        const brief = ev.type === 'assistant_message'
          ? `"${String(ev.message?.text ?? '').slice(0, 40)}"`
          : (ev.message?.text ? `"${String(ev.message.text).slice(0, 30)}"` : '');
        console.log('  event', ev.type, brief);
        if (ev.type === 'turn_end') return;
      } catch { /* 忽略心跳等非 JSON 行 */ }
    }
  }
})();

await new Promise((r) => setTimeout(r, 500));
await json('POST', `/conversations/${cid}/prompt`, {
  client_msg_id: 'sse-' + Date.now(),
  text: '只回复三个字：看到了。不要调用任何工具。',
}, token);

await Promise.race([pump, new Promise((r) => setTimeout(r, 100_000))]);
ctrl.abort();

const types = events.map((e) => e.type);
console.log('序列:', types.join(' → '));
const ok = types.includes('user_message') && types.includes('assistant_message') && types.includes('turn_end');
console.log(ok ? 'PASS SSE 事件序列完整' : 'FAIL 缺事件');
process.exit(ok ? 0 : 1);
