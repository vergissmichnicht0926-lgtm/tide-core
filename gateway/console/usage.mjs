/** 0.24 用量：按消息字符数统计，金额只做估算。 */

import { ApiError } from '../auth/errors.mjs';
import { readJson } from '../http.mjs';
import { parseContent, textOf } from '../messages.mjs';
import { audit } from '../routes/admin-data.mjs';
import { loadBotSettings, localDay, saveBotSettings } from '../settings.mjs';
import { writeConsoleChange } from './http.mjs';

function bad(message) {
  return new ApiError(400, 'bad-request', message);
}

function dayRange(count, now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const days = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(date.getDate() - offset);
    days.push(localDay(date));
  }
  return days;
}

function sumRows(rows, key) {
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

export function getUsage(ctx, url) {
  const requested = url.searchParams.get('days');
  const count = requested === null || requested === '' ? 7 : Number(requested);
  if (count !== 7 && count !== 30) throw bad('days 只能是 7 或 30');
  const dayList = dayRange(count);
  const first = dayList[0];
  const last = dayList[dayList.length - 1];
  const db = ctx.dbState.db;
  const rows = db.prepare(
    `SELECT day, SUM(messages) AS messages, SUM(turns) AS turns,
            SUM(chars_in) AS chars_in, SUM(chars_out) AS chars_out
       FROM usage_daily
      WHERE day >= ? AND day <= ?
      GROUP BY day`,
  ).all(first, last);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = dayList.map((day) => {
    const row = byDay.get(day) || {};
    return {
      day,
      messages: Number(row.messages) || 0,
      turns: Number(row.turns) || 0,
      charsIn: Number(row.chars_in) || 0,
      charsOut: Number(row.chars_out) || 0,
    };
  });
  const totals = {
    messages: sumRows(days, 'messages'),
    turns: sumRows(days, 'turns'),
    charsIn: sumRows(days, 'charsIn'),
    charsOut: sumRows(days, 'charsOut'),
  };

  const startMs = new Date(`${first}T00:00:00`).getTime();
  const endMs = new Date(`${last}T00:00:00`).getTime() + 24 * 60 * 60 * 1000;
  const messageRows = db.prepare(
    `SELECT c.id, c.title, m.role, m.content_json
       FROM message m
       JOIN conversation c ON c.id = m.conversation_id
      WHERE c.deleted_at IS NULL AND m.created_at >= ? AND m.created_at < ?`,
  ).all(startMs, endMs);
  const byConv = new Map();
  for (const row of messageRows) {
    const item = byConv.get(row.id) || {
      id: row.id,
      title: row.title || '（无标题）',
      messages: 0,
      charsOut: 0,
    };
    item.messages += 1;
    if (row.role === 'assistant') {
      item.charsOut += textOf(parseContent(row.content_json)).length;
    }
    byConv.set(row.id, item);
  }
  const byConversation = [...byConv.values()]
    .sort((a, b) => b.charsOut - a.charsOut || b.messages - a.messages)
    .slice(0, 10);

  const settings = loadBotSettings(db);
  return {
    ok: true,
    rangeDays: count,
    days,
    totals,
    byConversation,
    price: {
      inPer1k: settings.priceInPer1k,
      outPer1k: settings.priceOutPer1k,
    },
  };
}

export async function patchPrice(ctx, req, session) {
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('body 必须是 JSON 对象');
  }
  for (const key of Object.keys(body)) {
    if (key !== 'inPer1k' && key !== 'outPer1k') throw bad(`未知字段: ${key}`);
  }
  const price = {};
  for (const key of ['inPer1k', 'outPer1k']) {
    if (!Object.hasOwn(body, key)) throw bad(`${key} 必填`);
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0 || value > 100_000) {
      throw bad(`${key} 必须是 0~100000 的数字`);
    }
    price[key] = value;
  }
  const settings = saveBotSettings(ctx.dbState.db, {
    priceInPer1k: price.inPer1k,
    priceOutPer1k: price.outPer1k,
  });
  const detail = {
    inPer1k: settings.priceInPer1k,
    outPer1k: settings.priceOutPer1k,
  };
  audit(ctx, session.user.userId, 'bot.price', 'bot_settings', detail);
  writeConsoleChange(ctx, 'bot.price', 'bot_settings', detail);
  return { ok: true, price: detail };
}
