// Tide 工具白名单（M0 阶段）。
//
// M0 只放 DSH 现有工具；`mcp__tide__` 的 MCP 工具要等 M1 写完 tide-mcp 后再加。
// 这里用执行期 guard 做兜底，preset 组合负责“模型能不能看见”；
// 两边都保留：preset 决定 schema，guard 决定执行。
//
// 记住 QQbridge 的教训：不要把不存在的工具名塞进 ctx.tools.restrict——
// 它会抛错并被 try/catch 吞掉，等于白写。M0 先只 guard，M1 再拿真实工具名对账。
export const name = 'tide-tool-restrict';
export const inject = ['tools'];

// 默认 tide 档：只有聊天 + 只读网络能力，**没有任何本地执行能力**。
//
// 【2026-11-11 P3 修正】原来这里含 pwsh / read / read_image / write / edit / working_directory，
// 理由是「先生拍板能力优先」「自己一个人用，砍了损失大」。多用户与群聊（计划第十九节）定下来之后
// 这条不成立：默认档带 shell = 给每个进群的人一台服务器 shell。
// 而 qq-chat-v2.patch.yml 的默认档本来就只有 web / ask-user / todo + restrict，执行工具在 qq-owner。
// 所以执行能力整体移到 OWNER_TOOLS，默认档不再有。
//
// 后果：workspace / attachment 归属 / agent_token 这三条从「组织约定」升级成真边界
//（前提是 agent 没有别的路径碰文件系统）。owner 档仍有 pwsh，所以
// gateway 与 DSH 必须跑在不同 OS 用户下这条硬要求不变。
const BASE_TOOLS = [
  'ask_user_question',
  'todo_write',
];

// tide-owner 档额外放开的宿主能力。preset 里只有 tide-owner 会挂载这些工具。
const OWNER_TOOLS = [
  // 联网只在 owner 档：guest/restricted 不能借 web_fetch 访问内网。
  'web_search',
  'web_fetch',
  // 本地执行能力（2026-11-11 从 BASE_TOOLS 移下来）
  'pwsh',
  'bash',
  'read',
  'read_image',
  'write',
  'edit',
  'working_directory',
  // 宿主管理能力
  'plugin_manager',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'interrupt_agent',
  'workflow',
  'ralph',
  'present',
  'skill',
  'job_list',
  'job_output',
  'job_kill',
  'get_goal',
  'create_goal',
  'update_goal',
];

// 两档都不放：外部 coding agent 会派生新主体，风险高于普通 subagent。
const NEVER_TOOLS = new Set([
  'subagent_codex',
  'subagent_claude_code',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

// M1 写完 tide-mcp 后再打开。
const MCP_PREFIXES = ['mcp__tide__'];

// 这些不是 preset 自己挂的 scoped 工具，而是 host/base 继承到全局层的工具。
// 只靠 guard 只能拦住执行，模型 schema 里仍然看得见；必须用 restrict 从继承层隐藏。
// 当前名单来自 tools.restrict() 的 unknown-name 报错对账（2026-11-11）：
// 新增全局插件时必须重新对账并加到这里，否则它会重新出现在 tide 的 schema 里。
const RESTRICT_SCHEMA_TOOLS = [
  'working_directory',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
];

export function apply(ctx, config = {}) {
  const owner = config.owner === true;
  const allowed = new Set([...BASE_TOOLS, ...(owner ? OWNER_TOOLS : [])]);

  for (const tool of RESTRICT_SCHEMA_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [tool] });
    } catch (error) {
      console.error(`[tide-tool-restrict] skip restrict ${tool}: ${error?.message ?? error}`);
    }
  }

  ctx.tools.guard((exec) => {
    const toolName = exec?.name;
    if (typeof toolName !== 'string' || toolName.length === 0) {
      return '工具名无效，已拒绝';
    }
    if (NEVER_TOOLS.has(toolName)) {
      return `工具 "${toolName}" 已永久禁用`;
    }
    if (allowed.has(toolName)) return;
    if (MCP_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return;
    if (owner && (toolName.startsWith('dev_') || toolName.startsWith('team_task_'))) return;
    return `工具 "${toolName}" 不在 ${owner ? 'tide-owner' : 'tide'} 白名单内`;
  });
}
