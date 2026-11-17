import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {dutyRoles} from '../src/duties.mjs';

const fresh='100000000000000009';
const castRole=dutyRoles.find(duty=>duty.name==='接客キャスト').role_id;
function botMembers(f,members,{status=200}={}){
  const calls=[];
  f.hooks.botMembers=url=>{calls.push(url);return status===200?Response.json(members):Response.json({message:'error'},{status});};
  return calls;
}
const member=(id,name,roles=[],extra={})=>({user:{id,username:name,global_name:name,avatar:null,...extra},nick:null,roles});

test('Botで取得した運営用サーバーのメンバーは、ログイン前でもロール付きで運営ページに出る',async t=>{
  const f=await fixture();t.after(f.close);f.env.DISCORD_BOT_TOKEN='bot-token';
  const calls=botMembers(f,[member(fresh,'新しいキャスト',[castRole]),member(ids.staff,'staff',[]),member('100000000000000010','通知Bot',[],{bot:true})]);
  const data=await (await f.request('/api/manage',{user:'admin'})).json();
  assert.equal(calls.length,1);assert.equal(data.directory.count,2);
  const added=data.users.find(u=>u.id===fresh);
  assert.deepEqual(added.roles,['接客キャスト']);assert.equal(added.logged_in,false);
  assert.ok(!data.users.some(u=>u.display_name==='通知Bot'));
  await f.event();
  assert.equal((await f.request('/api/manage/assignments',{user:'admin',method:'POST',body:{event_id:'event-1',user_id:fresh,details:'1卓',published:false}})).status,200);
  await f.request('/api/manage',{user:'admin'});assert.equal(calls.length,1,'5分以内は再取得しない');
});

test('サーバーを抜けた未ログインの人は次の取得で一覧から消え、配置にも選べない',async t=>{
  const f=await fixture();t.after(f.close);f.env.DISCORD_BOT_TOKEN='bot-token';
  botMembers(f,[member(fresh,'新しいキャスト',[castRole])]);
  await f.request('/api/manage',{user:'admin'});
  botMembers(f,[]);
  const result=await (await f.request('/api/manage/staff-sync',{user:'admin',method:'POST'})).json();
  assert.ok(!result.users.some(u=>u.id===fresh));
  await f.event();
  assert.equal((await f.request('/api/manage/assignments',{user:'admin',method:'POST',body:{event_id:'event-1',user_id:fresh,details:'',published:false}})).status,400);
});

test('Botの取得に失敗しても運営ページは開け、ログイン済みのスタッフは選べる',async t=>{
  const f=await fixture();t.after(f.close);f.env.DISCORD_BOT_TOKEN='bad-token';
  botMembers(f,[],{status:401});
  const response=await f.request('/api/manage',{user:'admin'});assert.equal(response.status,200);
  const data=await response.json();
  assert.match(data.directory.error,/トークン/);assert.ok(data.users.some(u=>u.id===ids.staff));
  assert.equal((await f.request('/api/manage/staff-sync',{user:'admin',method:'POST'})).status,503);
});

test('Botが未設定なら従来どおりログイン済みのスタッフだけを表示し、再取得はできない',async t=>{
  const f=await fixture();t.after(f.close);
  const data=await (await f.request('/api/manage',{user:'admin'})).json();
  assert.equal(data.directory.configured,false);assert.deepEqual(data.users.map(u=>u.id).sort(),[ids.admin,ids.staff].sort());
  assert.equal((await f.request('/api/manage/staff-sync',{user:'admin',method:'POST'})).status,503);
});

test('スタッフ一覧の再取得は運営だけが実行できる',async t=>{
  const f=await fixture();t.after(f.close);f.env.DISCORD_BOT_TOKEN='bot-token';botMembers(f,[]);
  for(const [user,status] of [[undefined,401],['customer',403],['staff',403]])assert.equal((await f.request('/api/manage/staff-sync',{user,method:'POST'})).status,status);
});

test('テーブル作成前の本番に公開しても運営ページと配置の保存が動く',async t=>{
  const f=await fixture();t.after(f.close);f.DB.sqlite.exec('DROP TABLE staff_directory');
  assert.equal((await f.request('/api/manage',{user:'admin'})).status,200);
  await f.event();
  assert.equal((await f.request('/api/manage/assignments',{user:'admin',method:'POST',body:{event_id:'event-1',user_id:ids.staff,details:'',published:false}})).status,200);
});
