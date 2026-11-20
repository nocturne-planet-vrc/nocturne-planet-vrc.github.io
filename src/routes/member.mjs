// /api/member/* — members of the customer Discord server.
import { HttpError, text, nowIso, bodyJson, passphraseHash, equal, checkinWindow, rateLimit } from '../core.mjs';
import { vrchatStatus } from '../vrchat.mjs';
import { syncCustomerNickname } from '../customer-name.mjs';
import { grantChekiDeliveries } from '../cheki.mjs';
import { id, json, rows, sessionData } from './shared.mjs';
import { vrchatRoute } from './vrchat.mjs';

async function overview({ env, fetcher, actor }) {
  await grantChekiDeliveries(actor.id, env);
  const [visits, favorites, cheki] = await Promise.all([
    rows(
      env.DB.prepare(
        'SELECT v.event_id,v.checked_in_at,e.title,e.starts_at FROM visits v JOIN events e ON e.id=v.event_id WHERE user_id=? ORDER BY checked_in_at DESC'
      ).bind(actor.id)
    ),
    rows(env.DB.prepare('SELECT cast_id FROM favorites WHERE user_id=?').bind(actor.id)),
    rows(
      env.DB.prepare(
        "SELECT c.id,c.image_id,c.message,c.created_at,c.opened_at,c.sender_id,u.display_name AS sender_name,e.title AS event_title FROM cheki c JOIN users u ON u.id=c.sender_id LEFT JOIN events e ON e.id=c.event_id WHERE c.recipient_id=? AND c.withdrawn=0 AND c.deleted_at IS NULL UNION ALL SELECT b.id,b.image_id,b.message,b.created_at,d.opened_at,b.sender_id,u.display_name,e.title FROM cheki_batches b JOIN cheki_deliveries d ON d.batch_id=b.id JOIN users u ON u.id=b.sender_id JOIN events e ON e.id=b.event_id WHERE d.recipient_id=? AND b.state='sent' AND b.withdrawn=0 AND b.deleted_at IS NULL ORDER BY 4 DESC LIMIT 60"
      ).bind(actor.id, actor.id)
    )
  ]);
  const vrchat = await vrchatStatus(actor.id, env);
  vrchat.nickname = await syncCustomerNickname(actor, vrchat.linked, env, fetcher);
  return json({
    session: await sessionData(actor, env),
    visits,
    favorites: favorites.map(x => x.cast_id),
    cheki,
    vrchat
  });
}

async function saveFavorites({ request, env, actor }) {
  const data = await bodyJson(request);
  if (!Array.isArray(data.cast_ids) || data.cast_ids.length > 50)
    throw new HttpError(400, 'キャストの選択を確認してください。');
  const selected = [...new Set(data.cast_ids.map(id))];
  for (const cast of selected)
    if (!(await env.DB.prepare('SELECT id FROM casts WHERE id=? AND active=1').bind(cast).first()))
      throw new HttpError(400, '公開中のキャストを選んでください。');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM favorites WHERE user_id=?').bind(actor.id),
    ...selected.map(cast => env.DB.prepare('INSERT INTO favorites(user_id,cast_id) VALUES(?,?)').bind(actor.id, cast))
  ]);
  return json({ ok: true });
}

async function checkin({ request, env, actor }) {
  const data = await bodyJson(request),
    eventId = id(data.event_id),
    phrase = text(data.passphrase, 80, true);
  await rateLimit(env.DB, `checkin:${actor.id}`, 8, 600);
  const event = await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(eventId).first();
  if (!checkinWindow(event)) throw new HttpError(403, 'この営業のチェックイン受付時間外です。', 'CHECKIN_CLOSED');
  const hash = await passphraseHash(event.id, event.checkin_salt, phrase, env.CHECKIN_PEPPER);
  if (!equal(hash, event.checkin_hash)) throw new HttpError(400, '合言葉を確認してください。', 'CHECKIN_INCORRECT');
  const timestamp = nowIso();
  const inserted = await env.DB.prepare(
    'INSERT INTO visits(event_id,user_id,checked_in_at) SELECT id,?,? FROM events WHERE id=? AND deleted_at IS NULL AND published=1 AND checkin_hash=? AND checkin_opens_at<=? AND checkin_closes_at>=? ON CONFLICT(event_id,user_id) DO NOTHING'
  )
    .bind(actor.id, timestamp, event.id, hash, timestamp, timestamp)
    .run();
  const existing = await env.DB.prepare('SELECT checked_in_at FROM visits WHERE event_id=? AND user_id=?')
    .bind(event.id, actor.id)
    .first();
  if (!existing) throw new HttpError(409, '受付状態が変更されました。画面を再読み込みしてください。');
  return json({ ok: true, already: inserted.meta.changes === 0, checked_in_at: existing.checked_in_at });
}

async function chekiOpened({ env, actor, path }) {
  const chekiId = id(path.split('/')[4]),
    timestamp = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE cheki SET opened_at=COALESCE(opened_at,?) WHERE id=? AND recipient_id=? AND withdrawn=0 AND deleted_at IS NULL'
    ).bind(timestamp, chekiId, actor.id),
    env.DB.prepare(
      "UPDATE cheki_deliveries SET opened_at=COALESCE(opened_at,?) WHERE batch_id=? AND recipient_id=? AND EXISTS(SELECT 1 FROM cheki_batches WHERE id=? AND state='sent' AND withdrawn=0 AND deleted_at IS NULL)"
    ).bind(timestamp, chekiId, actor.id, chekiId)
  ]);
  return json({ ok: true });
}

export const memberRoutes = [
  vrchatRoute,
  ['GET', '/api/member', overview],
  ['PUT', '/api/member/favorites', saveFavorites],
  ['POST', '/api/member/checkin', checkin],
  ['POST', /^\/api\/member\/cheki\/[^/]+\/opened$/, chekiOpened]
];
