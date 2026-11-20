// /api/manage/* — holders of the organizer role on the staff Discord server.
import {
  HttpError,
  text,
  httpsUrl,
  iso,
  nowIso,
  bodyJson,
  formBody,
  randomToken,
  passphraseHash,
  rateLimit,
  snowflake
} from '../core.mjs';
import { driveStatus, createDriveDocument } from '../drive.mjs';
import { validateRegularHours } from '../../public/schedule.mjs';
import { siteSettingsPatch } from '../site-settings.mjs';
import { manageRecords } from '../manage-records.mjs';
import { ensureStaffResources } from '../schema.mjs';
import { syncStaffDirectory, staffUsers, isStaffCandidate } from '../staff-directory.mjs';
import { rosterFor } from '../reminders.mjs';
import { googleDocUrl, placementForEvent, savePlacement } from '../staff-resources.mjs';
import { readManualDocument } from '../manual-docs.mjs';
import {
  audit,
  bool,
  eventFields,
  getSettings,
  id,
  imageStatement,
  json,
  rows,
  saveImage,
  sessionData,
  staffContentFields
} from './shared.mjs';

async function records({ request, env, actor, url, path, method }) {
  return json(await manageRecords(path, method, url, request, actor, env));
}

async function overview({ request, env, fetcher, actor, url }) {
  await ensureStaffResources(env);
  const directory = await syncStaffDirectory(env, fetcher);
  const [settings, events, casts, content, attendance, users, assignments, drive, eventRecords, chekiRecords] =
    await Promise.all([
      getSettings(env),
      rows(
        env.DB.prepare(`SELECT ${eventFields} FROM events WHERE deleted_at IS NULL ORDER BY starts_at DESC LIMIT 100`)
      ),
      rows(env.DB.prepare('SELECT * FROM casts ORDER BY sort_order,display_name')),
      rows(env.DB.prepare(`SELECT ${staffContentFields} FROM content ORDER BY updated_at DESC LIMIT 200`)),
      rows(
        env.DB.prepare(
          'SELECT a.*,u.display_name FROM attendance a JOIN users u ON u.id=a.user_id JOIN events e ON e.id=a.event_id WHERE e.deleted_at IS NULL AND e.ends_at>? ORDER BY e.starts_at,u.display_name'
        ).bind(new Date(Date.now() - 30 * 86400000).toISOString())
      ),
      staffUsers(env),
      rows(
        env.DB.prepare(
          'SELECT a.* FROM assignments a JOIN events e ON e.id=a.event_id WHERE e.deleted_at IS NULL LIMIT 1000'
        )
      ),
      driveStatus(env),
      manageRecords('/api/manage/events', 'GET', new URL('/api/manage/events', url), request, actor, env),
      manageRecords('/api/manage/cheki', 'GET', new URL('/api/manage/cheki', url), request, actor, env)
    ]);
  return json({
    session: await sessionData(actor, env),
    settings,
    events,
    casts,
    content,
    attendance,
    users,
    assignments,
    drive,
    directory,
    record_lists: { events: eventRecords, cheki: chekiRecords },
    roster: await rosterFor(env),
    reminders_ready: !!env.DISCORD_BOT_TOKEN && !!env.CRON_SECRET
  });
}

async function staffSync({ env, fetcher, actor }) {
  await rateLimit(env.DB, 'staff-sync', 6, 60);
  const directory = await syncStaffDirectory(env, fetcher, { force: true });
  if (!directory.configured)
    throw new HttpError(503, 'Discord Botのトークンが設定されていません。', 'BOT_NOT_CONFIGURED');
  await audit(env, actor, 'staff.sync', 'staff_directory');
  return json({ directory, users: await staffUsers(env) });
}

async function saveSchedule({ request, env, actor }) {
  const data = await bodyJson(request);
  let regularHours;
  try {
    regularHours = validateRegularHours(data.regular_hours);
  } catch (error) {
    throw new HttpError(400, error.message);
  }
  await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.regular_hours',json(?)) WHERE key='site'")
    .bind(JSON.stringify(regularHours))
    .run();
  await audit(env, actor, 'schedule.save', 'site');
  return json({ ok: true, regular_hours: regularHours });
}

async function saveSettings({ request, env, actor }) {
  const settings = await siteSettingsPatch(await bodyJson(request), env);
  await env.DB.prepare("UPDATE settings SET value=json_patch(value,?) WHERE key='site'")
    .bind(JSON.stringify(settings))
    .run();
  await audit(env, actor, 'settings.save', 'site');
  return json({ ok: true });
}

async function saveEvent({ request, env, actor }) {
  const data = await bodyJson(request),
    eventId = data.id ? id(data.id) : crypto.randomUUID(),
    starts = iso(data.starts_at),
    ends = iso(data.ends_at),
    deadline = iso(data.response_deadline, true),
    opens = iso(data.checkin_opens_at, true),
    closes = iso(data.checkin_closes_at, true);
  if (ends <= starts || (opens && closes && closes <= opens))
    throw new HttpError(400, '終了は開始より後の時刻にしてください。');
  let salt = null,
    hash = null;
  const existing = await env.DB.prepare('SELECT checkin_salt,checkin_hash,category,deleted_at FROM events WHERE id=?')
    .bind(eventId)
    .first();
  if (existing?.deleted_at) throw new HttpError(409, '削除済みの営業日です。ごみ箱から復元してください。');
  const category = data.category === undefined ? existing?.category || '通常営業' : text(data.category, 24, true);
  if (data.passphrase) {
    const phrase = text(data.passphrase, 80, true);
    if (phrase.length < 4) throw new HttpError(400, '合言葉は4文字以上にしてください。');
    salt = randomToken();
    hash = await passphraseHash(eventId, salt, phrase, env.CHECKIN_PEPPER);
  } else if (existing) {
    salt = existing.checkin_salt;
    hash = existing.checkin_hash;
  }
  if (data.disable_checkin) {
    salt = null;
    hash = null;
  }
  const saved = await env.DB.prepare(
    'INSERT INTO events(id,title,description,category,starts_at,ends_at,response_deadline,published,checkin_opens_at,checkin_closes_at,checkin_salt,checkin_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,category=excluded.category,starts_at=excluded.starts_at,ends_at=excluded.ends_at,response_deadline=excluded.response_deadline,published=excluded.published,checkin_opens_at=excluded.checkin_opens_at,checkin_closes_at=excluded.checkin_closes_at,checkin_salt=excluded.checkin_salt,checkin_hash=excluded.checkin_hash,updated_at=excluded.updated_at WHERE events.deleted_at IS NULL'
  )
    .bind(
      eventId,
      text(data.title, 160, true),
      text(data.description || '', 4000),
      category,
      starts,
      ends,
      deadline,
      bool(data.published),
      opens,
      closes,
      salt,
      hash,
      nowIso(),
      nowIso()
    )
    .run();
  if (!saved.meta.changes) throw new HttpError(409, '削除済みの営業日です。ごみ箱から復元してください。');
  await audit(env, actor, 'event.save', eventId);
  return json({ ok: true, id: eventId });
}

async function createManualDocument({ request, env, fetcher }) {
  const data = await bodyJson(request);
  return json({ url: await createDriveDocument(text(data.title, 160, true), env, fetcher) });
}

async function previewManualDocument({ request, env, fetcher }) {
  const data = await bodyJson(request);
  return json(await readManualDocument(data.url, env, fetcher));
}

async function saveContent({ request, env, fetcher, actor }) {
  const data = await bodyJson(request),
    contentId = data.id ? id(data.id) : crypto.randomUUID(),
    slug = text(data.slug, 100, true);
  if (
    !['news', 'page', 'manual'].includes(data.kind) ||
    !['draft', 'published', 'archived'].includes(data.status) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  )
    throw new HttpError(400, '記事の種類・状態・URL名を確認してください。');
  const existing = await env.DB.prepare('SELECT published_at FROM content WHERE id=?').bind(contentId).first();
  await ensureStaffResources(env);
  const statements = [
    env.DB.prepare(
      'INSERT INTO content(id,kind,slug,title,excerpt,body,status,published_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,slug=excluded.slug,title=excluded.title,excerpt=excluded.excerpt,body=excluded.body,status=excluded.status,published_at=excluded.published_at,updated_at=excluded.updated_at,updated_by=excluded.updated_by'
    ).bind(
      contentId,
      data.kind,
      slug,
      text(data.title, 160, true),
      text(data.excerpt || '', 500),
      text(data.body || '', 60000),
      data.status,
      data.status === 'published' ? existing?.published_at || nowIso() : existing?.published_at || null,
      nowIso(),
      actor.id
    )
  ];
  if (data.kind !== 'manual' || Object.hasOwn(data, 'google_doc_url') || Object.hasOwn(data, 'google_doc_inline')) {
    const previous =
      data.kind === 'manual'
        ? await env.DB.prepare('SELECT url,inline_body FROM manual_google_docs WHERE content_id=?')
            .bind(contentId)
            .first()
        : null;
    const docUrl = data.kind === 'manual' ? googleDocUrl(data.google_doc_url ?? previous?.url ?? '') : '';
    const inlineBody =
      data.kind === 'manual' && data.google_doc_inline !== undefined
        ? bool(data.google_doc_inline)
        : Number(!!docUrl && docUrl === previous?.url && previous.inline_body === 1);
    if (inlineBody && !docUrl)
      throw new HttpError(400, '本文を表示する Google ドキュメントのリンクを入力してください。');
    if (inlineBody && data.status === 'published') await readManualDocument(docUrl, env, fetcher);
    statements.push(
      docUrl
        ? env.DB.prepare(
            'INSERT INTO manual_google_docs(content_id,url,inline_body) VALUES(?,?,?) ON CONFLICT(content_id) DO UPDATE SET url=excluded.url,inline_body=excluded.inline_body'
          ).bind(contentId, docUrl, inlineBody)
        : env.DB.prepare('DELETE FROM manual_google_docs WHERE content_id=?').bind(contentId)
    );
  }
  await env.DB.batch(statements);
  await audit(env, actor, 'content.' + data.status, contentId);
  return json({ ok: true, id: contentId });
}

async function saveCast({ request, env, actor }) {
  const data = await bodyJson(request),
    castId = data.id ? id(data.id) : crypto.randomUUID(),
    imageId = data.image_id ? id(data.image_id) : null;
  const existingCast = await env.DB.prepare('SELECT user_id FROM casts WHERE id=?').bind(castId).first();
  const castUser = Object.hasOwn(data, 'user_id')
    ? data.user_id
      ? snowflake(data.user_id)
      : null
    : existingCast?.user_id || null;
  if (castUser && !(await isStaffCandidate(castUser, env)))
    throw new HttpError(400, '運営用Discordサーバーにいる本人のアカウントを選んでください。');
  if (
    castUser &&
    (await env.DB.prepare('SELECT id FROM casts WHERE user_id=? AND id<>?').bind(castUser, castId).first())
  )
    throw new HttpError(409, 'このDiscordアカウントは別のキャスト紹介に紐付いています。');
  if (
    imageId &&
    !(await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public'").bind(imageId).first())
  )
    throw new HttpError(400, '公開用画像を選んでください。');
  const sort = Number(data.sort_order || 0);
  if (!Number.isSafeInteger(sort) || Math.abs(sort) > 10000) throw new HttpError(400, '表示順を確認してください。');
  try {
    await env.DB.prepare(
      'INSERT INTO casts(id,display_name,tagline,bio,image_id,x_url,youtube_url,sort_order,active,user_id) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,tagline=excluded.tagline,bio=excluded.bio,image_id=excluded.image_id,x_url=excluded.x_url,youtube_url=excluded.youtube_url,sort_order=excluded.sort_order,active=excluded.active,user_id=excluded.user_id'
    )
      .bind(
        castId,
        text(data.display_name, 80, true),
        text(data.tagline || '', 120),
        text(data.bio || '', 3000),
        imageId,
        httpsUrl(data.x_url || ''),
        httpsUrl(data.youtube_url || ''),
        sort,
        bool(data.active),
        castUser
      )
      .run();
  } catch (error) {
    if (/UNIQUE constraint failed: casts.user_id/.test(error.message))
      throw new HttpError(409, 'このDiscordアカウントは別のキャスト紹介に紐付いています。');
    throw error;
  }
  await audit(env, actor, 'cast.save', castId);
  return json({ ok: true, id: castId });
}

async function uploadImage({ request, env, fetcher, actor }) {
  await rateLimit(env.DB, `upload:${actor.id}`, 60, 3600);
  if (Number(request.headers.get('Content-Length')) > 4500000)
    throw new HttpError(413, '画像は4MB以下にしてください。');
  const form = await formBody(request),
    file = form.get('image');
  if (!(file instanceof File) || file.size > 4 * 1024 * 1024)
    throw new HttpError(400, '4MB以下の画像を選んでください。');
  const image = await saveImage(new Uint8Array(await file.arrayBuffer()), file.type, 'public', actor, env, fetcher);
  await imageStatement(env, image).run();
  return json({ id: image.id, url: `/api/images/${image.id}` });
}

async function placement({ request, env, actor, url, method }) {
  await ensureStaffResources(env);
  if (method === 'GET') return json(await placementForEvent(env, id(url.searchParams.get('event_id'))));
  const data = await bodyJson(request);
  return json(await savePlacement(env, actor, id(data.event_id), data));
}

async function saveAssignment({ request, env, actor }) {
  const data = await bodyJson(request),
    eventId = id(data.event_id),
    userId = snowflake(data.user_id);
  if (
    !(await isStaffCandidate(userId, env)) ||
    !(await env.DB.prepare('SELECT id FROM events WHERE id=? AND deleted_at IS NULL').bind(eventId).first())
  )
    throw new HttpError(400, '営業回と運営用サーバーにいるスタッフを選んでください。');
  const saved = await env.DB.prepare(
    'INSERT INTO assignments(event_id,user_id,details,published) SELECT ?,?,?,? FROM events WHERE id=? AND deleted_at IS NULL ON CONFLICT(event_id,user_id) DO UPDATE SET details=excluded.details,published=excluded.published'
  )
    .bind(eventId, userId, text(data.details || '', 3000), bool(data.published), eventId)
    .run();
  if (!saved.meta.changes) throw new HttpError(409, '削除済みの営業日です。');
  await audit(env, actor, 'assignment.save', eventId);
  return json({ ok: true });
}

export const manageRoutes = [
  // Paged record lists and the trash (src/manage-records.mjs).
  ['GET', /^\/api\/manage\/(events|cheki)$/, records],
  ['POST', /^\/api\/manage\/(events|cheki)\/(delete|restore)$/, records],
  ['GET', '/api/manage', overview],
  ['POST', '/api/manage/staff-sync', staffSync],
  ['POST', '/api/manage/schedule', saveSchedule],
  ['POST', '/api/manage/settings', saveSettings],
  ['POST', '/api/manage/events', saveEvent],
  ['POST', '/api/manage/manual-document', createManualDocument],
  ['POST', '/api/manage/manual-document/preview', previewManualDocument],
  ['POST', '/api/manage/content', saveContent],
  ['POST', '/api/manage/casts', saveCast],
  ['POST', '/api/manage/images', uploadImage],
  [['GET', 'POST'], '/api/manage/placement', placement],
  ['POST', '/api/manage/assignments', saveAssignment]
];
