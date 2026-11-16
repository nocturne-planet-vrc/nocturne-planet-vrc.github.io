PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  joined_as_customer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tokens TEXT NOT NULL,
  token_expires_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  refresh_lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX session_user ON sessions(user_id);
CREATE TABLE oauth_states (
  id_hash TEXT PRIMARY KEY,
  binder_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  destination TEXT NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  session_hash TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('site', '{"x_url":"https://x.com/NoctuPla_VRC","youtube_url":"","youtube_video":"","discord_invite":"","vrchat_group_url":"","hero_image":"","about":"Nocturne Planetは、自作プラネタリウムで星空解説・キャスト接客・歌唱ライブを楽しめるVRChatイベントです。","admission":"Group+・先着順","cadence":"隔週開催予定"}');
CREATE TABLE events (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  response_deadline TEXT, published INTEGER NOT NULL DEFAULT 0,
  checkin_opens_at TEXT, checkin_closes_at TEXT, checkin_salt TEXT, checkin_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX event_start ON events(starts_at);
CREATE TABLE casts (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '', image_id TEXT, x_url TEXT NOT NULL DEFAULT '',
  youtube_url TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE content (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('news','page','manual')),
  slug TEXT NOT NULL, title TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  published_at TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL REFERENCES users(id),
  UNIQUE(kind,slug)
);
CREATE INDEX content_public ON content(kind,status,published_at);
CREATE TABLE attendance (
  event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES users(id),
  answer TEXT NOT NULL CHECK(answer IN ('yes','no','maybe')),
  available_from TEXT NOT NULL DEFAULT '', available_until TEXT NOT NULL DEFAULT '',
  duties TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id,user_id)
);
CREATE TABLE assignments (
  event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES users(id),
  details TEXT NOT NULL DEFAULT '', published INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(event_id,user_id)
);
CREATE TABLE visits (
  event_id TEXT NOT NULL REFERENCES events(id), user_id TEXT NOT NULL REFERENCES users(id),
  checked_in_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id)
);
CREATE INDEX visit_user ON visits(user_id,checked_in_at);
CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES users(id), cast_id TEXT NOT NULL REFERENCES casts(id),
  PRIMARY KEY(user_id,cast_id)
);
CREATE TABLE images (
  id TEXT PRIMARY KEY, drive_id TEXT NOT NULL UNIQUE, mime TEXT NOT NULL,
  size INTEGER NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('private','public')),
  uploaded_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE cheki (
  id TEXT PRIMARY KEY, image_id TEXT NOT NULL UNIQUE REFERENCES images(id),
  sender_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT REFERENCES events(id), message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, opened_at TEXT, withdrawn INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cheki_recipient ON cheki(recipient_id,created_at);
CREATE TABLE integrations (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  resource_id TEXT NOT NULL, created_at TEXT NOT NULL
);
