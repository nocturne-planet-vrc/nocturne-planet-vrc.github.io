import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { findRoute } from '../src/routes/shared.mjs';

test('ルート表は最初に一致した項目を使い、正規表現の一致内容を渡す', () => {
  const first = () => 'first',
    second = () => 'second';
  const routes = [
    ['GET', '/api/a', first],
    [['GET', 'POST'], /^\/api\/(a|b)$/, second]
  ];
  assert.equal(findRoute(routes, 'GET', '/api/a').handler, first);
  const post = findRoute(routes, 'POST', '/api/a');
  assert.equal(post.handler, second);
  assert.equal(post.match[1], 'a');
  assert.equal(findRoute(routes, 'PUT', '/api/a'), null);
  assert.equal(findRoute(routes, 'GET', '/api/ab'), null);
});

test('専用ページの未登録APIは、権限とCSRFを確認してから404を返す', async t => {
  const f = await fixture();
  t.after(f.close);
  for (const area of ['member', 'staff', 'manage']) {
    assert.equal((await f.request(`/api/${area}/unknown`)).status, 401, area);
  }
  assert.equal((await f.request('/api/manage/unknown', { user: 'staff' })).status, 403);
  assert.equal((await f.request('/api/manage/unknown', { user: 'admin' })).status, 404);
  assert.equal((await f.request('/api/manage/unknown', { user: 'admin', method: 'POST', csrf: false })).status, 403);
  assert.equal((await f.request('/api/manage/unknown', { user: 'admin', method: 'POST' })).status, 404);
  // A known path with the wrong method is also "not found", as before.
  assert.equal((await f.request('/api/manage/assignments', { user: 'admin' })).status, 404);
  assert.equal((await f.request('/api/unknown')).status, 404);
  assert.equal((await f.request('/api/images/x', { method: 'POST' })).status, 404);
});

test('VRChatの名前同期は会員ページだけで使える', async t => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.request('/api/staff/vrchat/sync-name', { user: 'staff', method: 'POST' })).status, 404);
});
