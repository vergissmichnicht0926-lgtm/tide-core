/** 用量：消息、轮次、字符与可选的估算金额。 */

'use strict';

import {
  $, api, el, setText, reportError, toast,
} from '../core.js';

let timer = null;
let bound = false;
let loaded = null;
let priceFilled = false;

export function show() {
  bind();
  refresh();
  timer = setInterval(refresh, 60000);
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function refresh() {
  try {
    loaded = await api('usage?days=30');
    render(loaded);
  } catch (error) {
    reportError(error, '用量加载失败');
  }
}

function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sumDays(days) {
  return days.reduce((sum, day) => ({
    messages: sum.messages + Number(day.messages || 0),
    turns: sum.turns + Number(day.turns || 0),
    charsIn: sum.charsIn + Number(day.charsIn || 0),
    charsOut: sum.charsOut + Number(day.charsOut || 0),
  }), {
    messages: 0, turns: 0, charsIn: 0, charsOut: 0,
  });
}

function number(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function estimate(week, price) {
  const inPrice = Number(price?.inPer1k) || 0;
  const outPrice = Number(price?.outPer1k) || 0;
  if (inPrice <= 0 && outPrice <= 0) return null;
  return (week.charsIn / 2 / 1000) * inPrice
    + (week.charsOut / 2 / 1000) * outPrice;
}

function render(data) {
  const days = data.days || [];
  const today = days.find((day) => day.day === localDay()) || {
    messages: 0, turns: 0, charsIn: 0, charsOut: 0,
  };
  const week = sumDays(days.slice(-7));
  setText('usage-today-messages', number(today.messages));
  setText('usage-today-turns', number(today.turns));
  setText('usage-today-in', number(today.charsIn));
  setText('usage-today-out', number(today.charsOut));
  setText('usage-week-messages', number(week.messages));

  const value = estimate(week, data.price);
  setText('usage-estimate', value === null ? '未配置单价' : `¥${value.toFixed(2)}`);
  setText('usage-estimate-note', value === null ? '设置单价后估算' : '按 7 日字符');

  renderChart(days);
  if (days.length) {
    setText('usage-range', `${days[0].day} ~ ${days[days.length - 1].day}`);
  }
  renderConversations(data.byConversation || []);

  if (!priceFilled) {
    $('price-in').value = String(Number(data.price?.inPer1k) || 0);
    $('price-out').value = String(Number(data.price?.outPer1k) || 0);
    priceFilled = true;
  }
}

function renderChart(days) {
  const root = $('usage-bars');
  root.textContent = '';
  const max = Math.max(1, ...days.map((day) => Number(day.messages) || 0));
  days.forEach((day, index) => {
    const column = el('div', 'usage-bar');
    const bar = el('div', 'bar');
    bar.style.height = `${Math.max(2, ((Number(day.messages) || 0) / max) * 100)}%`;
    bar.title = `${day.day}：${number(day.messages)} 条 · ${number(day.charsOut)} 输出字符`;
    column.appendChild(bar);
    const label = index === 0 || index === days.length - 1
      || index === Math.floor(days.length / 2)
      ? day.day.slice(5)
      : '';
    column.appendChild(el('small', null, label));
    root.appendChild(column);
  });
}

function renderConversations(rows) {
  const body = $('usage-conversations');
  body.textContent = '';
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', null, row.title || '（无标题）'));
    tr.appendChild(el('td', null, number(row.messages)));
    tr.appendChild(el('td', null, number(row.charsOut)));
    tr.querySelectorAll('td')[0].setAttribute('data-label', '会话');
    tr.querySelectorAll('td')[1].setAttribute('data-label', '消息');
    tr.querySelectorAll('td')[2].setAttribute('data-label', '输出字符');
    body.appendChild(tr);
  });
  $('usage-empty').hidden = rows.length > 0;
}

function bind() {
  if (bound) return;
  bound = true;
  $('price-save').addEventListener('click', async () => {
    const inPer1k = Number($('price-in').value);
    const outPer1k = Number($('price-out').value);
    if (!Number.isFinite(inPer1k) || inPer1k < 0
      || !Number.isFinite(outPer1k) || outPer1k < 0) {
      $('price-status').textContent = '单价必须是非负数';
      return;
    }
    $('price-save').disabled = true;
    $('price-status').textContent = '保存中…';
    try {
      const data = await api('bot/price', {
        method: 'PATCH',
        body: { inPer1k, outPer1k },
      });
      if (loaded) {
        loaded.price = data.price;
        render(loaded);
      }
      $('price-status').textContent = '已保存';
      toast('单价已保存');
    } catch (error) {
      $('price-status').textContent = error.message || '保存失败';
    } finally {
      $('price-save').disabled = false;
    }
  });
}
