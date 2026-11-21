CREATE TABLE IF NOT EXISTS manual_document_parts (
  content_id TEXT NOT NULL REFERENCES manual_document_cache(content_id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  html TEXT NOT NULL,
  PRIMARY KEY(content_id,part)
);
