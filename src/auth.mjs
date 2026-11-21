import { HttpError, randomToken, sha256, equal, seal, unseal, isAdmin, rateLimit, snowflake, nowIso } from './core.mjs';

const DISCORD = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://nocturne-planet.pages.dev, 1.0.0)';
const epoch = () => Math.floor(Date.now() / 1000);
export const appOrigin = env => new URL(env.APP_ORIGIN).origin;
function cookieName(env, name) {
  return `${appOrigin(env).startsWith('https:') ? '__Host-' : ''}np_${name}`;
}
export function cookie(env, name, value, maxAge) {
  return `${cookieName(env, name)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${appOrigin(env).startsWith('https:') ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
}
function getCookie(request, env, name) {
  const prefix = cookieName(env, name) + '=';
  return (
    (request.headers.get('Cookie') || '')
      .split(';')
      .map(x => x.trim())
      .find(x => x.startsWith(prefix))
      ?.slice(prefix.length) || ''
  );
}
export async function sessionFor(request, env) {
  const token = getCookie(request, env, 'session');
  if (!token) throw new HttpError(401, 'Discordでログインしてください。', 'LOGIN_REQUIRED');
  const hash = await sha256(token);
  const session = await env.DB.prepare(
    `SELECT s.*,u.display_name,u.avatar_url,u.joined_as_customer,u.joined_as_staff,v.display_name AS vrchat_name
    FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN vrchat_links v ON v.user_id=s.user_id
    WHERE s.id_hash=? AND s.expires_at>?`
  )
    .bind(hash, epoch())
    .first();
  if (!session)
    throw new HttpError(401, 'ログインの有効期限が切れました。もう一度ログインしてください。', 'LOGIN_REQUIRED');
  return session;
}
async function discordFetch(url, options, fetcher) {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url, options);
    if (response.status !== 429) return response;
    const limit = await response.json().catch(() => ({}));
    const reported = Number(limit?.retry_after ?? response.headers.get('Retry-After'));
    const delay = Number.isFinite(reported) && reported > 0 ? reported : 1;
    if (attempt >= 2 || waited + delay > 5) {
      const seconds = Math.ceil(delay);
      const error = new HttpError(
        503,
        `Discordへの確認が混み合っています。${seconds}秒ほど待ってもう一度お試しください。`,
        'DISCORD_BUSY'
      );
      error.retryAfter = seconds;
      throw error;
    }
    waited += delay;
    await new Promise(resolve => setTimeout(resolve, Math.ceil(delay * 1000) + 100 + Math.random() * 250));
  }
}
async function discordToken(body, env, fetcher) {
  const response = await discordFetch(
    'https://discord.com/api/oauth2/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ ...body, client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET })
    },
    fetcher
  );
  if (!response.ok)
    throw new HttpError(
      response.status >= 500 ? 503 : 401,
      'Discordとの認証をもう一度お試しください。',
      'DISCORD_AUTH'
    );
  const token = await response.json();
  if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_in))
    throw new HttpError(503, 'Discordの認証情報を確認できませんでした。');
  return token;
}
async function tokensFor(session, env, fetcher) {
  let tokens = await unseal(session.tokens, env.TOKEN_ENCRYPTION_KEY);
  if (session.token_expires_at > epoch() + 30) return tokens;
  const lock = await env.DB.prepare(
    'UPDATE sessions SET refresh_lock_until=? WHERE id_hash=? AND tokens=? AND refresh_lock_until<? RETURNING refresh_lock_until'
  )
    .bind(epoch() + 30, session.id_hash, session.tokens, epoch())
    .first();
  if (!lock) {
    const current = await env.DB.prepare('SELECT tokens,token_expires_at FROM sessions WHERE id_hash=?')
      .bind(session.id_hash)
      .first();
    if (current?.token_expires_at > epoch() + 30) return unseal(current.tokens, env.TOKEN_ENCRYPTION_KEY);
    throw new HttpError(503, 'ログイン情報を更新しています。少し待ってお試しください。', 'TOKEN_REFRESH');
  }
  try {
    tokens = await discordToken({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, env, fetcher);
    await env.DB.prepare(
      'UPDATE sessions SET tokens=?,token_expires_at=?,refresh_lock_until=0 WHERE id_hash=? AND refresh_lock_until=?'
    )
      .bind(
        await seal(tokens, env.TOKEN_ENCRYPTION_KEY),
        epoch() + tokens.expires_in,
        session.id_hash,
        lock.refresh_lock_until
      )
      .run();
    return tokens;
  } catch (error) {
    await env.DB.prepare('UPDATE sessions SET refresh_lock_until=0 WHERE id_hash=? AND refresh_lock_until=?')
      .bind(session.id_hash, lock.refresh_lock_until)
      .run();
    throw error;
  }
}
const membershipInflight = new WeakMap();
async function queryMembership(accessToken, guildId, fetcher) {
  const response = await discordFetch(
    `${DISCORD}/users/@me/guilds/${snowflake(guildId)}/member`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': USER_AGENT }
    },
    fetcher
  );
  if (response.status === 404) return null;
  if (response.status === 401) throw new HttpError(401, 'Discordでログインし直してください。', 'LOGIN_REQUIRED');
  if (!response.ok)
    throw new HttpError(
      503,
      'Discordの所属確認ができません。少し時間を置いてお試しください。',
      `DISCORD_HTTP_${response.status}`
    );
  const member = await response.json();
  return member.pending ? null : member;
}
async function membership(accessToken, guildId, fetcher) {
  let pending = membershipInflight.get(fetcher);
  if (!pending) {
    pending = new Map();
    membershipInflight.set(fetcher, pending);
  }
  const key = `${accessToken}:${guildId}`;
  if (pending.has(key)) return pending.get(key);
  const result = queryMembership(accessToken, guildId, fetcher);
  pending.set(key, result);
  try {
    return await result;
  } finally {
    pending.delete(key);
  }
}
export async function actorFor(request, env, area, fetcher = fetch) {
  const session = await sessionFor(request, env),
    tokens = await tokensFor(session, env, fetcher);
  const member = await membership(
    tokens.access_token,
    area === 'member' ? env.CUSTOMER_GUILD_ID : env.STAFF_GUILD_ID,
    fetcher
  );
  if (!member)
    throw new HttpError(
      403,
      area === 'member' ? 'お客さん用Discordサーバーへの参加が必要です。' : '運営用Discordサーバーへの参加が必要です。',
      'GUILD_REQUIRED'
    );
  const admin = area !== 'member' && isAdmin(member, env);
  if (area === 'manage' && !admin)
    throw new HttpError(403, '運営ロールを持つ方だけがアクセスできます。', 'ROLE_REQUIRED');
  if (area === 'member' && !session.joined_as_customer)
    await env.DB.prepare('UPDATE users SET joined_as_customer=1 WHERE id=? AND joined_as_customer=0')
      .bind(session.user_id)
      .run();
  if (area !== 'member' && !session.joined_as_staff)
    await env.DB.prepare('UPDATE users SET joined_as_staff=1 WHERE id=? AND joined_as_staff=0')
      .bind(session.user_id)
      .run();
  return {
    id: session.user_id,
    name: (area === 'member' && session.vrchat_name) || session.display_name,
    avatar: session.avatar_url,
    admin,
    session,
    member
  };
}
export async function csrfFor(actor, env) {
  return sha256(`${actor.session.id_hash}:${env.TOKEN_ENCRYPTION_KEY}:csrf`);
}
export async function requireMutation(request, actor, env) {
  if (
    request.headers.get('Origin') !== appOrigin(env) ||
    !equal(request.headers.get('X-CSRF-Token'), await csrfFor(actor, env))
  )
    throw new HttpError(403, '画面を再読み込みして、もう一度お試しください。', 'CSRF');
}
export async function startOauth(request, env, purpose, fetcher = fetch) {
  const url = new URL(request.url),
    destination = purpose === 'google' ? 'manage' : url.searchParams.get('area') || 'member';
  if (!['staff', 'member', 'manage'].includes(destination)) throw new HttpError(400, 'ログイン先を確認してください。');
  if (url.origin !== appOrigin(env))
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${appOrigin(env)}/auth/${purpose}?area=${destination}&remember=${url.searchParams.get('remember') === '1' ? '1' : '0'}`
      }
    });
  if (!env.TOKEN_ENCRYPTION_KEY || !(purpose === 'google' ? env.GOOGLE_CLIENT_ID : env.DISCORD_CLIENT_ID))
    throw new HttpError(503, 'ログイン連携を準備しています。', 'NOT_CONFIGURED');
  const actor = purpose === 'google' ? await actorFor(request, env, 'manage', fetcher) : null;
  await rateLimit(
    env.DB,
    `oauth:${purpose}:${request.headers.get('CF-Connecting-IP') || 'local'}`,
    purpose === 'discord' ? 60 : 15
  );
  const state = randomToken(),
    binder = randomToken(),
    remember = url.searchParams.get('remember') === '1';
  await env.DB.prepare(
    'INSERT INTO oauth_states(id_hash,binder_hash,purpose,destination,remember,session_hash,expires_at) VALUES(?,?,?,?,?,?,?)'
  )
    .bind(
      await sha256(state),
      await sha256(binder),
      purpose,
      destination,
      Number(remember),
      actor?.session.id_hash || null,
      epoch() + 600
    )
    .run();
  const target = new URL(
    purpose === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://discord.com/oauth2/authorize'
  );
  const params = {
    client_id: purpose === 'google' ? env.GOOGLE_CLIENT_ID : env.DISCORD_CLIENT_ID,
    redirect_uri: `${appOrigin(env)}/auth/${purpose}/callback`,
    response_type: 'code',
    state,
    scope:
      purpose === 'google' ? 'openid email https://www.googleapis.com/auth/drive.file' : 'identify guilds.members.read'
  };
  if (purpose === 'google') Object.assign(params, { access_type: 'offline', prompt: 'consent select_account' });
  target.search = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.href,
      'Set-Cookie': cookie(env, `oauth_${purpose}`, binder, 600),
      'Cache-Control': 'no-store'
    }
  });
}
export async function consumeOauth(request, env, purpose) {
  const url = new URL(request.url),
    state = url.searchParams.get('state');
  if (!state) throw new HttpError(400, '認証を最初からやり直してください。');
  const record = await env.DB.prepare('DELETE FROM oauth_states WHERE id_hash=? AND purpose=? RETURNING *')
    .bind(await sha256(state), purpose)
    .first();
  if (
    !record ||
    record.expires_at < epoch() ||
    !equal(record.binder_hash, await sha256(getCookie(request, env, `oauth_${purpose}`)))
  )
    throw new HttpError(400, '認証の有効期限が切れたか、ブラウザーが異なります。', 'OAUTH_STATE');
  if (url.searchParams.has('error') || !url.searchParams.get('code')) {
    const error = new HttpError(400, '認証がキャンセルされました。', 'OAUTH_CANCELLED');
    error.destination = record.destination;
    throw error;
  }
  return { record, code: url.searchParams.get('code') };
}
export async function discordCallback(request, env, fetcher = fetch) {
  const { record, code } = await consumeOauth(request, env, 'discord');
  try {
    const tokens = await discordToken(
      { grant_type: 'authorization_code', code, redirect_uri: `${appOrigin(env)}/auth/discord/callback` },
      env,
      fetcher
    );
    const member = await membership(
      tokens.access_token,
      record.destination === 'member' ? env.CUSTOMER_GUILD_ID : env.STAFF_GUILD_ID,
      fetcher
    );
    if (!member || (record.destination === 'manage' && !isAdmin(member, env)))
      throw new HttpError(403, '対象のDiscordサーバーへの参加・運営ロールを確認してください。', 'GUILD_REQUIRED');
    let user = member.user;
    if (!user?.id || !user.username) {
      const response = await discordFetch(
        `${DISCORD}/users/@me`,
        {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': USER_AGENT }
        },
        fetcher
      );
      if (!response.ok) throw new HttpError(503, 'Discordアカウントを確認できませんでした。');
      user = await response.json();
    }
    snowflake(user.id);
    const name = user.global_name || user.username,
      avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
    const token = randomToken(),
      ttl = record.remember ? 2592000 : 86400;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users(id,display_name,avatar_url,joined_as_customer,joined_as_staff,last_seen_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,avatar_url=excluded.avatar_url,
        joined_as_customer=MAX(users.joined_as_customer,excluded.joined_as_customer),
        joined_as_staff=MAX(users.joined_as_staff,excluded.joined_as_staff),last_seen_at=excluded.last_seen_at`
      ).bind(
        user.id,
        name,
        avatar,
        Number(record.destination === 'member'),
        Number(record.destination !== 'member'),
        nowIso()
      ),
      env.DB.prepare(
        'INSERT INTO sessions(id_hash,user_id,tokens,token_expires_at,expires_at,created_at) VALUES(?,?,?,?,?,?)'
      ).bind(
        await sha256(token),
        user.id,
        await seal(tokens, env.TOKEN_ENCRYPTION_KEY),
        epoch() + tokens.expires_in,
        epoch() + ttl,
        epoch()
      )
    ]);
    const headers = new Headers({ Location: `/${record.destination}`, 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookie(env, 'session', token, record.remember ? ttl : undefined));
    headers.append('Set-Cookie', cookie(env, 'oauth_discord', '', 0));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    error.destination = record.destination;
    throw error;
  }
}
export async function signOut(request, env) {
  const actor = { session: await sessionFor(request, env) };
  await requireMutation(request, actor, env);
  await env.DB.prepare('DELETE FROM sessions WHERE id_hash=?').bind(actor.session.id_hash).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie(env, 'session', '', 0),
      'Cache-Control': 'no-store'
    }
  });
}
