// /api/staff/* — members of the staff Discord server (casts and staff).
import { HttpError, text, httpsUrl, nowIso, bodyJson, formBody, rateLimit } from '../core.mjs';
import { attendanceTimes } from '../../public/schedule.mjs';
import { dutyOptions, dutyRoles } from '../duties.mjs';
import { vrchatStatus } from '../vrchat.mjs';
import { ensureStaffResources } from '../schema.mjs';
import { chekiCast, chekiAudience, sendChekiBatch } from '../cheki.mjs';
import { currentPlacement } from '../staff-resources.mjs';
import { readManualDocument } from '../manual-docs.mjs';
import {
  audit,
  eventFields,
  getSettings,
  id,
  imageStatement,
  json,
  profileFields,
  publishedManuals,
  rows,
  saveImage,
  sessionData,
  staffProfile
} from './shared.mjs';
import { vrchatRoute } from './vrchat.mjs';

const castLinkRequired = () =>
  new HttpError(403, '運営にキャスト紹介の登録とDiscordアカウントの紐付けを依頼してください。', 'CAST_LINK_REQUIRED');
const castLinkChanged = () => new HttpError(409, 'キャスト紹介の紐付けが変わりました。画面を読み込み直してください。');

async function overview({ env, actor }) {
  await ensureStaffResources(env);
  const [events, attendance, manuals, assignments, sent] = await Promise.all([
    rows(
      env.DB.prepare(
        `SELECT ${eventFields} FROM events WHERE deleted_at IS NULL AND ends_at>? ORDER BY starts_at LIMIT 60`
      ).bind(new Date(Date.now() - 86400000).toISOString())
    ),
    rows(env.DB.prepare('SELECT * FROM attendance WHERE user_id=?').bind(actor.id)),
    publishedManuals(env),
    rows(
      env.DB.prepare(
        'SELECT a.event_id,a.details,e.title FROM assignments a JOIN events e ON e.id=a.event_id WHERE a.user_id=? AND a.published=1 AND e.deleted_at IS NULL ORDER BY e.starts_at DESC LIMIT 20'
      ).bind(actor.id)
    ),
    rows(
      env.DB.prepare(
        "SELECT c.id,c.message,c.created_at,c.withdrawn,e.title AS event_title,1 AS recipient_count FROM cheki c LEFT JOIN events e ON e.id=c.event_id WHERE c.sender_id=? AND c.deleted_at IS NULL UNION ALL SELECT b.id,b.message,b.created_at,b.withdrawn,e.title,(SELECT count(*) FROM cheki_deliveries WHERE batch_id=b.id) FROM cheki_batches b JOIN events e ON e.id=b.event_id WHERE b.sender_id=? AND b.state='sent' AND b.deleted_at IS NULL ORDER BY 3 DESC LIMIT 30"
      ).bind(actor.id, actor.id)
    )
  ]);
  return json({
    session: await sessionData(actor, env),
    events,
    attendance,
    manuals,
    assignments,
    sent,
    profile: await staffProfile(actor.id, env),
    cheki_cast: await chekiCast(actor.id, env),
    duty_options: dutyOptions(actor.member, env),
    vrchat: await vrchatStatus(actor.id, env)
  });
}

async function placement({ env }) {
  await ensureStaffResources(env);
  return json(await currentPlacement(env));
}

async function manuals({ env }) {
  await ensureStaffResources(env);
  return json({ manuals: await publishedManuals(env) });
}

async function manualDocument({ env, fetcher, match }) {
  await ensureStaffResources(env);
  const source = await env.DB.prepare(
    `SELECT d.url FROM manual_google_docs d JOIN content c ON c.id=d.content_id
      WHERE c.id=? AND c.kind='manual' AND c.status='published' AND d.inline_body=1`
  )
    .bind(match[1])
    .first();
  if (!source) throw new HttpError(404, '公開中のマニュアル本文が見つかりません。');
  return json(await readManualDocument(source.url, env, fetcher));
}

async function saveProfile({ request, env, actor }) {
  const data = await bodyJson(request),
    allowed = new Set(['cast_id', 'tagline', 'bio', 'x_url', 'youtube_url', 'image_id']);
  if (Object.keys(data).some(key => !allowed.has(key)))
    throw new HttpError(400, '変更できるのは、紹介写真・ひとこと・プロフィール・X・YouTubeです。');
  const current = await staffProfile(actor.id, env);
  if (!current) throw castLinkRequired();
  if (data.cast_id !== current.id) throw castLinkChanged();
  if (Object.hasOwn(data, 'image_id') && data.image_id !== null && typeof data.image_id !== 'string')
    throw new HttpError(400, '紹介写真を選び直してください。');
  const imageId = Object.hasOwn(data, 'image_id') ? (data.image_id ? id(data.image_id) : null) : current.image_id;
  if (
    imageId &&
    imageId !== current.image_id &&
    !(await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public' AND uploaded_by=?")
      .bind(imageId, actor.id)
      .first())
  )
    throw new HttpError(400, '本人がアップロードした紹介写真を選んでください。');
  const values = [
    text(data.tagline, 120),
    text(data.bio, 3000),
    httpsUrl(text(data.x_url, 2048)),
    httpsUrl(text(data.youtube_url, 2048))
  ];
  const updated = await env.DB.prepare(
    `UPDATE casts SET tagline=?,bio=?,x_url=?,youtube_url=?,image_id=? WHERE id=? AND user_id=? RETURNING ${profileFields}`
  )
    .bind(...values, imageId, current.id, actor.id)
    .first();
  if (!updated) throw castLinkChanged();
  await audit(env, actor, 'cast.self.update', current.id);
  return json({ ok: true, profile: updated });
}

async function uploadProfileImage({ request, env, fetcher, actor }) {
  const current = await staffProfile(actor.id, env);
  if (!current) throw castLinkRequired();
  await rateLimit(env.DB, `upload:${actor.id}`, 60, 3600);
  if (Number(request.headers.get('Content-Length')) > 4500000)
    throw new HttpError(413, '画像は4MB以下にしてください。');
  const form = await formBody(request),
    file = form.get('image');
  if (form.get('cast_id') !== current.id) throw castLinkChanged();
  if (!(file instanceof File) || file.size > 4 * 1024 * 1024)
    throw new HttpError(400, '4MB以下の画像を選んでください。');
  const image = await saveImage(new Uint8Array(await file.arrayBuffer()), file.type, 'public', actor, env, fetcher);
  await imageStatement(env, image).run();
  return json({ id: image.id, url: `/api/images/${image.id}` });
}

async function recipients({ env, actor, url }) {
  const audience = await chekiAudience(actor.id, url.searchParams.get('event_id'), env);
  return json({
    cast: audience.cast,
    event: audience.event,
    count: audience.count,
    audience_hash: audience.audience_hash
  });
}

async function saveAttendance({ request, env, actor }) {
  const data = await bodyJson(request),
    eventId = id(data.event_id),
    event = await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(eventId).first();
  if (
    !event ||
    event.deleted_at ||
    Date.parse(event.ends_at) < Date.now() ||
    (event.response_deadline && Date.parse(event.response_deadline) < Date.now())
  )
    throw new HttpError(403, '回答期限を過ぎています。運営へ連絡してください。');
  if (!['yes', 'no', 'maybe'].includes(data.answer)) throw new HttpError(400, '出欠を選んでください。');
  const statusOnly = data.status_only === true;
  let from,
    until,
    duties = '[]',
    note = '';
  if (statusOnly) {
    const defaults = attendanceTimes(null, event, (await getSettings(env)).regular_hours);
    from = defaults.available_from;
    until = defaults.available_until;
  } else {
    const names = dutyRoles.map(duty => duty.name);
    if (!Array.isArray(data.duties) || data.duties.some(duty => !names.includes(duty)))
      throw new HttpError(400, '担当を確認してください。');
    const allowed = new Set(
      dutyOptions(actor.member, env)
        .filter(duty => duty.available)
        .map(duty => duty.name)
    );
    if (data.duties.some(duty => !allowed.has(duty)))
      throw new HttpError(
        403,
        '現在のDiscordロールで選べない担当が含まれています。画面を読み込み直してください。',
        'DUTY_ROLE_REQUIRED'
      );
    from = text(data.available_from || '', 5);
    until = text(data.available_until || '', 5);
    if ([from, until].some(time => time && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)))
      throw new HttpError(400, '参加できる時間を確認してください。');
    duties = JSON.stringify([...new Set(data.duties)]);
    note = text(data.note || '', 1000);
  }
  const stamp = nowIso();
  const details = statusOnly
    ? ''
    : ',available_from=excluded.available_from,available_until=excluded.available_until,duties=excluded.duties,note=excluded.note';
  const saved = await env.DB.prepare(
    `INSERT INTO attendance(event_id,user_id,answer,available_from,available_until,duties,note,updated_at)
      SELECT ?,?,?,?,?,?,?,? FROM events WHERE id=? AND deleted_at IS NULL AND ends_at>=? AND (response_deadline IS NULL OR response_deadline>=?)
      ON CONFLICT(event_id,user_id) DO UPDATE SET answer=excluded.answer,updated_at=excluded.updated_at${details}
      RETURNING event_id,answer,available_from,available_until,duties,note,updated_at`
  )
    .bind(eventId, actor.id, data.answer, from, until, duties, note, stamp, eventId, stamp, stamp)
    .first();
  if (!saved) throw new HttpError(409, '営業日の受付状態が変更されました。画面を読み込み直してください。');
  return json({ ok: true, attendance: saved });
}

async function sendCheki({ request, env, fetcher, actor }) {
  return json(await sendChekiBatch(request, actor, env, fetcher));
}

async function withdrawCheki({ request, env, actor }) {
  const data = await bodyJson(request),
    chekiId = id(data.id);
  await env.DB.batch([
    env.DB.prepare('UPDATE cheki SET withdrawn=1 WHERE id=? AND sender_id=?').bind(chekiId, actor.id),
    env.DB.prepare("UPDATE cheki_batches SET withdrawn=1 WHERE id=? AND sender_id=? AND state='sent'").bind(
      chekiId,
      actor.id
    )
  ]);
  await audit(env, actor, 'cheki.withdraw', chekiId);
  return json({ ok: true });
}

export const staffRoutes = [
  vrchatRoute,
  ['GET', '/api/staff', overview],
  ['GET', '/api/staff/placement', placement],
  ['GET', '/api/staff/manuals', manuals],
  ['GET', /^\/api\/staff\/manuals\/([\w-]{1,100})\/document$/, manualDocument],
  ['POST', '/api/staff/profile', saveProfile],
  ['POST', '/api/staff/profile/image', uploadProfileImage],
  ['GET', '/api/staff/recipients', recipients],
  ['POST', '/api/staff/attendance', saveAttendance],
  ['POST', '/api/staff/cheki', sendCheki],
  ['POST', '/api/staff/cheki/withdraw', withdrawCheki]
];
