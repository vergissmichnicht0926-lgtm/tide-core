/** 控制台公共层：状态、hash 路由、API、DOM 小工具。 */

'use strict';

export const state = {
  csrf: null,
  route: 'overview',
  user: null,
};

export function $(id) {
  return document.getElementById(id);
}

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value === undefined || value === null ? '—' : String(value);
}

export function td(value, label) {
  const cell = document.createElement('td');
  cell.setAttribute('data-label', label);
  cell.appendChild(el('span', null, value));
  return cell;
}

export function emptyRow(cols, text) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = cols;
  cell.textContent = text;
  row.appendChild(cell);
  return row;
}

export function pill(text, tone = '') {
  return el('span', `pill${tone ? ` tone-${tone}` : ''}`, text);
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export const formatTime = fmtTime;

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

export function currentRoute() {
  const raw = String(location.hash || '').replace(/^#\/?/, '').trim();
  return raw || 'overview';
}

export function navigate(route) {
  const next = `#/${route}`;
  if (location.hash !== next) location.hash = next;
}

export function onRouteChange(handler) {
  window.addEventListener('hashchange', () => handler(currentRoute()));
}

export async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['x-tide-csrf'] = state.csrf;
  const response = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      (data && data.error && data.error.message) || `HTTP ${response.status}`,
    );
    error.status = response.status;
    error.code = data && data.error && data.error.code;
    throw error;
  }
  return data;
}

let toastTimer = null;

export function toast(message, bad = false) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.toggle('bad', Boolean(bad));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, bad ? 4200 : 2400);
}

export function reportError(error, prefix) {
  if (error && error.status === 401) {
    window.dispatchEvent(new Event('tide:unauthorized'));
    return;
  }
  toast(`${prefix ? `${prefix}：` : ''}${error && error.message ? error.message : '操作失败'}`, true);
}

export async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

export function confirmDialog(message, {
  title = '确认',
  okLabel = '确定',
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    const modal = $('confirm-modal');
    const ok = $('confirm-ok');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    ok.textContent = okLabel;
    ok.classList.toggle('danger', Boolean(danger));

    const cleanup = (value) => {
      modal.hidden = true;
      ok.removeEventListener('click', onOk);
      $('confirm-cancel').removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => {
      if (event.target === modal) cleanup(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') cleanup(false);
    };

    ok.addEventListener('click', onOk);
    $('confirm-cancel').addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    modal.hidden = false;
    ok.focus();
  });
}

export function conversationMembers(conversationId) {
  return api(`conversations/${encodeURIComponent(conversationId)}/members`);
}

export function addConversationMember(conversationId, userId) {
  return api(`conversations/${encodeURIComponent(conversationId)}/members`, {
    method: 'POST',
    body: { userId },
  });
}

export function removeConversationMember(conversationId, userId) {
  return api(
    `conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

export function changeConversationMemberRole(conversationId, userId, role) {
  return api(
    `conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}/role`,
    { method: 'PATCH', body: { role } },
  );
}

export function searchUsers(query) {
  return api(`users?q=${encodeURIComponent(String(query || '').trim())}`);
}

export function sendTestMessage(conversationId, text) {
  return api(`conversations/${encodeURIComponent(conversationId)}/test-message`, {
    method: 'POST',
    body: { text },
  });
}
