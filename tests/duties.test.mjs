import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ids } from './helpers.mjs';
import { dutyRoles } from '../src/duties.mjs';
import { jstTime } from '../public/schedule.mjs';

const answer = duties => ({
  event_id: 'event-1',
  answer: 'yes',
  available_from: '22:00',
  available_until: '23:30',
  duties,
  note: '担当確認'
});

test('出欠だけを即時保存する場合は初回に既定時刻を入れ、以降は回答の詳細を保持する', async t => {
  const f = await fixture();
  t.after(f.close);
  const event = await f.event();
  const regular = { interval_weeks: 1, weekday: 6, start_time: '21:30', end_time: '23:00' };
  await f.DB.prepare("UPDATE settings SET value=json_set(value,'$.regular_hours',json(?)) WHERE key='site'")
    .bind(JSON.stringify(regular))
    .run();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [dutyRoles[0].role_id] });
  const save = body => f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body });
  const quick = (value, eventId = event.id) => save({ event_id: eventId, answer: value, status_only: true });

  const first = await quick('yes');
  assert.equal(first.status, 200);
  const initial = (await first.json()).attendance;
  assert.deepEqual(
    [initial.answer, initial.available_from, initial.available_until, initial.duties, initial.note],
    ['yes', '21:30', '23:00', '[]', '']
  );
  await f.DB.prepare("UPDATE settings SET value=json_remove(value,'$.regular_hours') WHERE key='site'").run();
  const otherEvent = await f.event('event-2');
  const fallback = (await (await quick('maybe', otherEvent.id)).json()).attendance;
  assert.deepEqual(
    [fallback.available_from, fallback.available_until],
    [jstTime(otherEvent.starts_at), jstTime(otherEvent.ends_at)]
  );

  const details = { ...answer([dutyRoles[0].name]), available_until: '' };
  assert.equal((await save(details)).status, 200);
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [] });
  const changed = await quick('no');
  assert.equal(changed.status, 200);
  const stored = (await changed.json()).attendance;
  assert.deepEqual(
    [stored.answer, stored.available_from, stored.available_until, JSON.parse(stored.duties), stored.note],
    ['no', '22:00', '', details.duties, details.note]
  );

  await f.DB.prepare('UPDATE events SET response_deadline=? WHERE id=?')
    .bind(new Date(Date.now() - 1000).toISOString(), event.id)
    .run();
  assert.equal((await quick('yes')).status, 403);
  assert.equal(
    (
      await f.DB.prepare('SELECT answer FROM attendance WHERE event_id=? AND user_id=?')
        .bind(event.id, ids.staff)
        .first()
    ).answer,
    'no'
  );
});

test('8つの担当は、それぞれのDiscordロールに対応する項目だけ選べる', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  for (const duty of dutyRoles) {
    f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [duty.role_id] });
    const data = await (await f.request('/api/staff', { user: 'staff' })).json();
    assert.equal(data.duty_options.length, 8);
    assert.deepEqual(
      data.duty_options.filter(option => option.available).map(option => option.name),
      [duty.name]
    );
    assert.equal(
      (await f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body: answer([duty.name]) })).status,
      200
    );
  }
});

test('複数ロールの担当を保存でき、ロールのない担当を混ぜると元の回答を守る', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [dutyRoles[0].role_id, dutyRoles[2].role_id] });
  assert.equal(
    (
      await f.request('/api/staff/attendance', {
        user: 'staff',
        method: 'POST',
        body: answer(['接客キャスト', 'PA', 'PA'])
      })
    ).status,
    200
  );
  const read = () => f.DB.prepare('SELECT duties FROM attendance WHERE user_id=?').bind(ids.staff).first();
  assert.deepEqual(JSON.parse((await read()).duties), ['接客キャスト', 'PA']);
  const response = await f.request('/api/staff/attendance', {
    user: 'staff',
    method: 'POST',
    body: answer(['接客キャスト', '動画編集'])
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'DUTY_ROLE_REQUIRED');
  assert.deepEqual(JSON.parse((await read()).duties), ['接客キャスト', 'PA']);
});

test('ロールがない人も、担当を選ばず出欠と連絡を保存できる', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [] });
  const data = await (await f.request('/api/staff', { user: 'staff' })).json();
  assert.ok(data.duty_options.every(duty => !duty.available));
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body: answer([]) })).status,
    200
  );
  const saved = await f.DB.prepare('SELECT duties,note FROM attendance WHERE user_id=?').bind(ids.staff).first();
  assert.equal(saved.duties, '[]');
  assert.equal(saved.note, '担当確認');
});

test('回答画面を開いた後のロール剥奪・追加を、次の保存と読み込みで反映する', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [dutyRoles[0].role_id] });
  await f.request('/api/staff', { user: 'staff' });
  await f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body: answer(['接客キャスト']) });
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`, { roles: [dutyRoles[2].role_id] });
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body: answer(['接客キャスト']) }))
      .status,
    403
  );
  const updated = await (await f.request('/api/staff', { user: 'staff' })).json();
  assert.deepEqual(
    updated.duty_options.filter(duty => duty.available).map(duty => duty.name),
    ['PA']
  );
  assert.deepEqual(JSON.parse(updated.attendance[0].duties), ['接客キャスト']);
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body: answer(['PA']) })).status,
    200
  );
});

test('運営ロールがある人は全担当を選べるが、不明な担当は拒否する', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  const data = await (await f.request('/api/staff', { user: 'admin' })).json();
  assert.equal(data.duty_options.length, 8);
  assert.ok(data.duty_options.every(duty => duty.available));
  const all = dutyRoles.map(duty => duty.name);
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'admin', method: 'POST', body: answer(all) })).status,
    200
  );
  assert.deepEqual(
    JSON.parse((await f.DB.prepare('SELECT duties FROM attendance WHERE user_id=?').bind(ids.admin).first()).duties),
    all
  );
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'admin', method: 'POST', body: answer(['架空の担当']) })).status,
    400
  );
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'staff', method: 'POST', body: answer(['架空の担当']) })).status,
    400
  );
});

test('運営ロールを外すと担当ロールの範囲へ戻り、送信内容では運営になれない', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  await f.request('/api/staff', { user: 'admin' });
  f.members.set(`${ids.admin}:${f.env.STAFF_GUILD_ID}`, { roles: [dutyRoles[0].role_id] });
  const data = await (await f.request('/api/staff', { user: 'admin' })).json();
  assert.equal(data.session.admin, false);
  assert.deepEqual(
    data.duty_options.filter(duty => duty.available).map(duty => duty.name),
    ['接客キャスト']
  );
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'admin', method: 'POST', body: answer(['PA']) })).status,
    403
  );
  assert.equal(
    (await f.request('/api/staff/attendance', { user: 'admin', method: 'POST', body: answer(['接客キャスト']) }))
      .status,
    200
  );
  assert.equal(
    (
      await f.request('/api/staff/attendance', {
        user: 'staff',
        method: 'POST',
        body: { ...answer(['PA']), admin: true }
      })
    ).status,
    403
  );
});
