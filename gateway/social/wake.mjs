/**
 * M4.5 v2 唤醒：配置、运行时状态、8 触发判定。
 *
 * 这里只放纯函数，不碰 DB / 定时器。网关重启后的落库由 db 层和 engine 负责。
 * 判定顺序照 QQbridge `evaluateWakeTriggerV2`：
 *   private -> anyMessage -> atMention -> nameMention -> keyword:x -> question
 *   -> speaker:x -> probability -> null
 *
 * 注意：两套优先级不要混。
 *   · 本文件的判定顺序决定「这条消息命中哪个 reason」；
 *   · WAKE_PRIORITY 决定「合批窗口里已排队的 reason 要不要升级」。
 */

export const AI_NAMES = Object.freeze(['汐语', '小汐', 'Tide']);

export const WAKE_TRIGGER_KEYS = Object.freeze([
  'atMention',
  'nameMention',
  'speakerIds',
  'keywords',
  'question',
  'poke',
  'anyMessage',
  'probability',
]);

const WAKE_INPUT_KEYS = new Set([
  'mode',
  'infinite',
  'sleepUntil',
  'triggers',
  'batchWindowMs',
  'limits',
  'hint',
]);
const WAKE_TRIGGER_KEY_SET = new Set(WAKE_TRIGGER_KEYS);

export const WAKE_PRIORITY = Object.freeze({
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20,
});

export const TIMER_WAKE_REASONS = Object.freeze([
  'timeout',
  'replyCheck',
  'proactiveCheck',
  'bootstrap',
  'admin',
]);

const TIMER_SET = new Set(TIMER_WAKE_REASONS);

// 明确结束语可以跳过沉睡前观察。与 QQbridge 的 EXPLICIT_END_RE 同一口径。
export const EXPLICIT_END_RE =
  /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

export const DEFAULT_WAKE_LIMITS = Object.freeze({
  maxWakePerMinute: 1,
  maxWakePerHour: 12,
  preSleepWaitMs: 300_000,
  noActionLimit: 3,
  maxWakeConfigReminders: 2,
});

export const DEFAULT_WAKE_CONFIG = Object.freeze({
  mode: 'diving',
  infinite: true,
  sleepUntil: null,
  triggers: Object.freeze({
    atMention: true,
    nameMention: true,
    speakerIds: Object.freeze([]),
    keywords: Object.freeze(['汐语', '小汐', 'Tide']),
    question: true,
    poke: false,
    anyMessage: false,
    probability: 0.05,
  }),
  batchWindowMs: 8000,
  limits: DEFAULT_WAKE_LIMITS,
  hint: '',
  lastWakeAt: 0,
  wakeCount: 0,
  confirmedAt: 0,
  confirmedBy: 'default',
});

export function defaultWakeConfig() {
  return {
    mode: 'diving',
    infinite: true,
    sleepUntil: null,
    triggers: {
      atMention: true,
      nameMention: true,
      speakerIds: [],
      keywords: ['汐语', '小汐', 'Tide'],
      question: true,
      poke: false,
      anyMessage: false,
      probability: 0.05,
    },
    batchWindowMs: 8000,
    limits: { ...DEFAULT_WAKE_LIMITS },
    hint: '',
    lastWakeAt: 0,
    wakeCount: 0,
    confirmedAt: 0,
    confirmedBy: 'default',
  };
}

export function defaultSocialState() {
  return {
    lastIncomingAt: 0,
    lastAiReplyAt: 0,
    noActionCount: 0,
    wakeTimes: [],
    sendTimes: [],
    preSleepWaitSatisfiedAt: 0,
    preSleepWaitObservedAt: 0,
    pendingThoughts: [],
    lastWakeReason: null,
    lastActionAt: 0,
    wakeConfigReminders: 0,
    wakeConfigReminderPending: false,
    pendingWakeReasons: [],
  };
}

export function wakePriority(reason) {
  const base = String(reason ?? '').split(':')[0];
  return WAKE_PRIORITY[base] ?? 0;
}

export function isTimerWakeReason(reason) {
  return TIMER_SET.has(String(reason ?? '').split(':')[0]);
}

function parseObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** limits 只认 JSON number；字符串/NaN/Infinity 一律回落默认。 */
function limitNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const LIMIT_RANGES = Object.freeze({
  maxWakePerMinute: [1, 60],
  maxWakePerHour: [1, 240],
  preSleepWaitMs: [60_000, 1_800_000],
  noActionLimit: [1, 20],
  maxWakeConfigReminders: [0, 10],
});

function normalizeKeywords(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const out = [];
  for (const item of source) {
    const text = String(item ?? '').trim();
    if (!text || text.length > 40) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeSpeakerIds(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const out = [];
  for (const item of source) {
    const text = String(item ?? '').trim();
    if (!text || text.length > 100) continue;
    if (!out.includes(text)) out.push(text);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * 读库/读请求时归一化。任何坏数据都退到完整默认值，绝不留下 {}。
 * confirmedBy=default 的会话跟随产品推荐值更新；AI 设过的不动。
 */
export function normalizeWakeConfig(raw) {
  const src = parseObject(raw);
  if (!src || Object.keys(src).length === 0) return defaultWakeConfig();
  if (src.confirmedBy === 'default' || src.confirmedBy === undefined) {
    return defaultWakeConfig();
  }
  const cfg = defaultWakeConfig();
  cfg.mode = src.mode === 'active' ? 'active' : 'diving';
  cfg.infinite = src.infinite !== false;
  cfg.sleepUntil = cfg.infinite ? null : safeIso(src.sleepUntil);
  const tr = src.triggers && typeof src.triggers === 'object' ? src.triggers : {};
  cfg.triggers.atMention = tr.atMention !== false;
  cfg.triggers.nameMention = tr.nameMention !== false;
  cfg.triggers.speakerIds = normalizeSpeakerIds(tr.speakerIds, []);
  cfg.triggers.keywords = normalizeKeywords(
    tr.keywords,
    defaultWakeConfig().triggers.keywords,
  );
  cfg.triggers.question = tr.question !== false;
  cfg.triggers.poke = tr.poke === true;
  cfg.triggers.anyMessage = tr.anyMessage === true || cfg.mode === 'active';
  cfg.triggers.probability = clampNumber(tr.probability, 0, 1, 0.05);
  const limits = src.limits && typeof src.limits === 'object' && !Array.isArray(src.limits)
    ? src.limits
    : {};
  cfg.limits = {
    maxWakePerMinute: Math.round(limitNumber(limits.maxWakePerMinute, 1, 60, 1)),
    maxWakePerHour: Math.round(limitNumber(limits.maxWakePerHour, 1, 240, 12)),
    preSleepWaitMs: Math.round(
      limitNumber(limits.preSleepWaitMs, 60_000, 1_800_000, 300_000) / 1000,
    ) * 1000,
    noActionLimit: Math.round(limitNumber(limits.noActionLimit, 1, 20, 3)),
    maxWakeConfigReminders: Math.round(
      limitNumber(limits.maxWakeConfigReminders, 0, 10, 2),
    ),
  };
  cfg.hint = typeof src.hint === 'string' ? src.hint.trim().slice(0, 200) : '';
  cfg.batchWindowMs = Math.round(clampNumber(src.batchWindowMs, 1000, 60_000, 8000));
  cfg.lastWakeAt = Number.isFinite(Number(src.lastWakeAt)) ? Number(src.lastWakeAt) : 0;
  cfg.wakeCount = Number.isFinite(Number(src.wakeCount)) ? Number(src.wakeCount) : 0;
  cfg.confirmedAt = Number.isFinite(Number(src.confirmedAt)) ? Number(src.confirmedAt) : 0;
  cfg.confirmedBy = typeof src.confirmedBy === 'string' ? src.confirmedBy : 'agent';
  if (!isWakeable(cfg)) return defaultWakeConfig();
  return cfg;
}

export function normalizeSocialState(raw) {
  const src = parseObject(raw);
  const st = defaultSocialState();
  st.lastIncomingAt = Number(src.lastIncomingAt) || 0;
  st.lastAiReplyAt = Number(src.lastAiReplyAt) || 0;
  st.noActionCount = Math.max(0, Math.min(999, Number(src.noActionCount) || 0));
  st.wakeTimes = Array.isArray(src.wakeTimes)
    ? src.wakeTimes.map(Number).filter(Number.isFinite).slice(-200)
    : [];
  st.sendTimes = Array.isArray(src.sendTimes)
    ? src.sendTimes.map(Number).filter(Number.isFinite).slice(-200)
    : [];
  st.preSleepWaitSatisfiedAt = Number(src.preSleepWaitSatisfiedAt) || 0;
  st.preSleepWaitObservedAt = Number(src.preSleepWaitObservedAt) || 0;
  st.pendingThoughts = Array.isArray(src.pendingThoughts)
    ? src.pendingThoughts
        .filter((item) => item && typeof item.text === 'string' && item.text.trim())
        .slice(-20)
        .map((item) => ({
          text: String(item.text).slice(0, 500),
          createdAt: Number(item.createdAt) || 0,
          expiresAt: Number(item.expiresAt) || 0,
        }))
    : [];
  st.lastWakeReason = typeof src.lastWakeReason === 'string' ? src.lastWakeReason : null;
  st.lastActionAt = Number(src.lastActionAt) || 0;
  st.wakeConfigReminders = Math.max(0, Math.min(10, Number(src.wakeConfigReminders) || 0));
  st.wakeConfigReminderPending = src.wakeConfigReminderPending === true;
  st.pendingWakeReasons = Array.isArray(src.pendingWakeReasons)
    ? src.pendingWakeReasons
        .filter((item) => item && item.reason)
        .slice(-20)
        .map((item) => ({
          reason: String(item.reason),
          seq: Number(item.seq) || 0,
        }))
    : [];
  return st;
}

export function isWakeable(cfg) {
  if (!cfg) return false;
  const tr = cfg.triggers || {};
  if (cfg.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke) {
    return true;
  }
  if (Array.isArray(tr.keywords) && tr.keywords.length > 0) return true;
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0) return true;
  if (Number(tr.probability) > 0) return true;
  const until = Date.parse(cfg.sleepUntil || '');
  return cfg.infinite === false && Number.isFinite(until) && until > Date.now();
}

export function isSleepingConfig(cfg) {
  if (!cfg) return false;
  return cfg.mode !== 'active' && cfg.triggers?.anyMessage !== true;
}

export function hasExplicitEnd(text) {
  return EXPLICIT_END_RE.test(String(text ?? ''));
}

/**
 * 「是否在问 AI」。照 QQbridge `isDirectedAtAi` 的正则口径，把机器人昵称换成汐语。
 * 这是正则，不是模型判断 —— 群聊里任何带问号的消息都唤醒会太吵。
 */
export function isDirectedAtAi(text) {
  const lower = String(text ?? '').toLowerCase();
  const aiMention =
    /汐语|小汐|tide|deepseek|claude|chatgpt|gpt|ai|人工智能|机器人|模型/.test(lower);
  const challenge =
    /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  if (
    /(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(
      lower,
    )
  ) {
    return true;
  }
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

function nameMentioned(text) {
  const lower = String(text ?? '').toLowerCase();
  return AI_NAMES.some((name) => {
    const n = name.toLowerCase();
    return lower.includes(n) || lower.includes(`@${n}`);
  });
}

function atMentioned(text) {
  return AI_NAMES.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@\\s*${escaped}`, 'i').test(String(text ?? ''));
  });
}

/**
 * 第一层：这条消息要不要把会话叫醒。
 * @param {object} opts
 * @param {'direct'|'group'} opts.kind
 * @param {object} opts.config  normalized wake config
 * @param {string} opts.text    本条自己的文字（不含引用原文）
 * @param {string} [opts.senderId]
 * @param {string} [opts.senderLabel]
 * @param {boolean} [opts.quoteTargetIsSelf]
 * @param {() => number} [opts.random]
 */
export function evaluateWakeTrigger({
  kind,
  config,
  text,
  senderId = '',
  senderLabel = '',
  quoteTargetIsSelf = false,
  random = Math.random,
} = {}) {
  if (kind !== 'group') return 'private';
  const cfg = config || defaultWakeConfig();
  const tr = cfg.triggers || {};
  const plain = String(text ?? '');
  if (tr.anyMessage) return 'anyMessage';
  if (tr.atMention && (atMentioned(plain) || quoteTargetIsSelf)) return 'atMention';
  if (tr.nameMention && nameMentioned(plain)) return 'nameMention';
  if (Array.isArray(tr.keywords) && tr.keywords.length > 0) {
    const lower = plain.toLowerCase();
    for (const keyword of tr.keywords) {
      const kw = String(keyword ?? '').trim().toLowerCase();
      if (!kw) continue;
      if (/^[a-z0-9]+$/.test(kw) && kw.length <= 4) {
        if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) return `keyword:${keyword}`;
      } else if (lower.includes(kw)) {
        return `keyword:${keyword}`;
      }
    }
  }
  if (tr.question && isDirectedAtAi(plain)) return 'question';
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0 && senderId) {
    if (tr.speakerIds.some((id) => String(id) === String(senderId))) {
      return `speaker:${senderLabel || senderId}`;
    }
  }
  const probability = Number(tr.probability);
  if (probability > 0 && random() < probability) return 'probability';
  return null;
}

/**
 * `chat_set_wake_config` 的写入校验。部分更新按 current 合并，只接受已知字段。
 * 返回完整 config，confirmedBy 固定为 agent。
 */
export function validateWakeConfigInput(input, current, { kind = 'direct', now = Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('config 必须是对象');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const unknown = Object.keys(input).filter((key) => !WAKE_INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    const error = new Error(`未知的唤醒字段：${unknown.join(', ')}`);
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const rawTriggers = input.triggers;
  if (rawTriggers !== undefined
    && (!rawTriggers || typeof rawTriggers !== 'object' || Array.isArray(rawTriggers))) {
    const error = new Error('triggers 必须是对象');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  if (rawTriggers) {
    const unknownTriggers = Object.keys(rawTriggers)
      .filter((key) => !WAKE_TRIGGER_KEY_SET.has(key));
    if (unknownTriggers.length > 0) {
      const error = new Error(`未知的唤醒触发字段：${unknownTriggers.join(', ')}`);
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
  }
  const base = normalizeWakeConfig(current);
  const cfg = {
    ...base,
    triggers: { ...base.triggers },
    confirmedBy: 'agent',
    confirmedAt: now,
  };
  if (input.mode !== undefined) {
    if (input.mode !== 'diving' && input.mode !== 'active') {
      const error = new Error('mode 必须是 diving 或 active');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    cfg.mode = input.mode;
  }
  if (input.infinite !== undefined) cfg.infinite = input.infinite !== false;
  if (cfg.infinite) {
    cfg.sleepUntil = null;
  } else {
    const until = safeIso(input.sleepUntil ?? base.sleepUntil);
    const ms = Date.parse(until || '');
    if (!until || !Number.isFinite(ms) || ms <= now) {
      const error = new Error('infinite=false 时必须给未来的 sleepUntil（ISO 时间）');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    if (ms - now > 30 * 24 * 60 * 60 * 1000) {
      const error = new Error('sleepUntil 最多 30 天');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    cfg.sleepUntil = until;
  }
  const tr = rawTriggers || null;
  if (tr) {
    for (const key of WAKE_TRIGGER_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(tr, key)) continue;
      const value = tr[key];
      if (key === 'speakerIds') {
        cfg.triggers.speakerIds = normalizeSpeakerIds(value, []);
      } else if (key === 'keywords') {
        cfg.triggers.keywords = normalizeKeywords(value, []);
      } else if (key === 'probability') {
        cfg.triggers.probability = clampNumber(value, 0, 1, cfg.triggers.probability);
      } else {
        cfg.triggers[key] = value === true;
      }
    }
  }
  if (cfg.mode === 'active') {
    cfg.triggers.anyMessage = true;
  } else if (!tr || !Object.prototype.hasOwnProperty.call(tr, 'anyMessage')) {
    // active -> diving 的切换不能把 anyMessage 留在 true，否则永远不是 sleep-like。
    cfg.triggers.anyMessage = false;
  }
  if (input.batchWindowMs !== undefined) {
    cfg.batchWindowMs = Math.round(
      clampNumber(input.batchWindowMs, 1000, 60_000, cfg.batchWindowMs),
    );
  }
  if (input.limits !== undefined) {
    const rawLimits = input.limits;
    if (!rawLimits || typeof rawLimits !== 'object' || Array.isArray(rawLimits)) {
      const error = new Error('limits 必须是对象');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    for (const key of Object.keys(rawLimits)) {
      if (!Object.hasOwn(LIMIT_RANGES, key)) {
        const error = new Error(`未知 limits 字段：${key}`);
        error.status = 400;
        error.code = 'bad-request';
        throw error;
      }
      const value = rawLimits[key];
      const [min, max] = LIMIT_RANGES[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        const error = new Error(`${key} 必须是 ${min}~${max} 的整数`);
        error.status = 400;
        error.code = 'bad-request';
        throw error;
      }
      if (key === 'preSleepWaitMs' && value % 1000 !== 0) {
        const error = new Error('preSleepWaitMs 必须是 1000 的倍数');
        error.status = 400;
        error.code = 'bad-request';
        throw error;
      }
      cfg.limits[key] = value;
    }
  }
  if (input.hint !== undefined) {
    if (typeof input.hint !== 'string') {
      const error = new Error('hint 必须是字符串');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const hint = input.hint.trim();
    if (hint.length > 200) {
      const error = new Error('hint 最多 200 字');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    cfg.hint = hint;
  }
  if (kind !== 'group' && cfg.triggers.speakerIds.length > 0) {
    const error = new Error('speakerIds 只对群聊有效');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  if (!isWakeable(cfg)) {
    const error = new Error(
      '这份配置没有任何可触发唤醒的条件，会把会话变成永眠；至少保留一个触发或设置有限的 sleepUntil',
    );
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  return cfg;
}

export function wakeConfigSummary(cfg) {
  const tr = cfg?.triggers || {};
  const parts = [];
  if (tr.atMention) parts.push('@');
  if (tr.nameMention) parts.push('名字');
  if (Array.isArray(tr.keywords) && tr.keywords.length) parts.push(`关键词(${tr.keywords.join('、')})`);
  if (tr.question) parts.push('提问');
  if (tr.poke) parts.push('拍一拍');
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    parts.push(`指定成员(${tr.speakerIds.join(',')})`);
  }
  if (tr.anyMessage) parts.push('任意消息');
  if (Number(tr.probability) > 0) parts.push(`概率 ${Number(tr.probability).toFixed(2)}`);
  const mode = cfg?.mode === 'active' ? '活跃' : '潜水';
  const time = cfg?.infinite
    ? '无限'
    : cfg?.sleepUntil
      ? `有限至 ${cfg.sleepUntil}`
      : '未设时间';
  const limits = cfg?.limits || DEFAULT_WAKE_LIMITS;
  const hint = typeof cfg?.hint === 'string' ? cfg.hint.trim() : '';
  const limitText = `限制：每分钟 ${limits.maxWakePerMinute} 次 / 每小时 ${limits.maxWakePerHour} 次 / 沉睡前观察 ${Math.round((Number(limits.preSleepWaitMs) || 300_000) / 1000)} 秒 / 连续 ${limits.noActionLimit} 轮无行动重置`;
  return `${mode}，${time}${parts.length ? `；触发：${parts.join('/')}` : ''}；${limitText}${hint ? `；管理员建议：${hint}` : ''}`;
}
