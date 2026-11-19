// tide-mcp.mjs 的 stdio 契约测试
// 起一个真 fake gateway + 一个真 MCP 子进程，按 JSON-RPC 打。
//   node --test tests/mcp.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GW_PORT = 7802;
const GW = `http://127.0.0.1:${GW_PORT}`;
const TOK_A = 'a'.repeat(48);

let gw;
let mcp;

// ── 子进程管理 ──────────────────────────────────────────────────────────

function waitForHealth(url, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`${url}/health`);
        if (r.ok) return resolve();
      } catch {
        /* 还没起来 */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`${url} 起不来`));
      setTimeout(tick, 80);
    };
    tick();
  });
}

function startMcp(env = {}) {
  const proc = spawn(process.execPath, ['mcp/tide-mcp.mjs'], {
    cwd: ROOT,
    env: { ...process.env, TIDE_AGENT_SECRET: 'test-secret', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const hit = pending.get(msg.id);
    if (hit) {
      pending.delete(msg.id);
      hit(msg);
    }
  });

  let seq = 1;
  const call = (method, params) => {
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  return {
    call,
    async callTool(name, args) {
      const msg = await call('tools/call', { name, arguments: args });
      if (msg.error) throw new Error(msg.error.message);
      return msg.result.content[0].text;
    },
    stop() {
      proc.kill();
    },
  };
}

// ── 生命周期 ────────────────────────────────────────────────────────────

before(async () => {
  gw = spawn(process.execPath, ['mcp/fake-gateway.mjs', '--port', String(GW_PORT), '--deterministic'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await waitForHealth(GW);
  mcp = startMcp({ TIDE_GATEWAY_URL: GW });
});

after(() => {
  mcp?.stop();
  gw?.kill();
});

// ── 用例 ────────────────────────────────────────────────────────────────

test('1. initialize 返回 tide 的 serverInfo 与 tools 能力', async () => {
  const msg = await mcp.call('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(msg.result.serverInfo.name, 'tide');
  assert.equal(msg.result.serverInfo.version, '0.1.0');
  assert.ok(msg.result.capabilities.tools);
});

test('2. tools/list 返回 14 个 chat_* 工具，且每个都要求 token', async () => {
  const msg = await mcp.call('tools/list', {});
  const tools = msg.result.tools;
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, [
    'chat_get_profile',
    'chat_get_prompt',
    'chat_get_recent',
    'chat_mark_read',
    'chat_memory_append',
    'chat_memory_query',
    'chat_memory_remove',
    'chat_publish_moment',
    'chat_read_attachment',
    'chat_send',
    'chat_send_voice',
    'chat_set_profile',
    'chat_set_wake_config',
    'chat_wait',
  ]);

  for (const t of tools) {
    assert.ok(
      t.inputSchema.required.includes('token'),
      `${t.name} 的 inputSchema 必须要求 token`,
    );
    assert.ok(t.description && t.description.length > 10, `${t.name} 缺说明`);
  }
});

test('3. 不带 token 调 chat_get_prompt → 返回人话，不是 stack', async () => {
  const text = await mcp.callTool('chat_get_prompt', {});
  assert.match(text, /缺少 token/);
});

test('4. 假 token → 返回无效提示', async () => {
  const text = await mcp.callTool('chat_get_prompt', { token: 'z'.repeat(48) });
  assert.match(text, /token 无效/);
});

test('5. chat_get_prompt 正常返回上下文与水位', async () => {
  const text = await mcp.callTool('chat_get_prompt', { token: TOK_A });
  assert.match(text, /已读水位/);
  assert.match(text, /唤醒：/);
  assert.match(text, /令牌指纹 [0-9a-f]{4}/);
});

test('6. chat_send 发两条 → 报告 seq', async () => {
  const text = await mcp.callTool('chat_send', {
    token: TOK_A,
    messages: ['测试第一条', '测试第二条'],
    clientBatchId: 'mcp-batch-1',
  });
  assert.match(text, /已发出 2 条/);
  assert.match(text, /#\d+/);
});

test('7. chat_send 同 clientBatchId 同内容重放 → 幂等命中', async () => {
  const text = await mcp.callTool('chat_send', {
    token: TOK_A,
    messages: ['测试第一条', '测试第二条'],
    clientBatchId: 'mcp-batch-1',
  });
  assert.match(text, /已经发过了/);
});

test('8. chat_get_recent 读得到刚发的消息', async () => {
  const text = await mcp.callTool('chat_get_recent', { token: TOK_A, limit: 5 });
  assert.match(text, /测试第一条/);
});

test('9. chat_wait(purpose=reply) 返回 arrived/quiet/timeout 三个信号', async () => {
  const text = await mcp.callTool('chat_wait', {
    token: TOK_A,
    purpose: 'reply',
    quietMs: 1000,
    timeoutMs: 2000,
  });
  assert.match(text, /arrived=/);
  assert.match(text, /quiet=/);
  assert.match(text, /timeout=/);
});

test('10. chat_mark_read 推进水位', async () => {
  const text = await mcp.callTool('chat_mark_read', { token: TOK_A, throughSeq: 2 });
  assert.match(text, /已读水位推进到 seq \d+/);
});

test('11. chat_memory_append 后能 query 到', async () => {
  const put = await mcp.callTool('chat_memory_append', {
    token: TOK_A,
    kind: 'impression',
    text: '喜欢短句',
  });
  assert.match(put, /已记下/);

  const got = await mcp.callTool('chat_memory_query', { token: TOK_A, kind: 'impression' });
  assert.match(got, /喜欢短句/);
});

test('12. chat_memory_remove 不传 confirm → 拒绝', async () => {
  const text = await mcp.callTool('chat_memory_remove', { token: TOK_A, id: 1 });
  assert.match(text, /confirm: true/);
});

test('13. chat_read_attachment 读文本附件', async () => {
  const recent = await mcp.callTool('chat_get_recent', { token: TOK_A, limit: 5 });
  const m = recent.match(/［附件 1 个：(\S+)/);
  assert.ok(m, '种子会话里应有带附件的消息');
  const text = await mcp.callTool('chat_read_attachment', {
    token: TOK_A,
    attachmentId: m[1],
  });
  assert.ok(text.length > 0);
});

test('14. 未知工具名 → 明确报错而不是崩', async () => {
  const msg = await mcp.call('tools/call', { name: 'chat_nope', arguments: {} });
  assert.equal(msg.result.isError, true);
  assert.match(msg.result.content[0].text, /没有这个工具/);
});

test('15. chat_memory_remove 传 confirm:true → 真删掉', async () => {
  const put = await mcp.callTool('chat_memory_append', {
    token: TOK_A,
    kind: 'thought',
    text: '这条要删掉',
  });
  const id = put.match(/#(\d+)/)[1];

  const del = await mcp.callTool('chat_memory_remove', { token: TOK_A, id: Number(id), confirm: true });
  assert.match(del, /已删除/);

  const got = await mcp.callTool('chat_memory_query', { token: TOK_A, kind: 'thought' });
  assert.ok(!got.includes('这条要删掉'), '删掉之后不该再查得到');
});

test('16. 用别的会话的 token 读附件 → 人话提示越权', async () => {
  const recent = await mcp.callTool('chat_get_recent', { token: TOK_A, limit: 5 });
  const m = recent.match(/［附件 1 个：(\S+)/);
  assert.ok(m);

  const text = await mcp.callTool('chat_read_attachment', {
    token: 'b'.repeat(48),
    attachmentId: m[1],
  });
  assert.match(text, /不属于当前对话/);
});

test('17. chat_publish_moment 发布动态，空正文被拒绝', async () => {
  const text = await mcp.callTool('chat_publish_moment', {
    token: TOK_A,
    text: '今晚的月亮落在桌角上。',
  });
  assert.match(text, /动态已发布/);
  assert.match(text, /今晚的月亮落在桌角上/);

  const empty = await mcp.callTool('chat_publish_moment', { token: TOK_A, text: '  ' });
  assert.match(empty, /不能为空/);
});
