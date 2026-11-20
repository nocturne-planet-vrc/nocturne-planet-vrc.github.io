import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { validateRegularHours, regularHoursLabel, attendanceTimes, newEventTimes } from '../public/schedule.mjs';

const hours = { interval_weeks: 2, weekday: 6, start_time: '22:00', end_time: '00:30' };

test('通常営業は運営だけが変更でき、公開HP用データへ反映する', async t => {
  const f = await fixture();
  t.after(f.close);
  for (const [user, status] of [
    [undefined, 401],
    ['customer', 403],
    ['staff', 403]
  ])
    assert.equal(
      (await f.request('/api/manage/schedule', { user, method: 'POST', body: { regular_hours: hours } })).status,
      status
    );
  assert.equal(
    (
      await f.request('/api/manage/schedule', {
        user: 'admin',
        method: 'POST',
        csrf: false,
        body: { regular_hours: hours }
      })
    ).status,
    403
  );
  assert.equal(
    (await f.request('/api/manage/schedule', { user: 'admin', method: 'POST', body: { regular_hours: hours } })).status,
    200
  );
  const settings = (await (await f.request('/api/public')).json()).settings;
  assert.deepEqual(settings.regular_hours, hours);
  assert.equal(regularHoursLabel(settings.regular_hours), '隔週土曜日 22:00〜翌00:30');
});

test('不正な曜日・時刻・空の通常営業を保存せず、前の設定を守る', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.request('/api/manage/schedule', { user: 'admin', method: 'POST', body: { regular_hours: hours } });
  for (const change of [
    { weekday: 7 },
    { weekday: null },
    { weekday: 1.5 },
    { interval_weeks: 3 },
    { interval_weeks: '1' },
    { start_time: '24:00' },
    { start_time: '9:00' },
    { end_time: '22:00' },
    { end_time: '' }
  ]) {
    assert.equal(
      (
        await f.request('/api/manage/schedule', {
          user: 'admin',
          method: 'POST',
          body: { regular_hours: { ...hours, ...change } }
        })
      ).status,
      400
    );
  }
  assert.equal((await f.request('/api/manage/schedule', { user: 'admin', method: 'POST', body: {} })).status, 400);
  assert.deepEqual((await (await f.request('/api/public')).json()).settings.regular_hours, hours);
  assert.equal(
    regularHoursLabel(validateRegularHours({ ...hours, interval_weeks: 1, weekday: 0, end_time: '23:30' })),
    '毎週日曜日 22:00〜23:30'
  );
});

test('サイト設定の保存で通常営業が消えず、通常営業の解除で他の設定が消えない', async t => {
  const f = await fixture();
  t.after(f.close);
  const original = (await (await f.request('/api/public')).json()).settings;
  await f.request('/api/manage/schedule', { user: 'admin', method: 'POST', body: { regular_hours: hours } });
  assert.equal((await (await f.request('/api/public')).json()).settings.x_url, original.x_url);
  assert.equal(
    (
      await f.request('/api/manage/settings', {
        user: 'admin',
        method: 'POST',
        body: { ...original, regular_hours: null, about: '更新した説明' }
      })
    ).status,
    200
  );
  let settings = (await (await f.request('/api/public')).json()).settings;
  assert.deepEqual(settings.regular_hours, hours);
  assert.equal(settings.about, '更新した説明');
  await f.request('/api/manage/schedule', { user: 'admin', method: 'POST', body: { regular_hours: null } });
  settings = (await (await f.request('/api/public')).json()).settings;
  assert.equal(settings.regular_hours, null);
  assert.equal(settings.about, '更新した説明');
  assert.equal(settings.x_url, original.x_url);
});

test('未回答は通常営業時間を使い、未設定なら営業回の日本時間を使う', () => {
  const event = { starts_at: '2026-11-16T14:30:00Z', ends_at: '2026-11-16T16:00:00Z' };
  assert.deepEqual(attendanceTimes(undefined, event, hours), { available_from: '22:00', available_until: '00:30' });
  assert.deepEqual(attendanceTimes(undefined, event, null), { available_from: '23:30', available_until: '01:00' });
});

test('回答済みの時刻・意図的な空欄は通常営業を変更しても維持する', () => {
  assert.deepEqual(attendanceTimes({ available_from: '21:45', available_until: '00:15' }, {}, hours), {
    available_from: '21:45',
    available_until: '00:15'
  });
  assert.deepEqual(attendanceTimes({ available_from: '', available_until: '' }, {}, hours), {
    available_from: '',
    available_until: ''
  });
});

test('新しい営業は日本時間で次の営業曜日と通常の開始・終了時刻を入れる', () => {
  const now = new Date('2026-11-16T15:30:00Z'); // 日本時間は火曜日。
  assert.deepEqual(newEventTimes(null, now), {});
  assert.deepEqual(newEventTimes({ ...hours, interval_weeks: 1, weekday: 2, end_time: '23:30' }, now), {
    starts_at: '2026-11-17T13:00:00.000Z',
    ends_at: '2026-11-17T14:30:00.000Z'
  });
  assert.deepEqual(newEventTimes(hours, now), {
    starts_at: '2026-11-21T13:00:00.000Z',
    ends_at: '2026-11-21T15:30:00.000Z'
  });
});

test('開始済みの曜日は翌週へ進め、日曜・年越し・翌日終了も正しく扱う', () => {
  assert.deepEqual(newEventTimes({ ...hours, weekday: 2 }, new Date('2026-11-17T13:00:00Z')), {
    starts_at: '2026-11-24T13:00:00.000Z',
    ends_at: '2026-11-24T15:30:00.000Z'
  });
  assert.deepEqual(newEventTimes({ ...hours, weekday: 2 }, new Date('2026-11-17T13:01:00Z')), {
    starts_at: '2026-11-24T13:00:00.000Z',
    ends_at: '2026-11-24T15:30:00.000Z'
  });
  assert.deepEqual(newEventTimes({ ...hours, weekday: 0 }, new Date('2026-12-31T15:00:00Z')), {
    starts_at: '2027-01-03T13:00:00.000Z',
    ends_at: '2027-01-03T15:30:00.000Z'
  });
});
