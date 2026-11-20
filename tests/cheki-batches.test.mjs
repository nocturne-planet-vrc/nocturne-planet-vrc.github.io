import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ids } from './helpers.mjs';

// Synthetic 1px PNG; no user image, token, or external service is used.
const png = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64')
);
const preview = f => f.request('/api/staff/recipients?event_id=event-1', { user: 'staff' });
const count = async (f, table) => (await f.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n;
async function setup(t) {
  const f = await fixture();
  t.after(f.close);
  await f.event();
  await f.cast();
  await f.favorite();
  await f.visit();
  await f.connectDrive();
  f.audience = await (await preview(f)).json();
  return f;
}
function body(
  f,
  {
    batchId = crypto.randomUUID(),
    eventId = 'event-1',
    hash = f.audience.audience_hash,
    message = '星空の思い出',
    bytes = png,
    mime = 'image/png',
    filename = 'test.png',
    extra = {}
  } = {}
) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    event_id: eventId,
    audience_hash: hash,
    batch_id: batchId,
    message,
    ...extra
  }))
    form.set(key, value);
  form.set('image', new File([bytes], filename, { type: mime }));
  return form;
}
const send = (f, form, options = {}) =>
  f.request('/api/staff/cheki', { user: 'staff', method: 'POST', body: form, ...options });
async function result(response, status = 200) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function noDelivery(f) {
  assert.equal(await count(f, 'cheki_deliveries'), 0);
  assert.equal(await count(f, 'images'), 0);
  assert.equal(await count(f, 'audit_log'), 0);
}
const batchRow = (f, id) => f.DB.prepare('SELECT * FROM cheki_batches WHERE id=?').bind(id).first();
const isDeliveryBatch = ({ statements }) => statements.some(s => s.sql.startsWith('WITH eligible AS'));

test('一斉送信は対象者だけに配信し、Drive画像1枚を共有して旧chekiを保持する', async t => {
  const f = await setup(t);
  await f.favorite(ids.other);
  await f.visit(ids.other);
  await f.favorite(ids.admin);
  await f.visit(ids.admin);
  f.audience = await (await preview(f)).json();
  await f.cheki({ image: 'legacy' });
  const batchId = crypto.randomUUID(),
    data = await result(await send(f, body(f, { batchId })));
  assert.deepEqual(data, { ok: true, id: batchId, count: 2, already: false });
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(f.uploads[0].bytes, png);
  assert.equal(f.uploads[0].mime, 'image/png');
  assert.deepEqual(f.uploads[0].metadata.parents, ['private-folder']);
  assert.ok(!Object.hasOwn(f.uploads[0].metadata, 'permissions'));
  const batch = await batchRow(f, batchId);
  assert.equal(batch.state, 'sent');
  assert.equal(batch.sender_id, ids.staff);
  assert.equal(batch.cast_id, 'cast-1');
  assert.equal(batch.event_id, 'event-1');
  const image = await f.DB.prepare('SELECT * FROM images WHERE id=?').bind(batch.image_id).first();
  assert.equal(image.visibility, 'private');
  assert.equal(image.size, png.length);
  assert.equal(image.uploaded_by, ids.staff);
  assert.deepEqual(
    (await f.DB.prepare('SELECT recipient_id FROM cheki_deliveries ORDER BY recipient_id').all()).results.map(
      r => r.recipient_id
    ),
    [ids.customer, ids.other]
  );
  assert.equal(await count(f, 'images'), 2);
  assert.equal(await count(f, 'cheki'), 1);
  assert.equal(await count(f, 'audit_log'), 1);
  assert.equal(f.deletions.length, 0);
  const history = await result(await f.request('/api/staff', { user: 'staff' }));
  assert.equal(history.sent.find(r => r.id === batchId).recipient_count, 2);
  assert.ok(history.sent.some(r => r.id === 'legacy'));
  const serialized = JSON.stringify({ data, history: history.sent });
  for (const secret of [ids.customer, ids.other, 'uploaded-drive-', 'private-folder'])
    assert.ok(!serialized.includes(secret), secret);
});

test('同じUUIDと内容の再送はalreadyになり条件変更・取消後も再配信しない', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  assert.deepEqual(await result(await send(f, body(f, { batchId, filename: 'renamed.png' }))), {
    ok: true,
    id: batchId,
    count: 1,
    already: true
  });
  await f.DB.prepare('DELETE FROM favorites').run();
  await f.DB.prepare('UPDATE casts SET active=0').run();
  await result(await f.request('/api/staff/cheki/withdraw', { user: 'staff', method: 'POST', body: { id: batchId } }));
  assert.equal((await result(await send(f, body(f, { batchId })))).already, true);
  assert.equal((await batchRow(f, batchId)).withdrawn, 1);
  assert.equal(f.uploads.length, 1);
  assert.equal(await count(f, 'cheki_deliveries'), 1);
  assert.equal(
    (await f.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action='cheki.batch.send'").first()).n,
    1
  );
});

for (const [label, changes] of [
  ['メッセージ', { message: '別の本文' }],
  ['営業回', { eventId: 'event-2' }],
  ['対象hash', { hash: 'different-audience' }],
  ['画像の内容', { bytes: new Uint8Array([...png.slice(0, -1), png.at(-1) ^ 1]) }],
  ['画像形式', { bytes: new Uint8Array([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]), mime: 'image/jpeg' }]
])
  test(`同じUUIDで${label}が違う再送は拒否する`, async t => {
    const f = await setup(t),
      batchId = crypto.randomUUID();
    await f.event('event-2');
    await result(await send(f, body(f, { batchId })));
    await result(await send(f, body(f, { batchId, ...changes })), 409);
    assert.equal(f.uploads.length, 1);
    assert.equal(await count(f, 'cheki_deliveries'), 1);
  });

test('別の送信者は他人のUUIDを再利用できない', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  await result(await send(f, body(f, { batchId }), { user: 'admin' }), 409);
  assert.equal(f.uploads.length, 1);
});

test('アップロード中の同じUUID要求はpendingで拒否し画像を二重保存しない', { timeout: 5000 }, async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  let entered, release;
  const uploading = new Promise(resolve => {
      entered = resolve;
    }),
    gate = new Promise(resolve => {
      release = resolve;
    });
  f.hooks.uploadHook = async () => {
    entered();
    await gate;
  };
  const first = send(f, body(f, { batchId }));
  try {
    await uploading;
    assert.equal((await batchRow(f, batchId)).state, 'pending');
    assert.equal((await result(await send(f, body(f, { batchId })), 409)).code, 'CHEKI_PENDING');
    await result(await send(f, body(f, { batchId, message: '変更' })), 409);
    assert.equal(f.uploads.length, 1);
  } finally {
    release();
    await result(await first);
  }
  assert.equal((await result(await send(f, body(f, { batchId })))).already, true);
  assert.equal(await count(f, 'cheki_deliveries'), 1);
});

for (const key of ['recipient_id', 'recipient_ids', 'cast_id'])
  test(`個別指定${key}は空文字でも拒否する`, async t => {
    const f = await setup(t);
    for (const value of ['', key === 'cast_id' ? 'cast-1' : ids.other])
      await result(await send(f, body(f, { extra: { [key]: value } })), 400);
    assert.equal(f.uploads.length, 0);
    assert.equal(await count(f, 'cheki_batches'), 0);
    await noDelivery(f);
  });

test('旧JSON個別送信は廃止しmultipartの必須値とUUIDv4を検証する', async t => {
  const f = await setup(t);
  await result(await send(f, { recipient_id: ids.customer, event_id: 'event-1' }), 400);
  for (const field of ['batch_id', 'event_id', 'audience_hash', 'image']) {
    const form = body(f);
    form.delete(field);
    await result(await send(f, form), 400);
  }
  for (const batchId of [
    '',
    'not-a-uuid',
    '00000000-0000-1000-8000-000000000000',
    '00000000-0000-4000-0000-000000000000'
  ])
    await result(await send(f, body(f, { batchId })), 400);
  await result(await send(f, body(f, { message: 'あ'.repeat(501) })), 400);
  assert.equal(f.uploads.length, 0);
  await noDelivery(f);
});

test('画像形式・画像サイズ・multipart上限を保存前に検証する', async t => {
  const f = await setup(t);
  for (const options of [
    { bytes: new Uint8Array(12) },
    { bytes: png, mime: 'image/jpeg' },
    { bytes: new Uint8Array(11) },
    { bytes: new Uint8Array(4 * 1024 * 1024 + 1) }
  ])
    await result(await send(f, body(f, options)), 400);
  const oversized = body(f, { extra: { padding: 'x'.repeat(4500000) } });
  await result(await send(f, oversized), 413);
  assert.equal(f.uploads.length, 0);
  assert.equal(await count(f, 'cheki_batches'), 0);
});

test('送信APIは認証・CSRF・Originと本人の公開cast紐付けを必須にする', async t => {
  const f = await setup(t);
  for (const [options, status] of [
    [{ user: undefined }, 401],
    [{ user: 'customer' }, 403],
    [{ user: 'admin' }, 403],
    [{ csrf: false }, 403],
    [{ origin: 'https://evil.example' }, 403]
  ])
    await result(await send(f, body(f), options), status);
  await f.DB.prepare("UPDATE casts SET active=0 WHERE id='cast-1'").run();
  await result(await send(f, body(f)), 403);
  await f.DB.prepare("UPDATE casts SET active=1,user_id=NULL WHERE id='cast-1'").run();
  await result(await send(f, body(f)), 403);
  assert.equal(f.uploads.length, 0);
  await noDelivery(f);
});

test('古いhashは拒否し、確認済み対象0人なら配布準備して後日受信できる', async t => {
  const f = await setup(t);
  await f.DB.prepare('DELETE FROM favorites').run();
  assert.equal((await result(await send(f, body(f)), 409)).code, 'AUDIENCE_CHANGED');
  assert.equal(f.uploads.length, 0);
  assert.equal(await count(f, 'cheki_batches'), 0);
  await noDelivery(f);
  f.audience = await (await preview(f)).json();
  assert.equal(f.audience.count, 0);
  const batchId = crypto.randomUUID();
  assert.deepEqual(await result(await send(f, body(f, { batchId }))), {
    ok: true,
    id: batchId,
    count: 0,
    already: false
  });
  assert.equal((await batchRow(f, batchId)).state, 'sent');
  assert.equal(await count(f, 'images'), 1);
  assert.equal(await count(f, 'cheki_deliveries'), 0);
  assert.equal(f.uploads.length, 1);
  const imageId = (await batchRow(f, batchId)).image_id;
  assert.equal((await f.request('/api/images/' + imageId, { user: 'staff' })).status, 200);
  assert.equal((await f.request('/api/images/' + imageId, { user: 'customer' })).status, 403);
  await f.favorite();
  assert.deepEqual(
    (await result(await f.request('/api/member', { user: 'customer' }))).cheki.map(c => c.id),
    [batchId]
  );
  assert.equal((await f.request('/api/images/' + imageId, { user: 'customer' })).status, 200);
  await f.request('/api/member', { user: 'customer' });
  assert.equal(await count(f, 'cheki_deliveries'), 1);
  assert.deepEqual(await result(await send(f, body(f, { batchId }))), {
    ok: true,
    id: batchId,
    count: 0,
    already: true
  });
  assert.equal(f.uploads.length, 1);
});

test('同人数で受取人が入れ替わっても古いhashを拒否する', async t => {
  const f = await setup(t);
  await f.DB.prepare('DELETE FROM favorites').run();
  await f.favorite(ids.other);
  await f.visit(ids.other);
  assert.equal((await result(await send(f, body(f)), 409)).code, 'AUDIENCE_CHANGED');
  assert.equal(f.uploads.length, 0);
  await noDelivery(f);
});

for (const [label, sql] of [
  ['お気に入り解除', 'DELETE FROM favorites'],
  ['来店削除', 'DELETE FROM visits'],
  ['会員登録解除', 'UPDATE users SET joined_as_customer=0'],
  ['キャスト非公開', 'UPDATE casts SET active=0'],
  ['紐付け変更', `UPDATE casts SET user_id='${ids.admin}'`],
  ['営業非公開', 'UPDATE events SET published=0'],
  ['営業開始を未来へ変更', "UPDATE events SET starts_at='2999-01-01T00:00:00.000Z'"]
])
  test(`アップロード中の${label}で配信せずDrive画像を削除する`, async t => {
    const f = await setup(t),
      batchId = crypto.randomUUID();
    f.hooks.uploadHook = () => f.DB.prepare(sql).run();
    const response = await send(f, body(f, { batchId }));
    assert.ok([400, 403, 409].includes(response.status), await response.text());
    assert.equal((await batchRow(f, batchId)).state, 'failed');
    assert.equal(f.uploads.length, 1);
    assert.deepEqual(f.deletions, [f.uploads[0].id]);
    assert.equal(f.driveFiles.size, 0);
    await noDelivery(f);
  });

for (const [label, mutate] of [
  [
    '対象減少',
    async f => {
      await f.DB.prepare('DELETE FROM favorites').run();
    }
  ],
  [
    '対象増加',
    async f => {
      await f.favorite(ids.other);
      await f.visit(ids.other);
    }
  ],
  [
    '同人数の入れ替え',
    async f => {
      await f.DB.prepare('DELETE FROM favorites').run();
      await f.favorite(ids.other);
      await f.visit(ids.other);
    }
  ],
  [
    'キャストの紐付け変更',
    async f => {
      await f.DB.prepare('UPDATE casts SET user_id=?').bind(ids.admin).run();
    }
  ],
  [
    '営業非公開',
    async f => {
      await f.DB.prepare('UPDATE events SET published=0').run();
    }
  ]
])
  test(`最終SQL直前の${label}もCTEで拒否して部分配信しない`, async t => {
    const f = await setup(t),
      batchId = crypto.randomUUID();
    let changed = false;
    f.hooks.beforeBatch = async context => {
      if (isDeliveryBatch(context)) {
        changed = true;
        await mutate(f);
      }
    };
    assert.equal((await result(await send(f, body(f, { batchId })), 409)).code, 'AUDIENCE_CHANGED');
    assert.equal(changed, true);
    const row = await batchRow(f, batchId);
    assert.equal(row.state, 'failed');
    assert.equal(row.image_id, null);
    assert.equal(f.driveFiles.size, 0);
    assert.deepEqual(f.deletions, [f.uploads[0].id]);
    await noDelivery(f);
  });

test('アップロード失敗はfailedとなり同じUUIDと内容で安全に再試行できる', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  f.hooks.uploadHook = () => Response.json({ error: 'mock unavailable' }, { status: 503 });
  assert.equal((await result(await send(f, body(f, { batchId })), 503)).code, 'DRIVE_UPLOAD');
  assert.equal((await batchRow(f, batchId)).state, 'failed');
  assert.equal(f.deletions.length, 0);
  await noDelivery(f);
  await result(await send(f, body(f, { batchId, message: '失敗後に変更した内容' })), 409);
  assert.equal(f.uploads.length, 1);
  f.hooks.uploadHook = undefined;
  assert.equal((await result(await send(f, body(f, { batchId })))).already, false);
  assert.equal(f.uploads.length, 2);
  assert.equal(await count(f, 'images'), 1);
  assert.equal(await count(f, 'cheki_deliveries'), 1);
});

test('条件変更失敗のあと条件を戻せば同じUUIDで再試行できる', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  f.hooks.uploadHook = () => f.DB.prepare('DELETE FROM favorites').run();
  await result(await send(f, body(f, { batchId })), 409);
  f.hooks.uploadHook = undefined;
  await f.favorite();
  await result(await send(f, body(f, { batchId })));
  assert.equal(f.uploads.length, 2);
  assert.equal(f.deletions.length, 1);
  assert.equal(f.driveFiles.size, 1);
  assert.equal(await count(f, 'cheki_deliveries'), 1);
});

test('最終DB処理の失敗はロールバックし結果不明のpendingを再送・削除しない', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  // Abort after the image and deliveries have been inserted, to exercise real rollback.
  f.DB.sqlite.exec(
    "CREATE TRIGGER reject_send_audit BEFORE INSERT ON audit_log WHEN NEW.action='cheki.batch.send' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END"
  );
  await result(await send(f, body(f, { batchId })), 500);
  await noDelivery(f);
  assert.equal((await batchRow(f, batchId)).state, 'pending');
  assert.equal(f.deletions.length, 0);
  assert.equal(f.driveFiles.size, 1);
  assert.equal((await result(await send(f, body(f, { batchId })), 409)).code, 'CHEKI_PENDING');
  assert.equal(f.uploads.length, 1);
});

test('DB確定後に応答を失っても画像を消さず再送はalreadyになる', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID(),
    batch = f.DB.batch.bind(f.DB);
  let lost = false;
  f.DB.batch = async statements => {
    const values = await batch(statements);
    if (!lost && isDeliveryBatch({ statements })) {
      lost = true;
      throw new Error('injected response loss after commit');
    }
    return values;
  };
  await result(await send(f, body(f, { batchId })), 500);
  assert.equal(lost, true);
  assert.equal((await batchRow(f, batchId)).state, 'sent');
  assert.equal(await count(f, 'images'), 1);
  assert.equal(await count(f, 'cheki_deliveries'), 1);
  assert.equal(await count(f, 'audit_log'), 1);
  assert.equal(f.deletions.length, 0);
  assert.equal(f.driveFiles.size, 1);
  assert.deepEqual(await result(await send(f, body(f, { batchId }))), {
    ok: true,
    id: batchId,
    count: 1,
    already: true
  });
  assert.equal(f.uploads.length, 1);
  const response = await f.request('/api/images/' + (await batchRow(f, batchId)).image_id, { user: 'customer' });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
});

test('Drive削除が失敗しても配信は失敗のままで画像APIからアクセスできない', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  f.hooks.uploadHook = () => f.DB.prepare('DELETE FROM favorites').run();
  f.hooks.deleteHook = () => new Response(null, { status: 503 });
  await result(await send(f, body(f, { batchId })), 409);
  assert.equal(f.driveFiles.size, 1);
  assert.equal(f.deletions.length, 1);
  await noDelivery(f);
  assert.equal((await batchRow(f, batchId)).state, 'failed');
  assert.equal(
    (await f.request('/api/images/' + f.uploads[0].metadata.appProperties.image_id, { user: 'customer' })).status,
    404
  );
});

test('新旧の受信一覧は統合され、未受取人には見えず既読は受取人ごとに独立する', async t => {
  const f = await setup(t);
  await f.favorite(ids.other);
  await f.visit(ids.other);
  f.audience = await (await preview(f)).json();
  await f.cheki({ image: 'legacy' });
  await f.DB.prepare("UPDATE cheki SET created_at='2025-01-01T00:00:00.000Z'").run();
  const batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  const received = await result(await f.request('/api/member', { user: 'customer' }));
  assert.deepEqual(
    received.cheki.map(c => c.id),
    [batchId, 'legacy']
  );
  assert.equal(received.cheki[0].sender_id, ids.staff);
  assert.equal(received.cheki[0].event_title, 'テスト営業');
  assert.deepEqual(
    (await result(await f.request('/api/member', { user: 'other' }))).cheki.map(c => c.id),
    [batchId]
  );
  await f.request(`/api/member/cheki/${batchId}/opened`, { user: 'other', method: 'POST', body: {} });
  const own = await f.DB.prepare('SELECT opened_at FROM cheki_deliveries WHERE batch_id=? AND recipient_id=?')
    .bind(batchId, ids.other)
    .first();
  assert.ok(own.opened_at);
  await f.request(`/api/member/cheki/${batchId}/opened`, { user: 'other', method: 'POST', body: {} });
  assert.equal(
    (
      await f.DB.prepare('SELECT opened_at FROM cheki_deliveries WHERE batch_id=? AND recipient_id=?')
        .bind(batchId, ids.other)
        .first()
    ).opened_at,
    own.opened_at
  );
  assert.equal(
    (
      await f.DB.prepare('SELECT opened_at FROM cheki_deliveries WHERE batch_id=? AND recipient_id=?')
        .bind(batchId, ids.customer)
        .first()
    ).opened_at,
    null
  );
  await f.request('/api/member/cheki/legacy/opened', { user: 'customer', method: 'POST', body: {} });
  assert.ok((await f.DB.prepare("SELECT opened_at FROM cheki WHERE id='legacy'").first()).opened_at);
  assert.equal(await count(f, 'cheki'), 1);
});

test('バッチ画像は受取人と送信者だけ取得でき、運営・無関係会員はDriveに到達しない', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  const imageId = (await batchRow(f, batchId)).image_id,
    path = '/api/images/' + imageId;
  const before = f.calls.filter(c => c.url.includes('/drive/v3/files/')).length;
  for (const user of ['other', 'admin', undefined])
    assert.equal((await f.request(path, { user })).status, user ? 403 : 401);
  assert.equal(f.calls.filter(c => c.url.includes('/drive/v3/files/')).length, before);
  for (const user of ['customer', 'staff']) {
    const response = await f.request(path, { user });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  }
  await f.DB.prepare('DELETE FROM favorites').run();
  await f.DB.prepare('DELETE FROM visits').run();
  await f.DB.prepare('UPDATE casts SET user_id=?').bind(ids.admin).run();
  assert.equal((await f.request(path, { user: 'customer' })).status, 200);
  assert.equal((await f.request(path, { user: 'staff' })).status, 200);
  assert.equal((await f.request(path, { user: 'admin' })).status, 403);
});

test('新チェキも会員退会・送信者スタッフ退会を現在の所属で判定する', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  const path = '/api/images/' + (await batchRow(f, batchId)).image_id;
  f.members.delete(`${ids.customer}:${f.env.CUSTOMER_GUILD_ID}`);
  f.members.set(`${ids.customer}:${f.env.STAFF_GUILD_ID}`, { roles: [] });
  assert.equal((await f.request(path, { user: 'customer' })).status, 403);
  f.members.delete(`${ids.staff}:${f.env.STAFF_GUILD_ID}`);
  f.members.set(`${ids.staff}:${f.env.CUSTOMER_GUILD_ID}`, { roles: [] });
  assert.equal((await f.request(path, { user: 'staff' })).status, 403);
});

test('新旧の取消は送信者限定で新画像の直URL・受信一覧・既読更新も遮断する', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await f.cheki({ image: 'legacy' });
  await result(await send(f, body(f, { batchId })));
  const imageId = (await batchRow(f, batchId)).image_id;
  for (const id of [batchId, 'legacy'])
    await result(await f.request('/api/staff/cheki/withdraw', { user: 'admin', method: 'POST', body: { id } }));
  assert.equal((await batchRow(f, batchId)).withdrawn, 0);
  assert.equal((await f.DB.prepare("SELECT withdrawn FROM cheki WHERE id='legacy'").first()).withdrawn, 0);
  for (const id of [batchId, 'legacy'])
    await result(await f.request('/api/staff/cheki/withdraw', { user: 'staff', method: 'POST', body: { id } }));
  for (const user of ['customer', 'staff'])
    assert.equal((await f.request('/api/images/' + imageId, { user })).status, 403);
  assert.deepEqual((await result(await f.request('/api/member', { user: 'customer' }))).cheki, []);
  await f.request(`/api/member/cheki/${batchId}/opened`, { user: 'customer', method: 'POST', body: {} });
  assert.equal(
    (await f.DB.prepare('SELECT opened_at FROM cheki_deliveries WHERE batch_id=?').bind(batchId).first()).opened_at,
    null
  );
  const history = (await result(await f.request('/api/staff', { user: 'staff' }))).sent;
  assert.ok(history.every(c => c.withdrawn === 1));
  assert.equal(history.length, 2);
  assert.equal(f.deletions.length, 0);
});

const saveCast = (f, data, user = 'admin') =>
  f.request('/api/manage/casts', {
    user,
    method: 'POST',
    body: { display_name: '更新キャスト', active: true, ...data }
  });
test('mapping未指定は既存値を維持し明示解除でき、複数NULLを許容する', async t => {
  const f = await setup(t);
  await result(await saveCast(f, { id: 'cast-1', display_name: '改名' }));
  assert.equal((await f.DB.prepare("SELECT user_id FROM casts WHERE id='cast-1'").first()).user_id, ids.staff);
  await result(await saveCast(f, { id: 'cast-1', user_id: null }));
  assert.equal((await f.DB.prepare("SELECT user_id FROM casts WHERE id='cast-1'").first()).user_id, null);
  for (const id of ['unmapped-1', 'unmapped-2']) await result(await saveCast(f, { id }));
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM casts WHERE user_id IS NULL').first()).n, 3);
  await result(await saveCast(f, { id: 'unmapped-1', user_id: ids.staff }));
  await result(await saveCast(f, { id: 'unmapped-1', user_id: '' }));
  assert.equal((await f.DB.prepare("SELECT user_id FROM casts WHERE id='unmapped-1'").first()).user_id, null);
});

test('mappingは運営限定でスタッフ登録済みユーザーのみ許可し重複を拒否する', async t => {
  const f = await setup(t);
  for (const user of ['staff', 'customer'])
    await result(await saveCast(f, { id: 'cast-1', user_id: ids.admin }, user), 403);
  await result(await saveCast(f, { id: 'cast-1', user_id: ids.admin }));
  await result(
    await f.request('/api/manage/casts', {
      method: 'POST',
      body: { id: 'cast-1', display_name: '不正更新', active: true, user_id: ids.staff }
    }),
    401
  );
  for (const user_id of [ids.customer, '999999999999999999', 'invalid'])
    await result(await saveCast(f, { id: 'new-cast', user_id }), 400);
  await result(await saveCast(f, { id: 'another', user_id: ids.admin }), 409);
  await result(await saveCast(f, { id: 'cast-1', user_id: ids.staff }));
  await result(await saveCast(f, { id: 'another', user_id: ids.staff }), 409);
  assert.equal((await f.DB.prepare("SELECT user_id FROM casts WHERE id='cast-1'").first()).user_id, ids.staff);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM casts WHERE id IN ('another','new-cast')").first()).n, 0);
  assert.throws(
    () =>
      f.DB.sqlite
        .prepare('INSERT INTO casts(id,display_name,user_id) VALUES(?,?,?)')
        .run('direct-duplicate', 'duplicate', ids.staff),
    /UNIQUE/
  );
});

test('公開APIからmappingと配信個人情報は漏れない', async t => {
  const f = await setup(t);
  await result(await send(f, body(f)));
  const data = await result(await f.request('/api/public'));
  assert.ok(data.casts.length);
  assert.ok(data.casts.every(c => !Object.hasOwn(c, 'user_id')));
  const raw = JSON.stringify(data);
  for (const secret of [ids.staff, ids.customer, 'audience_hash', 'request_hash', 'recipient_id', 'uploaded-drive-'])
    assert.ok(!raw.includes(secret), secret);
});

for (const order of [
  ['favorite', 'visit'],
  ['visit', 'favorite']
])
  test(`送信後${order.join('→')}の順でも両方揃ってから本人のGETで一度だけ追加受信する`, async t => {
    const f = await setup(t),
      batchId = crypto.randomUUID();
    await result(await send(f, body(f, { batchId })));
    const imageId = (await batchRow(f, batchId)).image_id;
    const inbox = async () => (await result(await f.request('/api/member', { user: 'other' }))).cheki;
    assert.deepEqual(await inbox(), []);
    const enroll = {
      favorite: () =>
        f.request('/api/member/favorites', { user: 'other', method: 'PUT', body: { cast_ids: ['cast-1'] } }),
      visit: () =>
        f.request('/api/member/checkin', {
          user: 'other',
          method: 'POST',
          body: { event_id: 'event-1', passphrase: 'ほしぞら' }
        })
    };
    await result(await enroll[order[0]]());
    assert.deepEqual(await inbox(), []);
    assert.equal(await count(f, 'cheki_deliveries'), 1);
    assert.equal((await f.request('/api/images/' + imageId, { user: 'other' })).status, 403);
    await result(await enroll[order[1]]());
    // Another member's GET must not grant this user's delivery.
    await f.request('/api/member', { user: 'customer' });
    assert.equal(await count(f, 'cheki_deliveries'), 1);
    const received = await inbox();
    assert.deepEqual(
      received.map(c => c.id),
      [batchId]
    );
    assert.equal(received[0].sender_id, ids.staff);
    assert.equal(received[0].opened_at, null);
    assert.equal(await count(f, 'cheki_deliveries'), 2);
    assert.equal((await f.request('/api/images/' + imageId, { user: 'other' })).status, 200);
    await inbox();
    await inbox();
    assert.equal(await count(f, 'cheki_deliveries'), 2);
    assert.equal(f.uploads.length, 1);
    assert.equal(await count(f, 'audit_log'), 1);
    await f.request(`/api/member/cheki/${batchId}/opened`, { user: 'other', method: 'POST', body: {} });
    const opened = (await inbox())[0].opened_at;
    assert.ok(opened);
    await result(await f.request('/api/member/favorites', { user: 'other', method: 'PUT', body: { cast_ids: [] } }));
    await f.DB.prepare('DELETE FROM visits WHERE user_id=?').bind(ids.other).run();
    await f.DB.prepare('UPDATE casts SET user_id=?,active=0').bind(ids.admin).run();
    assert.equal((await inbox())[0].opened_at, opened);
    assert.equal((await f.request('/api/images/' + imageId, { user: 'other' })).status, 200);
  });

test('後日追加もbatchのcastとevent両方の一致を要求し紐付け変更後も元の送信者を保持する', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  await f.event('event-2');
  await f.cast({ id: 'cast-2', user: null });
  await f.favorite(ids.other, 'cast-2');
  await f.visit(ids.other, 'event-2');
  const inbox = async () => (await result(await f.request('/api/member', { user: 'other' }))).cheki;
  assert.deepEqual(await inbox(), []);
  await f.favorite(ids.other);
  assert.deepEqual(await inbox(), []);
  await f.DB.prepare('UPDATE casts SET user_id=? WHERE id=?').bind(ids.admin, 'cast-1').run();
  await f.visit(ids.other);
  const received = await inbox();
  assert.deepEqual(
    received.map(c => c.id),
    [batchId]
  );
  assert.equal(received[0].sender_id, ids.staff);
  assert.equal((await f.request('/api/images/' + received[0].image_id, { user: 'admin' })).status, 403);
});

test('pending・failed・取消済みbatchには後日の対象者を新規追加しない', async t => {
  const f = await setup(t),
    batchId = crypto.randomUUID();
  await result(await send(f, body(f, { batchId })));
  await f.favorite(ids.other);
  await f.visit(ids.other);
  for (const state of ['pending', 'failed']) {
    await f.DB.prepare('UPDATE cheki_batches SET state=? WHERE id=?').bind(state, batchId).run();
    assert.deepEqual((await result(await f.request('/api/member', { user: 'other' }))).cheki, []);
    assert.equal(await count(f, 'cheki_deliveries'), 1);
    assert.deepEqual((await result(await f.request('/api/member', { user: 'customer' }))).cheki, []);
    const imageId = (await batchRow(f, batchId)).image_id;
    for (const user of ['customer', 'staff'])
      assert.equal((await f.request('/api/images/' + imageId, { user })).status, 403);
  }
  await f.DB.prepare("UPDATE cheki_batches SET state='sent' WHERE id=?").bind(batchId).run();
  await result(await f.request('/api/staff/cheki/withdraw', { user: 'staff', method: 'POST', body: { id: batchId } }));
  for (let i = 0; i < 2; i++)
    assert.deepEqual((await result(await f.request('/api/member', { user: 'other' }))).cheki, []);
  assert.equal(await count(f, 'cheki_deliveries'), 1);
  assert.equal(
    (await f.request('/api/images/' + (await batchRow(f, batchId)).image_id, { user: 'other' })).status,
    403
  );
});

for (const [label, sql] of [
  ['紐付け解除', 'UPDATE casts SET user_id=NULL'],
  ['キャスト非公開', 'UPDATE casts SET active=0'],
  ['営業非公開', 'UPDATE events SET published=0'],
  ['営業未来化', "UPDATE events SET starts_at='2999-01-01T00:00:00.000Z'"]
])
  test(`対象0人でも最終SQL直前の${label}を拒否する`, async t => {
    const f = await setup(t);
    await f.DB.prepare('DELETE FROM favorites').run();
    f.audience = await (await preview(f)).json();
    const batchId = crypto.randomUUID();
    f.hooks.beforeBatch = async context => {
      if (isDeliveryBatch(context)) await f.DB.prepare(sql).run();
    };
    assert.equal((await result(await send(f, body(f, { batchId })), 409)).code, 'AUDIENCE_CHANGED');
    assert.equal((await batchRow(f, batchId)).state, 'failed');
    assert.equal((await batchRow(f, batchId)).image_id, null);
    assert.equal(f.deletions.length, 1);
    await noDelivery(f);
  });
