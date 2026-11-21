// Routes that do not belong to a signed-in area. Some still check the session
// themselves (session info and image access).
import { HttpError, nowIso } from '../core.mjs';
import { actorFor, sessionFor } from '../auth.mjs';
import { downloadDrive } from '../drive.mjs';
import { contentFields, getSettings, id, json, publishedEvents, rows, sessionData } from './shared.mjs';

async function schedule({ env }) {
  return json({
    events: await rows(
      env.DB.prepare(
        'SELECT id,title,description,category,starts_at,ends_at FROM events WHERE deleted_at IS NULL AND published=1 AND ends_at>=? ORDER BY starts_at,id'
      ).bind(nowIso())
    )
  });
}

async function publicData({ env }) {
  const [settings, events, casts, content] = await Promise.all([
    getSettings(env),
    publishedEvents(env),
    rows(
      env.DB.prepare(
        'SELECT id,display_name,tagline,bio,image_id,x_url,youtube_url FROM casts WHERE active=1 ORDER BY sort_order,display_name'
      )
    ),
    rows(
      env.DB.prepare(
        `SELECT ${contentFields} FROM content WHERE kind IN ('news','page') AND status='published' ORDER BY published_at DESC LIMIT 100`
      )
    )
  ]);
  return json({ settings, events, casts, content });
}

async function session({ request, env, fetcher, url }) {
  const area = url.searchParams.get('area');
  if (!['member', 'staff', 'manage'].includes(area)) throw new HttpError(400, 'ページを確認してください。');
  const actor = await actorFor(request, env, area, fetcher);
  return json(await sessionData(actor, env));
}

// Public images are served anonymously only while something published uses them.
// The list of places below must cover every image field in site settings.
const publicImageUse =
  "SELECT id FROM casts WHERE active=1 AND image_id=? UNION ALL SELECT id FROM content WHERE kind IN ('news','page') AND status='published' AND instr(body,?)>0 UNION ALL SELECT key AS id FROM settings WHERE key='site' AND json_extract(value,'$.hero_image')=? UNION ALL SELECT settings.key AS id FROM settings, json_each(settings.value,'$.hero_images') AS hero WHERE settings.key='site' AND json_valid(settings.value) AND json_type(settings.value,'$.hero_images')='array' AND hero.value=? UNION ALL SELECT settings.key AS id FROM settings, json_each(settings.value,'$.programs') AS card WHERE settings.key='site' AND json_extract(card.value,'$.image')=? UNION ALL SELECT settings.key AS id FROM settings, json_each(settings.value,'$.facilities') AS card WHERE settings.key='site' AND json_extract(card.value,'$.image')=? UNION ALL SELECT key AS id FROM settings WHERE key='site' AND json_extract(value,'$.recruit_page.image')=? UNION ALL SELECT key AS id FROM settings WHERE key='site' AND json_extract(value,'$.share_image')=? LIMIT 1";

async function image({ request, env, fetcher, path }) {
  const imageId = id(path.split('/').pop()),
    image = await env.DB.prepare('SELECT * FROM images WHERE id=?').bind(imageId).first();
  if (!image) throw new HttpError(404, '画像が見つかりません。');
  let allowed = false;
  if (image.visibility === 'public') {
    const used = await env.DB.prepare(publicImageUse)
      .bind(imageId, `/api/images/${imageId}`, imageId, imageId, imageId, imageId, imageId, imageId)
      .first();
    allowed = !!used;
    if (!allowed) {
      const manual = await env.DB.prepare(
        "SELECT id FROM content WHERE kind='manual' AND status='published' AND instr(body,?)>0 LIMIT 1"
      )
        .bind(`/api/images/${imageId}`)
        .first();
      const session = await sessionFor(request, env);
      const ownCast = await env.DB.prepare('SELECT id FROM casts WHERE user_id=? AND (image_id=? OR ?=1)')
        .bind(session.user_id, imageId, Number(image.uploaded_by === session.user_id))
        .first();
      const actor = await actorFor(request, env, manual || ownCast ? 'staff' : 'manage', fetcher);
      allowed = !!manual || !!ownCast || actor.admin;
    }
  } else {
    const session = await sessionFor(request, env);
    const cheki = await env.DB.prepare(
      "SELECT sender_id,recipient_id,withdrawn,deleted_at FROM cheki WHERE image_id=? AND (recipient_id=? OR sender_id=?) UNION ALL SELECT b.sender_id,d.recipient_id,b.withdrawn,b.deleted_at FROM cheki_batches b LEFT JOIN cheki_deliveries d ON d.batch_id=b.id WHERE b.image_id=? AND b.state='sent' AND (d.recipient_id=? OR b.sender_id=?) LIMIT 1"
    )
      .bind(imageId, session.user_id, session.user_id, imageId, session.user_id, session.user_id)
      .first();
    if (cheki && !cheki.withdrawn && !cheki.deleted_at) {
      if (session.user_id === cheki.recipient_id) {
        try {
          await actorFor(request, env, 'member', fetcher);
          allowed = true;
        } catch (error) {
          if (error.status !== 403 || session.user_id !== cheki.sender_id) throw error;
        }
      }
      if (!allowed && session.user_id === cheki.sender_id) {
        await actorFor(request, env, 'staff', fetcher);
        allowed = true;
      }
    }
  }
  if (!allowed) throw new HttpError(403, 'このチェキを閲覧する権限がありません。');
  return new Response(await downloadDrive(image.drive_id, env, fetcher), {
    headers: {
      'Content-Type': image.mime,
      'Content-Length': String(image.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline'
    }
  });
}

export const publicRoutes = [
  ['GET', '/api/schedule', schedule],
  ['GET', '/api/public', publicData],
  ['GET', '/api/session', session],
  ['GET', /^\/api\/images\//, image]
];
