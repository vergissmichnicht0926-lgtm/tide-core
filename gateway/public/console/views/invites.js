/** 邀请与设备：用户列表、邀请码四态分组、设备抽屉。 */

'use strict';

import {
  $, api, el, td, fmtTime, reportError, toast, copyText, confirmDialog,
} from '../core.js';

const STATUS = {
  active: { label: '有效', tone: 'tone-ok' },
  'used-up': { label: '已用尽', tone: 'tone-warn' },
  expired: { label: '已过期', tone: 'tone-warn' },
  revoked: { label: '已撤销', tone: 'tone-bad' },
};
const TAB_ORDER = ['active', 'used-up', 'expired', 'revoked'];

let timer = null;
let bound = false;
let users = [];
let invites = [];
let groups = [];
let tab = 'active';
let drawerUser = null;
let devices = [];
let loadedLimits = null;
let limitsFilled = false;

export function show() {
  bind();
  loadAll();
  timer = setInterval(loadAll, 30000);
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
  closeDrawer();
}

async function loadAll() {
  await Promise.all([loadUsers(), loadInvites(), loadGroups(), loadLimits()]);
}

async function loadLimits() {
  try {
    const data = await api('bot');
    loadedLimits = data.limits;
    if (!limitsFilled || !limitsDirty()) {
      fillLimits(data.limits);
      limitsFilled = true;
    }
  } catch (error) {
    reportError(error, '用户配额加载失败');
  }
}

function limitsForm() {
  return {
    dailyMessages: Number($('limit-daily').value),
    maxConversations: Number($('limit-convos').value),
    uploadMb: Number($('limit-upload').value),
  };
}

function limitsDirty() {
  if (!loadedLimits) return false;
  const form = limitsForm();
  return form.dailyMessages !== loadedLimits.dailyMessages
    || form.maxConversations !== loadedLimits.maxConversations
    || form.uploadMb !== loadedLimits.uploadMb;
}

function fillLimits(limits) {
  $('limit-daily').value = String(limits.dailyMessages);
  $('limit-convos').value = String(limits.maxConversations);
  $('limit-upload').value = String(limits.uploadMb);
}

async function saveLimits() {
  const limits = limitsForm();
  const rules = [
    ['dailyMessages', 1, 100000, '每日消息数'],
    ['maxConversations', 1, 1000, '最多会话数'],
    ['uploadMb', 1, 1024, '单文件 MB'],
  ];
  for (const [key, min, max, label] of rules) {
    const value = limits[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      $('quota-status').textContent = `${label} 必须是 ${min}~${max} 的整数`;
      return;
    }
  }
  const ok = await confirmDialog(
    '保存后将影响所有用户的下一次上传 / 建会话 / 发消息。确定保存？',
    { title: '保存用户配额', okLabel: '保存', danger: false },
  );
  if (!ok) return;
  try {
    const data = await api('bot/limits', { method: 'PATCH', body: { limits } });
    loadedLimits = data.limits;
    fillLimits(data.limits);
    $('quota-status').textContent = '已保存，立即生效';
    toast('用户配额已保存');
  } catch (error) {
    $('quota-status').textContent = '';
    reportError(error, '配额保存失败');
  }
}

async function loadUsers() {
  try {
    const data = await api('users');
    users = data.users || [];
    renderUsers();
  } catch (error) {
    reportError(error, '用户加载失败');
  }
}

async function loadInvites() {
  try {
    const data = await api('invites');
    invites = data.invites || [];
    renderTabs();
    renderInvites();
  } catch (error) {
    reportError(error, '邀请码加载失败');
  }
}

async function loadGroups() {
  try {
    const data = await api('conversations');
    groups = (data.conversations || []).filter((item) => item.kind === 'group');
    renderGroupOptions();
  } catch (error) {
    reportError(error, '群列表加载失败');
  }
}

function small(label, onClick, { disabled = false, title = '', danger = false } = {}) {
  const button = el('button', `ghost small${danger ? '' : ''}`, label);
  button.type = 'button';
  button.disabled = disabled;
  if (title) button.title = title;
  if (danger) button.style.color = 'var(--warn)';
  button.addEventListener('click', onClick);
  return button;
}

function renderUsers() {
  $('user-count').textContent = `${users.length} 人`;
  const body = $('users');
  body.textContent = '';
  users.forEach((user) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.setAttribute('data-label', '账号');
    name.appendChild(el('span', null, user.displayName));
    if (user.username !== user.displayName) {
      name.appendChild(el('span', 'cell-sub', `@${user.username}`));
    }
    row.appendChild(name);

    const role = document.createElement('td');
    role.setAttribute('data-label', '角色');
    role.appendChild(el('span', `pill ${user.role === 'admin' ? 'tone-green' : ''}`,
      user.role === 'admin' ? '管理员' : '访客'));
    if (user.disabled) role.appendChild(el('span', 'pill tone-bad', '已停用'));
    row.appendChild(role);

    row.appendChild(td(user.conversationCount, '会话'));
    row.appendChild(td(fmtTime(user.lastActiveAt), '最近活跃'));

    const action = document.createElement('td');
    action.setAttribute('data-label', '操作');
    action.appendChild(small('查看设备', () => openDrawer(user)));
    row.appendChild(action);
    body.appendChild(row);
  });
}

function renderTabs() {
  const box = $('invite-tabs');
  box.textContent = '';
  const counts = Object.fromEntries(TAB_ORDER.map((key) => [key, 0]));
  invites.forEach((invite) => {
    if (counts[invite.status] !== undefined) counts[invite.status] += 1;
  });
  TAB_ORDER.forEach((key) => {
    const button = el('button', tab === key ? 'active' : '',
      `${STATUS[key].label} ${counts[key]}`);
    button.type = 'button';
    button.addEventListener('click', () => {
      tab = key;
      renderTabs();
      renderInvites();
    });
    box.appendChild(button);
  });
}

async function copyShare(invite) {
  const text = invite.webUrl || invite.joinUrl;
  const ok = await copyText(text);
  toast(ok ? '链接已复制' : '复制失败，请手动选中', !ok);
}

function renderInvites() {
  const rows = invites.filter((invite) => invite.status === tab);
  $('invite-count').textContent = `${rows.length} 张`;
  const body = $('invites');
  body.textContent = '';
  rows.forEach((invite) => {
    const status = STATUS[invite.status] || { label: invite.status, tone: '' };
    const row = document.createElement('tr');

    const code = document.createElement('td');
    code.setAttribute('data-label', '码');
    code.appendChild(el('span', 'mono', invite.code));
    code.appendChild(el('span', `pill ${status.tone}`, status.label));
    row.appendChild(code);
    row.appendChild(td(invite.kind === 'group'
      ? `群 · ${invite.groupTitle || invite.groupId}`
      : 'Bot', '类型'));
    row.appendChild(td(`${invite.usedCount}/${invite.maxUses}`, '用量'));
    row.appendChild(td(fmtTime(invite.expiresAt), '过期'));

    const actions = document.createElement('td');
    actions.setAttribute('data-label', '操作');
    const wrap = el('div', 'row-actions');
    const active = invite.status === 'active';
    wrap.appendChild(small('复制链接', () => copyShare(invite), {
      disabled: !active || (!invite.webUrl && !invite.joinUrl),
      title: active
        ? (invite.webUrl || invite.joinUrl ? '复制分享链接' : '服务器未配置公网地址')
        : '只有有效邀请码可以复制',
    }));
    wrap.appendChild(small('撤销', async () => {
      const ok = await confirmDialog(
        `撤销后 ${invite.code} 不能再使用，已分享出去的链接会失效。`,
        { title: '撤销邀请码', okLabel: '撤销' },
      );
      if (!ok) return;
      try {
        await api(`invites/${encodeURIComponent(invite.id)}/revoke`, { method: 'POST' });
        toast('邀请码已撤销');
        loadInvites();
      } catch (error) {
        reportError(error, '撤销失败');
      }
    }, { disabled: !active, title: active ? '撤销这个邀请码' : '只有有效邀请码可以撤销', danger: true }));
    actions.appendChild(wrap);
    row.appendChild(actions);
    body.appendChild(row);
  });
  $('invites-empty').hidden = rows.length > 0;
}

function renderGroupOptions() {
  const select = $('invite-group');
  const current = select.value;
  select.textContent = '';
  if (!groups.length) {
    const option = el('option', null, '还没有群');
    option.value = '';
    select.appendChild(option);
    return;
  }
  groups.forEach((group) => {
    const option = el('option', null, group.title || group.id);
    option.value = group.id;
    select.appendChild(option);
  });
  if (groups.some((group) => group.id === current)) select.value = current;
}

function toggleForm(show) {
  $('invite-form').hidden = !show;
  if (show) {
    renderGroupOptions();
    $('invite-kind').focus();
  }
}

async function createInvite(event) {
  event.preventDefault();
  const kind = $('invite-kind').value;
  const body = {
    kind,
    expiresInMinutes: Number($('invite-expires').value),
    maxUses: Number($('invite-uses').value),
  };
  if (kind === 'group') {
    const groupId = $('invite-group').value;
    if (!groupId) {
      $('invite-status').textContent = '先选一个群';
      return;
    }
    body.groupId = groupId;
  }
  $('invite-status').textContent = '创建中…';
  try {
    const data = await api('invites', { method: 'POST', body });
    if ((data.warnings || []).includes('public-base-url-missing')) {
      const warning = $('invite-warning');
      warning.textContent = '服务器未配置公网地址，邀请码只能手动发码。';
      warning.hidden = false;
    }
    toggleForm(false);
    $('invite-status').textContent = '';
    toast('邀请码已创建');
    tab = 'active';
    loadInvites();
  } catch (error) {
    $('invite-status').textContent = '';
    reportError(error, '创建失败');
  }
}

function openDrawer(user) {
  drawerUser = user;
  $('device-drawer-title').textContent = `${user.displayName} 的设备`;
  $('device-drawer').hidden = false;
  $('device-drawer-body').textContent = '加载中…';
  loadDevices();
}

function closeDrawer() {
  drawerUser = null;
  devices = [];
  $('device-drawer').hidden = true;
}

async function loadDevices() {
  if (!drawerUser) return;
  try {
    const data = await api(`users/${encodeURIComponent(drawerUser.userId)}/devices`);
    devices = data.devices || [];
    renderDevices();
  } catch (error) {
    reportError(error, '设备加载失败');
  }
}

function renderDevices() {
  const body = $('device-drawer-body');
  body.textContent = '';
  if (!devices.length) {
    body.appendChild(el('p', 'note', '这个用户还没有设备。'));
    return;
  }
  devices.forEach((device) => {
    const card = el('div', 'device-item');
    const head = el('div', 'device-head');
    head.appendChild(el('span', null, device.name || '未命名设备'));
    head.appendChild(el('span', `pill ${device.active ? 'tone-green' : 'tone-bad'}`,
      device.revokedAt ? '已撤销' : (device.active ? '活跃' : '已过期')));
    if (device.trusted) head.appendChild(el('span', 'pill tone-warn', '受信'));
    if (device.liveConnections > 0) {
      head.appendChild(el('span', 'pill tone-blue', `${device.liveConnections} 条连接`));
    }
    card.appendChild(head);

    const meta = el('div', 'device-meta');
    meta.appendChild(el('div', null, `ID ${device.id}`));
    meta.appendChild(el('div', null, `创建 ${fmtTime(device.createdAt)}`));
    meta.appendChild(el('div', null, `最近使用 ${fmtTime(device.lastSeenAt)}`));
    meta.appendChild(el('div', null, `到期 ${fmtTime(device.expiresAt)}`));
    card.appendChild(meta);

    if (!device.revokedAt) {
      const actions = el('div', 'device-actions');
      actions.appendChild(small('吊销', () => revokeDevice(device), { danger: true }));
      card.appendChild(actions);
    }
    body.appendChild(card);
  });
}

async function revokeDevice(device) {
  const group = device.trustedDeviceId
    ? devices.filter((item) => item.trustedDeviceId === device.trustedDeviceId)
    : [device];
  const others = group.filter((item) => item.id !== device.id && !item.revokedAt).length;
  const live = group.reduce((sum, item) => sum + (item.liveConnections || 0), 0);
  const scope = others > 0
    ? `这台设备属于受信组 ${device.trustedDeviceId}，会同时踢掉组内另外 ${others} 台设备。`
    : (device.trustedDeviceId
      ? `这台设备属于受信组 ${device.trustedDeviceId}，会一并移除该组信任。`
      : '');
  const connections = live > 0
    ? `将同时断开该设备 ${live} 条实时连接。`
    : '当前没有实时连接。';
  const ok = await confirmDialog(
    `${scope}${connections}吊销后该设备需要重新登录，且不可恢复。`,
    { title: '吊销设备', okLabel: '吊销' },
  );
  if (!ok) return;
  try {
    const result = await api(
      `users/${encodeURIComponent(drawerUser.userId)}/devices/${encodeURIComponent(device.id)}/revoke`,
      { method: 'POST' },
    );
    toast(`已吊销${result.closedStreams ? `，断开 ${result.closedStreams} 条连接` : ''}`);
    await loadDevices();
    loadUsers();
  } catch (error) {
    reportError(error, '吊销失败');
  }
}

function bind() {
  if (bound) return;
  bound = true;
  $('invite-new').addEventListener('click', () => toggleForm(true));
  $('invite-cancel').addEventListener('click', () => toggleForm(false));
  $('invite-kind').addEventListener('change', () => {
    $('invite-group-field').hidden = $('invite-kind').value !== 'group';
  });
  $('invite-form').addEventListener('submit', createInvite);
  $('quota-save').addEventListener('click', saveLimits);
  ['limit-daily', 'limit-convos', 'limit-upload'].forEach((id) => {
    $(id).addEventListener('input', () => {
      $('quota-status').textContent = limitsDirty()
        ? '有未保存的修改'
        : '保存后影响下一次上传 / 建会话 / 发消息';
    });
  });
  $('device-drawer').addEventListener('click', (event) => {
    if (event.target === $('device-drawer')) closeDrawer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('device-drawer').hidden) closeDrawer();
  });
}
