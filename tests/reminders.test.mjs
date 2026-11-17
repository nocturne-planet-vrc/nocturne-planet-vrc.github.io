import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {dutyRoles} from '../src/duties.mjs';
import {sendReminders,currentStage,reminderMessage} from '../src/reminders.mjs';

const castRole=dutyRoles.find(duty=>duty.name==='接客キャスト').role_id;
const fresh='100000000000000009',noRole='100000000000000010';
const minute=60000,hour=60*minute;
const cronSecret='c'.repeat(40);

async function setup(t,{deadlineIn=11*hour}={}){
  const f=await fixture();t.after(f.close);
  f.env.DISCORD_BOT_TOKEN='bot-token';f.env.CRON_SECRET=cronSecret;
  f.hooks.botMembers=()=>Response.json([
    {user:{id:ids.staff,username:'staff'},roles:[castRole]},
    {user:{id:fresh,username:'fresh'},roles:[castRole]},
    {user:{id:noRole,username:'guest'},roles:[]}
  ]);
  const now=Date.now();
  await f.event('event-1',{starts_at:new Date(now+2*86400000).toISOString(),ends_at:new Date(now+2*86400000+5400000).toISOString(),response_deadline:new Date(now+deadlineIn).toISOString()});
  return {f,now};
}
const cron=(f,auth='Bearer '+cronSecret)=>f.request('/api/cron/reminders',{method:'POST',headers:{Authorization:auth}});

test('締切の段階は、始まっている窓のうち一番近いものを選ぶ',()=>{
  const deadline=new Date(Date.UTC(2026,10,20,12)).toISOString(),end=Date.parse(deadline);
  assert.equal(currentStage(deadline,end-13*hour),null);
  assert.equal(currentStage(deadline,end-11*hour),720);
  assert.equal(currentStage(deadline,end-50*minute),60);
  assert.equal(currentStage(deadline,end-3*minute),5);
  assert.equal(currentStage(deadline,end+minute),null);
});

test('担当ロールがあり未回答の人だけに、締切12時間前のDMを1回だけ送る',async t=>{
  const {f}=await setup(t);
  await f.DB.prepare("INSERT INTO attendance(event_id,user_id,answer,updated_at) VALUES('event-1',?,'yes',?)").bind(ids.staff,new Date().toISOString()).run();
  const result=await (await cron(f)).json();
  assert.equal(result.sent,1);assert.deepEqual(f.dms.opened,[fresh]);
  assert.match(f.dms.sent[0].content,/出欠の回答がまだ/);assert.match(f.dms.sent[0].content,/\/staff/);
  assert.deepEqual(f.dms.sent[0].allowed_mentions,{parse:[]});
  assert.equal((await (await cron(f)).json()).sent,0,'同じ段階は再送しない');
  assert.equal(f.dms.sent.length,1);
});

test('1時間前・5分前もそれぞれ送り、DMチャンネルは使い回す',async t=>{
  const {f,now}=await setup(t);
  await sendReminders(f.env,f.fetcher,now);
  const deadline=now+11*hour;
  assert.equal((await sendReminders(f.env,f.fetcher,deadline-50*minute)).sent,2);
  assert.equal((await sendReminders(f.env,f.fetcher,deadline-4*minute)).sent,2);
  assert.equal((await sendReminders(f.env,f.fetcher,deadline-2*minute)).sent,0);
  assert.equal(f.dms.sent.length,6);assert.equal(f.dms.opened.length,2,'DMを開くのは1人1回');
  assert.match(f.dms.sent.at(-1).content,/あと4分/);
});

test('締切直前に初めて実行しても、古い「12時間前」の通知は送らない',async t=>{
  const {f,now}=await setup(t,{deadlineIn:3*minute});
  assert.equal((await sendReminders(f.env,f.fetcher,now)).sent,2);
  const log=(await f.DB.prepare('SELECT DISTINCT stage FROM reminder_log').all()).results.map(r=>r.stage);
  assert.deepEqual(log,[5]);
});

test('締切が変わったら、新しい締切に合わせて通知し直す',async t=>{
  const {f,now}=await setup(t);
  await sendReminders(f.env,f.fetcher,now);
  await f.DB.prepare('UPDATE events SET response_deadline=? WHERE id=?').bind(new Date(now+10*hour).toISOString(),'event-1').run();
  assert.equal((await sendReminders(f.env,f.fetcher,now)).sent,2);
});

test('DMを受け取らない人は記録し、ほかの人への送信は続ける',async t=>{
  const {f}=await setup(t);
  f.hooks.dmSend=channel=>channel==='dm-'+ids.staff?Response.json({code:50007,message:'Cannot send messages to this user'},{status:403}):undefined;
  const result=await (await cron(f)).json();
  assert.equal(result.sent,1);assert.equal(result.failed,1);
  const row=await f.DB.prepare('SELECT status FROM reminder_log WHERE user_id=?').bind(ids.staff).first();
  assert.equal(row.status,'blocked');
  const data=await (await f.request('/api/manage',{user:'admin'})).json();
  assert.ok(data.roster.reminders.some(r=>r.user_id===ids.staff&&r.status==='blocked'));
});

test('Discordの送信制限に当たった分は次回に回す',async t=>{
  const {f}=await setup(t);
  let limited=true;f.hooks.dmSend=()=>limited?Response.json({retry_after:1},{status:429}):undefined;
  const first=await (await cron(f)).json();
  assert.equal(first.sent,0);assert.ok(first.deferred>=1);
  limited=false;
  assert.equal((await (await cron(f)).json()).sent,2);
});

test('締切前の通知の実行には秘密の合言葉が必要',async t=>{
  const {f}=await setup(t);
  assert.equal((await cron(f,'')).status,401);
  assert.equal((await cron(f,'Bearer wrong')).status,401);
  delete f.env.CRON_SECRET;assert.equal((await cron(f)).status,404);
  assert.equal(f.dms.sent.length,0);
});

test('運営ページに出欠の対象者と未回答の状況が出る',async t=>{
  const {f}=await setup(t);
  const data=await (await f.request('/api/manage',{user:'admin'})).json();
  assert.deepEqual(data.roster.target_ids.sort(),[ids.staff,fresh].sort());
  assert.ok(!data.roster.target_ids.includes(noRole),'担当ロールがない人は対象外');
  assert.equal(data.reminders_ready,true);
});

test('通知文に営業名・期限・スタッフページを入れる',()=>{
  const now=Date.UTC(2026,10,20,0);
  const text=reminderMessage({title:'通常営業',starts_at:new Date(now+2*86400000).toISOString(),response_deadline:new Date(now+hour).toISOString()},now,'https://nocturne-planet.pages.dev');
  assert.match(text,/営業：通常営業/);assert.match(text,/あと約1時間/);assert.match(text,/https:\/\/nocturne-planet\.pages\.dev\/staff$/);
});

