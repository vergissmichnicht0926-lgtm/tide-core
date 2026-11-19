PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  legacy_key TEXT UNIQUE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'direct'
    CHECK (kind IN ('direct','group')),
  title TEXT NOT NULL,
  avatar TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dsh_session_id TEXT,
  dsh_workspace_id TEXT,
  dsh_after_seq INTEGER NOT NULL DEFAULT 0,
  -- DSH session 代次：只在策略 rebuild 真正替换 session 时 +1；消息 seq 不重置。
  epoch INTEGER NOT NULL DEFAULT 1,
  agent_token TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT 'restricted'
    CHECK (policy IN ('restricted','owner')),
  policy_hash TEXT NOT NULL,
  user_read_seq INTEGER NOT NULL DEFAULT 0, -- legacy：M7b 起成员已读只看 conversation_member.last_read_seq
  agent_read_seq INTEGER NOT NULL DEFAULT 0,
  recap_at INTEGER,
  -- M4.5：必须是完整 defaultWakeConfigV2，不能留 {}，否则会话永久不醒。
  wake_config_json TEXT NOT NULL DEFAULT '{"mode":"diving","infinite":true,"sleepUntil":null,"triggers":{"atMention":true,"nameMention":true,"speakerIds":[],"keywords":["汐语","小汐","Tide"],"question":true,"poke":false,"anyMessage":false,"probability":0.05},"batchWindowMs":8000,"lastWakeAt":0,"wakeCount":0,"confirmedAt":0,"confirmedBy":"default"}',
  social_state_json TEXT NOT NULL DEFAULT '{}',
  announcement TEXT,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_conversation_user ON conversation(user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_token ON conversation(agent_token);

-- M7a：会话成员模型。M6.5 每个 direct 只有一个 owner；群聊后续扩成 N 个 member。
CREATE TABLE IF NOT EXISTS conversation_member (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  -- 群管理员：role 受历史 CHECK 限制仍是 member，对外 API 映射成 role='admin'。
  is_admin INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  join_seq INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_member_user ON conversation_member(user_id, conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_member_one_owner
  ON conversation_member(conversation_id) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  dsh_turn TEXT,
  dsh_message_id TEXT,
  client_msg_id TEXT,
  wake_reason TEXT,
  sender_user_id TEXT,
  sender_name TEXT,
  mentions TEXT,
  recalled_at INTEGER,
  UNIQUE(conversation_id, seq),
  UNIQUE(conversation_id, client_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_message_conv_seq ON message(conversation_id, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_dsh
  ON message(conversation_id, dsh_message_id)
  WHERE dsh_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachment (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES message(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  name TEXT,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT,
  local_path TEXT NOT NULL,
  remote_path TEXT,
  uploader_user_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sticker (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT,
  name          TEXT NOT NULL,
  tags_json     TEXT NOT NULL DEFAULT '[]',
  usage_note    TEXT NOT NULL DEFAULT '',
  attachment_id TEXT NOT NULL,
  md5           TEXT NOT NULL DEFAULT '',
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  disabled_at   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sticker_owner ON sticker(owner_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_md5 ON sticker(md5) WHERE md5 != '';
CREATE INDEX IF NOT EXISTS idx_attachment_conv ON attachment(conversation_id);

CREATE TABLE IF NOT EXISTS seen_seq (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  viewer TEXT NOT NULL CHECK (viewer IN ('user','agent')),
  seq INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, viewer, seq)
);

CREATE TABLE IF NOT EXISTS message_batch (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  client_batch_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  message_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, client_batch_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_created ON message_batch(created_at);

CREATE TABLE IF NOT EXISTS agent_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_conv_kind ON agent_memory(conversation_id, kind);

CREATE TABLE IF NOT EXISTS pending_wake (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  seq INTEGER,
  created_at INTEGER NOT NULL
);

-- 发送节流（8 条/分、60 条/时）：超限批次排队，不丢弃。created_at/not_before 都是毫秒。
CREATE TABLE IF NOT EXISTS send_queue (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  messages_json TEXT NOT NULL,
  reply_to_message_id TEXT,
  client_batch_id TEXT,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  not_before INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed')),
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_send_queue_pending
  ON send_queue(conversation_id, state, not_before);

CREATE TABLE IF NOT EXISTS bubble_queue (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  client_batch_id TEXT,
  segment_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply_to TEXT,
  not_before_ms INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sent','failed')),
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (conversation_id, client_batch_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_bubble_queue_pending
  ON bubble_queue(conversation_id, state, not_before_ms, segment_index);

-- M6.5：单 bot 多用户（admin / guest）
CREATE TABLE IF NOT EXISTS invite (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'bot' CHECK (kind IN ('bot','group')),
  role TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('admin','guest')),
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  group_id TEXT REFERENCES conversation(id) ON DELETE CASCADE,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_code ON invite(code);

CREATE TABLE IF NOT EXISTS join_request (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('bot','group')),
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_join_request_user ON join_request(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_join_request_status ON join_request(status, created_at ASC);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  chars_in INTEGER NOT NULL DEFAULT 0,
  chars_out INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS bot_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  persona_override TEXT,
  ai_name TEXT,
  ai_signature TEXT,
  ai_avatar TEXT,
  model TEXT,
  tool_profile TEXT,
  default_wake_config_json TEXT,
  per_user_limits_json TEXT,
  silent_until_ms INTEGER NOT NULL DEFAULT 0,
  bubble_delay_ms INTEGER NOT NULL DEFAULT 1200,
  price_in_per_1k REAL NOT NULL DEFAULT 0,
  price_out_per_1k REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO bot_settings
  (id, persona_override, model, tool_profile, default_wake_config_json,
   per_user_limits_json, updated_at)
VALUES
  (1, NULL, NULL, NULL, NULL,
   '{"dailyMessages":500,"maxConversations":5,"uploadMb":100}', 0);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS rebuild_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','failed')),
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rebuild_conversation ON rebuild_queue(conversation_id);

-- M9：动态。目前只有私聊 bot 有发布权（走 /agent/moments），
-- 可见范围 = 已经添加该 bot 私聊的用户；点赞按用户唯一。
CREATE TABLE IF NOT EXISTS moment (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moment_created ON moment(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moment_conversation ON moment(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS moment_like (
  moment_id TEXT NOT NULL REFERENCES moment(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (moment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_moment_like_user ON moment_like(user_id);

-- P0 管理台：控制台会话与结构化事件。
CREATE TABLE IF NOT EXISTS admin_session (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  csrf_hash   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_session_exp ON admin_session(expires_at);

CREATE TABLE IF NOT EXISTS event_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT NOT NULL,
  level           TEXT NOT NULL,
  kind            TEXT NOT NULL,
  conversation_id TEXT,
  detail          TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_at ON event_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_event_kind_at ON event_log(kind, at DESC);
