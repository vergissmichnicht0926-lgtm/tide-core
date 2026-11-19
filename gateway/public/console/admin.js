/** 控制台入口：登录、hash 路由、导航高亮。 */

'use strict';

import { $, api, state, currentRoute, onRouteChange } from './core.js';
import * as overview from './views/overview.js';
import * as sessions from './views/conversations.js';
import * as simulation from './views/simulation.js';
import * as persona from './views/persona.js';
import * as invites from './views/invites.js';
import * as usage from './views/usage.js';
import * as security from './views/security.js';
import * as tools from './views/tools.js';

const routes = {
  overview: { view: overview, title: '总览', sub: '运行状态与最近事件' },
  sessions: { view: sessions, title: '会话', sub: '搜索、筛选与会话详情' },
  simulation: { view: simulation, title: '仿真', sub: '默认唤醒配置与用户配额' },
  persona: { view: persona, title: '人格', sub: '公开资料与提示词' },
  invites: { view: invites, title: '邀请与设备', sub: '用户、邀请码与设备' },
  usage: { view: usage, title: '用量', sub: '消息、轮次与字符估算' },
  security: { view: security, title: '访问与安全', sub: '审计与登录历史' },
  tools: { view: tools, title: '工具参考', sub: 'MCP 工具清单' },
};

let active = null;

function showError(message) {
  const node = $('login-error');
  node.textContent = message || '';
  node.hidden = !message;
}

function hideAll() {
  for (const entry of Object.values(routes)) entry.view.hide();
  active = null;
}

function showLogin(message) {
  hideAll();
  state.csrf = null;
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  if (message) showError(message);
  $('login-username').focus();
}

function showApp() {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  showError('');
}

function applyRoute(route) {
  const name = routes[route] ? route : 'overview';
  state.route = name;
  if (active && active !== routes[name].view) active.hide();
  active = routes[name].view;

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.getAttribute('data-route') === name);
  });
  for (const [key, entry] of Object.entries(routes)) {
    $(`view-${key}`).hidden = key !== name;
  }
  $('page-title').textContent = routes[name].title;
  $('page-sub').textContent = routes[name].sub;
  active.show();
}

async function login(event) {
  event.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!username || !password) {
    showError('账号和密码都要填');
    return;
  }
  $('login-submit').disabled = true;
  try {
    const data = await api('session', { method: 'POST', body: { username, password } });
    state.csrf = data.csrfToken;
    state.user = data.user || null;
    $('side-version').textContent = `v${data.version || '—'}`;
    $('login-password').value = '';
    showApp();
    applyRoute(currentRoute());
  } catch (error) {
    showError(error.message || '登录失败');
  } finally {
    $('login-submit').disabled = false;
  }
}

function logout() {
  api('session', { method: 'DELETE' })
    .catch(() => {})
    .finally(() => showLogin(''));
}

function boot() {
  $('login-form').addEventListener('submit', login);
  $('logout').addEventListener('click', logout);
  document.querySelectorAll('[data-goto]').forEach((button) => {
    button.addEventListener('click', () => {
      location.hash = `#/${button.getAttribute('data-goto')}`;
    });
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      $(button.getAttribute('data-close')).hidden = true;
    });
  });
  window.addEventListener('tide:unauthorized', () => showLogin('登录已失效，请重新登录'));
  onRouteChange((route) => {
    if (!$('app-view').hidden) applyRoute(route);
  });

  api('session')
    .then((data) => {
      state.csrf = data.csrfToken;
      state.user = data.user || null;
      $('side-version').textContent = `v${data.version || '—'}`;
      showApp();
      applyRoute(currentRoute());
    })
    .catch((error) => {
      showLogin(error.status === 401 ? '' : `会话检查失败：${error.message}`);
    });
}

document.addEventListener('DOMContentLoaded', boot);
