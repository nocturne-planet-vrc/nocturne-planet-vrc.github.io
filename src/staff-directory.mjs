import { HttpError, nowIso, isAdmin } from './core.mjs';
import { dutyRoles } from './duties.mjs';

const DISCORD = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://nocturne-planet.pages.dev, 1.0.0)';
const STALE_MS = 5 * 60 * 1000;
const STATE_KEY = 'staff_directory';

export const botConfigured = env => !!env.DISCORD_BOT_TOKEN;

// Same schema as migrations/0007. Creating it here keeps the organizer page working
// if the code is published before the remote migration runs.
export const ensureStaffTable = env =>
  env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS staff_directory (user_id TEXT PRIMARY KEY REFERENCES users(id), display_name TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]', synced_at TEXT NOT NULL)"
  ).run();
const ensureTable = ensureStaffTable;

async function readState(env) {
  const row = await env.DB.prepare('SELECT value FROM integrations WHERE key=?').bind(STATE_KEY).first();
  try {
    return row ? JSON.parse(row.value) : {};
  } catch {
    return {};
  }
}
const writeState = (env, state) =>
  env.DB.prepare(
    'INSERT INTO integrations(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(STATE_KEY, JSON.stringify(state));

async function fetchMembers(env, fetcher) {
  const members = [];
  let after = '0';
  for (let page = 0; page < 20; page++) {
    const response = await fetcher(DISCORD + '/guilds/' + env.STAFF_GUILD_ID + '/members?limit=1000&after=' + after, {
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'User-Agent': USER_AGENT }
    });
    if (response.status === 429) {
      const limit = await response.json().catch(() => ({}));
      const error = new HttpError(
        503,
        'Discordが混み合っています。' +
          Math.ceil(Number(limit.retry_after) || 5) +
          '秒ほど待ってから再読み込みしてください。',
        'DISCORD_BUSY'
      );
      error.retryAfter = Math.max(1, Math.ceil(Number(limit.retry_after) || 5));
      throw error;
    }
    if (response.status === 401)
      throw new HttpError(
        503,
        'Botのトークンが無効です。Developer Portalで発行したトークンを設定し直してください。',
        'BOT_TOKEN'
      );
    if (response.status === 403)
      throw new HttpError(
        503,
        'Botが運営用サーバーのメンバーを読めません。Botをサーバーに追加し、Server Members Intentを有効にしてください。',
        'BOT_ACCESS'
      );
    if (!response.ok)
      throw new HttpError(503, 'Discordからメンバー一覧を取得できませんでした。', 'BOT_HTTP_' + response.status);
    const batch = await response.json();
    if (!Array.isArray(batch))
      throw new HttpError(503, 'Discordからメンバー一覧を取得できませんでした。', 'BOT_RESPONSE');
    members.push(...batch);
    if (batch.length < 1000) break;
    after = batch.at(-1).user.id;
  }
  return members.filter(member => member?.user && !member.user.bot && /^\d{17,20}$/.test(member.user.id));
}

function memberRow(member) {
  const user = member.user,
    name = String(member.nick || user.global_name || user.username || user.id).slice(0, 80);
  const avatar =
    user.avatar && /^[a-zA-Z0-9_]+$/.test(user.avatar)
      ? 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.png?size=128'
      : null;
  return {
    id: user.id,
    name,
    avatar,
    roles: (Array.isArray(member.roles) ? member.roles : []).filter(role => /^\d{17,20}$/.test(role))
  };
}

// Reads the staff server member list with the bot. Without force, a recent result is reused
// and failures are reported in the status instead of blocking the organizer page.
export async function syncStaffDirectory(env, fetcher, { force = false } = {}) {
  await ensureTable(env);
  if (!botConfigured(env)) return { configured: false };
  const state = await readState(env);
  if (!force && state.synced_at && Date.now() - Date.parse(state.synced_at) < STALE_MS && !state.error)
    return { configured: true, ...state };
  try {
    const rows = (await fetchMembers(env, fetcher)).map(memberRow),
      now = nowIso(),
      payload = JSON.stringify(rows),
      next = { synced_at: now, count: rows.length, error: null };
    // Four statements regardless of member count, to stay within D1's per-request query limit.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id,display_name,avatar_url,last_seen_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.avatar'),? FROM json_each(?) WHERE true ON CONFLICT(id) DO NOTHING"
      ).bind(now, payload),
      env.DB.prepare('DELETE FROM staff_directory'),
      env.DB.prepare(
        "INSERT INTO staff_directory(user_id,display_name,roles,synced_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.roles'),? FROM json_each(?)"
      ).bind(now, payload),
      writeState(env, next)
    ]);
    return { configured: true, ...next };
  } catch (error) {
    const next = { ...state, error: error.message || 'メンバー一覧を取得できませんでした。', failed_at: nowIso() };
    await writeState(env, next).run();
    if (force) throw error;
    return { configured: true, ...next };
  }
}

export function roleNames(roles, env) {
  const ids = new Set(roles),
    names = [];
  if (isAdmin({ roles }, env)) names.push('運営');
  for (const duty of dutyRoles) if (ids.has(duty.role_id)) names.push(duty.name);
  return names;
}

export async function staffUsers(env) {
  const { results } = await env.DB.prepare(
    'SELECT u.id,COALESCE(d.display_name,u.display_name) AS display_name,d.roles,d.user_id IS NOT NULL AS in_server,u.joined_as_staff AS logged_in FROM users u LEFT JOIN staff_directory d ON d.user_id=u.id WHERE u.joined_as_staff=1 OR d.user_id IS NOT NULL ORDER BY display_name LIMIT 500'
  ).all();
  return results.map(row => {
    let roles = [];
    try {
      roles = JSON.parse(row.roles || '[]');
    } catch {}
    return {
      id: row.id,
      display_name: row.display_name,
      roles: roleNames(roles, env),
      in_server: !!row.in_server,
      logged_in: !!row.logged_in
    };
  });
}

export async function isStaffCandidate(userId, env) {
  await ensureTable(env);
  return !!(await env.DB.prepare(
    'SELECT u.id FROM users u LEFT JOIN staff_directory d ON d.user_id=u.id WHERE u.id=? AND (u.joined_as_staff=1 OR d.user_id IS NOT NULL)'
  )
    .bind(userId)
    .first());
}
