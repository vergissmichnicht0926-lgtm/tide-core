/** 总览：指标四格、实时一行、最近 20 条事件。 */

'use strict';

import {
  $, api, el, setText, td, fmtTime, formatDuration, reportError, navigate,
} from '../core.js';

let timer = null;
let silenceTimer = null;
let bound = false;
let silentUntil = 0;

export function show() {
  bind();
  refresh();
  timer = setInterval(refresh, 5000);
  silenceTimer = setInterval(renderSilence, 30000);
  renderSilence();
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
  if (silenceTimer) clearInterval(silenceTimer);
  silenceTimer = null;
}

export function refresh() {
  loadOverview();
  loadOps();
}

function loadOverview() {
  const errorNode = $('overview-error');
  api('overview')
    .then((data) => {
      errorNode.hidden = true;
      render(data);
    })
    .catch((error) => {
      errorNode.hidden = false;
      reportError(error, '总览加载失败');
    });
}

function loadOps() {
  api('ops')
    .then((data) => {
      $('ops-error').hidden = true;
      renderOps(data);
    })
    .catch(() => {
      $('ops-error').hidden = false;
    });
}

function hoursText(seconds) {
  const hours = Math.max(0, Number(seconds) || 0) / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟前`;
  if (hours < 48) return `${Math.round(hours)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function renderOps(data) {
  const probe = data.probe || {};
  const probeDot = $('ops-probe-dot');
  const probeText = $('ops-probe-text');
  if (probe.status === 'ok') {
    probeDot.className = 'dot green';
    probeText.textContent = probe.lastResult === 'restarted'
      ? `已自愈 ${Math.round(Number(probe.restartMs) || 0)} ms`
      : '正常';
  } else if (probe.status === 'stale') {
    probeDot.className = 'dot yellow';
    const minutes = Math.max(1, Math.round((Number(probe.ageSec) || 0) / 60));
    probeText.textContent = `探活未上报 · 已 ${minutes} 分钟`;
  } else {
    probeDot.className = 'dot red';
    probeText.textContent = probe.status === 'failed' ? '探活失败' : '探活未上报';
  }

  const backup = data.backup || {};
  const backupDot = $('ops-backup-dot');
  const backupText = $('ops-backup-text');
  const ageSec = Number(backup.ageSec);
  const offsiteOk = Boolean(backup.offsite && backup.offsite.ok);
  if (!backup.lastAt || (Number.isFinite(ageSec) && ageSec > 48 * 3600)) {
    backupDot.className = 'dot red';
    backupText.textContent = '超过 48 小时没有成功记录';
  } else if (!offsiteOk) {
    backupDot.className = 'dot yellow';
    backupText.textContent = '备份成功 · 离机失败';
  } else if (Number.isFinite(ageSec) && ageSec <= 24 * 3600) {
    backupDot.className = 'dot green';
    backupText.textContent = hoursText(ageSec);
  } else {
    backupDot.className = 'dot yellow';
    backupText.textContent = hoursText(ageSec);
  }

  const gateway = data.gateway || {};
  $('ops-gateway-dot').className = `dot ${gateway.ok ? 'green' : 'red'}`;
  $('ops-gateway-text').textContent = gateway.ok
    ? `${gateway.pid} · 运行 ${formatDuration(gateway.uptimeSec)}`
    : '不可达';

  const parts = [];
  if (probe.lastRestartAt) {
    const seconds = (Number(probe.restartMs) || 0) / 1000;
    parts.push(`最近自愈 ${seconds.toFixed(1)}s（${fmtTime(probe.lastRestartAt)}）`);
  } else {
    parts.push('从无自愈');
  }
  if (data.db) {
    const walMb = (Number(data.db.walBytes) || 0) / (1024 * 1024);
    parts.push(`WAL ${walMb.toFixed(1)} MB`);
  }
  if (gateway.version) parts.push(`版本 ${gateway.version}`);
  $('ops-detail').textContent = parts.join(' · ');
}

function toneForKind(kind) {
  if (kind === 'console.login') return 'tone-blue';
  if (kind === 'gateway.start' || kind === 'backup.ok') return 'tone-green';
  return '';
}

function render(data) {
  const metrics = data.metrics || {};
  setText('metric-mode', data.mode || '—');
  setText('metric-connections', metrics.activeUserConnections ?? 0);
  setText('metric-conversations', metrics.conversationCount ?? 0);
  setText('metric-today', metrics.todayMessages ?? 0);
  setText('side-version', `v${data.version || '—'}`);
  silentUntil = Number(data.silentUntil) || 0;
  renderSilence();

  setText('rt-mode', data.mode || '—');
  setText('rt-connections', metrics.activeUserConnections ?? 0);
  setText('rt-replay', metrics.replaySkipped ?? 0);
  setText('rt-epoch', metrics.epochChanged ?? 0);
  setText('rt-cursor', metrics.cursorAhead ?? 0);

  const tunnel = data.lights && data.lights.tunnel;
  $('top-dot').className = `dot ${tunnel && tunnel.ok === false ? 'red' : (tunnel && tunnel.ok ? 'green' : 'unknown')}`;
  $('top-dot').title = tunnel && tunnel.ok === false
    ? '公网不可达'
    : (tunnel && tunnel.ok ? `公网正常 ${tunnel.latencyMs ?? '—'} ms` : '公网状态未知');

  const body = $('events');
  body.textContent = '';
  const events = (data.events || []).slice(0, 20);
  events.forEach((event) => {
    const row = document.createElement('tr');
    row.appendChild(td(fmtTime(event.at), '时间'));
    const kindCell = document.createElement('td');
    kindCell.setAttribute('data-label', '类型');
    kindCell.appendChild(el('span', `pill ${toneForKind(event.kind)}`, event.kind));
    row.appendChild(kindCell);
    let detail = event.detail ? String(event.detail) : '';
    if (detail.length > 120) detail = `${detail.slice(0, 120)}…`;
    row.appendChild(td(detail || '—', '摘要'));
    body.appendChild(row);
  });
  $('overview-empty').hidden = events.length > 0;
}

function renderSilence() {
  const banner = $('silence-banner');
  const active = silentUntil > Date.now();
  banner.hidden = !active;
  if (!active) return;
  const seconds = Math.max(0, Math.ceil((silentUntil - Date.now()) / 1000));
  $('silence-banner-text').textContent =
    `静默中，还剩 ${formatDuration(seconds)}；消息照常接收，主动发言暂停`;
}

function bind() {
  if (bound) return;
  bound = true;
  $('overview-error').addEventListener('click', () => refresh());
  document.querySelectorAll('[data-goto="sessions"]').forEach((button) => {
    button.addEventListener('click', () => navigate('sessions'));
  });
}
