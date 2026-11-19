// tide-tool-restrict.mjs 的 guard 行为测试。
//
// 2026-11-11 P3：默认档砍掉执行工具之后，这条 guard 是「普通用户碰不到服务器文件系统」
// 的最后一道墙（preset 决定模型看得见什么，guard 决定实际能不能跑）。
// 所以这里断言的正是「tide 档调 pwsh 必须被拒」——M0 验收第 2 条反转后的形态。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply, name, inject } from '../plugins/tide-agent-presets/tide-tool-restrict.mjs';

// 拿一个假的 ctx.tools，只实现 guard，把注册进来的判定函数抓出来。
function makeCtx() {
  const captured = {};
  return {
    captured,
    tools: {
      guard(fn) {
        captured.guard = fn;
      },
      // restrict 现在不该被调用；调了就记下来，测试里断言它没被用
      restrict(arg) {
        captured.restrictCalls = [...(captured.restrictCalls ?? []), arg];
      },
    },
  };
}

function guardFor(owner) {
  const ctx = makeCtx();
  apply(ctx, owner ? { owner: true } : {});
  assert.equal(typeof ctx.captured.guard, 'function', 'apply 必须注册 guard');
  return { guard: ctx.captured.guard, captured: ctx.captured };
}

const EXEC_TOOLS = ['pwsh', 'bash', 'read', 'read_image', 'write', 'edit', 'working_directory'];
const CHAT_TOOLS = ['ask_user_question', 'todo_write'];
const OWNER_NET_TOOLS = ['web_search', 'web_fetch'];

test('模块元信息', () => {
  assert.equal(name, 'tide-tool-restrict');
  assert.deepEqual(inject, ['tools']);
});

test('默认档：ask_user/todo 放行', () => {
  const { guard } = guardFor(false);
  for (const tool of CHAT_TOOLS) {
    assert.equal(guard({ name: tool }), undefined, `${tool} 应放行`);
  }
});

test('默认档：web_search/web_fetch 被拒（guest 无网）', () => {
  const { guard } = guardFor(false);
  for (const tool of OWNER_NET_TOOLS) {
    assert.match(String(guard({ name: tool })), /不在 tide 白名单内/);
  }
});

test('默认档：执行工具全部被拒（M0 验收第 2 条）', () => {
  const { guard } = guardFor(false);
  for (const tool of EXEC_TOOLS) {
    const reason = guard({ name: tool });
    assert.equal(typeof reason, 'string', `${tool} 应被拒`);
    assert.match(reason, /不在 tide 白名单内/);
  }
});

test('owner 档：执行工具放行', () => {
  const { guard } = guardFor(true);
  for (const tool of [...CHAT_TOOLS, ...OWNER_NET_TOOLS, ...EXEC_TOOLS]) {
    assert.equal(guard({ name: tool }), undefined, `owner 档 ${tool} 应放行`);
  }
});

test('owner 档：宿主能力放行', () => {
  const { guard } = guardFor(true);
  for (const tool of ['plugin_manager', 'subagent', 'schedule_create', 'present', 'skill']) {
    assert.equal(guard({ name: tool }), undefined, `owner 档 ${tool} 应放行`);
  }
});

test('默认档：宿主能力被拒', () => {
  const { guard } = guardFor(false);
  for (const tool of ['plugin_manager', 'subagent', 'schedule_create', 'present', 'skill']) {
    assert.match(String(guard({ name: tool })), /不在 tide 白名单内/);
  }
});

test('MCP 前缀放行：mcp__tide__chat_*', () => {
  const { guard } = guardFor(false);
  for (const tool of ['mcp__tide__chat_send', 'mcp__tide__chat_wait', 'mcp__tide__chat_read_attachment']) {
    assert.equal(guard({ name: tool }), undefined, `${tool} 应放行`);
  }
});

test('非 tide 的 MCP 前缀不放行', () => {
  const { guard } = guardFor(false);
  assert.match(String(guard({ name: 'mcp__peek__peek' })), /不在 tide 白名单内/);
  assert.match(String(guard({ name: 'mcp__snowluma__qq_send' })), /不在 tide 白名单内/);
});

test('NEVER_TOOLS 两档都拒，且理由是永久禁用', () => {
  for (const owner of [false, true]) {
    const { guard } = guardFor(owner);
    for (const tool of ['subagent_codex', 'subagent_claude_code', 'read_mcp_resource']) {
      assert.match(String(guard({ name: tool })), /已永久禁用/, `owner=${owner} ${tool}`);
    }
  }
});

test('坏工具名被拒', () => {
  const { guard } = guardFor(false);
  assert.match(String(guard({ name: '' })), /工具名无效/);
  assert.match(String(guard({ name: undefined })), /工具名无效/);
  assert.match(String(guard({})), /工具名无效/);
});

test('restrict 隐藏全局 working_directory', () => {
  const { captured } = guardFor(false);
  assert.deepEqual(captured.restrictCalls, [
    { deny: ['working_directory'] },
    { deny: ['list_mcp_resources'] },
    { deny: ['list_mcp_resource_templates'] },
    { deny: ['read_mcp_resource'] },
  ]);
});
