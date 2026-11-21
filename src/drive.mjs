import { HttpError, seal, unseal, text, nowIso, limitedBytes } from './core.mjs';
import { appOrigin, actorFor, consumeOauth, cookie } from './auth.mjs';
const accessCache = new Map();
export async function driveStatus(env) {
  const row = await env.DB.prepare("SELECT value FROM integrations WHERE key='drive'").first();
  if (!row) return { connected: false };
  const integration = await unseal(row.value, env.TOKEN_ENCRYPTION_KEY);
  return { connected: true, email: integration.email || '', connected_at: integration.connected_at };
}
export async function googleCallback(request, env, fetcher = fetch) {
  const actor = await actorFor(request, env, 'manage', fetcher),
    { record, code } = await consumeOauth(request, env, 'google');
  if (record.session_hash !== actor.session.id_hash)
    throw new HttpError(403, '連携を開始した運営アカウントでやり直してください。');
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: `${appOrigin(env)}/auth/google/callback`
    })
  });
  if (!response.ok) throw new HttpError(503, 'Google Driveとの連携に失敗しました。');
  const tokens = await response.json();
  if (!tokens.refresh_token || !tokens.scope?.includes('drive.file'))
    throw new HttpError(400, 'Driveのファイル保存を許可して、もう一度連携してください。');
  const profileResponse = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  });
  if (!profileResponse.ok) throw new HttpError(503, '保存先のGoogleアカウントを確認できませんでした。');
  const profile = await profileResponse.json();
  if (env.GOOGLE_OWNER_EMAIL && profile.email?.toLowerCase() !== env.GOOGLE_OWNER_EMAIL.toLowerCase())
    throw new HttpError(403, 'イベント用のGoogleアカウントを選択してください。');
  const existing = await env.DB.prepare("SELECT value FROM integrations WHERE key='drive'").first();
  let folderId;
  if (existing) {
    const old = await unseal(existing.value, env.TOKEN_ENCRYPTION_KEY);
    if (old.google_id !== profile.sub)
      throw new HttpError(409, '保存済み画像を守るため、同じGoogleアカウントで連携してください。');
    folderId = old.folder_id;
  }
  if (!folderId) {
    const folder = await fetcher('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Nocturne Planet — HP画像保管',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { app: 'nocturne-planet' }
      })
    });
    if (!folder.ok) throw new HttpError(503, 'Driveに保存用フォルダを作成できませんでした。');
    folderId = (await folder.json()).id;
  }
  const integration = {
    folder_id: folderId,
    refresh_token: tokens.refresh_token,
    email: profile.email,
    google_id: profile.sub,
    connected_at: nowIso()
  };
  await env.DB.prepare(
    "INSERT INTO integrations(key,value) VALUES('drive',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  )
    .bind(await seal(integration, env.TOKEN_ENCRYPTION_KEY))
    .run();
  accessCache.clear();
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/manage?drive=connected',
      'Set-Cookie': cookie(env, 'oauth_google', '', 0),
      'Cache-Control': 'no-store'
    }
  });
}
async function driveAccess(env, fetcher) {
  const integrationValue = (await env.DB.prepare("SELECT value FROM integrations WHERE key='drive'").first())?.value;
  if (!integrationValue) throw new HttpError(503, '運営によるGoogle Driveの連携が必要です。', 'DRIVE_NOT_CONNECTED');
  const integration = await unseal(integrationValue, env.TOKEN_ENCRYPTION_KEY),
    cached = accessCache.get(integrationValue);
  if (cached?.expires > Date.now() + 30000) return { ...integration, access_token: cached.token };
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: integration.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  if (!response.ok) throw new HttpError(503, 'Google Driveの連携を運営に確認してください。', 'DRIVE_AUTH');
  const token = await response.json();
  accessCache.set(integrationValue, { token: token.access_token, expires: Date.now() + token.expires_in * 1000 });
  return { ...integration, access_token: token.access_token };
}
export async function uploadDrive(bytes, mime, id, env, fetcher = fetch) {
  const access = await driveAccess(env, fetcher),
    boundary = `np_${crypto.randomUUID()}`;
  const metadata = {
    name: `${id}.${mime.split('/')[1]}`,
    parents: [access.folder_id],
    appProperties: { app: 'nocturne-planet', image_id: id }
  };
  const payload = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`
  ]);
  const response = await fetcher('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access.access_token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: payload
  });
  if (!response.ok)
    throw new HttpError(503, '画像を保存できませんでした。空き容量と連携状態を確認してください。', 'DRIVE_UPLOAD');
  return text((await response.json()).id, 200, true);
}
export async function downloadDrive(id, env, fetcher = fetch) {
  const access = await driveAccess(env, fetcher);
  const response = await fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
    headers: { Authorization: `Bearer ${access.access_token}` }
  });
  if (!response.ok)
    throw new HttpError(response.status === 404 ? 404 : 503, '画像を取得できませんでした。', 'DRIVE_DOWNLOAD');
  return response.body;
}
export async function discardDrive(id, env, fetcher = fetch) {
  const access = await driveAccess(env, fetcher);
  const response = await fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${access.access_token}` }
  });
  if (!response.ok && response.status !== 404) throw new HttpError(503, '未送信画像を整理できませんでした。');
}

export async function createDriveDocument(title, env, fetcher = fetch) {
  const access = await driveAccess(env, fetcher);
  const response = await fetcher('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title,
      mimeType: 'application/vnd.google-apps.document',
      appProperties: { app: 'nocturne-planet', purpose: 'staff-manual' }
    })
  });
  if (!response.ok) throw new HttpError(503, 'Google ドキュメントを作成できませんでした。', 'MANUAL_CREATE');
  const { id } = await response.json();
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id))
    throw new HttpError(503, '作成したドキュメントのリンクを取得できませんでした。', 'MANUAL_CREATE');
  return `https://docs.google.com/document/d/${id}/edit`;
}

export async function exportDriveDocument(documentId, env, fetcher = fetch) {
  const access = await driveAccess(env, fetcher);
  const response = await fetcher(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}/export?mimeType=text%2Fmarkdown`,
    {
      headers: { Authorization: `Bearer ${access.access_token}` },
      redirect: 'manual'
    }
  );
  if (response.status === 403 || response.status === 404) {
    throw new HttpError(
      409,
      'この文書を連携先の Google Drive から読み取れません。運営画面の「Google ドキュメントを作成」で作った文書を使えます。',
      'MANUAL_DRIVE_ACCESS'
    );
  }
  if (!response.ok) throw new HttpError(503, 'Google ドキュメントの本文を取得できませんでした。', 'MANUAL_EXPORT');
  try {
    return new TextDecoder().decode(await limitedBytes(response, 2 * 1024 * 1024));
  } catch (error) {
    if (error.status === 413) throw new HttpError(413, 'Google ドキュメントの本文が大きすぎます。', 'MANUAL_TOO_LARGE');
    throw error;
  }
}
