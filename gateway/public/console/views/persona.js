/** 人格：公开资料与提示词，保存条只在有脏值时出现。 */

'use strict';

import {
  $, api, formatDuration, reportError, toast,
} from '../core.js';

let timer = null;
let silenceTimer = null;
let loaded = null;
let pendingAvatar;
let saving = false;
let bound = false;
let silentUntil = 0;
let silenceSaving = false;

export function show() {
  bind();
  refresh();
  timer = setInterval(refresh, 15000);
  silenceTimer = setInterval(renderSilence, 30000);
  renderSilence();
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
  if (silenceTimer) clearInterval(silenceTimer);
  silenceTimer = null;
  $('persona-savebar').hidden = true;
}

async function refresh() {
  try {
    const data = await api('bot');
    if (!loaded || !dirty()) {
      loaded = data.bot;
      fill(data.bot);
    }
    silentUntil = Number(data.silentUntil) || 0;
    renderSilence();
  } catch (error) {
    reportError(error, '人格卡加载失败');
  }
}

function remainingText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return formatDuration(total);
}

function renderSilence() {
  const active = silentUntil > Date.now();
  $('silence-toggle').checked = active;
  $('silence-state').textContent = active ? '静默中' : '未静默';
  $('silence-remaining').textContent = active
    ? `还剩 ${remainingText(silentUntil - Date.now())}`
    : '当前未静默';
  $('silence-off').disabled = !active || silenceSaving;
  $('silence-toggle').disabled = silenceSaving;
  document.querySelectorAll('[data-silence-minutes], [data-silence-tomorrow]').forEach((button) => {
    button.disabled = silenceSaving;
  });
}

function tomorrowAtEight() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date;
}

async function setSilence(body) {
  if (silenceSaving) return;
  silenceSaving = true;
  renderSilence();
  try {
    const data = await api('bot/silence', { method: 'PATCH', body });
    silentUntil = Number(data.silentUntil) || 0;
    renderSilence();
    toast(data.active ? `已静默至 ${new Date(data.silentUntil).toLocaleString('zh-CN', { hour12: false })}` : '已解除静默');
  } catch (error) {
    reportError(error, '静默设置失败');
    renderSilence();
  } finally {
    silenceSaving = false;
    renderSilence();
  }
}

function dirty() {
  if (!loaded) return false;
  return $('persona-name').value.trim() !== (loaded.name || '')
    || $('persona-signature').value.trim() !== (loaded.signature || '')
    || $('persona-prompt').value.trim() !== (loaded.personaOverride || '')
    || pendingAvatar !== undefined;
}

function updateBar() {
  $('persona-savebar').hidden = !dirty();
  $('persona-save').disabled = saving;
}

function renderAvatar(bot) {
  const image = $('persona-avatar');
  if (typeof pendingAvatar === 'string') {
    image.src = pendingAvatar;
    image.hidden = false;
    return;
  }
  if (pendingAvatar === null || !bot.hasAvatar) {
    image.hidden = true;
    image.removeAttribute('src');
    return;
  }
  image.src = `api/bot/avatar?v=${encodeURIComponent(bot.avatarVersion || '')}`;
  image.hidden = false;
}

function fill(bot) {
  $('persona-name').value = bot.name || '';
  $('persona-signature').value = bot.signature || '';
  $('persona-prompt').value = bot.personaOverride || '';
  pendingAvatar = undefined;
  renderAvatar(bot);
  updateBar();
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('图片解析失败'));
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, size, size);
        const scale = Math.min(size / image.width, size / image.height);
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        context.drawImage(
          image,
          Math.round((size - width) / 2),
          Math.round((size - height) / 2),
          width,
          height,
        );
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function save() {
  if (saving) return;
  const body = {
    name: $('persona-name').value.trim() || null,
    signature: $('persona-signature').value.trim() || null,
    personaOverride: $('persona-prompt').value.trim() || null,
  };
  if (pendingAvatar !== undefined) body.avatar = pendingAvatar;
  saving = true;
  updateBar();
  try {
    const data = await api('bot', { method: 'PATCH', body });
    loaded = data.bot;
    fill(data.bot);
    toast('人格卡已保存');
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
  ['persona-name', 'persona-signature', 'persona-prompt'].forEach((id) => {
    $(id).addEventListener('input', updateBar);
  });
  $('persona-save').addEventListener('click', save);
  $('persona-discard').addEventListener('click', () => {
    if (loaded) fill(loaded);
  });
  $('persona-avatar-clear').addEventListener('click', () => {
    pendingAvatar = null;
    renderAvatar(loaded || { hasAvatar: false });
    updateBar();
  });
  $('persona-file').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) {
      toast('只支持 PNG / JPEG / WebP', true);
      return;
    }
    try {
      pendingAvatar = await shrinkImage(file);
      if (pendingAvatar.length > 500000) {
        pendingAvatar = undefined;
        renderAvatar(loaded || { hasAvatar: false });
        toast('图片压缩后仍然太大，换一张', true);
      } else {
        renderAvatar(loaded || { hasAvatar: false });
      }
      updateBar();
    } catch (error) {
      toast(error.message || '图片读取失败', true);
    }
  });
  $('silence-toggle').addEventListener('change', (event) => {
    setSilence(event.target.checked ? { minutes: 60 } : { off: true });
  });
  $('silence-off').addEventListener('click', () => setSilence({ off: true }));
  document.querySelectorAll('[data-silence-minutes]').forEach((button) => {
    button.addEventListener('click', () => {
      setSilence({ minutes: Number(button.getAttribute('data-silence-minutes')) });
    });
  });
  document.querySelectorAll('[data-silence-tomorrow]').forEach((button) => {
    button.addEventListener('click', () => {
      setSilence({ until: tomorrowAtEight().toISOString() });
    });
  });
}
