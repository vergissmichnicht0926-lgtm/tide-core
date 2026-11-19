// 一次性生成管理台的工具清单：从 mcp/tide-mcp.mjs 的 tools 定义提取。
// 运行时不解析源码，产物 tools.json 提交进仓库。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcePath = path.join(root, 'mcp', 'tide-mcp.mjs');
const outPath = path.join(root, 'gateway', 'public', 'console', 'tools.json');

const source = fs.readFileSync(sourcePath, 'utf8');
const tStart = source.indexOf('const T = {');
const toolsStart = source.indexOf('const tools = [');
const toolsEnd = source.indexOf('\n];', toolsStart);
if (tStart < 0 || toolsStart < 0 || toolsEnd < 0) {
  throw new Error('找不到 mcp/tide-mcp.mjs 里的 T / tools 定义');
}

const block = [
  source.slice(tStart, toolsStart),
  source.slice(toolsStart, toolsEnd + 3),
  'return tools;',
].join('\n');
const tools = new Function(block)();

const summaryOf = (text) => {
  const first = String(text ?? '').split(/[。\n]/)[0].trim();
  return first ? `${first}。` : '';
};

const out = tools.map((tool) => ({
  name: tool.name,
  summary: summaryOf(tool.description),
  params: Object.entries(tool.inputSchema?.properties ?? {}).map(([name, schema]) => ({
    name,
    required: (tool.inputSchema.required || []).includes(name),
    type: schema.type || 'string',
  })),
}));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${out.length} tools -> ${outPath}`);
