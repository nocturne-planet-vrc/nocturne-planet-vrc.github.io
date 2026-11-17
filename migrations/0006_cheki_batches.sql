ALTER TABLE casts ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE UNIQUE INDEX cast_user ON casts(user_id) WHERE user_id IS NOT NULL;
CREATE TABLE cheki_batches (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  cast_id TEXT NOT NULL REFERENCES casts(id),
  image_id TEXT UNIQUE REFERENCES images(id),
  message TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL,
  expected_count INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sent','failed')),
  created_at TEXT NOT NULL,
  withdrawn INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cheki_batch_sender ON cheki_batches(sender_id,created_at);
CREATE TABLE cheki_deliveries (
  batch_id TEXT NOT NULL REFERENCES cheki_batches(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  opened_at TEXT,
  PRIMARY KEY(batch_id,recipient_id)
);
CREATE INDEX cheki_delivery_recipient ON cheki_deliveries(recipient_id,batch_id);
