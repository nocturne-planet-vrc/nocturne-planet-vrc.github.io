import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

test('今後の営業一覧は公開済み・終了前だけを日時順に返し、内部情報を渡さない', async t => {
  const f = await fixture();
  t.after(f.close);
  const later = offset => new Date(Date.now() + offset * 86400000).toISOString();
  await f.event('later', { starts_at: later(4), ends_at: later(4.1), category: '特別営業' });
  await f.event('next', { starts_at: later(1), ends_at: later(1.1) });
  await f.event('draft', { published: 0, starts_at: later(2), ends_at: later(2.1), title: '非公開の営業' });
  await f.event('past', { starts_at: later(-2), ends_at: later(-1) });
  await f.event('ongoing');
  const response = await f.request('/api/schedule');
  assert.equal(response.status, 200);
  const { events } = await response.json();
  assert.deepEqual(
    events.map(e => e.id),
    ['ongoing', 'next', 'later']
  );
  assert.equal(events[1].category, '通常営業');
  assert.equal(events[2].category, '特別営業');
  assert.deepEqual(Object.keys(events[0]).sort(), ['category', 'description', 'ends_at', 'id', 'starts_at', 'title']);
  for (let n = 0; n < 65; n++) await f.event(`extra-${n}`, { starts_at: later(n + 6), ends_at: later(n + 6.1) });
  assert.equal((await (await f.request('/api/schedule')).json()).events.length, 68);
});

test('営業ラベルは運営が保存でき、未指定の編集では既存ラベルを維持する', async t => {
  const f = await fixture();
  t.after(f.close);
  const event = await f.event();
  const body = {
    id: event.id,
    title: '特別公演',
    description: '星空の解説',
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    published: true,
    category: '特別営業'
  };
  for (const [user, status] of [
    [undefined, 401],
    ['customer', 403],
    ['staff', 403]
  ])
    assert.equal((await f.request('/api/manage/events', { user, method: 'POST', body })).status, status);
  assert.equal(
    (await f.request('/api/manage/events', { user: 'admin', method: 'POST', csrf: false, body })).status,
    403
  );
  assert.equal((await f.request('/api/manage/events', { user: 'admin', method: 'POST', body })).status, 200);
  assert.equal((await (await f.request('/api/schedule')).json()).events[0].category, '特別営業');
  delete body.category;
  assert.equal((await f.request('/api/manage/events', { user: 'admin', method: 'POST', body })).status, 200);
  assert.equal(
    (await f.DB.prepare('SELECT category FROM events WHERE id=?').bind(event.id).first()).category,
    '特別営業'
  );
  assert.equal(
    (await f.request('/api/manage/events', { user: 'admin', method: 'POST', body: { ...body, category: '記念営業' } }))
      .status,
    200
  );
  for (const category of ['', '   ', 'あ'.repeat(25), {}])
    assert.equal(
      (await f.request('/api/manage/events', { user: 'admin', method: 'POST', body: { ...body, category } })).status,
      400
    );
  assert.equal(
    (await f.DB.prepare('SELECT category FROM events WHERE id=?').bind(event.id).first()).category,
    '記念営業'
  );
});

test('今後の営業予定のURLを直接開ける', async t => {
  const f = await fixture();
  t.after(f.close);
  for (const path of ['/schedule', '/schedule/']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /href="\/schedule"/);
  }
});
