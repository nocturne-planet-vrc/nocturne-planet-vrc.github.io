import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {vrchatUserId} from '../src/vrchat.mjs';

const first='usr_00000000-0000-0000-0000-000000000001',second='usr_00000000-0000-0000-0000-000000000002';
const body={profile_url:`https://vrchat.com/home/user/${first}`};
const action=(f,action,body={},user='customer',extra={})=>f.request(`/api/${user==='staff'?'staff':'member'}/vrchat/${action}`,{user,method:'POST',body,...extra});
const setup=async t=>{const f=await fixture();t.after(f.close);f.env.VRCHAT_AUTH_TOKEN='fixture-vrchat-token';return f;};
const start=async(f,user='customer')=>{const response=await action(f,'start',body,user);assert.equal(response.status,200);return (await response.json()).challenge;};
const profile=(f,id,code)=>f.vrchatUsers.set(id,{id,displayName:'星空のお客さん',bio:`自己紹介\n${code}\nよろしくお願いします`});

test('本人のプロフィールにある有効なコードでだけDiscord会員情報に連携する',async t=>{
  const f=await setup(t),challenge=await start(f);profile(f,first,challenge.code);
  assert.match(challenge.code,/^NP-[0-9A-F]{20}$/);
  assert.ok(Date.parse(challenge.expires_at)>Date.now());
  const response=await action(f,'verify');assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.linked.vrchat_id,first);assert.equal(data.linked.display_name,'星空のお客さん');assert.equal(data.challenge,null);
  assert.equal((await action(f,'verify')).status,410);
  const own=await (await f.request('/api/member',{user:'customer'})).json();assert.equal(own.vrchat.linked.vrchat_id,first);
  const other=await (await f.request('/api/member',{user:'other'})).json();assert.equal(other.vrchat.linked,null);assert.equal(other.vrchat.challenge,null);
  assert.ok(!JSON.stringify(await (await f.request('/api/public')).json()).includes(challenge.code));
  assert.ok(!JSON.stringify(data).includes(f.env.VRCHAT_AUTH_TOKEN));
});

test('不一致・他人のコード・再発行前のコード・期限切れでは連携しない',async t=>{
  const f=await setup(t),old=await start(f),fresh=await start(f);
  assert.notEqual(old.code,fresh.code);profile(f,first,old.code);
  assert.equal((await action(f,'verify')).status,400);
  assert.equal((await action(f,'verify')).status,429);
  assert.equal((await action(f,'verify',{},'other')).status,410);
  await f.DB.prepare('UPDATE vrchat_challenges SET checked_at=0,expires_at=1 WHERE user_id=?').bind(ids.customer).run();
  profile(f,first,fresh.code);assert.equal((await action(f,'verify')).status,410);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,0);
});

test('同一VRChatアカウントの同時確認でも重複連携せず、以前の連携は維持する',async t=>{
  const f=await setup(t),a=await start(f),b=await start(f,'other');
  profile(f,first,a.code);assert.equal((await action(f,'verify')).status,200);
  profile(f,first,b.code);assert.equal((await action(f,'verify',{},'other')).status,409);
  assert.equal((await action(f,'start',body,'other')).status,409);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,1);
  await action(f,'start',{profile_url:second});profile(f,second,'間違ったコード');
  assert.equal((await action(f,'verify')).status,400);
  assert.equal((await f.DB.prepare('SELECT vrchat_id FROM vrchat_links WHERE user_id=?').bind(ids.customer).first()).vrchat_id,first);
});

test('プロフィール取得中の再発行・期限切れ・不正な応答で確認済みにしない',async t=>{
  const f=await setup(t);await start(f);
  f.vrchatUsers.set(first,async()=>{await f.DB.prepare('UPDATE vrchat_challenges SET expires_at=1 WHERE user_id=?').bind(ids.customer).run();return {id:first,displayName:'お客さん',bio:(await f.DB.prepare('SELECT code FROM vrchat_challenges WHERE user_id=?').bind(ids.customer).first()).code};});
  assert.equal((await action(f,'verify')).status,409);
  const fresh=await start(f);f.vrchatUsers.set(first,{id:second,displayName:'別の人',bio:fresh.code});
  assert.equal((await action(f,'verify')).status,503);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,0);
});

test('連携解除は本人だけに作用し、Discordの来店記録は保持する',async t=>{
  const f=await setup(t),challenge=await start(f);profile(f,first,challenge.code);await action(f,'verify');await f.event();
  await f.DB.prepare('INSERT INTO visits(event_id,user_id,checked_in_at) VALUES(?,?,?)').bind('event-1',ids.customer,new Date().toISOString()).run();
  await action(f,'unlink',{user_id:ids.customer},'other');assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,1);
  assert.equal((await action(f,'unlink')).status,200);assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,0);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM visits').first()).n,1);
});

test('ログイン・所属・CSRFを確認し、スタッフページからも本人の連携を使える',async t=>{
  const f=await setup(t);
  assert.equal((await f.request('/api/member/vrchat/start',{method:'POST',body})).status,401);
  assert.equal((await action(f,'start',body,'customer',{csrf:false})).status,403);
  await start(f,'staff');
  const data=await (await f.request('/api/staff',{user:'staff'})).json();assert.equal(data.vrchat.challenge.vrchat_id,first);
  f.members.delete(`${ids.staff}:${f.env.STAFF_GUILD_ID}`);assert.equal((await action(f,'verify',{},'staff')).status,403);
});

test('取得先は固定し、認証情報を転送せず、VRChatの回数制限では連続取得しない',async t=>{
  const f=await setup(t),challenge=await start(f);
  f.vrchatUsers.set(first,options=>{assert.equal(options.redirect,'error');assert.match(options.headers['User-Agent'],/^NocturnePlanet\/1\.0 /);assert.equal(options.headers.Cookie,`auth=${f.env.VRCHAT_AUTH_TOKEN}`);return new Response('',{status:429,headers:{'Retry-After':'120'}});});
  const limited=await action(f,'verify');assert.equal(limited.status,503);assert.equal(limited.headers.get('Retry-After'),'120');
  await f.DB.prepare('UPDATE vrchat_challenges SET checked_at=0 WHERE user_id=?').bind(ids.customer).run();
  profile(f,first,challenge.code);assert.equal((await action(f,'verify')).status,503);
  assert.equal(f.calls.filter(call=>call.url.startsWith('https://api.vrchat.cloud/')).length,1);
});

test('未設定・認証切れ・プロフィール非取得時は確認済みにしない',async t=>{
  const f=await setup(t);delete f.env.VRCHAT_AUTH_TOKEN;assert.equal((await action(f,'start',body)).status,503);
  f.env.VRCHAT_AUTH_TOKEN='fixture-vrchat-token';await start(f);f.vrchatUsers.set(first,new Response('',{status:401}));
  const response=await action(f,'verify');assert.equal(response.status,503);assert.equal((await response.json()).code,'VRCHAT_CONNECTION');
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,0);
});

test('VRChat以外のURL・認証情報入りURL・不正なIDは受け付けない',()=>{
  assert.equal(vrchatUserId(body.profile_url+'/?ref=test'),first);assert.equal(vrchatUserId(first),first);
  for(const input of ['https://vrchat.com.evil.test/home/user/'+first,'https://example.test/'+first,'https://user:password@vrchat.com/home/user/'+first,'http://vrchat.com/home/user/'+first,'https://vrchat.com:8443/home/user/'+first,'https://vrchat.com/home/avatar/'+first,'usr_bad','javascript:alert(1)',{}])assert.throws(()=>vrchatUserId(input));
});
