CREATE TABLE IF NOT EXISTS event_placements (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  instances TEXT NOT NULL,
  published INTEGER NOT NULL CHECK(published IN (0,1)),
  revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_google_docs (
  content_id TEXT PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  inline_body INTEGER NOT NULL DEFAULT 0 CHECK(inline_body IN (0,1))
);
