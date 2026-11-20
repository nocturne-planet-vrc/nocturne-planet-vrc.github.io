import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ids } from './helpers.mjs';
import { siteContent, siteDefaults, durationLabel } from '../public/site-content.mjs';
import { recruitContent, recruitDefaults, renderRecruitPage } from '../public/recruit-content.mjs';

const save = (f, body, extra = {}) =>
  f.request('/api/manage/settings', { user: 'admin', method: 'POST', body, ...extra });
const settings = async f => (await (await f.request('/api/public')).json()).settings;
async function setup(t) {
  const f = await fixture();
  t.after(f.close);
  return f;
}
async function image(f, id, visibility = 'public') {
  await f.DB.prepare(
    'INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)'
  )
    .bind(id, 'drive-' + id, 'image/webp', 4, visibility, ids.admin, new Date().toISOString())
    .run();
}

test('開催場所・会場URL・所要時間・プログラム・施設紹介を運営だけが保存できる', async t => {
  const f = await setup(t),
    body = {
      ...structuredClone(siteDefaults),
      venue: '新しい星空ワールド',
      venue_url: 'https://vrchat.com/home/world/wrld_123',
      main_minutes: 90,
      after_minutes: 20,
      facility_intro: '新しい施設の案内\n2行目です。'
    };
  body.programs[0].title = '今夜の天体';
  body.programs[0].minutes = 20;
  body.facilities[0].title = '新しいドーム';
  for (const [user, status] of [
    [undefined, 401],
    ['customer', 403],
    ['staff', 403]
  ])
    assert.equal((await save(f, body, { user })).status, status);
  assert.equal((await save(f, body, { csrf: false })).status, 403);
  assert.equal((await save(f, body)).status, 200);
  const saved = await settings(f);
  for (const key of Object.keys(body)) assert.deepEqual(saved[key], body[key]);
  assert.equal(durationLabel(siteContent(saved)), '本編90分 ＋ アフター20分');
});

test('従来の設定の保存や一部だけの更新で、開催場所・紹介写真・通常営業を消さない', async t => {
  const f = await setup(t),
    original = await settings(f);
  const hours = { interval_weeks: 2, weekday: 6, start_time: '22:00', end_time: '23:30' };
  await f.request('/api/manage/schedule', { user: 'admin', method: 'POST', body: { regular_hours: hours } });
  await save(f, { venue: '変更した会場', programs: siteDefaults.programs, facilities: siteDefaults.facilities });
  assert.equal((await save(f, { ...original, about: '更新した概要' })).status, 200);
  assert.equal((await save(f, { cadence: '祝日は変更する場合があります' })).status, 200);
  const saved = await settings(f);
  assert.equal(saved.venue, '変更した会場');
  assert.equal(saved.about, '更新した概要');
  assert.deepEqual(saved.programs, siteDefaults.programs);
  assert.deepEqual(saved.facilities, siteDefaults.facilities);
  assert.deepEqual(saved.regular_hours, hours);
  assert.equal(saved.x_url, original.x_url);
});

test('不正な会場URL・時間・紹介内容は設定を一部も更新せず拒否する', async t => {
  const f = await setup(t),
    original = await settings(f);
  const bad = [
    { venue: '' },
    { venue: 'x'.repeat(161) },
    { venue_url: 'javascript:alert(1)' },
    { venue_url: 'http://example.test/world' },
    { main_minutes: -1 },
    { main_minutes: 600.5 },
    { after_minutes: 601 },
    { main_minutes: 30 },
    { main_minutes: '90' },
    { programs: [] },
    { facilities: {} },
    { programs: [null, null, null] }
  ];
  for (const body of bad) {
    assert.equal((await save(f, { about: '保存されない説明', ...body })).status, 400, JSON.stringify(body));
    assert.deepEqual(await settings(f), original);
  }
  const programs = structuredClone(siteDefaults.programs);
  programs[0].minutes = 601;
  assert.equal((await save(f, { programs })).status, 400);
});

test('募集フォームのURLを保存・差し替え・解除でき、不正なリンクを保存しない', async t => {
  const f = await setup(t),
    url = 'https://docs.google.com/forms/d/e/example/viewform';
  assert.equal((await save(f, { recruit_url: url })).status, 200);
  assert.equal((await settings(f)).recruit_url, url);
  await save(f, { cadence: '毎月開催' });
  assert.equal((await settings(f)).recruit_url, url);
  for (const bad of ['javascript:alert(1)', 'http://example.test', 'https://user:pass@example.test']) {
    assert.equal((await save(f, { recruit_url: bad })).status, 400);
    assert.equal((await settings(f)).recruit_url, url);
  }
  assert.equal((await save(f, { recruit_url: 'https://forms.gle/example' })).status, 200);
  assert.equal((await settings(f)).recruit_url, 'https://forms.gle/example');
  assert.equal((await save(f, { recruit_url: '' })).status, 200);
  assert.equal((await settings(f)).recruit_url, '');
});

test('募集ページの構成・列数・非表示・応募案内を保存し、ほかのサイト設定の保存でも保持する', async t => {
  const f = await setup(t),
    page = structuredClone(recruitDefaults),
    url = 'https://forms.gle/recruit';
  page.image_side = 'left';
  page.title = '新しい募集の見出し';
  page.sections.reverse();
  page.sections[0].enabled = false;
  page.sections[1].tone = 'paper';
  page.sections[2].columns = 1;
  page.sections.push({
    id: 'new-section',
    type: 'text',
    title: '活動のルール',
    body: '新しい説明',
    enabled: true,
    columns: 1,
    tone: 'cream',
    items: []
  });
  assert.equal((await save(f, { recruit_page: page, recruit_url: url })).status, 200);
  await save(f, { venue: '新しい会場' });
  assert.deepEqual((await settings(f)).recruit_page, page);
  const html = renderRecruitPage(recruitContent(await settings(f)), url);
  assert.ok(html.includes('新しい募集の見出し'));
  assert.ok(html.includes('活動のルール'));
  assert.ok(!html.includes('id="flow"'));
  assert.ok(html.includes('columns-1'));
  assert.ok(html.includes('image-left'));
  assert.ok(html.includes(url));
  const copy = recruitContent();
  copy.sections[0].title = '変更';
  assert.notEqual(recruitDefaults.sections[0].title, '変更');
});

test('募集ページの不正な構成は保存せず、公開文章はHTMLとして実行しない', async t => {
  const f = await setup(t),
    original = await settings(f);
  for (const change of [
    p => (p.sections[0].type = 'script'),
    p => (p.sections[0].id = 'contact'),
    p => (p.sections[1].id = p.sections[0].id),
    p => (p.sections[0].enabled = 'yes'),
    p => (p.sections[0].columns = 4),
    p => (p.sections[0].tone = 'url(javascript:1)'),
    p => (p.sections = Array(13).fill(p.sections[0])),
    p => (p.contact.items = 'invalid'),
    p => (p.image = 'https://example.test/photo'),
    p => (p.title = '')
  ]) {
    const page = structuredClone(recruitDefaults);
    change(page);
    assert.equal((await save(f, { recruit_page: page })).status, 400);
    assert.deepEqual(await settings(f), original);
  }
  const page = structuredClone(recruitDefaults);
  page.title = '<img src=x onerror=alert(1)>';
  page.sections[0].items[0].body = '<script>alert(1)</script>';
  page.contact.button_label = '<iframe>';
  const html = renderRecruitPage(page, 'javascript:alert(1)');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('受付準備中') || html.includes('準備中'));
});

test('募集ページの写真は公開用画像だけを使い、取り外した写真は公開しない', async t => {
  const f = await setup(t);
  await f.connectDrive();
  await image(f, 'recruit-photo');
  await image(f, 'private-recruit', 'private');
  const page = structuredClone(recruitDefaults);
  page.image = 'private-recruit';
  assert.equal((await save(f, { recruit_page: page })).status, 400);
  page.image = 'recruit-photo';
  assert.equal((await save(f, { recruit_page: page })).status, 200);
  assert.equal((await f.request('/api/images/recruit-photo')).status, 200);
  assert.equal((await save(f, { recruit_page: recruitDefaults })).status, 200);
  assert.equal((await f.request('/api/images/recruit-photo')).status, 401);
});

test('紹介写真は同梱写真か公開用画像に限定し、使用をやめた写真は公開しない', async t => {
  const f = await setup(t);
  await f.connectDrive();
  await image(f, 'program-photo');
  await image(f, 'facility-photo');
  await image(f, 'private-photo', 'private');
  const programs = structuredClone(siteDefaults.programs),
    facilities = structuredClone(siteDefaults.facilities);
  programs[0].image = 'program-photo';
  facilities[0].image = 'facility-photo';
  assert.equal((await f.request('/api/images/program-photo')).status, 401);
  assert.equal((await save(f, { programs, facilities })).status, 200);
  assert.equal((await f.request('/api/images/program-photo')).status, 200);
  assert.equal((await f.request('/api/images/facility-photo')).status, 200);
  for (const ref of [
    'private-photo',
    'missing',
    '/assets/unknown.webp',
    'https://example.test/photo.jpg',
    '../secret'
  ]) {
    programs[0].image = ref;
    assert.equal((await save(f, { programs })).status, 400, ref);
  }
  assert.equal((await f.request('/api/images/private-photo')).status, 401);
  assert.equal((await save(f, { programs: siteDefaults.programs, facilities: siteDefaults.facilities })).status, 200);
  assert.equal((await f.request('/api/images/program-photo')).status, 401);
  assert.equal((await f.request('/api/images/facility-photo')).status, 401);
});

test('未設定のサイトでも管理画面とホームが同じ初期値を使い、HTMLを含む文章をそのまま保存する', async t => {
  const f = await setup(t),
    first = siteContent(await settings(f));
  assert.equal(first.venue, siteDefaults.venue);
  assert.equal(first.main_minutes, 75);
  assert.deepEqual(first.facilities, siteDefaults.facilities);
  first.programs[0].title = 'コピーを変えても初期値を変更しない';
  assert.equal(siteDefaults.programs[0].title, '星空解説');
  const name = '<img src=x onerror=alert(1)>',
    programs = structuredClone(siteDefaults.programs);
  programs[0].description = '<script>alert(1)</script>';
  assert.equal((await save(f, { venue: name, programs })).status, 200);
  const saved = siteContent(await settings(f));
  assert.equal(saved.venue, name);
  assert.equal(saved.programs[0].description, '<script>alert(1)</script>');
  assert.equal((await save(f, { x_url: '', youtube_url: '', discord_invite: '', cadence: '' })).status, 200);
  const cleared = await settings(f);
  for (const key of ['x_url', 'youtube_url', 'discord_invite', 'cadence']) assert.equal(cleared[key], '');
});
