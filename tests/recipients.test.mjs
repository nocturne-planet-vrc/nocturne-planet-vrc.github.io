import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';

const audience=(f,event='event-1',user='staff',extra='')=>f.request('/api/staff/recipients?event_id='+encodeURIComponent(event)+extra,{user});
async function setup(t){const f=await fixture();t.after(f.close);await f.event();await f.cast();return f;}

test('対象確認はcast・event・count・hashだけを返し、旧検索でも個人情報を返さない',async t=>{
  const f=await setup(t);await f.favorite();await f.visit();
  await f.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) VALUES(?,?,?,?)').bind(ids.customer,'usr_00000000-0000-0000-0000-000000000001','秘密のVRChat名',new Date().toISOString()).run();
  for(const q of ['', '&q=customer', '&q='+ids.customer, '&q='+encodeURIComponent("%_!' OR 1=1 --")]){
    const response=await audience(f,'event-1','staff',q);assert.equal(response.status,200);
    const data=await response.json();assert.deepEqual(Object.keys(data).sort(),['audience_hash','cast','count','event']);
    assert.deepEqual(data.cast,{id:'cast-1',display_name:'テストキャスト'});
    assert.deepEqual(Object.keys(data.event).sort(),['id','starts_at','title']);assert.equal(data.event.id,'event-1');assert.equal(data.count,1);assert.match(data.audience_hash,/^[A-Za-z0-9_-]{43}$/);
    const raw=JSON.stringify(data);for(const secret of [ids.customer,'customer','秘密のVRChat名','recipient_ids','recipients','users'])assert.ok(!raw.includes(secret),secret);
  }
  for(const query of ['customer',ids.customer,'秘密のVRChat名'])assert.equal((await f.request('/api/staff/recipients?q='+encodeURIComponent(query),{user:'staff'})).status,400);
});

test('対象は自分のお気に入りAND選択営業の来店AND会員登録だけに限定する',async t=>{
  const f=await setup(t);await f.event('event-2');await f.cast({id:'cast-2',user:ids.admin});
  // customer: both; other: favorite only; staff: visit only; admin: both but not a customer.
  await f.favorite();await f.visit();await f.favorite(ids.other);await f.visit(ids.staff);await f.favorite(ids.admin);await f.visit(ids.admin);
  const extra='100000000000000005';await f.DB.prepare('INSERT INTO users(id,display_name,joined_as_customer,last_seen_at) VALUES(?,?,1,?)').bind(extra,'別営業のお客さん',new Date().toISOString()).run();
  await f.favorite(extra);await f.visit(extra,'event-2');
  const foreign='100000000000000006';await f.DB.prepare('INSERT INTO users(id,display_name,joined_as_customer,last_seen_at) VALUES(?,?,1,?)').bind(foreign,'別キャストのお客さん',new Date().toISOString()).run();
  await f.favorite(foreign,'cast-2');await f.visit(foreign);
  assert.equal((await (await audience(f)).json()).count,1);
  await f.DB.prepare('DELETE FROM favorites WHERE user_id=?').bind(ids.customer).run();
  assert.equal((await (await audience(f)).json()).count,0);
});

test('hashは安定し、同人数の対象入れ替えと営業回・送信者の違いを区別する',async t=>{
  const f=await setup(t);await f.event('event-2');await f.cast({id:'cast-2',user:ids.admin});
  await f.favorite();await f.visit();await f.visit(ids.other);await f.visit(ids.customer,'event-2');await f.favorite(ids.customer,'cast-2');
  const initial=await (await audience(f)).json();assert.equal((await (await audience(f)).json()).audience_hash,initial.audience_hash);
  assert.notEqual((await (await audience(f,'event-2')).json()).audience_hash,initial.audience_hash);
  assert.notEqual((await (await audience(f,'event-1','admin')).json()).audience_hash,initial.audience_hash);
  await f.DB.prepare('DELETE FROM favorites WHERE user_id=? AND cast_id=?').bind(ids.customer,'cast-1').run();await f.favorite(ids.other);
  const swapped=await (await audience(f)).json();assert.equal(swapped.count,initial.count);assert.notEqual(swapped.audience_hash,initial.audience_hash);
  await f.favorite();const both=await (await audience(f)).json();
  await f.DB.prepare("DELETE FROM favorites WHERE cast_id='cast-1'").run();await f.favorite();await f.favorite(ids.other);
  assert.equal((await (await audience(f)).json()).audience_hash,both.audience_hash);
});

test('未認証・会員のみ・未紐付け運営・非公開キャストは対象確認できない',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('/api/staff/recipients?event_id=event-1')).status,401);
  assert.equal((await audience(f,'event-1','customer')).status,403);
  const admin=await audience(f,'event-1','admin');assert.equal(admin.status,403);assert.equal((await admin.json()).code,'CAST_LINK_REQUIRED');
  await f.DB.prepare("UPDATE casts SET active=0 WHERE id='cast-1'").run();assert.equal((await audience(f)).status,403);
  await f.DB.prepare("UPDATE casts SET active=1,user_id=NULL WHERE id='cast-1'").run();assert.equal((await audience(f)).status,403);
});

test('対象確認は公開済みかつ開始済みの営業を必須とする',async t=>{
  const f=await setup(t);await f.event('draft',{published:0});await f.event('future',{starts_at:new Date(Date.now()+86400000).toISOString()});
  for(const event of ['draft','future','missing',"' OR 1=1 --",''])assert.equal((await audience(f,event)).status,400,event);
  await f.event('past',{starts_at:'2025-01-01T00:00:00.000Z',ends_at:'2025-01-01T01:00:00.000Z'});assert.equal((await audience(f,'past')).status,200);
});
