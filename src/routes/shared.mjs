import { HttpError, nowIso, imageType } from '../core.mjs';
import { csrfFor } from '../auth.mjs';
import { uploadDrive } from '../drive.mjs';

export const eventFields =
  'id,title,description,category,starts_at,ends_at,response_deadline,published,checkin_opens_at,checkin_closes_at';
export const contentFields = 'id,kind,slug,title,excerpt,body,status,published_at,updated_at';
export const staffContentFields =
  contentFields +
  ', (SELECT url FROM manual_google_docs WHERE content_id=content.id) AS google_doc_url, (SELECT inline_body FROM manual_google_docs WHERE content_id=content.id) AS google_doc_inline';
export const profileFields = 'id,display_name,tagline,bio,x_url,youtube_url,active,image_id';

export const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export const rows = async statement => (await statement.all()).results;
export const publishedEvents = (env, fields = eventFields) =>
  rows(
    env.DB.prepare(
      `SELECT ${fields} FROM events WHERE deleted_at IS NULL AND published=1 ORDER BY starts_at DESC LIMIT 60`
    )
  );
export const publishedManuals = env =>
  rows(
    env.DB.prepare(
      `SELECT ${staffContentFields}, (
        SELECT m.html FROM manual_google_docs d JOIN manual_document_cache m ON m.content_id=d.content_id
        WHERE d.content_id=content.id AND d.inline_body=1
          AND NOT EXISTS (SELECT 1 FROM manual_document_parts p WHERE p.content_id=d.content_id)
      ) AS google_doc_html
      FROM content WHERE kind='manual' AND status='published' ORDER BY title`
    )
  );
export const sessionData = async (actor, env) => ({
  user: { id: actor.id, name: actor.name, avatar: actor.avatar },
  admin: actor.admin,
  csrf: await csrfFor(actor, env)
});
export const getSettings = async env =>
  JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key='site'").first())?.value || '{}');
export const staffProfile = (user, env) =>
  env.DB.prepare(`SELECT ${profileFields} FROM casts WHERE user_id=?`).bind(user).first();

export function bool(value) {
  if (typeof value !== 'boolean') throw new HttpError(400, '公開状態を確認してください。');
  return Number(value);
}
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new HttpError(400, 'IDを確認してください。');
  return value;
}
export async function audit(env, actor, action, resource) {
  await env.DB.prepare('INSERT INTO audit_log(id,actor_id,action,resource_id,created_at) VALUES(?,?,?,?,?)')
    .bind(crypto.randomUUID(), actor.id, action, resource, nowIso())
    .run();
}
export async function saveImage(bytes, mime, visibility, actor, env, fetcher) {
  if (bytes.length > 4 * 1024 * 1024 || bytes.length < 12) throw new HttpError(413, '画像は4MB以下にしてください。');
  if (imageType(bytes) !== mime) throw new HttpError(400, '画像の形式が一致しません。');
  const imageId = crypto.randomUUID(),
    driveId = await uploadDrive(bytes, mime, imageId, env, fetcher);
  return {
    id: imageId,
    drive_id: driveId,
    mime,
    size: bytes.length,
    visibility,
    uploaded_by: actor.id,
    created_at: nowIso()
  };
}
export function imageStatement(env, image) {
  return env.DB.prepare(
    'INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)'
  ).bind(image.id, image.drive_id, image.mime, image.size, image.visibility, image.uploaded_by, image.created_at);
}

/**
 * Route tables are arrays of [method(s), path, handler]. `path` is an exact
 * string or a RegExp; a RegExp match is passed to the handler as `ctx.match`.
 * The first matching entry wins.
 */
export function findRoute(routes, method, path) {
  for (const [methods, pattern, handler] of routes) {
    if (!(Array.isArray(methods) ? methods : [methods]).includes(method)) continue;
    if (typeof pattern === 'string') {
      if (pattern === path) return { handler, match: null };
    } else {
      const match = pattern.exec(path);
      if (match) return { handler, match };
    }
  }
  return null;
}
