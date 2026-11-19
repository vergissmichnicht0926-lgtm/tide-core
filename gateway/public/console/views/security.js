/** 访问与安全：审计日志、登录历史，各自分页。 */

'use strict';

import { $, api, el, td, fmtTime, reportError } from '../core.js';

const LIMIT = 20;
const FILTERS = [
  ['all', '全部'],
  ['login', '登录'],
  ['invite', '邀请'],
  ['settings', '设置'],
  ['device', '设备'],
];

let bound = false;
let auditFilter = 'all';
let auditOffset = 0;
let loginOffset = 0;
let timer = null;

export function show() {
  bind();
  renderFilters();
  loadAudit();
  loadLogin();
  timer = setInterval(() => {
    loadAudit();
    loadLogin();
  }, 30000);
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
}

function renderFilters() {
  const box = $('audit-filters');
  box.textContent = '';
  FILTERS.forEach(([key, label]) => {
    const button = el('button', auditFilter === key ? 'active' : '', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      auditFilter = key;
      auditOffset = 0;
      renderFilters();
      loadAudit();
    });
    box.appendChild(button);
  });
}

async function loadAudit() {
  try {
    const data = await api(`audit?limit=${LIMIT}&offset=${auditOffset}&filter=${auditFilter}`);
    const body = $('audit-body');
    body.textContent = '';
    (data.rows || []).forEach((row) => {
      const tr = document.createElement('tr');
      tr.appendChild(td(fmtTime(row.at), '时间'));
      const action = document.createElement('td');
      action.setAttribute('data-label', '动作');
      action.appendChild(el('span', 'mono', row.action));
      tr.appendChild(action);
      tr.appendChild(td(row.actor, '操作者'));
      tr.appendChild(td(row.target || '—', '对象'));
      const result = document.createElement('td');
      result.setAttribute('data-label', '结果');
      result.appendChild(el('span', 'pill tone-green', row.result === 'ok' ? '成功' : row.result));
      tr.appendChild(result);
      body.appendChild(tr);
    });
    $('audit-empty').hidden = (data.rows || []).length > 0;
    renderPager('audit', data.total, auditOffset, (offset) => {
      auditOffset = offset;
      loadAudit();
    });
  } catch (error) {
    reportError(error, '审计加载失败');
  }
}

async function loadLogin() {
  try {
    const data = await api(`login-attempts?limit=${LIMIT}&offset=${loginOffset}`);
    const body = $('login-body');
    body.textContent = '';
    (data.rows || []).forEach((row) => {
      const tr = document.createElement('tr');
      tr.appendChild(td(fmtTime(row.at), '时间'));
      tr.appendChild(td(row.username, '账号'));
      const result = document.createElement('td');
      result.setAttribute('data-label', '结果');
      result.appendChild(el('span', `pill ${row.ok ? 'tone-green' : 'tone-bad'}`,
        row.ok ? '成功' : '失败'));
      tr.appendChild(result);
      tr.appendChild(td(row.ip || '—', 'IP'));
      body.appendChild(tr);
    });
    $('login-empty').hidden = (data.rows || []).length > 0;
    renderPager('login', data.total, loginOffset, (offset) => {
      loginOffset = offset;
      loadLogin();
    });
  } catch (error) {
    reportError(error, '登录历史加载失败');
  }
}

function renderPager(prefix, total, offset, go) {
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const page = Math.floor(offset / LIMIT) + 1;
  $(`${prefix}-page`).textContent = `第 ${page} / ${pages} 页`;
  $(`${prefix}-prev`).disabled = page <= 1;
  $(`${prefix}-next`).disabled = page >= pages;
  $(`${prefix}-prev`).onclick = () => go(Math.max(0, (page - 2) * LIMIT));
  $(`${prefix}-next`).onclick = () => go(Math.min((pages - 1) * LIMIT, page * LIMIT));
}

function bind() {
  if (bound) return;
  bound = true;
}
