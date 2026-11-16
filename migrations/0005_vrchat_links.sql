CREATE TABLE vrchat_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  vrchat_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE TABLE vrchat_challenges (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  vrchat_id TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
