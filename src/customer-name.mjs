import { snowflake, nowIso } from './core.mjs';

const DISCORD = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://nocturne-planet.pages.dev, 1.0.0)';
const epoch = () => Math.floor(Date.now() / 1000);
// Keep the portal usable when code reaches production before migration 0008.
export const ensureNicknameTable = env =>
  env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS discord_nickname_sync (user_id TEXT PRIMARY KEY REFERENCES users(id), vrchat_id TEXT NOT NULL, target_name TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL, retry_after INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)'
  ).run();
export const discordNickname = name => Array.from(name.trim().replace(/\s+/gu, ' ')).slice(0, 32).join('');
const result = row =>
  row ? { status: row.status, message: row.message, target_name: row.target_name, retry_after: row.retry_after } : null;

export async function syncCustomerNickname(actor, linked, env, fetcher) {
  if (!linked) return null;
  await ensureNicknameTable(env);
  const target = discordNickname(linked.display_name),
    now = epoch();
  const read = () =>
    env.DB.prepare('SELECT * FROM discord_nickname_sync WHERE user_id=? AND vrchat_id=? AND target_name=?')
      .bind(actor.id, linked.vrchat_id, target)
      .first();
  const save = async (status, message, retryAfter = now + 300) => {
    await env.DB.prepare(
      'UPDATE discord_nickname_sync SET status=?,message=?,retry_after=?,updated_at=? WHERE user_id=? AND vrchat_id=? AND target_name=?'
    )
      .bind(status, message, retryAfter, nowIso(), actor.id, linked.vrchat_id, target)
      .run();
    return { status, message, target_name: target, retry_after: retryAfter };
  };
  const previous = await read();
  // A short lease prevents concurrent page loads from issuing duplicate PATCHes.
  // Failed automatic attempts wait five minutes, including retries from an open page.
  if (previous && previous.retry_after > now && previous.status !== 'synced') return result(previous);
  if (previous?.status === 'synced' && actor.member.nick === target) return result(previous);
  const claimed = await env.DB.prepare(
    "INSERT INTO discord_nickname_sync(user_id,vrchat_id,target_name,status,message,retry_after,updated_at) SELECT user_id,vrchat_id,?,'pending','Discordのニックネームを更新しています。',?,? FROM vrchat_links WHERE user_id=? AND vrchat_id=? AND display_name=? ON CONFLICT(user_id) DO UPDATE SET vrchat_id=excluded.vrchat_id,target_name=excluded.target_name,status=excluded.status,message=excluded.message,retry_after=excluded.retry_after,updated_at=excluded.updated_at WHERE discord_nickname_sync.vrchat_id<>excluded.vrchat_id OR discord_nickname_sync.target_name<>excluded.target_name OR discord_nickname_sync.retry_after<=? OR discord_nickname_sync.status='synced' RETURNING user_id"
  )
    .bind(target, now + 30, nowIso(), actor.id, linked.vrchat_id, linked.display_name, now)
    .first();
  if (!claimed) return result(await read());
  if (actor.member.nick === target)
    return save('synced', 'お客様用DiscordサーバーのニックネームはVRChat名と同じです。');
  if (!env.DISCORD_BOT_TOKEN)
    return save('unavailable', 'Discordのニックネームはまだ更新できていません。運営がBotの設定を確認しています。');
  const backoff = await env.DB.prepare(
    "SELECT resets_at FROM rate_limits WHERE key='discord:nickname:backoff'"
  ).first();
  if (backoff?.resets_at > now)
    return save(
      'rate_limited',
      'Discordへの更新が混み合っています。時間を置いて再試行してください。',
      backoff.resets_at
    );
  let response;
  try {
    response = await fetcher(`${DISCORD}/guilds/${snowflake(env.CUSTOMER_GUILD_ID)}/members/${snowflake(actor.id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-Audit-Log-Reason': 'Verified VRChat account name sync'
      },
      body: JSON.stringify({ nick: target }),
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    return save('failed', 'Discordに接続できず、ニックネームを更新できませんでした。時間を置いて自動で再試行します。');
  }
  if (response.ok) {
    actor.member.nick = target;
    return save(
      'synced',
      'お客様用DiscordサーバーのニックネームをVRChat名に更新しました。' +
        (Array.from(linked.display_name).length > 32 ? 'Discord側は先頭32文字です。' : '')
    );
  }
  if (response.status === 429) {
    const data = await response.json().catch(() => ({}));
    const seconds = Math.min(
      3600,
      Math.max(1, Math.ceil(Number(data.retry_after) || Number(response.headers.get('Retry-After')) || 60))
    );
    const until = now + seconds;
    await env.DB.prepare(
      "INSERT INTO rate_limits(key,count,resets_at) VALUES('discord:nickname:backoff',0,?) ON CONFLICT(key) DO UPDATE SET resets_at=MAX(resets_at,excluded.resets_at)"
    )
      .bind(until)
      .run();
    return save('rate_limited', 'Discordへの更新が混み合っています。時間を置いて再試行してください。', until);
  }
  if (response.status === 403)
    return save(
      'blocked',
      'ニックネームを変更できませんでした。運営にBotの「ニックネームの管理」権限とロールの順序を確認してもらってください。サーバー所有者の名前はBotでは変更できません。'
    );
  if (response.status === 404 || response.status === 401)
    return save(
      'unavailable',
      'ニックネームを更新できませんでした。運営にお客様用サーバーへのBotの追加と接続設定を確認してもらってください。'
    );
  return save('failed', 'Discordのニックネームを更新できませんでした。時間を置いて再試行してください。');
}
