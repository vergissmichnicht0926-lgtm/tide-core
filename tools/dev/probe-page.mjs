// 探针 2：session/page 能不能当读消息的入口（不依赖 follow opening frame）。
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
  const j = await res.json();
  return j.result;
}

const list = await rpc('session/list', { _request: {} });
const items = list.value?.items ?? [];
// 挑一个已经有消息的：拿 running 或最新的几个逐个试
const candidates = items.slice(0, 8);
for (const it of candidates) {
  const seq = it.projections?.asOfSeq;
  const r = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId: it.sessionId }, throughSeq: seq, maxMessages: 5 },
  });
  const v = r.value;
  console.log('---', it.sessionId, 'preset=', it.projections?.values?.agentPreset);
  if (!r.ok) { console.log('   err', JSON.stringify(r.error).slice(0, 200)); continue; }
  const recs = v.records ?? [];
  console.log('   ok records=', recs.length, 'hasMore=', v.hasMore);
  for (const rec of recs.slice(0, 4)) {
    const e = rec.event ?? rec;
    const d = e.data ?? {};
    const txt = typeof d.text === 'string' ? d.text : (d.content ? JSON.stringify(d.content).slice(0, 80) : '');
    console.log('    ', e.type, 'seq=', e.seq, 'role=', d.role ?? '', 'text=', String(txt).slice(0, 80));
  }
  if (recs.length) break;
}
