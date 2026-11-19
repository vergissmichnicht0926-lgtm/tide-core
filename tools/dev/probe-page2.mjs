// 探针 3：session/page 的 assistant/message 记录长什么样，文本在哪。
import fs from 'node:fs';
import path from 'node:path';
import { mintBrowserCookie } from '../../gateway/dsh/client.mjs';

const base = 'http://127.0.0.1:3081';
const home = 'D:/dsh/lab/dsh-home';

const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
const lines = text.split(/\r?\n/);
const startIdx = lines.findIndex((l) => /^\s*client-connection\/browser-session:\s*$/.test(l));
const indent = lines[startIdx].match(/^\s*/)[0].length;
const block = [];
for (let i = startIdx + 1; i < lines.length; i += 1) {
  const l = lines[i];
  if (!l.trim()) { block.push(l); continue; }
  if (l.match(/^\s*/)[0].length <= indent) break;
  block.push(l);
}
const raw = /^\s*secret:\s*(\S+)\s*$/m.exec(block.join('\n'))[1];
const { cookie } = mintBrowserCookie(new URL(base).host, Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

async function rpc(method, args) {
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'p-' + Math.random().toString(36).slice(2), method, payload: { args } }),
  });
  return (await res.json()).result;
}

const list = await rpc('session/list', { _request: {} });
const items = list.value?.items ?? [];
const it = items[0];
const asOf = it.projections?.asOfSeq;

const r = await rpc('session/page', {
  request: { address: { kind: 'session', sessionId: it.sessionId }, throughSeq: asOf, maxMessages: 200 },
});
const recs = r.value?.records ?? [];
console.log('records', recs.length, 'hasMore', r.value?.hasMore, 'asOfSeq', asOf);

const assistants = recs.filter((x) => (x.event ?? x).type === 'assistant/message');
console.log('assistant/message 条数', assistants.length);
if (assistants.length) {
  const last = assistants[assistants.length - 1];
  console.log('--- 最后一条 assistant/message 原始形状 ---');
  console.log(JSON.stringify(last, null, 2).slice(0, 1800));
}

const users = recs.filter((x) => (x.event ?? x).type === 'user/message');
if (users.length) {
  console.log('--- 最后一条 user/message ---');
  console.log(JSON.stringify(users[users.length - 1], null, 2).slice(0, 900));
}
