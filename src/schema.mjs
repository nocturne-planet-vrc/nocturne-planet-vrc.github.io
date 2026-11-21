// Runtime schema upgrades.
//
// Cloudflare Pages deployments do not apply D1 migrations, so tables and columns
// added after the initial schema are also prepared here the first time they are
// needed. Every statement is additive and idempotent; keep table definitions
// identical to the matching file in migrations/.
//
//   0007  staff_directory
//   0008  discord_nickname_sync
//   0009  event_placements, manual_google_docs(.inline_body)
//   0010  manual_document_cache
//   -     events/cheki/cheki_batches.deleted_at  (runtime only, no migration file)
//   -     reminder_log, discord_dm_channels     (runtime only, no migration file)
//
// The runtime-only items cannot simply gain a migration now: production already
// has them, and SQLite's ADD COLUMN is not idempotent, so a new migration would
// fail there. Add them to a migration only together with a fresh-database plan.
//
// Each preparation runs once per D1 binding. A failed attempt is forgotten so
// the next request retries it.

function once(prepare) {
  const ready = new WeakMap();
  return env => {
    if (!ready.has(env.DB)) {
      ready.set(
        env.DB,
        prepare(env.DB).catch(error => {
          ready.delete(env.DB);
          throw error;
        })
      );
    }
    return ready.get(env.DB);
  };
}

async function addColumnIfMissing(db, table, column, definition) {
  const exists = async () =>
    (await db.prepare(`PRAGMA table_info(${table})`).all()).results.some(info => info.name === column);
  if (await exists()) return;
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    // Another request may have added it between the check and the ALTER.
    if (!(await exists())) throw error;
  }
}

export const ensureManageTrash = once(async db => {
  for (const table of ['events', 'cheki', 'cheki_batches']) await addColumnIfMissing(db, table, 'deleted_at', 'TEXT');
  await db.prepare('CREATE INDEX IF NOT EXISTS event_deleted_start ON events(deleted_at,starts_at)').run();
});

export const ensureStaffTable = once(async db => {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS staff_directory (user_id TEXT PRIMARY KEY REFERENCES users(id), display_name TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]', synced_at TEXT NOT NULL)"
    )
    .run();
});

export const ensureNicknameTable = once(async db => {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS discord_nickname_sync (user_id TEXT PRIMARY KEY REFERENCES users(id), vrchat_id TEXT NOT NULL, target_name TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, retry_after INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)'
    )
    .run();
});

export const ensureReminderTables = once(async db => {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS reminder_log (event_id TEXT NOT NULL, user_id TEXT NOT NULL, deadline TEXT NOT NULL, stage INTEGER NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL, PRIMARY KEY(event_id,user_id,deadline,stage))"
    ),
    db.prepare('CREATE TABLE IF NOT EXISTS discord_dm_channels (user_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL)')
  ]);
});

export const ensureStaffResources = once(async db => {
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS event_placements (event_id TEXT PRIMARY KEY REFERENCES events(id), instances TEXT NOT NULL, published INTEGER NOT NULL CHECK(published IN (0,1)), revision TEXT NOT NULL)'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS manual_google_docs (content_id TEXT PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE, url TEXT NOT NULL, inline_body INTEGER NOT NULL DEFAULT 0 CHECK(inline_body IN (0,1)))'
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS manual_document_cache (content_id TEXT PRIMARY KEY REFERENCES manual_google_docs(content_id) ON DELETE CASCADE, source_key TEXT NOT NULL, html TEXT NOT NULL, fetched_at INTEGER NOT NULL)'
    )
  ]);
  await addColumnIfMissing(
    db,
    'manual_google_docs',
    'inline_body',
    'INTEGER NOT NULL DEFAULT 0 CHECK(inline_body IN (0,1))'
  );
});
