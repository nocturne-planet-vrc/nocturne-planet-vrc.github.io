import { HttpError, nowIso, equal } from './core.mjs';
import { dutyRoles } from './duties.mjs';
import { syncStaffDirectory, botConfigured } from './staff-directory.mjs';
import { ensureReminderTables, ensureStaffTable } from './schema.mjs';

const DISCORD = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://nocturne-planet.pages.dev, 1.0.0)';
// Minutes before the attendance deadline. The smallest stage whose window has started is sent,
// so a late first run never sends an outdated "12 hours left" message.
export const reminderStages = [720, 60, 5];
// Each DM costs up to two Discord requests; stay well inside the per-request subrequest limit.
const MAX_DMS_PER_RUN = 20;
const dutyRoleIds = new Set(dutyRoles.map(duty => duty.role_id));

// Staff expected to answer: members of the staff server who hold at least one duty role.
export async function attendanceTargets(env) {
  await ensureStaffTable(env);
  const { results } = await env.DB.prepare('SELECT user_id,display_name,roles FROM staff_directory').all();
  return results.filter(row => {
    let roles = [];
    try {
      roles = JSON.parse(row.roles || '[]');
    } catch {}
    return roles.some(role => dutyRoleIds.has(role));
  });
}

export function currentStage(deadline, now) {
  const end = Date.parse(deadline);
  if (!Number.isFinite(end) || now >= end) return null;
  const started = reminderStages.filter(stage => now >= end - stage * 60000);
  return started.length ? Math.min(...started) : null;
}

const dateTime = value =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
function remaining(deadline, now) {
  const minutes = Math.max(1, Math.round((Date.parse(deadline) - now) / 60000));
  return minutes >= 60 ? '約' + Math.round(minutes / 60) + '時間' : minutes + '分';
}
export function reminderMessage(event, now, origin) {
  return (
    '【のくぷら】出欠の回答がまだのようです\n' +
    '営業：' +
    event.title +
    '（' +
    dateTime(event.starts_at) +
    '〜）\n' +
    '回答期限：' +
    dateTime(event.response_deadline) +
    '（あと' +
    remaining(event.response_deadline, now) +
    '）\n' +
    '回答はスタッフページからお願いします。\n' +
    origin +
    '/staff'
  );
}

async function discordJson(fetcher, env, path, body) {
  const response = await fetcher(DISCORD + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

async function sendDm(env, fetcher, userId, channels, content) {
  let channelId = channels.get(userId),
    fresh = false;
  if (!channelId) {
    const { response, data } = await discordJson(fetcher, env, '/users/@me/channels', { recipient_id: userId });
    if (response.status === 429) return { retry: true };
    if (!response.ok || !data.id)
      return { status: 'failed', detail: 'DMを開けませんでした（' + response.status + '）' };
    channelId = data.id;
    fresh = true;
  }
  const { response, data } = await discordJson(fetcher, env, '/channels/' + channelId + '/messages', {
    content,
    allowed_mentions: { parse: [] }
  });
  if (response.status === 429) return { retry: true, channelId, fresh };
  if (response.ok) return { status: 'sent', channelId, fresh };
  if (data.code === 50007) return { status: 'blocked', detail: 'DMを受け取らない設定です', channelId, fresh };
  return { status: 'failed', detail: '送信できませんでした（' + response.status + '）', channelId, fresh };
}

export async function sendReminders(env, fetcher, now = Date.now()) {
  await ensureReminderTables(env);
  if (!botConfigured(env)) return { configured: false, sent: 0 };
  const { results: events } = await env.DB.prepare(
    'SELECT id,title,starts_at,ends_at,response_deadline FROM events WHERE deleted_at IS NULL AND response_deadline IS NOT NULL AND response_deadline>? AND ends_at>? ORDER BY response_deadline LIMIT 20'
  )
    .bind(new Date(now).toISOString(), new Date(now).toISOString())
    .all();
  const due = events
    .map(event => ({ event, stage: currentStage(event.response_deadline, now) }))
    .filter(item => item.stage !== null);
  if (!due.length) return { configured: true, sent: 0 };
  // Refresh roles only when a reminder window is open (reuses a sync younger than 5 minutes).
  await syncStaffDirectory(env, fetcher);
  const targets = await attendanceTargets(env);
  if (!targets.length) return { configured: true, sent: 0 };
  const origin = new URL(env.APP_ORIGIN).origin,
    queue = [];
  for (const { event, stage } of due) {
    // Skip people who answered and people who already got this stage or a later one for this deadline.
    const { results: skip } = await env.DB.prepare(
      'SELECT user_id FROM attendance WHERE event_id=? UNION SELECT user_id FROM reminder_log WHERE event_id=? AND deadline=? AND stage<=?'
    )
      .bind(event.id, event.id, event.response_deadline, stage)
      .all();
    const skipped = new Set(skip.map(row => row.user_id));
    for (const target of targets)
      if (!skipped.has(target.user_id)) queue.push({ event, stage, user_id: target.user_id });
  }
  const batch = queue.slice(0, MAX_DMS_PER_RUN);
  if (!batch.length) return { configured: true, sent: 0 };
  const stamp = nowIso();
  // Claim rows first so overlapping runs cannot send the same reminder twice.
  const claimed = new Set(
    (
      await env.DB.prepare(
        "INSERT OR IGNORE INTO reminder_log(event_id,user_id,deadline,stage,status,sent_at) SELECT json_extract(value,'$.e'),json_extract(value,'$.u'),json_extract(value,'$.d'),json_extract(value,'$.s'),'pending',? FROM json_each(?) WHERE true RETURNING event_id||':'||user_id AS k"
      )
        .bind(
          stamp,
          JSON.stringify(
            batch.map(item => ({ e: item.event.id, u: item.user_id, d: item.event.response_deadline, s: item.stage }))
          )
        )
        .all()
    ).results.map(row => row.k)
  );
  const { results: cached } = await env.DB.prepare('SELECT user_id,channel_id FROM discord_dm_channels').all();
  const channels = new Map(cached.map(row => [row.user_id, row.channel_id])),
    updates = [],
    released = [],
    newChannels = [];
  let stopped = false;
  for (const item of batch) {
    if (!claimed.has(item.event.id + ':' + item.user_id)) continue;
    if (stopped) {
      released.push(item);
      continue;
    }
    if (
      !(await env.DB.prepare('SELECT id FROM events WHERE id=? AND deleted_at IS NULL AND response_deadline=?')
        .bind(item.event.id, item.event.response_deadline)
        .first())
    ) {
      released.push(item);
      continue;
    }
    const result = await sendDm(env, fetcher, item.user_id, channels, reminderMessage(item.event, now, origin));
    if (result.channelId && result.fresh) {
      channels.set(item.user_id, result.channelId);
      newChannels.push({ u: item.user_id, c: result.channelId });
    }
    if (result.retry) {
      stopped = true;
      released.push(item);
      continue;
    }
    updates.push({
      e: item.event.id,
      u: item.user_id,
      d: item.event.response_deadline,
      s: item.stage,
      st: result.status,
      dt: result.detail || ''
    });
  }
  const statements = [];
  if (updates.length)
    statements.push(
      env.DB.prepare(
        "UPDATE reminder_log SET status=(SELECT json_extract(value,'$.st') FROM json_each(?2) WHERE json_extract(value,'$.e')=reminder_log.event_id AND json_extract(value,'$.u')=reminder_log.user_id),detail=(SELECT json_extract(value,'$.dt') FROM json_each(?2) WHERE json_extract(value,'$.e')=reminder_log.event_id AND json_extract(value,'$.u')=reminder_log.user_id),sent_at=?1 WHERE status='pending' AND EXISTS(SELECT 1 FROM json_each(?2) WHERE json_extract(value,'$.e')=reminder_log.event_id AND json_extract(value,'$.u')=reminder_log.user_id AND json_extract(value,'$.d')=reminder_log.deadline AND json_extract(value,'$.s')=reminder_log.stage)"
      ).bind(nowIso(), JSON.stringify(updates))
    );
  // Rate-limited sends go back to the queue for the next run.
  if (released.length)
    statements.push(
      env.DB.prepare(
        "DELETE FROM reminder_log WHERE status='pending' AND EXISTS(SELECT 1 FROM json_each(?) WHERE json_extract(value,'$.e')=reminder_log.event_id AND json_extract(value,'$.u')=reminder_log.user_id AND json_extract(value,'$.d')=reminder_log.deadline AND json_extract(value,'$.s')=reminder_log.stage)"
      ).bind(
        JSON.stringify(
          released.map(item => ({ e: item.event.id, u: item.user_id, d: item.event.response_deadline, s: item.stage }))
        )
      )
    );
  if (newChannels.length)
    statements.push(
      env.DB.prepare(
        "INSERT INTO discord_dm_channels(user_id,channel_id) SELECT json_extract(value,'$.u'),json_extract(value,'$.c') FROM json_each(?) WHERE true ON CONFLICT(user_id) DO UPDATE SET channel_id=excluded.channel_id"
      ).bind(JSON.stringify(newChannels))
    );
  if (statements.length) await env.DB.batch(statements);
  return {
    configured: true,
    sent: updates.filter(update => update.st === 'sent').length,
    failed: updates.filter(update => update.st !== 'sent').length,
    deferred: released.length + Math.max(0, queue.length - batch.length)
  };
}

export function authorizeCron(request, env) {
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32) throw new HttpError(404, 'ページが見つかりません。');
  const header = request.headers.get('Authorization') || '';
  if (!equal(header, 'Bearer ' + env.CRON_SECRET)) throw new HttpError(401, '認証できませんでした。');
}

// Organizer view: who is expected to answer, and the reminder history for upcoming events.
export async function rosterFor(env) {
  await ensureReminderTables(env);
  const targets = await attendanceTargets(env),
    now = nowIso();
  const { results: reminders } = await env.DB.prepare(
    'SELECT r.event_id,r.user_id,r.stage,r.status,r.detail,r.sent_at FROM reminder_log r JOIN events e ON e.id=r.event_id AND e.response_deadline=r.deadline WHERE e.deleted_at IS NULL AND e.ends_at>? ORDER BY r.sent_at'
  )
    .bind(now)
    .all();
  return { target_ids: targets.map(target => target.user_id), reminders, stages: reminderStages };
}
