import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, ids } from './helpers.mjs';
import { seal, unseal, httpsUrl, isAdmin, passphraseHash } from '../src/core.mjs';
import { cookie } from '../src/auth.mjs';
import { markdown, apiBlob } from '../public/ui.mjs';
import { actorFor } from '../src/auth.mjs';
import { limitedBytes } from '../src/core.mjs';
import { createWorker } from '../src/worker.mjs';

test('非公開画像はDiscordの指定時間を待ち、権限エラーでは再取得しない', async t => {
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? Response.json({ code: 'DISCORD_BUSY', retry_after: 0.001 }, { status: 503 })
      : new Response('image-data', { headers: { 'Content-Type': 'image/webp' } });
  const blob = await apiBlob('/api/images/private');
  assert.equal(blob.type, 'image/webp');
  assert.equal(await blob.text(), 'image-data');
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: '閲覧できません' }, { status: 403 });
  };
  await assert.rejects(apiBlob('/api/images/private'), error => error.status === 403);
  assert.equal(calls, 1);
});

test('画面データと認証情報を一度の所属確認で返す', async t => {
  const f = await fixture();
  t.after(f.close);
  for (const [area, user] of [
    ['member', 'customer'],
    ['staff', 'staff'],
    ['manage', 'admin']
  ]) {
    let calls = 0;
    const worker = createWorker(async () => {
      calls++;
      return Response.json({ roles: user === 'admin' ? [f.env.ADMIN_ROLE_IDS] : [] });
    });
    const response = await worker.fetch(
      new Request(f.env.APP_ORIGIN + '/api/' + area, { headers: { Cookie: `__Host-np_session=${f.tokens[user]}` } }),
      f.env,
      {}
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.session.user.id, ids[user]);
    assert.ok(data.session.csrf);
    assert.equal(calls, 1);
  }
});

test('Drive接続でDiscordが混雑しても認証状態を保持して再試行できる', async t => {
  const f = await fixture();
  t.after(f.close);
  const start = await f.request('/auth/google', { user: 'admin' }),
    state = new URL(start.headers.get('Location')).searchParams.get('state');
  const request = () =>
    new Request(f.env.APP_ORIGIN + '/auth/google/callback?state=' + state + '&code=google-code', {
      headers: { Cookie: start.headers.getSetCookie()[0].split(';')[0] + `; __Host-np_session=${f.tokens.admin}` }
    });
  const busy = createWorker(async (url, options) => {
    assert.match(options.headers['User-Agent'], /^DiscordBot \(/);
    return Response.json({ retry_after: 30 }, { status: 429 });
  });
  const failed = await busy.fetch(request(), f.env, {});
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('Retry-After'), '30');
  assert.match(await failed.text(), /接続を再試行/);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM oauth_states').first()).n, 1);
  const recovered = createWorker(async url => {
    if (String(url).includes('discord.com')) return Response.json({ roles: [f.env.ADMIN_ROLE_IDS] });
    if (String(url).includes('oauth2.googleapis.com/token'))
      return Response.json({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/drive.file'
      });
    if (String(url).includes('openidconnect'))
      return Response.json({ sub: 'event-owner', email: 'event@example.test' });
    if (String(url).includes('/drive/v3/files')) return Response.json({ id: 'event-folder' });
    throw new Error('Unexpected remote request');
  });
  const result = await recovered.fetch(request(), f.env, {});
  assert.equal(result.status, 302);
  assert.equal(result.headers.get('Location'), '/manage?drive=connected');
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM oauth_states').first()).n, 0);
  assert.ok(await f.DB.prepare("SELECT value FROM integrations WHERE key='drive'").first());
});

test('同時の所属確認をまとめ、次の確認では再取得する', async t => {
  const f = await fixture();
  t.after(f.close);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ roles: [] });
  };
  const request = () =>
    new Request(f.env.APP_ORIGIN + '/api/member', { headers: { Cookie: `__Host-np_session=${f.tokens.customer}` } });
  await Promise.all([actorFor(request(), f.env, 'member', fetcher), actorFor(request(), f.env, 'member', fetcher)]);
  assert.equal(calls, 1);
  await actorFor(request(), f.env, 'member', fetcher);
  assert.equal(calls, 2);
});
test('Discordの回数制限では待機後に再確認し、確認前には通さない', async t => {
  const f = await fixture();
  t.after(f.close);
  let calls = 0;
  const fetcher = async () =>
    ++calls === 1 ? Response.json({ retry_after: 0.05 }, { status: 429 }) : Response.json({ roles: [] });
  const actor = await actorFor(
    new Request(f.env.APP_ORIGIN + '/api/member', { headers: { Cookie: `__Host-np_session=${f.tokens.customer}` } }),
    f.env,
    'member',
    fetcher
  );
  assert.equal(actor.id, ids.customer);
  assert.equal(calls, 2);
});
test('サイズ不明の分割アップロードでも上限を超えると拒否する', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    }
  });
  await assert.rejects(
    limitedBytes(new Request('https://example.test', { method: 'POST', body: stream, duplex: 'half' }), 10),
    error => error.status === 413
  );
});

test('会員・スタッフ・運営APIは未認証で取得できない', async t => {
  const f = await fixture();
  t.after(f.close);
  for (const path of ['/api/member', '/api/staff', '/api/manage']) assert.equal((await f.request(path)).status, 401);
});
test('顧客サーバーの所属だけではスタッフ・運営に入れない', async t => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.request('/api/member', { user: 'customer' })).status, 200);
  assert.equal((await f.request('/api/staff', { user: 'customer' })).status, 403);
  assert.equal((await f.request('/api/manage', { user: 'customer' })).status, 403);
});
test('運営ロールの剥奪・退会を次のリクエストから反映する', async t => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.request('/api/manage', { user: 'admin' })).status, 200);
  f.members.set(`${ids.admin}:${f.env.STAFF_GUILD_ID}`, { roles: [] });
  assert.equal((await f.request('/api/manage', { user: 'admin' })).status, 403);
  f.members.delete(`${ids.customer}:${f.env.CUSTOMER_GUILD_ID}`);
  assert.equal((await f.request('/api/member', { user: 'customer' })).status, 403);
  assert.equal(isAdmin({ roles: [] }, { ADMIN_ROLE_IDS: '' }), false);
});
test('Discord確認が失敗した場合に保存済み権限で通さない', async t => {
  const f = await fixture();
  t.after(f.close);
  const { createWorker } = await import('../src/worker.mjs');
  const worker = createWorker(async () => new Response('Unavailable', { status: 503 }));
  const response = await worker.fetch(
    new Request(f.env.APP_ORIGIN + '/api/manage', { headers: { Cookie: `__Host-np_session=${f.tokens.admin}` } }),
    f.env,
    {}
  );
  assert.equal(response.status, 503);
});
test('更新操作に同一サイトのOriginとCSRFトークンが必要', async t => {
  const f = await fixture();
  t.after(f.close);
  const options = { user: 'customer', method: 'PUT', body: { cast_ids: [] } };
  assert.equal((await f.request('/api/member/favorites', { ...options, csrf: false })).status, 403);
  assert.equal((await f.request('/api/member/favorites', { ...options, origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/member/favorites', options)).status, 200);
});
test('合言葉と受付時間を検証し、同じ営業を二重に数えない', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  const call = phrase =>
    f.request('/api/member/checkin', {
      user: 'customer',
      method: 'POST',
      body: { event_id: 'event-1', passphrase: phrase }
    });
  assert.equal((await call('ちがう')).status, 400);
  assert.equal((await (await call('ほしぞら')).json()).already, false);
  assert.equal((await (await call('ほしぞら')).json()).already, true);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM visits').first()).n, 1);
  await f.DB.prepare('UPDATE events SET checkin_closes_at=?')
    .bind(new Date(Date.now() - 1000).toISOString())
    .run();
  assert.equal((await call('ほしぞら')).status, 403);
});
test('チェキは受取人と送信者だけが取得でき、無関係な運営にも渡さない', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.cheki();
  for (const user of ['other', 'admin'])
    assert.equal((await f.request('/api/images/cheki-image', { user })).status, 403);
  assert.equal(f.calls.filter(c => c.url.includes('googleapis')).length, 0);
  for (const user of ['customer', 'staff']) {
    const response = await f.request('/api/images/cheki-image', { user });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await response.arrayBuffer()).byteLength, 4);
  }
  assert.equal((await f.request('/api/images/cheki-image')).status, 401);
});
test('顧客退会後・送信者のスタッフ退会後はチェキを表示しない', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.cheki();
  f.members.delete(`${ids.customer}:${f.env.CUSTOMER_GUILD_ID}`);
  f.members.set(`${ids.customer}:${f.env.STAFF_GUILD_ID}`, { roles: [] });
  assert.equal((await f.request('/api/images/cheki-image', { user: 'customer' })).status, 403);
  f.members.delete(`${ids.staff}:${f.env.STAFF_GUILD_ID}`);
  f.members.set(`${ids.staff}:${f.env.CUSTOMER_GUILD_ID}`, { roles: [] });
  assert.equal((await f.request('/api/images/cheki-image', { user: 'staff' })).status, 403);
});
test('送信取り消し後は画像の直URLも取得できない', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.cheki();
  assert.equal(
    (await f.request('/api/staff/cheki/withdraw', { user: 'staff', method: 'POST', body: { id: 'cheki-image' } }))
      .status,
    200
  );
  assert.equal((await f.request('/api/images/cheki-image', { user: 'customer' })).status, 403);
  assert.equal((await (await f.request('/api/member', { user: 'customer' })).json()).cheki.length, 0);
});
test('公開データに下書き・マニュアル・合言葉・会員情報を含めない', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  for (const [id, kind, status] of [
    ['draft', 'news', 'draft'],
    ['manual', 'manual', 'published'],
    ['news', 'news', 'published']
  ])
    await f.DB.prepare(
      'INSERT INTO content(id,kind,slug,title,body,status,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)'
    )
      .bind(id, kind, id, id, 'private body ' + id, status, new Date().toISOString(), ids.admin)
      .run();
  const data = await (await f.request('/api/public')).json();
  assert.deepEqual(
    data.content.map(x => x.id),
    ['news']
  );
  const raw = JSON.stringify(data);
  for (const word of [
    'checkin_hash',
    'checkin_salt',
    'private body manual',
    'private body draft',
    ids.customer,
    'refresh_token'
  ])
    assert.equal(raw.includes(word), false);
});
test('下書き画像は運営、公開マニュアルの画像はスタッフに限定', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.cheki({ image: 'draft-image' });
  await f.DB.prepare("UPDATE images SET visibility='public' WHERE id='draft-image'").run();
  assert.equal((await f.request('/api/images/draft-image')).status, 401);
  assert.equal((await f.request('/api/images/draft-image', { user: 'staff' })).status, 403);
  assert.equal((await f.request('/api/images/draft-image', { user: 'admin' })).status, 200);
  await f.DB.prepare(
    "INSERT INTO content(id,kind,slug,title,body,status,updated_at,updated_by) VALUES('manual','manual','manual','Manual','![図](/api/images/draft-image)','published',?,?)"
  )
    .bind(new Date().toISOString(), ids.admin)
    .run();
  assert.equal((await f.request('/api/images/draft-image', { user: 'staff' })).status, 200);
  assert.equal((await f.request('/api/images/draft-image', { user: 'customer' })).status, 403);
});
test('出欠を本人に紐付け、締切後の書き換えを拒否する', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  const options = {
    user: 'staff',
    method: 'POST',
    body: {
      event_id: 'event-1',
      user_id: ids.admin,
      answer: 'yes',
      duties: ['星空解説', '歌パフォーマンス', '動画編集']
    }
  };
  assert.equal((await f.request('/api/staff/attendance', options)).status, 200);
  assert.equal((await f.DB.prepare('SELECT user_id FROM attendance').first()).user_id, ids.staff);
  await f.DB.prepare('UPDATE events SET response_deadline=?')
    .bind(new Date(Date.now() - 1000).toISOString())
    .run();
  assert.equal((await f.request('/api/staff/attendance', options)).status, 403);
});
test('配置は本人宛ての公開済みだけが見える', async t => {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  for (const [user, details, published] of [
    [ids.staff, '卓1', 1],
    [ids.admin, '卓2', 1]
  ])
    await f.DB.prepare('INSERT INTO assignments(event_id,user_id,details,published) VALUES(?,?,?,?)')
      .bind('event-1', user, details, published)
      .run();
  const data = await (await f.request('/api/staff', { user: 'staff' })).json();
  assert.deepEqual(
    data.assignments.map(a => a.details),
    ['卓1']
  );
  await f.DB.prepare('UPDATE assignments SET published=0').run();
  assert.equal((await (await f.request('/api/staff', { user: 'staff' })).json()).assignments.length, 0);
});
test('OAuth stateはブラウザーと紐付き一度しか使えない', async t => {
  const f = await fixture();
  t.after(f.close);
  const start = await f.request('/auth/discord?area=member&remember=1');
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('Location'));
  assert.equal(authorize.searchParams.get('scope'), 'identify guilds.members.read');
  const binder = start.headers.getSetCookie()[0].split(';')[0],
    callback = '/auth/discord/callback?state=' + authorize.searchParams.get('state') + '&code=test';
  const completed = await f.request(callback, { cookie: binder });
  assert.equal(completed.headers.get('Location'), '/member');
  assert.match(completed.headers.getSetCookie().join(';'), /Max-Age=2592000/);
  assert.match((await f.request(callback, { cookie: binder })).headers.get('Location'), /error=/);
});
test('認証キャンセルは元のスタッフページに戻す', async t => {
  const f = await fixture();
  t.after(f.close);
  const start = await f.request('/auth/discord?area=staff');
  const state = new URL(start.headers.get('Location')).searchParams.get('state');
  const response = await f.request('/auth/discord/callback?state=' + state + '&error=access_denied', {
    cookie: start.headers.getSetCookie()[0].split(';')[0]
  });
  assert.match(response.headers.get('Location'), /^\/staff\?error=/);
});
test('暗号化データは改ざん・別キーで復号できない', async () => {
  const key = Buffer.alloc(32, 2).toString('base64'),
    value = await seal({ refresh_token: 'sensitive' }, key);
  assert.equal(value.includes('sensitive'), false);
  assert.deepEqual(await unseal(value, key), { refresh_token: 'sensitive' });
  await assert.rejects(unseal(value, Buffer.alloc(32, 3).toString('base64')));
  assert.notEqual(
    await passphraseHash('a', 'salt', 'ほしぞら', 'x'.repeat(30)),
    await passphraseHash('b', 'salt', 'ほしぞら', 'x'.repeat(30))
  );
});
test('ログインCookieはHTTPS限定・JavaScript非公開', () => {
  const value = cookie({ APP_ORIGIN: 'https://example.test' }, 'session', 'token', 2592000);
  for (const part of ['__Host-np_session=', 'HttpOnly', 'SameSite=Lax', 'Secure', 'Path=/', 'Max-Age=2592000'])
    assert.ok(value.includes(part));
});
test('記事のHTML・危険なURLを実行せず表示する', () => {
  assert.throws(
    () => httpsUrl('not a url'),
    e => e.status === 400
  );
  assert.throws(
    () => httpsUrl('javascript:alert(1)'),
    e => e.status === 400
  );
  const html = markdown('<img src=x onerror=alert(1)>\n**強調**\n![写真](/api/images/test)');
  assert.match(html, /&lt;img/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /<strong>強調<\/strong>/);
  assert.match(html, /<img src="\/api\/images\/test"/);
});
test('公開ナビに管理用リンクを出さず指定コピーとSVGを使う', () => {
  const html = readFileSync('public/index.html', 'utf8');
  assert.match(html, /今宵、星降るドームで夜想曲を。/);
  assert.ok(!/href="\/(staff|manage)/.test(html));
  assert.match(html, /logo-dark\.svg/);
  assert.ok(!/<script(?![^>]*src=)/.test(html));
});
