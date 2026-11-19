/** 会话：搜索、筛选、分页与详情抽屉。 */

'use strict';

import {
  $, api, el, td, fmtTime, reportError, confirmDialog, state,
  conversationMembers, addConversationMember, removeConversationMember,
  changeConversationMemberRole, searchUsers, sendTestMessage,
} from '../core.js';

const PAGE_SIZE = 20;

let timer = null;
let bound = false;
let items = [];
let page = 1;
let search = '';
let kind = 'all';

export function show() {
  bind();
  refresh();
  timer = setInterval(refresh, 15000);
}

export function hide() {
  if (timer) clearInterval(timer);
  timer = null;
  $('session-drawer').hidden = true;
}

export function refresh() {
  api('conversations')
    .then((data) => {
      items = data.conversations || [];
      render();
    })
    .catch((error) => reportError(error, '会话加载失败'));
}

function filtered() {
  const needle = search.trim().toLowerCase();
  return items.filter((item) => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (needle && !String(item.title || '').toLowerCase().includes(needle)) return false;
    return true;
  });
}

function shortSession(id) {
  if (!id) return '—';
  return (id.startsWith('session-') ? id.slice(8) : id).slice(0, 8);
}

function render() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  page = Math.min(page, pages);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  $('session-count').textContent = `${rows.length} 个会话`;
  $('session-page').textContent = `第 ${page} / ${pages} 页`;
  $('session-prev').disabled = page <= 1;
  $('session-next').disabled = page >= pages;

  const body = $('sessions');
  body.textContent = '';
  slice.forEach((item) => {
    const row = document.createElement('tr');
    row.className = 'clickable';
    row.appendChild(td(item.title || '（无标题）', '标题'));
    const typeCell = document.createElement('td');
    typeCell.setAttribute('data-label', '类型');
    typeCell.appendChild(el('span', `pill ${item.kind === 'group' ? 'tone-blue' : ''}`,
      item.kind === 'group' ? '群聊' : '私聊'));
    row.appendChild(typeCell);
    row.appendChild(td(item.members, '成员'));
    row.appendChild(td(fmtTime(item.updatedAt), '最近活动'));
    const actionCell = document.createElement('td');
    actionCell.setAttribute('data-label', '操作');
    const button = el('button', 'ghost small', '详情');
    button.type = 'button';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openDrawer(item);
    });
    actionCell.appendChild(button);
    row.appendChild(actionCell);
    row.addEventListener('click', () => openDrawer(item));
    body.appendChild(row);
  });
  $('sessions-empty').hidden = slice.length > 0;
}

async function openDrawer(item) {
  const drawer = $('session-drawer');
  const body = $('session-drawer-body');
  $('session-drawer-title').textContent = item.title || '会话详情';
  body.textContent = '';
  drawer.hidden = false;

  const dl = el('div', 'card');
  const rows = [
    ['epoch', item.epoch],
    ['dsh_session', shortSession(item.dshSessionId)],
    ['最新 seq', item.latestSeq],
    ['工作区', item.dshWorkspaceId || '—'],
    ['最近活动', fmtTime(item.updatedAt)],
  ];
  rows.forEach(([label, value]) => {
    const row = el('div', 'kv');
    row.appendChild(el('span', null, label));
    row.appendChild(el('b', label === 'dsh_session' ? 'mono' : null, value));
    dl.appendChild(row);
  });
  body.appendChild(dl);

  const wake = el('div', 'drawer-section wake-section');
  wake.appendChild(el('h3', null, '本会话唤醒'));
  wake.appendChild(el('p', 'note',
    '只影响这个会话；仿真页改的是以后新建会话的默认值。'));
  const wakeSummary = el('p', 'wake-summary', '加载中…');
  wake.appendChild(wakeSummary);
  body.appendChild(wake);
  mountWakeForm(item, wake, wakeSummary);

  if (item.kind === 'group') {
    const members = el('div', 'drawer-section member-manage');
    body.appendChild(members);
    mountMemberManager(item, members);
  }

  const events = el('div', 'drawer-section');
  events.appendChild(el('h3', null, '最近事件'));
  const list = el('div');
  list.textContent = '加载中…';
  events.appendChild(list);
  body.appendChild(events);

  try {
    const data = await api(`conversations/${encodeURIComponent(item.id)}/events?limit=5`);
    list.textContent = '';
    (data.events || []).forEach((event) => {
      list.appendChild(el('div', 'event-line',
        `${fmtTime(event.at)} · ${event.kind}${event.detail ? ` · ${String(event.detail).slice(0, 80)}` : ''}`));
    });
    if (!(data.events || []).length) list.appendChild(el('p', 'note', '这个会话还没有事件'));
  } catch (error) {
    list.textContent = '';
    list.appendChild(el('p', 'note', `读取失败：${error.message}`));
  }

  const test = el('div', 'drawer-section test-send');
  test.appendChild(el('h3', null, '测试发送'));
  test.appendChild(el('p', 'note',
    '以你的身份发一条真实消息，可能触发回复；会消耗每日消息额度。'));
  const testInput = document.createElement('input');
  testInput.type = 'text';
  testInput.maxLength = 500;
  testInput.placeholder = '输入一条测试消息';
  test.appendChild(testInput);
  const testActions = el('div', 'wake-actions');
  const testButton = el('button', 'primary small', '发送');
  testButton.type = 'button';
  const testResult = el('span', 'wake-message');
  testActions.appendChild(testButton);
  testActions.appendChild(testResult);
  test.appendChild(testActions);
  body.appendChild(test);
  testButton.addEventListener('click', async () => {
    const text = testInput.value.trim();
    if (!text) {
      testResult.textContent = '请输入消息';
      testResult.classList.add('bad');
      return;
    }
    testButton.disabled = true;
    testResult.classList.remove('bad');
    testResult.textContent = '发送中…';
    try {
      const data = await sendTestMessage(item.id, text);
      testInput.value = '';
      const wake = data.wakeReason ? data.wakeReason : '未唤醒';
      testResult.textContent = `已发送 #${data.seq}，唤醒：${wake}`;
    } catch (error) {
      testResult.classList.add('bad');
      testResult.textContent = `${error.code || 'error'}：${error.message}`;
    } finally {
      testButton.disabled = false;
    }
  });
}

function mountMemberManager(item, section) {
  const head = el('div', 'member-head');
  head.appendChild(el('h3', null, '成员'));
  const add = el('button', 'ghost small', '添加成员');
  add.type = 'button';
  head.appendChild(add);
  section.appendChild(head);

  const status = el('p', 'member-status');
  section.appendChild(status);

  const search = el('div', 'member-search');
  search.hidden = true;
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = '按 username 搜索';
  searchInput.autocomplete = 'off';
  search.appendChild(searchInput);
  const results = el('div', 'member-results');
  search.appendChild(results);
  section.appendChild(search);

  const list = el('div', 'member-list');
  list.textContent = '加载中…';
  section.appendChild(list);

  let members = [];
  let seq = 0;
  let searchTimer = null;

  const setStatus = (text, bad = false) => {
    status.textContent = text || '';
    status.classList.toggle('bad', Boolean(bad));
  };

  const reload = async () => {
    try {
      const data = await conversationMembers(item.id);
      members = data.members || [];
      renderMembers();
      setStatus('');
    } catch (error) {
      list.textContent = '';
      list.appendChild(el('p', 'note', `读取失败：${error.message}`));
    }
  };

  const act = async (promise) => {
    try {
      await promise;
      await reload();
      return true;
    } catch (error) {
      setStatus(`${error.code || 'error'}：${error.message}`, true);
      return false;
    }
  };

  const renderMembers = () => {
    list.textContent = '';
    members.forEach((member) => {
      const row = el('div', 'member-row');
      const who = el('div', 'member-who');
      who.appendChild(el('b', null, member.display_name || member.user_id));
      if (member.username) who.appendChild(el('small', null, `@${member.username}`));
      row.appendChild(who);
      row.appendChild(el('span', 'pill',
        member.role === 'owner' ? '群主'
          : (member.role === 'admin' ? '管理员' : '成员')));

      const actions = el('div', 'member-actions');
      const isSelf = state.user && state.user.userId === member.user_id;
      if (member.role !== 'owner') {
        if (isSelf) {
          const leave = el('button', 'ghost small', '退出群聊');
          leave.type = 'button';
          leave.addEventListener('click', async () => {
            if (!await confirmDialog('确定退出这个群聊？', {
              title: '退出群聊', okLabel: '退出',
            })) return;
            await act(removeConversationMember(item.id, member.user_id));
          });
          actions.appendChild(leave);
        } else {
          const role = el('button', 'ghost small',
            member.role === 'admin' ? '取消管理员' : '设管理员');
          role.type = 'button';
          role.addEventListener('click', () => {
            act(changeConversationMemberRole(
              item.id,
              member.user_id,
              member.role === 'admin' ? 'member' : 'admin',
            ));
          });
          const remove = el('button', 'ghost small', '移出');
          remove.type = 'button';
          remove.addEventListener('click', async () => {
            if (!await confirmDialog(
              `确定把「${member.display_name || member.user_id}」移出群聊？`,
              { title: '移出成员', okLabel: '移出' },
            )) return;
            await act(removeConversationMember(item.id, member.user_id));
          });
          actions.appendChild(role);
          actions.appendChild(remove);
        }
      }
      if (actions.childNodes.length) row.appendChild(actions);
      list.appendChild(row);
    });
    if (!members.length) list.appendChild(el('p', 'note', '没有成员数据'));
  };

  const renderSearch = (users) => {
    results.textContent = '';
    const existing = new Set(members.map((member) => member.user_id));
    const available = users.filter((user) =>
      !existing.has(user.userId) && !user.disabled).slice(0, 8);
    available.forEach((user) => {
      const button = el('button', 'ghost small member-result',
        `${user.displayName || user.username} @${user.username}`);
      button.type = 'button';
      button.addEventListener('click', async () => {
        setStatus('添加中…');
        if (await act(addConversationMember(item.id, user.userId))) {
          searchInput.value = '';
          results.textContent = '';
          search.hidden = true;
          setStatus(`已添加 ${user.displayName || user.username}`);
        }
      });
      results.appendChild(button);
    });
    if (!available.length) results.appendChild(el('p', 'note', '没有可添加的用户'));
  };

  add.addEventListener('click', () => {
    search.hidden = !search.hidden;
    if (!search.hidden) searchInput.focus();
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) {
      results.textContent = '';
      return;
    }
    const mine = ++seq;
    searchTimer = setTimeout(async () => {
      try {
        const data = await searchUsers(q);
        if (mine === seq) renderSearch(data.users || []);
      } catch (error) {
        if (mine === seq) {
          results.textContent = '';
          results.appendChild(el('p', 'note', `搜索失败：${error.message}`));
        }
      }
    }, 250);
  });

  reload();
}

const WAKE_LIMITS = [
  ['maxWakePerMinute', '每分钟唤醒', 1, 60, 1, '1–60 次/分'],
  ['maxWakePerHour', '每小时唤醒', 1, 240, 1, '1–240 次/时'],
  ['preSleepWaitMs', '沉睡前观察（秒）', 60, 1800, 1, '60–1800 秒'],
  ['noActionLimit', '连续无行动重置', 1, 20, 1, '1–20 轮'],
  ['maxWakeConfigReminders', '唤醒配置提醒', 0, 10, 1, '0–10 次'],
];

function numberField(min, max, step = '1') {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

function formRow(label, control, hint) {
  const row = el('div', 'group-row');
  row.appendChild(el('span', null, label));
  row.appendChild(control);
  if (hint) row.appendChild(el('small', null, hint));
  return row;
}

function toggleRow(label, hint) {
  const wrap = el('label', 'switch-row');
  const control = document.createElement('input');
  control.type = 'checkbox';
  const sw = el('span', 'switch');
  sw.appendChild(control);
  sw.appendChild(el('i'));
  wrap.appendChild(sw);
  const text = document.createElement('span');
  text.appendChild(el('b', null, label));
  text.appendChild(el('small', null, hint));
  wrap.appendChild(text);
  return { control, node: wrap };
}

function splitKeywords(text) {
  const out = [];
  String(text || '').split(/[,，]/).forEach((item) => {
    const value = item.trim();
    if (value && !out.includes(value) && out.length < 20) out.push(value);
  });
  return out;
}

function mountWakeForm(item, section, summary) {
  const form = el('div', 'wake-form');
  form.hidden = true;
  section.appendChild(form);

  const mode = document.createElement('select');
  mode.appendChild(new Option('潜水', 'diving'));
  mode.appendChild(new Option('活跃', 'active'));
  form.appendChild(formRow('模式', mode));

  const switches = el('div', 'switch-grid');
  const at = toggleRow('@提及', '被 @ 时醒来');
  const name = toggleRow('名字', '消息里出现汐语/小汐/Tide');
  const question = toggleRow('提问', '直接问句');
  const poke = toggleRow('拍一拍', '被拍时醒来');
  const any = toggleRow('任意消息', '每条群消息都看（会明显变吵）');
  [at, name, question, poke, any].forEach((entry) => switches.appendChild(entry.node));
  form.appendChild(switches);

  const keywords = document.createElement('input');
  keywords.type = 'text';
  keywords.placeholder = '汐语, 小汐, Tide';
  form.appendChild(formRow('关键词', keywords, '逗号分隔，最多 20 个'));

  const probability = numberField(0, 1, '0.01');
  form.appendChild(formRow('概率', probability, '0–1，步进 0.01'));

  const batch = numberField(1, 60);
  form.appendChild(formRow('批量窗口（秒）', batch, '1–60 秒'));

  const limits = {};
  WAKE_LIMITS.forEach(([key, label, min, max, step, hint]) => {
    const input = numberField(min, max, step);
    limits[key] = input;
    form.appendChild(formRow(label, input, hint));
  });

  const hint = document.createElement('textarea');
  hint.maxLength = 200;
  hint.rows = 2;
  hint.placeholder = '写给 AI 的建议，可留空';
  form.appendChild(formRow('管理员建议', hint, '作为建议交给 AI，最多 200 字'));

  const actions = el('div', 'wake-actions');
  const save = el('button', 'primary small', '保存');
  save.type = 'button';
  const reset = el('button', 'ghost small', '恢复为默认');
  reset.type = 'button';
  const message = el('span', 'wake-message');
  actions.appendChild(save);
  actions.appendChild(reset);
  actions.appendChild(message);
  form.appendChild(actions);

  const setMessage = (text, bad = false) => {
    message.textContent = text || '';
    message.classList.toggle('bad', Boolean(bad));
  };

  const applyResult = (data) => {
    summary.textContent = data.summary || '—';
    summary.classList.toggle('same', Boolean(data.matchesDefaults));
    summary.title = data.matchesDefaults ? '与默认值相同' : '';
    if (data.matchesDefaults && !summary.nextElementSibling?.classList?.contains('wake-same')) {
      summary.insertAdjacentElement('afterend', el('p', 'note wake-same', '与默认值相同'));
    } else if (!data.matchesDefaults) {
      const same = section.querySelector('.wake-same');
      if (same) same.remove();
    } else {
      const same = section.querySelector('.wake-same');
      if (same) same.hidden = false;
    }
    form.hidden = false;
  };

  const fill = (config) => {
    const tr = config.triggers || {};
    mode.value = config.mode === 'active' ? 'active' : 'diving';
    at.control.checked = tr.atMention !== false;
    name.control.checked = tr.nameMention !== false;
    question.control.checked = tr.question !== false;
    poke.control.checked = tr.poke === true;
    any.control.checked = tr.anyMessage === true;
    any.control.disabled = mode.value === 'active';
    keywords.value = Array.isArray(tr.keywords) ? tr.keywords.join(', ') : '';
    probability.value = String(Number(tr.probability) || 0);
    batch.value = String(Math.round((Number(config.batchWindowMs) || 8000) / 1000));
    const cfgLimits = config.limits || {};
    WAKE_LIMITS.forEach(([key]) => {
      const fallback = key === 'preSleepWaitMs'
        ? Math.round((Number(cfgLimits[key]) || 300_000) / 1000)
        : (cfgLimits[key] ?? 0);
      limits[key].value = String(fallback);
    });
    hint.value = config.hint || '';
  };

  const values = () => ({
    mode: mode.value,
    triggers: {
      atMention: at.control.checked,
      nameMention: name.control.checked,
      question: question.control.checked,
      poke: poke.control.checked,
      anyMessage: any.control.checked,
      keywords: splitKeywords(keywords.value),
      probability: Number(probability.value),
    },
    batchWindowMs: Math.round(Number(batch.value) * 1000),
    limits: {
      maxWakePerMinute: Number(limits.maxWakePerMinute.value),
      maxWakePerHour: Number(limits.maxWakePerHour.value),
      preSleepWaitMs: Math.round(Number(limits.preSleepWaitMs.value) * 1000),
      noActionLimit: Number(limits.noActionLimit.value),
      maxWakeConfigReminders: Number(limits.maxWakeConfigReminders.value),
    },
    hint: hint.value.trim(),
  });

  const validate = () => {
    const seconds = Number(batch.value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) {
      return '批量窗口必须是 1~60 秒';
    }
    const prob = Number(probability.value);
    if (!Number.isFinite(prob) || prob < 0 || prob > 1) {
      return '概率必须在 0~1 之间';
    }
    for (const [key, label, min, max] of WAKE_LIMITS) {
      const raw = Number(limits[key].value);
      if (!Number.isInteger(raw) || raw < min || raw > max) {
        return `${label} 必须是 ${min}~${max} 的整数`;
      }
    }
    return null;
  };

  mode.addEventListener('change', () => {
    if (mode.value === 'active') any.control.checked = true;
    any.control.disabled = mode.value === 'active';
  });

  const setBusy = (busy) => {
    save.disabled = busy;
    reset.disabled = busy;
  };

  save.addEventListener('click', async () => {
    const invalid = validate();
    if (invalid) {
      setMessage(invalid, true);
      return;
    }
    setBusy(true);
    setMessage('保存中…');
    try {
      const data = await api(`conversations/${encodeURIComponent(item.id)}/wake`, {
        method: 'PATCH',
        body: { config: values() },
      });
      applyResult(data);
      setMessage('已保存');
    } catch (error) {
      setMessage(error.message || '保存失败', true);
    } finally {
      setBusy(false);
    }
  });

  reset.addEventListener('click', async () => {
    setBusy(true);
    setMessage('正在恢复…');
    try {
      const data = await api(`conversations/${encodeURIComponent(item.id)}/wake/reset`, {
        method: 'POST',
      });
      fill(data.config);
      applyResult(data);
      setMessage('已恢复为默认');
    } catch (error) {
      setMessage(error.message || '恢复失败', true);
    } finally {
      setBusy(false);
    }
  });

  api(`conversations/${encodeURIComponent(item.id)}/wake`)
    .then((data) => {
      fill(data.config);
      applyResult(data);
      setMessage('');
    })
    .catch((error) => {
      summary.textContent = '读取失败';
      setMessage(error.message || '读取失败', true);
      form.hidden = true;
    });
}

function bind() {
  if (bound) return;
  bound = true;
  $('session-search').addEventListener('input', (event) => {
    search = event.target.value;
    page = 1;
    render();
  });
  $('session-type').addEventListener('change', (event) => {
    kind = event.target.value;
    page = 1;
    render();
  });
  $('session-prev').addEventListener('click', () => {
    if (page > 1) {
      page -= 1;
      render();
    }
  });
  $('session-next').addEventListener('click', () => {
    page += 1;
    render();
  });
  $('session-drawer').addEventListener('click', (event) => {
    if (event.target === $('session-drawer')) $('session-drawer').hidden = true;
  });
}
