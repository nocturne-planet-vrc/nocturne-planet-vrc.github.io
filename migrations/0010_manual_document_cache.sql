CREATE TABLE IF NOT EXISTS manual_document_cache (
  content_id TEXT PRIMARY KEY REFERENCES manual_google_docs(content_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  html TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
