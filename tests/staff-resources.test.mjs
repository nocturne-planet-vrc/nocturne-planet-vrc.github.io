import test from 'node:test';
import assert from 'node:assert/strict';
import { placementCards } from '../public/placement.mjs';
import { fixture, ids } from './helpers.mjs';

const seats = () => Array.from({ length: 9 }, () => ({ in_use: true, user_id: '', name: '' }));

test('3×3の卓図に固定ルートを描き、未使用の卓は順番を保って飛ばす', () => {
  const input = seats();
  input[0].name = '初回キャスト';
  const html = placementCards([{ seats: input, staff: [] }]);
  assert.deepEqual(
    [...html.matchAll(/data-table-number="(\d+)"/g)].map(match => Number(match[1])),
    [9, 8, 7, 6, 5, 4, 3, 2, 1]
  );
  assert.match(html, /初回の担当/);
  assert.match(html, /初回キャスト/);
  assert.match(html, /南（舞台側）/);
  const routes = markup =>
    Object.fromEntries(
      [...markup.matchAll(/data-table-number="(\d+)" data-destination="(\d+)"/g)].map(([, from, to]) => [
        from,
        Number(to)
      ])
    );
  assert.deepEqual(routes(html), { 1: 2, 2: 3, 3: 9, 9: 8, 8: 7, 7: 4, 4: 5, 5: 6, 6: 1 });
  input[1].in_use = false;
  assert.deepEqual(routes(placementCards([{ seats: input, staff: [] }])), {
    1: 3,
    3: 9,
    9: 8,
    8: 7,
    7: 4,
    4: 5,
    5: 6,
    6: 1
  });
});

test('対象営業回に参加するDiscordアカウントだけを配置し、公開範囲と更新の競合を確認する', async t => {
  const f = await fixture();
  t.after(f.close);
  const event = await f.event();
  await f.event('other-event');
  await f.DB.prepare('INSERT INTO assignments(event_id,user_id,details,published) VALUES(?,?,?,1)')
    .bind(event.id, ids.staff, '本人宛て')
    .run();
  const mark = (eventId, userId, answer) =>
    f.DB.prepare(
      `INSERT INTO attendance(event_id,user_id,answer,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(event_id,user_id) DO UPDATE SET answer=excluded.answer`
    )
      .bind(eventId, userId, answer, new Date().toISOString())
      .run();
  await mark(event.id, ids.staff, 'yes');
  await mark(event.id, ids.admin, 'maybe');
  await mark(event.id, ids.customer, 'no');
  await mark('other-event', ids.other, 'yes');
  await f.DB.prepare('INSERT INTO staff_directory(user_id,display_name,synced_at) VALUES(?,?,?)')
    .bind(ids.staff, 'サーバー表示名', new Date().toISOString())
    .run();
  const placement = '/api/manage/placement';
  const staffPlacement = () => f.request('/api/staff/placement', { user: 'staff' }).then(response => response.json());
  const update = (body, user = 'admin') => f.request(placement, { user, method: 'POST', body });
  const input = seats();
  input[0].user_id = ids.staff;
  input[0].name = '送信した表示名';
  const entry = { event_id: event.id, instances: [{ seats: input, staff: [] }], published: false, revision: null };
  assert.equal((await update(entry, 'staff')).status, 403);
  assert.equal((await f.request('/api/staff/placement', { user: 'customer' })).status, 403);
  const candidates = await (await f.request(placement + '?event_id=' + event.id, { user: 'admin' })).json();
  assert.deepEqual(candidates.attendees, [{ id: ids.staff, name: 'サーバー表示名' }]);
  const draft = await (await update(entry)).json();
  assert.ok(draft.revision);
  assert.deepEqual((await staffPlacement()).instances, []);
  const draftRead = await (await f.request(placement + '?event_id=' + event.id, { user: 'admin' })).json();
  assert.equal(draftRead.instances[0].seats[0].name, 'サーバー表示名');
  assert.equal((await update({ ...entry, published: true })).status, 409);
  const invalid = structuredClone(entry);
  invalid.instances[0].seats[0].user_id = ids.other;
  assert.equal((await update({ ...invalid, revision: draft.revision, published: true })).status, 400);
  entry.instances[0].staff = [{ user_id: ids.admin, role: 'pa' }];
  assert.equal((await update({ ...entry, revision: draft.revision, published: true })).status, 400);
  await mark(event.id, ids.admin, 'yes');
  const withStaff = staff => ({
    ...entry,
    revision: draft.revision,
    published: true,
    instances: [{ ...entry.instances[0], staff }]
  });
  assert.equal((await update(withStaff([{ user_id: ids.admin, role: 'unknown' }]))).status, 400);
  assert.equal((await update(withStaff([...entry.instances[0].staff, ...entry.instances[0].staff]))).status, 400);
  entry.instances[0].staff.push({ user_id: ids.admin, role: 'lighting' });
  const live = await update({ ...entry, revision: draft.revision, published: true });
  assert.equal(live.status, 200);
  const published = await staffPlacement();
  assert.equal(published.event.id, event.id);
  assert.deepEqual(published.instances[0].seats[0], { in_use: true, name: 'サーバー表示名' });
  assert.deepEqual(published.instances[0].staff, [
    { name: 'admin', role: 'pa' },
    { name: 'admin', role: 'lighting' }
  ]);
  const html = placementCards(published.instances);
  assert.match(html, /<dt>ホールスタッフ<\/dt>/);
  assert.match(html, /<dt>バー担当<\/dt>/);
  assert.match(html, /<dt>カメラ<\/dt>/);
  assert.match(html, /<dt>照明<\/dt>\s*<dd><ul><li>admin<\/li>/);
  assert.match(html, /<dt>PA<\/dt>\s*<dd><ul><li>admin<\/li>/);
  await mark(event.id, ids.staff, 'no');
  const version = (await live.json()).revision;
  assert.equal((await update({ ...entry, revision: version, published: true })).status, 400);
  const legacy = await (await f.request('/api/staff', { user: 'staff' })).json();
  assert.equal(legacy.assignments[0].details, '本人宛て');
  assert.deepEqual(legacy.placement, published);
  assert.ok(legacy.cheki_events.some(item => item.id === event.id));
  const legacySeats = [
    ...entry.instances[0].seats,
    ...Array.from({ length: 3 }, () => ({ in_use: false, fixed: false, name: '', next_name: '' }))
  ];
  await f.DB.prepare('UPDATE event_placements SET instances=? WHERE event_id=?')
    .bind(JSON.stringify([{ seats: legacySeats, staff: ['旧配置のスタッフ'] }]), event.id)
    .run();
  const legacyPlacement = (await staffPlacement()).instances[0];
  assert.equal(legacyPlacement.seats.length, 9);
  assert.deepEqual(legacyPlacement.staff, [{ name: '旧配置のスタッフ', role: '' }]);
  Object.assign(legacySeats[9], { in_use: true, name: '旧配置の担当者' });
  await f.DB.prepare('UPDATE event_placements SET instances=? WHERE event_id=?')
    .bind(JSON.stringify([{ seats: legacySeats, staff: [] }]), event.id)
    .run();
  assert.equal((await staffPlacement()).instances[0].seats[9].name, '旧配置の担当者');
  await f.DB.prepare("UPDATE events SET published=0 WHERE id='other-event'").run();
  await f.DB.prepare('UPDATE events SET published=0 WHERE id=?').bind(event.id).run();
  assert.deepEqual(await staffPlacement(), { event: null, instances: [] });
});

test('Google ドキュメントの共有リンクは公開済みマニュアルを読める人だけに返す', async t => {
  const f = await fixture();
  t.after(f.close);
  const url = 'https://docs.google.com/document/d/test-id/edit?tab=t.example#heading=h.test';
  const values = { kind: 'manual', slug: 'service', title: '接客マニュアル', body: 'サイトの補足', status: 'draft' };
  const write = (body, user = 'admin') => f.request('/api/manage/content', { user, method: 'POST', body });
  const manuals = () =>
    f
      .request('/api/staff/manuals', { user: 'staff' })
      .then(response => response.json())
      .then(data => data.manuals);
  assert.equal((await write({ ...values, google_doc_url: url }, 'staff')).status, 403);
  assert.equal(
    (await write({ ...values, google_doc_url: 'https://docs.google.com.evil.test/document/d/test-id/edit' })).status,
    400
  );
  const { id } = await (await write({ ...values, google_doc_url: url })).json();
  assert.deepEqual(await manuals(), []);
  assert.equal((await write({ ...values, id, status: 'published' })).status, 200);
  assert.equal((await manuals())[0].google_doc_url, url);
  assert.equal((await f.request('/api/staff/manuals', { user: 'customer' })).status, 403);
  assert.equal((await (await f.request('/api/public')).text()).includes(url), false);
  assert.equal((await write({ ...values, id, status: 'published', google_doc_url: '' })).status, 200);
  assert.equal((await manuals())[0].google_doc_url, null);
});

test('Google ドキュメント本文を公開時に取り込み、再公開までスタッフに保存済みの本文を返す', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.connectDrive();
  const create = await f.request('/api/manage/manual-document', {
    user: 'admin',
    method: 'POST',
    body: { title: '接客マニュアル' }
  });
  assert.equal(create.status, 200);
  const { url } = await create.json();
  const idInDrive = new URL(url).pathname.split('/')[3];
  f.manualDocuments.set(
    idInDrive,
    [
      '# 受付時の案内',
      '',
      '1. お客様に挨拶します。',
      '2. 卓へご案内します。',
      '',
      '| 場面 | 案内 |',
      '| --- | --- |',
      '| 開始 | **挨拶** |',
      '',
      '<script>危険な要素</script>',
      '![画像の説明](https://example.test/photo.png)',
      '[リンク](javascript:alert%281%29)'
    ].join('\n')
  );
  const preview = await f.request('/api/manage/manual-document/preview', {
    user: 'admin',
    method: 'POST',
    body: { url }
  });
  assert.equal(preview.status, 200);
  const { html } = await preview.json();
  assert.match(html, /<h1>受付時の案内<\/h1>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>挨拶<\/strong>/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
  const body = {
    kind: 'manual',
    slug: 'doc-manual',
    title: '接客マニュアル',
    body: '補足です。',
    google_doc_url: url,
    google_doc_inline: true
  };
  const write = fields =>
    f.request('/api/manage/content', { user: 'admin', method: 'POST', body: { ...body, ...fields } });
  const { id } = await (await write({ status: 'draft' })).json();
  const path = '/api/staff/manuals/' + id + '/document';
  assert.equal((await f.request(path, { user: 'staff' })).status, 404);
  assert.equal(
    (await write({ id, status: 'published', google_doc_url: 'https://docs.google.com/document/d/unavailable/edit' }))
      .status,
    409
  );
  const exports = () => f.calls.filter(call => call.url.includes('/export?')).length;
  const before = exports();
  assert.equal((await write({ id, status: 'published' })).status, 200);
  assert.equal(exports(), before + 1);
  assert.equal((await f.request(path, { user: 'customer' })).status, 403);
  const first = await f.request(path, { user: 'staff' });
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.match((await first.json()).html, /受付時の案内/);
  const staffOverview = async () => (await f.request('/api/staff', { user: 'staff' })).json();
  assert.match((await staffOverview()).manuals[0].google_doc_html, /受付時の案内/);
  assert.equal((await f.request('/api/staff', { user: 'customer' })).status, 403);
  // The first snapshot release wrote a bare UUID, including for documents saved before this upgrade.
  await f.DB.prepare(
    "UPDATE manual_document_cache SET source_key=substr(source_key, length('published:')+1),fetched_at=0 WHERE content_id=?"
  )
    .bind(id)
    .run();
  f.manualDocuments.set(idInDrive, '# 新しい説明\n\n原本で更新しました。');
  assert.match((await staffOverview()).manuals[0].google_doc_html, /受付時の案内/);
  assert.match((await (await f.request(path, { user: 'admin' })).json()).html, /受付時の案内/);
  assert.equal(exports(), before + 1);
  const fresh = await f.request('/api/manage/manual-document/preview', {
    user: 'admin',
    method: 'POST',
    body: { url }
  });
  assert.match((await fresh.json()).html, /原本で更新しました/);
  assert.equal((await write({ id, status: 'published' })).status, 200);
  assert.match((await (await f.request(path, { user: 'staff' })).json()).html, /原本で更新しました/);
  assert.match((await staffOverview()).manuals[0].google_doc_html, /原本で更新しました/);
  assert.equal(exports(), before + 3);
  assert.equal((await (await f.request('/api/public')).text()).includes('原本で更新しました'), false);
  f.manualDocuments.delete(idInDrive);
  assert.equal((await write({ id, status: 'published' })).status, 409);
  assert.match((await staffOverview()).manuals[0].google_doc_html, /原本で更新しました/);
  assert.equal((await write({ id, status: 'archived' })).status, 200);
  assert.equal((await f.request(path, { user: 'staff' })).status, 404);
  assert.deepEqual((await staffOverview()).manuals, []);
  assert.equal(await f.DB.prepare('SELECT content_id FROM manual_document_cache').first(), null);
});

test('旧方式でキャッシュした公開マニュアルを初回に取り込み直し、長い本文も再利用する', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.connectDrive();
  const stamp = new Date().toISOString();
  await f.DB.prepare(
    "INSERT INTO content(id,kind,slug,title,status,updated_at,updated_by) VALUES('legacy','manual','legacy','既存マニュアル','published',?,?)"
  )
    .bind(stamp, ids.admin)
    .run();
  await f.DB.prepare(
    "INSERT INTO manual_google_docs(content_id,url,inline_body) VALUES('legacy','https://docs.google.com/document/d/legacy/edit',1)"
  ).run();
  await f.DB.prepare(
    "INSERT INTO manual_document_cache(content_id,source_key,html,fetched_at) VALUES('legacy','old-hash','<p>古い本文</p>',?)"
  )
    .bind(Date.now())
    .run();
  const overview = () => f.request('/api/staff', { user: 'staff' }).then(response => response.json());
  assert.equal((await overview()).manuals[0].google_doc_html, null);
  const path = '/api/staff/manuals/legacy/document';
  const raw = 'あ'.repeat(299_996) + '🌟' + 'い'.repeat(40_000);
  f.manualDocuments.set('legacy', raw);
  const read = () => f.request(path, { user: 'staff' }).then(response => response.json());
  assert.equal((await read()).html, `<p>${raw}</p>\n`);
  const part = await f.DB.prepare(
    "SELECT html FROM manual_document_parts WHERE content_id='legacy' AND part=1"
  ).first();
  assert.ok(part.html.startsWith('🌟'));
  await f.DB.prepare(
    "UPDATE manual_document_cache SET source_key=substr(source_key, length('published:')+1) WHERE content_id='legacy'"
  ).run();
  f.manualDocuments.delete('legacy');
  assert.equal((await read()).html, `<p>${raw}</p>\n`);
  assert.equal(f.calls.filter(call => call.url.includes('/export?')).length, 1);
  assert.equal((await overview()).manuals[0].google_doc_html, null);
  await f.request('/api/manage/content', {
    user: 'admin',
    method: 'POST',
    body: { id: 'legacy', kind: 'manual', slug: 'legacy', title: '既存マニュアル', status: 'archived' }
  });
  assert.equal((await f.request(path, { user: 'staff' })).status, 404);
  assert.equal(await f.DB.prepare('SELECT content_id FROM manual_document_parts').first(), null);
});
