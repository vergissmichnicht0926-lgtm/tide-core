// 探针：看 session/follow 在 HTTP 上长什么样，以及能不能从中拿到 assistant 消息。
import fs from 'node:fs';
import path from 'node:path';
import { mintBrowserCookie } from '../../gateway/dsh/client.mjs';

const base = 'http://127.0.0.1:3081';
const home = 'D:/dsh/lab/dsh-home';

const credPath = path.join(home, '.credentials.yaml');
const text = fs.readFileSync(credPath, 'utf8');
// 按缩进切块，别用会把下一条记录吃进来的非贪婪正则（client.mjs:50-93 有同款）
const lines = text.split(/\r?\n/);
const startIdx = lines.findIndex((l) => /^\s*client-connection\/browser-session:\s*$/.test(l));
if (startIdx < 0) { console.error('凭据里没有 browser-session'); process.exit(1); }
const indent = lines[startIdx].match(/^\s*/)[0].length;
const block = [];
for (let i = startIdx + 1; i < lines.length; i += 1) {
  const l = lines[i];
  if (!l.trim()) { block.push(l); continue; }
  if (l.match(/^\s*/)[0].length <= indent) break;
  block.push(l);
}
const raw = /^\s*secret:\s*(\S+)\s*$/m.exec(block.join('\n'))?.[1];
if (!raw) { console.error('browser-session 没有 secret'); process.exit(1); }
const secret = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
console.log('secret 字节数', secret.byteLength);
const authority = new URL(base).host;
const { cookie } = mintBrowserCookie(authority, secret);
console.log('cookie 长度', cookie.length, '前缀', cookie.slice(0, 24));

async function rpc(method, args) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p-' + Date.now(), method, payload: { args } }),
  });
  const j = await res.json();
  if (!j.result?.ok) throw new Error(method + ': ' + JSON.stringify(j.result?.error));
  return j.result.value;
}

const list = await rpc('session/list', { _request: {} });
const items = list.items ?? [];
console.log('会话数', items.length);
for (const it of items.slice(0, 6)) {
  console.log(' -', it.sessionId, 'preset=', it.projections?.values?.agentPreset, 'running=', it.running);
}

const sessionId = process.argv[2] || items[items.length - 1]?.sessionId;
if (!sessionId) {
  console.error('没有会话可探');
  process.exit(1);
}
console.log('探 follow:', sessionId);

const res = await fetch(`${base}/api/session/follow`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'probe-follow-' + Date.now(),
    method: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } } },
  }),
});
console.log('HTTP', res.status, res.headers.get('content-type'));

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let chunks = 0;
const deadline = Date.now() + 6000;
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  chunks += 1;
  if (buf.length > 4000) break;
}
reader.cancel().catch(() => {});

console.log('读到', chunks, '块，共', buf.length, '字符');
console.log('--- 前 2500 字符 ---');
console.log(buf.slice(0, 2500));
