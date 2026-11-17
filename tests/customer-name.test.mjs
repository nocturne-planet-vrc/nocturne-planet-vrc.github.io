import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {discordNickname} from '../src/customer-name.mjs';

const vrchat='usr_00000000-0000-0000-0000-000000000001';
const mutations=f=>f.calls.filter(c=>c.method==='PATCH'&&c.url.includes('/members/'));
async function setup(t,hooks={}){const f=await fixture(hooks);t.after(f.close);f.env.DISCORD_BOT_TOKEN='nickname-test-bot';return f;}
async function link(f,name='星空のお客さん',user=ids.customer){await f.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) VALUES(?,?,?,?)').bind(user,vrchat,name,new Date().toISOString()).run();}
const sync=f=>f.request('/api/member/vrchat/sync-name',{user:'customer',method:'POST',body:{}});

test('本人確認完了直後から会員名とお客様用サーバーのニックネームにVRChat名を使う',async t=>{
  const f=await setup(t);f.env.VRCHAT_AUTH_TOKEN='fixture-vrchat-token';
  const challenge=await (await f.request('/api/member/vrchat/start',{user:'customer',method:'POST',body:{profile_url:vrchat}})).json();
  f.vrchatUsers.set(vrchat,{id:vrchat,displayName:'星空のお客さん',bio:challenge.challenge.code});
  const response=await f.request('/api/member/vrchat/verify',{user:'customer',method:'POST',body:{}});
  assert.equal(response.status,200);const fresh=await response.json();
  assert.equal(fresh.session.user.name,'星空のお客さん');assert.equal(fresh.nickname.status,'synced');
  assert.equal(f.members.get(ids.customer+':'+f.env.CUSTOMER_GUILD_ID).nick,'星空のお客さん');
  assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0].url,`https://discord.com/api/v10/guilds/${f.env.CUSTOMER_GUILD_ID}/members/${ids.customer}`);
  assert.equal((await f.DB.prepare('SELECT display_name FROM users WHERE id=?').bind(ids.customer).first()).display_name,'customer');
  const next=await (await f.request('/api/member',{user:'customer'})).json();assert.equal(next.session.user.name,'星空のお客さん');assert.equal(mutations(f).length,1);
  assert.ok(!JSON.stringify(next).includes(f.env.DISCORD_BOT_TOKEN));
});

test('以前の連携済み会員も次にページを開くと同期し、Discordで再ログインしてもVRChat名を優先する',async t=>{
  const f=await setup(t);await link(f);
  await f.DB.prepare('UPDATE users SET display_name=? WHERE id=?').bind('新しいDiscord表示名',ids.customer).run();
  const member=await (await f.request('/api/member',{user:'customer'})).json();assert.equal(member.session.user.name,'星空のお客さん');assert.equal(member.vrchat.nickname.status,'synced');
  assert.equal(mutations(f).length,1);
  f.members.set(ids.customer+':'+f.env.STAFF_GUILD_ID,{roles:[],pending:false});
  const staff=await (await f.request('/api/staff',{user:'customer'})).json();assert.equal(staff.session.user.name,'新しいDiscord表示名');assert.equal(mutations(f).length,1);
});

test('未連携の会員とスタッフ専用の連携ではDiscordのニックネームを変更しない',async t=>{
  const f=await setup(t);
  assert.equal((await (await f.request('/api/member',{user:'customer'})).json()).session.user.name,'customer');
  await link(f,'スタッフのVRChat名',ids.staff);
  assert.equal((await (await f.request('/api/staff',{user:'staff'})).json()).session.user.name,'staff');
  assert.equal(mutations(f).length,0);
  assert.equal((await f.request('/api/staff/vrchat/sync-name',{user:'staff',method:'POST',body:{}})).status,404);
});

test('Botの権限エラーでも連携と会員名は保持し、再試行後に同期できる',async t=>{
  let denied=true;const f=await setup(t,{nicknamePatch:()=>denied?Response.json({code:50013},{status:403}):undefined});await link(f);
  const first=await (await f.request('/api/member',{user:'customer'})).json();assert.equal(first.session.user.name,'星空のお客さん');assert.equal(first.vrchat.nickname.status,'blocked');
  await f.request('/api/member',{user:'customer'});assert.equal(mutations(f).length,1);
  denied=false;assert.equal((await (await sync(f)).json()).nickname.status,'blocked');assert.equal(mutations(f).length,1);
  await f.DB.prepare('UPDATE discord_nickname_sync SET retry_after=0 WHERE user_id=?').bind(ids.customer).run();
  const response=await sync(f);assert.equal(response.status,200);assert.equal((await response.json()).nickname.status,'synced');assert.equal(mutations(f).length,2);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM vrchat_links').first()).n,1);
});

test('Bot未設定・未参加・接続失敗でも会員ページを開ける',async t=>{
  for(const mode of ['unconfigured','401','404','500','network'])await t.test(mode,async sub=>{
    const f=await setup(sub,{nicknamePatch:()=>{if(mode==='network')throw new Error('network fixture');return Response.json({},{status:Number(mode)||500});}});await link(f);
    if(mode==='unconfigured')delete f.env.DISCORD_BOT_TOKEN;
    const response=await f.request('/api/member',{user:'customer'});assert.equal(response.status,200);const data=await response.json();assert.equal(data.session.user.name,'星空のお客さん');assert.ok(['unavailable','failed'].includes(data.vrchat.nickname.status));assert.ok(data.vrchat.linked);
  });
});

test('Discordの429では全会員のニックネーム更新を待機し、再試行でも待機時間を守る',async t=>{
  const f=await setup(t,{nicknamePatch:()=>Response.json({retry_after:120},{status:429})});await link(f);
  assert.equal((await (await sync(f)).json()).nickname.status,'rate_limited');await sync(f);assert.equal(mutations(f).length,1);
  await f.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) VALUES(?,?,?,?)').bind(ids.other,'usr_00000000-0000-0000-0000-000000000002','別のお客さん',new Date().toISOString()).run();
  assert.equal((await (await f.request('/api/member',{user:'other'})).json()).vrchat.nickname.status,'rate_limited');assert.equal(mutations(f).length,1);
});

test('同時に会員ページを開いても同じニックネーム更新を重複送信しない',async t=>{
  let release,started;const entered=new Promise(resolve=>started=resolve),hold=new Promise(resolve=>release=resolve);
  const f=await setup(t,{nicknamePatch:async()=>{started();await hold;}});await link(f);
  const first=f.request('/api/member',{user:'customer'});await entered;
  try{const second=await f.request('/api/member',{user:'customer'});assert.equal(second.status,200);assert.equal((await second.json()).vrchat.nickname.status,'pending');assert.equal(mutations(f).length,1);}finally{release();}
  assert.equal((await first).status,200);
});

test('連携解除で会員名をDiscord名へ戻し、他人の同期・解除を拒否する',async t=>{
  const f=await setup(t);await link(f);await f.event();await f.visit();await sync(f);
  assert.equal((await f.request('/api/member/vrchat/sync-name',{method:'POST',body:{user_id:ids.customer}})).status,401);
  assert.equal((await f.request('/api/member/vrchat/sync-name',{user:'customer',method:'POST',body:{},csrf:false})).status,403);
  const other=await f.request('/api/member/vrchat/sync-name',{user:'other',method:'POST',body:{user_id:ids.customer}});assert.equal((await other.json()).nickname,null);assert.equal(mutations(f).length,1);
  const removed=await (await f.request('/api/member/vrchat/unlink',{user:'customer',method:'POST',body:{}})).json();assert.equal(removed.session.user.name,'customer');assert.equal(removed.linked,null);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM discord_nickname_sync').first()).n,0);assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM visits').first()).n,1);
  assert.equal(mutations(f).length,1);
});

test('Discord側だけ32文字に収め、絵文字を分断せず、会員名の全文は保持する',async t=>{
  const f=await setup(t),name='🌟'.repeat(33);await link(f,name);
  const data=await (await f.request('/api/member',{user:'customer'})).json();assert.equal(data.session.user.name,name);assert.equal(f.members.get(ids.customer+':'+f.env.CUSTOMER_GUILD_ID).nick,'🌟'.repeat(32));
  assert.equal(discordNickname('  星空  の お客さん  '),'星空 の お客さん');
});

test('同期テーブルの反映前でも連携済みの会員ページを開ける',async t=>{
  const f=await setup(t);await f.DB.prepare('DROP TABLE discord_nickname_sync').run();await link(f);
  const response=await f.request('/api/member',{user:'customer'});assert.equal(response.status,200);assert.equal((await response.json()).vrchat.nickname.status,'synced');
});
