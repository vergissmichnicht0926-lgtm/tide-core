/** 工具参考：静态 MCP 工具清单。 */

'use strict';

import { $, api, el, td } from '../core.js';

let loaded = null;

export function show() {
  if (!loaded) load();
  else render();
}

export function hide() {}

async function load() {
  try {
    loaded = await api('tools');
    render();
  } catch {
    $('tools-empty').hidden = false;
  }
}

function render() {
  const body = $('tools-body');
  body.textContent = '';
  (loaded || []).forEach((tool) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.setAttribute('data-label', '工具');
    name.appendChild(el('span', 'mono', tool.name));
    row.appendChild(name);
    row.appendChild(td(tool.summary || '—', '说明'));
    const params = Array.isArray(tool.params) ? tool.params : [];
    const paramText = params.length
      ? params.map((item) => `${item.name}${item.required ? '*' : ''}`).join('、')
      : '—';
    row.appendChild(td(`（${params.length}）${paramText}`, '参数'));
    body.appendChild(row);
  });
  $('tools-empty').hidden = (loaded || []).length > 0;
}
