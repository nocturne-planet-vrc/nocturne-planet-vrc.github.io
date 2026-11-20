import { HttpError, httpsUrl, nowIso, text } from './core.mjs';
import { ensureStaffTable } from './staff-directory.mjs';
import { placementStaffRoles } from '../public/placement-roles.mjs';

const schemas = new WeakMap();
const staffRoleIds = new Set(placementStaffRoles.map(([id]) => id));
export function ensureStaffResources(env) {
  if (!schemas.has(env.DB)) {
    const ready = (async () => {
      await env.DB.batch([
        env.DB.prepare(
          'CREATE TABLE IF NOT EXISTS event_placements (event_id TEXT PRIMARY KEY REFERENCES events(id), instances TEXT NOT NULL, published INTEGER NOT NULL CHECK(published IN (0,1)), revision TEXT NOT NULL)'
        ),
        env.DB.prepare(
          'CREATE TABLE IF NOT EXISTS manual_google_docs (content_id TEXT PRIMARY KEY REFERENCES content(id) ON DELETE CASCADE, url TEXT NOT NULL, inline_body INTEGER NOT NULL DEFAULT 0 CHECK(inline_body IN (0,1)))'
        )
      ]);
      const hasInlineBody = async () =>
        (await env.DB.prepare('PRAGMA table_info(manual_google_docs)').all()).results.some(
          column => column.name === 'inline_body'
        );
      if (!(await hasInlineBody())) {
        try {
          await env.DB.prepare(
            'ALTER TABLE manual_google_docs ADD COLUMN inline_body INTEGER NOT NULL DEFAULT 0 CHECK(inline_body IN (0,1))'
          ).run();
        } catch (error) {
          if (!(await hasInlineBody())) throw error;
        }
      }
    })().catch(error => {
      schemas.delete(env.DB);
      throw error;
    });
    schemas.set(env.DB, ready);
  }
  return schemas.get(env.DB);
}

export function googleDocUrl(value) {
  if (value === '') return '';
  const url = new URL(httpsUrl(text(value, 2048, true)));
  if (
    url.origin !== 'https://docs.google.com' ||
    !/^\/document\/(?:u\/\d+\/)?d\/[\w-]+(?:\/(?:edit|view|preview))?\/?$/.test(url.pathname)
  ) {
    throw new HttpError(400, 'Google ドキュメントの共有リンクを入力してください。');
  }
  // Open with the reader's Google account and preserve tab, heading and resource-key links.
  url.pathname = url.pathname.replace(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+).*$/, '/document/d/$1/edit');
  url.searchParams.delete('authuser');
  return url.href;
}

function readPlacements(value) {
  return JSON.parse(value || '[]').map(instance => {
    const extra = instance.seats.slice(9);
    const seats = extra.some(seat => seat.in_use || seat.name || seat.user_id)
      ? instance.seats
      : instance.seats.slice(0, 9);
    return {
      seats: seats.map(({ in_use, user_id = '', name }) => ({ in_use, user_id, name })),
      staff: instance.staff.map(person =>
        typeof person === 'string' ? { user_id: '', name: person, role: '' } : { ...person, role: person.role ?? '' }
      )
    };
  });
}

async function placementAttendees(env, eventId) {
  await ensureStaffTable(env);
  const { results } = await env.DB.prepare(
    `SELECT u.id,COALESCE(d.display_name,u.display_name) AS name
    FROM attendance a JOIN users u ON u.id=a.user_id LEFT JOIN staff_directory d ON d.user_id=u.id
    WHERE a.event_id=? AND a.answer='yes' ORDER BY name COLLATE NOCASE,u.id`
  )
    .bind(eventId)
    .all();
  return results;
}

export async function currentPlacement(env) {
  const entry = await env.DB.prepare(
    `SELECT e.id,e.title,e.starts_at,p.instances
    FROM events e LEFT JOIN event_placements p ON p.event_id=e.id AND p.published=1
    WHERE e.deleted_at IS NULL AND e.published=1 AND e.ends_at>?
    ORDER BY e.starts_at,e.id LIMIT 1`
  )
    .bind(nowIso())
    .first();
  if (!entry) return { event: null, instances: [] };
  const { instances, ...event } = entry;
  return {
    event,
    instances: readPlacements(instances).map(instance => ({
      seats: instance.seats.map(({ in_use, name }) => ({ in_use, name: in_use ? name : '' })),
      staff: instance.staff.map(({ name, role }) => ({ name, role }))
    }))
  };
}

export async function placementForEvent(env, eventId) {
  const row = await env.DB.prepare(
    `SELECT p.instances,p.published,p.revision,e.published AS event_published
    FROM events e LEFT JOIN event_placements p ON p.event_id=e.id
    WHERE e.id=? AND e.deleted_at IS NULL`
  )
    .bind(eventId)
    .first();
  if (!row) throw new HttpError(404, '該当する営業回が見つかりません。');
  return {
    ...row,
    instances: readPlacements(row.instances),
    published: !!row.published,
    attendees: await placementAttendees(env, eventId)
  };
}

export async function savePlacement(env, actor, eventId, { instances, published, revision }) {
  if (
    !Array.isArray(instances) ||
    instances.length > 12 ||
    typeof published !== 'boolean' ||
    (revision !== null && typeof revision !== 'string')
  ) {
    throw new HttpError(400, '配置の入力内容を確認してください。');
  }
  if (published && !instances.length) throw new HttpError(400, '公開するインスタンスを追加してください。');
  const names = new Map((await placementAttendees(env, eventId)).map(person => [person.id, person.name]));
  const assigned = new Set();
  function attendee(person, required = false) {
    const userId = person?.user_id;
    if (userId === '' && !required && !person.name) return { user_id: '', name: '' };
    if (!names.has(userId))
      throw new HttpError(
        400,
        'この営業回に「参加」と回答した人を選び直してください。',
        'PLACEMENT_ATTENDANCE_CHANGED'
      );
    assigned.add(userId);
    return { user_id: userId, name: names.get(userId) };
  }
  const validated = instances.map((instance, index) => {
    if (
      !Array.isArray(instance?.seats) ||
      ![9, 12].includes(instance.seats.length) ||
      !Array.isArray(instance.staff) ||
      instance.staff.length > 24
    ) {
      throw new HttpError(400, '各インスタンスは卓1〜9と、スタッフ24人まで設定できます。');
    }
    const seats = instance.seats.map(seat => {
      if (typeof seat?.in_use !== 'boolean') throw new HttpError(400, '卓の使用状態を確認してください。');
      return { in_use: seat.in_use, ...(seat.in_use ? attendee(seat) : { user_id: '', name: '' }) };
    });
    const castIds = seats.map(seat => seat.user_id).filter(Boolean);
    if (new Set(castIds).size !== castIds.length)
      throw new HttpError(400, `第${index + 1}インスタンスで、同じキャストが複数の卓にいます。`);
    const staff = instance.staff.map(person => {
      const role = person?.role ?? '';
      if (role !== '' && !staffRoleIds.has(role)) throw new HttpError(400, 'スタッフの担当を選び直してください。');
      return { ...attendee(person, true), role };
    });
    if (new Set(staff.map(person => `${person.role}:${person.user_id}`)).size !== staff.length) {
      throw new HttpError(400, `第${index + 1}インスタンスで、同じ担当に同じスタッフが複数います。`);
    }
    return { seats, staff };
  });
  const nextRevision = crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO event_placements(event_id,instances,published,revision)
      SELECT e.id,?,?,? FROM events e LEFT JOIN event_placements p ON p.event_id=e.id
      WHERE e.id=? AND e.deleted_at IS NULL AND p.revision IS ?
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) chosen
          WHERE NOT EXISTS (SELECT 1 FROM attendance a WHERE a.event_id=e.id AND a.user_id=chosen.value AND a.answer='yes')
        )
      ON CONFLICT(event_id) DO UPDATE SET instances=excluded.instances,published=excluded.published,revision=excluded.revision
      WHERE event_placements.revision IS ?`
    ).bind(
      JSON.stringify(validated),
      Number(published),
      nextRevision,
      eventId,
      revision,
      JSON.stringify([...assigned]),
      revision
    ),
    env.DB.prepare(
      `INSERT INTO audit_log(id,actor_id,action,resource_id,created_at)
      SELECT ?,?,?,event_id,? FROM event_placements WHERE event_id=? AND revision=?`
    ).bind(crypto.randomUUID(), actor.id, 'placement.save', nowIso(), eventId, nextRevision)
  ]);
  if (!result[0].meta.changes)
    throw new HttpError(409, 'ほかの操作で営業回・出欠・配置が変更されました。ページを開き直してください。');
  return { instances: validated, published, revision: nextRevision };
}
