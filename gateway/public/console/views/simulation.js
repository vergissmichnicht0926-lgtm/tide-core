/** 仿真：折叠组排版；只有唤醒推荐值与批量窗口可写。 */

'use strict';

import { $, api, el, setText, reportError, toast } from '../core.js';

let timer = null;
let bound = false;
let saving = false;
let filled = false;
let loadedWake = null;
let toolsLoaded = null;
let bubbleFilled = false;

export function show() {
  bind();
  refresh();
  timer = setInterval(refresh, 30000);
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
  $('sim-savebar').hidden = true;
}

async function refresh() {
  try {
    const [wake, bot, overview] = await Promise.all([
      api('bot/wake'),
      api('bot'),
      api('overview'),
    ]);
    loadedWake = wake;
    renderStatus(bot.runtime || {}, overview);
    if (!bubbleFilled) {
      $('bubble-delay').value = String(bot.send?.bubbleDelayMs ?? 1200);
      bubbleFilled = true;
    }
    if (!toolsLoaded) loadTools();
    if (!filled || !wakeDirty()) {
      fill(wake.config);
      filled = true;
    } else {
      updateBar();
    }
  } catch (error) {
    reportError(error, '仿真配置加载失败');
  }
}

function renderStatus(runtime, overview) {
  setText('sim-mode', runtime.realtimeMode || '—');
  setText('sim-connections', overview?.metrics?.activeUserConnections ?? 0);
  setText('sim-version', overview?.version ? `v${overview.version}` : '—');
}

async function loadTools() {
  try {
    toolsLoaded = await api('tools');
    const body = $('sim-tools');
    body.textContent = '';
    (toolsLoaded || []).forEach((tool) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.appendChild(el('span', 'mono', tool.name));
      row.appendChild(name);
      row.appendChild(el('td', null, tool.summary || '—'));
      body.appendChild(row);
    });
  } catch (error) {
    reportError(error, '工具清单加载失败');
  }
}

function parseKeywords(text) {
  const out = [];
  String(text || '').split(/[,，]/).forEach((item) => {
    const value = item.trim();
    if (value && !out.includes(value) && out.length < 20) out.push(value);
  });
  return out;
}

function wakeForm() {
  return {
    mode: $('wake-mode').value,
    triggers: {
      atMention: $('wake-at').checked,
      nameMention: $('wake-name').checked,
      question: $('wake-question').checked,
      poke: $('wake-poke').checked,
      anyMessage: $('wake-any').checked,
      keywords: parseKeywords($('wake-keywords').value),
      probability: Number($('wake-prob').value),
    },
    batchWindowMs: Math.round(Number($('wake-batch').value) * 1000),
    limits: {
      maxWakePerMinute: Number($('wake-limit-minute').value),
      maxWakePerHour: Number($('wake-limit-hour').value),
      preSleepWaitMs: Math.round(Number($('wake-limit-presleep').value) * 1000),
      noActionLimit: Number($('wake-limit-noaction').value),
      maxWakeConfigReminders: Number($('wake-limit-reminders').value),
    },
    hint: $('wake-hint').value.trim(),
  };
}

function wakeDirty() {
  if (!loadedWake) return false;
  const form = wakeForm();
  const cfg = loadedWake.config;
  const tr = cfg.triggers || {};
  const limits = cfg.limits || {};
  const source = form.triggers;
  return form.mode !== cfg.mode
    || source.atMention !== Boolean(tr.atMention)
    || source.nameMention !== Boolean(tr.nameMention)
    || source.question !== Boolean(tr.question)
    || source.poke !== Boolean(tr.poke)
    || source.anyMessage !== Boolean(tr.anyMessage)
    || source.keywords.join('\u0000') !== (tr.keywords || []).join('\u0000')
    || Math.abs(source.probability - Number(tr.probability)) > 1e-9
    || form.batchWindowMs !== Number(cfg.batchWindowMs)
    || form.limits.maxWakePerMinute !== Number(limits.maxWakePerMinute)
    || form.limits.maxWakePerHour !== Number(limits.maxWakePerHour)
    || form.limits.preSleepWaitMs !== Number(limits.preSleepWaitMs)
    || form.limits.noActionLimit !== Number(limits.noActionLimit)
    || form.limits.maxWakeConfigReminders !== Number(limits.maxWakeConfigReminders)
    || form.hint !== (cfg.hint || '');
}

function allTriggersOff() {
  const tr = wakeForm().triggers;
  return !tr.atMention && !tr.nameMention && !tr.question && !tr.poke
    && !tr.anyMessage && tr.keywords.length === 0 && !(tr.probability > 0);
}

function updateBar() {
  $('wake-note').hidden = !allTriggersOff();
  $('sim-savebar').hidden = !wakeDirty();
  $('sim-save').disabled = saving || allTriggersOff();
}

function fill(config) {
  const tr = config.triggers || {};
  $('wake-mode').value = config.mode === 'active' ? 'active' : 'diving';
  $('wake-at').checked = tr.atMention !== false;
  $('wake-name').checked = tr.nameMention !== false;
  $('wake-question').checked = tr.question !== false;
  $('wake-poke').checked = tr.poke === true;
  $('wake-any').checked = tr.anyMessage === true;
  $('wake-any').disabled = config.mode === 'active';
  $('wake-keywords').value = Array.isArray(tr.keywords) ? tr.keywords.join(', ') : '';
  $('wake-prob').value = String(Number(tr.probability) || 0);
  $('wake-prob-value').textContent =
    `${Math.round((Number(tr.probability) || 0) * 100)}%`;
  $('wake-batch').value = String(Math.round((Number(config.batchWindowMs) || 8000) / 1000));
  const limits = config.limits || {};
  $('wake-limit-minute').value = String(limits.maxWakePerMinute ?? 1);
  $('wake-limit-hour').value = String(limits.maxWakePerHour ?? 12);
  $('wake-limit-presleep').value = String(
    Math.round((Number(limits.preSleepWaitMs) || 300_000) / 1000),
  );
  $('wake-limit-noaction').value = String(limits.noActionLimit ?? 3);
  $('wake-limit-reminders').value = String(limits.maxWakeConfigReminders ?? 2);
  $('wake-hint').value = config.hint || '';
  setText('sim-current-mode', config.mode === 'active' ? '活跃' : '潜水');
  updateBar();
}

async function save() {
  if (saving || !wakeDirty()) return;
  const seconds = Number($('wake-batch').value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
    toast('批量窗口必须是 1~60 秒', true);
    return;
  }
  const presleep = Number($('wake-limit-presleep').value);
  if (!Number.isInteger(presleep) || presleep < 60 || presleep > 1800) {
    toast('沉睡前观察必须是 60~1800 秒', true);
    return;
  }
  const limitRules = [
    ['wake-limit-minute', 1, 60, '每分钟唤醒'],
    ['wake-limit-hour', 1, 240, '每小时唤醒'],
    ['wake-limit-noaction', 1, 20, '连续无行动重置'],
    ['wake-limit-reminders', 0, 10, '唤醒配置提醒'],
  ];
  for (const [id, min, max, label] of limitRules) {
    const value = Number($(id).value);
    if (!Number.isInteger(value) || value < min || value > max) {
      toast(`${label} 必须是 ${min}~${max} 的整数`, true);
      return;
    }
  }
  saving = true;
  updateBar();
  try {
    const data = await api('bot/wake', {
      method: 'PATCH',
      body: { config: wakeForm() },
    });
    loadedWake = data;
    fill(data.config);
    toast('仿真配置已保存');
  } catch (error) {
    reportError(error, '保存失败');
  } finally {
    saving = false;
    updateBar();
  }
}

function bind() {
  if (bound) return;
  bound = true;
  ['wake-at', 'wake-name', 'wake-question', 'wake-poke', 'wake-any',
    'wake-keywords', 'wake-prob', 'wake-batch', 'wake-hint',
    'wake-limit-minute', 'wake-limit-hour', 'wake-limit-presleep',
    'wake-limit-noaction', 'wake-limit-reminders'].forEach((id) => {
    $(id).addEventListener('input', updateBar);
    $(id).addEventListener('change', updateBar);
  });
  $('wake-mode').addEventListener('change', () => {
    const active = $('wake-mode').value === 'active';
    if (active) $('wake-any').checked = true;
    $('wake-any').disabled = active;
    updateBar();
  });
  $('wake-prob').addEventListener('input', () => {
    $('wake-prob-value').textContent = `${Math.round(Number($('wake-prob').value) * 100)}%`;
    updateBar();
  });
  $('sim-save').addEventListener('click', save);
  $('sim-discard').addEventListener('click', () => {
    if (loadedWake) fill(loadedWake.config);
  });
  $('bubble-save').addEventListener('click', async () => {
    const value = Number($('bubble-delay').value);
    if (!Number.isInteger(value) || value < 0 || value > 3000) {
      $('bubble-status').textContent = '气泡间隔必须是 0~3000 的整数';
      return;
    }
    $('bubble-save').disabled = true;
    $('bubble-status').textContent = '保存中…';
    try {
      const data = await api('bot/send', {
        method: 'PATCH',
        body: { bubbleDelayMs: value },
      });
      $('bubble-delay').value = String(data.bubbleDelayMs);
      $('bubble-status').textContent = '已保存';
      toast('气泡间隔已保存');
    } catch (error) {
      $('bubble-status').textContent = error.message || '保存失败';
    } finally {
      $('bubble-save').disabled = false;
    }
  });
}
