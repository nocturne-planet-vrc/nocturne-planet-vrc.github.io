import { HttpError, text, formBody, nowIso, sha256, base64url, imageType, rateLimit } from './core.mjs';
import { uploadDrive, discardDrive } from './drive.mjs';

const validId = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new HttpError(400, '営業回を選んでください。');
  return value;
};
// This query is also evaluated inside the final transaction; callers cannot supply recipients.
const eligible = `SELECT u.id FROM users u JOIN favorites f ON f.user_id=u.id JOIN casts c ON c.id=f.cast_id JOIN visits v ON v.user_id=u.id JOIN events e ON e.id=v.event_id WHERE u.joined_as_customer=1 AND c.user_id=? AND c.id=? AND c.active=1 AND v.event_id=? AND e.published=1 AND e.deleted_at IS NULL AND e.starts_at<=?`;
export const chekiCast = (sender, env) =>
  env.DB.prepare('SELECT id,display_name FROM casts WHERE user_id=? AND active=1').bind(sender).first();
export async function grantChekiDeliveries(user, env) {
  await env.DB.prepare(
    "INSERT INTO cheki_deliveries(batch_id,recipient_id) SELECT b.id,u.id FROM cheki_batches b JOIN events e ON e.id=b.event_id AND e.deleted_at IS NULL JOIN favorites f ON f.cast_id=b.cast_id JOIN visits v ON v.event_id=b.event_id AND v.user_id=f.user_id JOIN users u ON u.id=f.user_id WHERE u.id=? AND u.joined_as_customer=1 AND b.state='sent' AND b.withdrawn=0 AND b.deleted_at IS NULL ON CONFLICT(batch_id,recipient_id) DO NOTHING"
  )
    .bind(user)
    .run();
}
export async function chekiAudience(sender, eventId, env) {
  const event = await env.DB.prepare(
    'SELECT id,title,starts_at FROM events WHERE id=? AND published=1 AND deleted_at IS NULL AND starts_at<=?'
  )
    .bind(validId(eventId), nowIso())
    .first();
  if (!event) throw new HttpError(400, '開始済みの公開されている営業回を選んでください。');
  const cast = await chekiCast(sender, env);
  if (!cast)
    throw new HttpError(
      403,
      '運営に、公開中のキャスト紹介とDiscordアカウントの紐付けを依頼してください。',
      'CAST_LINK_REQUIRED'
    );
  const recipients = (
    await env.DB.prepare(eligible + ' ORDER BY u.id')
      .bind(sender, cast.id, event.id, nowIso())
      .all()
  ).results.map(u => u.id);
  return {
    cast,
    event,
    recipients,
    count: recipients.length,
    audience_hash: await sha256(JSON.stringify([sender, cast.id, event.id, recipients]))
  };
}
const changed = () =>
  new HttpError(409, '送信対象が変わりました。対象人数を確認し直してください。', 'AUDIENCE_CHANGED');
export async function sendChekiBatch(request, actor, env, fetcher) {
  if (Number(request.headers.get('Content-Length')) > 4500000)
    throw new HttpError(413, '画像は4MB以下にしてください。');
  const form = await formBody(request);
  if (form.has('recipient_id') || form.has('recipient_ids') || form.has('cast_id'))
    throw new HttpError(400, '個別の送信先は指定できません。画面を再読み込みしてください。');
  const batchId = form.get('batch_id'),
    eventId = validId(form.get('event_id')),
    audienceHash = text(form.get('audience_hash'), 100, true),
    message = text(form.get('message') || '', 500),
    file = form.get('image');
  if (
    typeof batchId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(batchId)
  )
    throw new HttpError(400, '送信画面を再読み込みしてください。');
  if (!(file instanceof File) || file.size > 4 * 1024 * 1024 || file.size < 12)
    throw new HttpError(400, '4MB以下の画像を選んでください。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (imageType(bytes) !== file.type) throw new HttpError(400, '画像の形式が一致しません。');
  const digest = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))),
    requestHash = await sha256(JSON.stringify([actor.id, eventId, audienceHash, message, file.type, digest]));
  function replay(batch) {
    if (batch.sender_id !== actor.id || batch.request_hash !== requestHash)
      throw new HttpError(409, '送信内容が変わっています。送信画面を再読み込みしてください。');
    if (batch.deleted_at) throw new HttpError(409, 'このチェキは運営により削除されています。');
    if (batch.state === 'sent') return { ok: true, id: batchId, count: batch.expected_count, already: true };
    if (batch.state === 'pending')
      throw new HttpError(409, 'このチェキは送信処理中です。少し待って送信履歴を確認してください。', 'CHEKI_PENDING');
  }
  const existing = await env.DB.prepare('SELECT * FROM cheki_batches WHERE id=?').bind(batchId).first();
  if (existing) {
    const result = replay(existing);
    if (result) return result;
  }
  const audience = await chekiAudience(actor.id, eventId, env);
  if (audience.audience_hash !== audienceHash) throw changed();
  await rateLimit(env.DB, `upload:${actor.id}`, 60, 3600);
  const timestamp = nowIso();
  const claimed = await env.DB.prepare(
    "INSERT INTO cheki_batches(id,sender_id,event_id,cast_id,message,request_hash,expected_count,state,created_at) VALUES(?,?,?,?,?,?,?,'pending',?) ON CONFLICT(id) DO UPDATE SET state='pending',created_at=excluded.created_at WHERE cheki_batches.state='failed' AND cheki_batches.sender_id=excluded.sender_id AND cheki_batches.request_hash=excluded.request_hash"
  )
    .bind(batchId, actor.id, eventId, audience.cast.id, message, requestHash, audience.count, timestamp)
    .run();
  if (!claimed.meta.changes)
    return replay(await env.DB.prepare('SELECT * FROM cheki_batches WHERE id=?').bind(batchId).first());
  let image,
    commitAttempted = false;
  try {
    const imageId = crypto.randomUUID(),
      driveId = await uploadDrive(bytes, file.type, imageId, env, fetcher);
    image = { id: imageId, drive_id: driveId };
    const fresh = await chekiAudience(actor.id, eventId, env);
    if (fresh.audience_hash !== audienceHash) throw changed();
    commitAttempted = true;
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)'
      ).bind(imageId, driveId, file.type, bytes.length, 'private', actor.id, timestamp),
      env.DB.prepare(
        `WITH eligible AS (${eligible}) INSERT INTO cheki_deliveries(batch_id,recipient_id) SELECT ?,id FROM eligible WHERE (SELECT count(*) FROM eligible)=? AND NOT EXISTS(SELECT 1 FROM eligible WHERE id NOT IN (SELECT value FROM json_each(?)))`
      ).bind(
        actor.id,
        audience.cast.id,
        eventId,
        nowIso(),
        batchId,
        audience.count,
        JSON.stringify(audience.recipients)
      ),
      env.DB.prepare(
        `WITH eligible AS (${eligible}) UPDATE cheki_batches SET image_id=?,state=CASE WHEN (SELECT count(*) FROM cheki_deliveries WHERE batch_id=?)=expected_count AND (SELECT count(*) FROM eligible)=expected_count AND EXISTS(SELECT 1 FROM casts c JOIN events e ON e.id=cheki_batches.event_id WHERE c.id=cheki_batches.cast_id AND c.user_id=cheki_batches.sender_id AND c.active=1 AND e.published=1 AND e.deleted_at IS NULL AND e.starts_at<=?) THEN 'sent' ELSE 'failed' END WHERE id=? AND state='pending'`
      ).bind(actor.id, audience.cast.id, eventId, nowIso(), imageId, batchId, nowIso(), batchId),
      env.DB.prepare(
        "INSERT INTO audit_log(id,actor_id,action,resource_id,created_at) SELECT ?,?,'cheki.batch.send',id,? FROM cheki_batches WHERE id=? AND state='sent'"
      ).bind(crypto.randomUUID(), actor.id, timestamp, batchId)
    ]);
    const saved = await env.DB.prepare('SELECT state FROM cheki_batches WHERE id=?').bind(batchId).first();
    if (saved.state !== 'sent') {
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM cheki_deliveries WHERE batch_id=? AND EXISTS(SELECT 1 FROM cheki_batches WHERE id=? AND state='failed')"
        ).bind(batchId, batchId),
        env.DB.prepare("UPDATE cheki_batches SET image_id=NULL WHERE id=? AND state='failed'").bind(batchId),
        env.DB.prepare('DELETE FROM images WHERE id=?').bind(imageId)
      ]);
      await discardDrive(driveId, env, fetcher).catch(() => {});
      throw changed();
    }
    return { ok: true, id: batchId, count: audience.count, already: false };
  } catch (error) {
    // An uncertain database outcome is never retried or deleted automatically.
    if (!commitAttempted) {
      await env.DB.prepare("UPDATE cheki_batches SET state='failed' WHERE id=? AND state='pending'")
        .bind(batchId)
        .run();
      if (image) await discardDrive(image.drive_id, env, fetcher).catch(() => {});
    }
    throw error;
  }
}
