-- Members of the staff Discord server, read with the event's bot.
-- Lets organizers pick staff who have roles but have not signed in yet.
CREATE TABLE IF NOT EXISTS staff_directory (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT NOT NULL
);
