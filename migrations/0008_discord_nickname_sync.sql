CREATE TABLE IF NOT EXISTS discord_nickname_sync (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  vrchat_id TEXT NOT NULL,
  target_name TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  retry_after INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
