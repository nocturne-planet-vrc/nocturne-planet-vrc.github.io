import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {sendReminders} from '../src/reminders.mjs';
import {ensureManageTrash} from '../src/manage-records.mjs';
import {DatabaseSync} from 'node:sqlite';

const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=','base64'));
async function setup(t){const f=await fixture();t.after(f.close);await f.event();await f.cast();await f.favorite();await f.visit();await f.cheki({image:'legacy'});return f;}
async function batch(f){
  const audience=await (await f.request('/api/staff/recipients?event_id=event-1',{user:'staff'})).json(),id=crypto.randomUUID(),body=new FormData();
  for(const [key,value] of Object.entries({batch_id:id,event_id:'event-1',audience_hash:audience.audience_hash,message:'private-message'}))body.set(key,value);
  body.set('image',new File([png],'test.png',{type:'image/png'}));
  assert.equal((await f.request('/api/staff/cheki',{user:'staff',method:'POST',body})).status,200);
  return f.DB.prepare('SELECT * FROM cheki_batches WHERE id=?').bind(id).first();
}
const mutate=(f,resource,action,body,extra={})=>f.request(`/api/manage/${resource}/${action}`,{user:'admin',method:'POST',body,...extra});
const list=async(f,resource,query='')=>(await (await f.request(`/api/manage/${resource}${query}`,{user:'admin'})).json());
const member=async(f,user='customer')=>(await (await f.request('/api/member',{user})).json());
async function eventAction(f,action,extra={}){const event=await f.DB.prepare('SELECT * FROM events WHERE id=?').bind('event-1').first();return mutate(f,'events',action,{id:event.id,updated_at:event.updated_at},extra);}

test('運営だけがチェキ管理・営業日管理を取得でき、削除と復元にCSRFが必要',async t=>{
  const f=await setup(t),event=await f.DB.prepare('SELECT * FROM events').first();
  for(const [user,status] of [[undefined,401],['customer',403],['staff',403]]){
    for(const path of ['/api/manage/cheki','/api/manage/events'])assert.equal((await f.request(path,{user})).status,status);
    for(const [resource,body] of [['events',{id:event.id,updated_at:event.updated_at}],['cheki',{items:[{kind:'single',id:'legacy'}]}]])for(const action of ['delete','restore'])assert.equal((await mutate(f,resource,action,body,{user})).status,status);
  }
  for(const action of ['delete','restore'])assert.equal((await mutate(f,'cheki',action,{items:[{kind:'single',id:'legacy'}]},{csrf:false})).status,403);
  assert.equal((await eventAction(f,'delete',{csrf:false})).status,403);
});

test('旧チェキと一斉送信を選択削除し、画像の直URL・追加配布も止め、未選択と来店履歴を保つ',async t=>{
  const f=await setup(t),sent=await batch(f);await f.cheki({image:'keep'});
  const data=await list(f,'cheki');assert.equal(data.total,3);
  for(const item of data.cheki)for(const key of ['image_id','message','recipient_id','drive_id'])assert.ok(!Object.hasOwn(item,key));
  assert.equal((await f.request('/api/images/'+sent.image_id,{user:'admin'})).status,403);
  const items=[{kind:'single',id:'legacy'},{kind:'batch',id:sent.id}];
  assert.equal((await mutate(f,'cheki','delete',{items})).status,200);
  assert.deepEqual((await member(f)).cheki.map(c=>c.id),['keep']);assert.equal((await member(f)).visits.length,1);
  assert.equal((await f.request('/api/images/legacy',{user:'customer'})).status,403);assert.equal((await f.request('/api/images/'+sent.image_id,{user:'staff'})).status,403);
  await f.favorite(ids.other);await f.visit(ids.other);assert.deepEqual((await member(f,'other')).cheki,[]);
  assert.equal((await list(f,'cheki')).total,1);assert.equal((await list(f,'cheki','?deleted=1')).total,2);
  assert.equal((await mutate(f,'cheki','delete',{items})).status,200);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action='cheki.delete'").first()).n,2);
  assert.equal(f.deletions.length,0);
  assert.equal((await mutate(f,'cheki','restore',{items})).status,200);
  assert.equal((await member(f)).cheki.length,3);assert.equal((await member(f,'other')).cheki.length,1);
  assert.equal((await f.request('/api/images/'+sent.image_id,{user:'customer'})).status,200);
});

test('削除中に送信者が取り消したチェキは、運営が復元しても再配布しない',async t=>{
  const f=await setup(t),sent=await batch(f),items=[{kind:'batch',id:sent.id}];
  await mutate(f,'cheki','delete',{items});await f.request('/api/staff/cheki/withdraw',{user:'staff',method:'POST',body:{id:sent.id}});await mutate(f,'cheki','restore',{items});
  assert.equal((await member(f)).cheki.some(c=>c.id===sent.id),false);assert.equal((await f.request('/api/images/'+sent.image_id,{user:'customer'})).status,403);
});

test('選択の不備や不明なIDを含む一括削除は、一部も更新しない',async t=>{
  const f=await setup(t);
  for(const items of [[],[{kind:'wrong',id:'legacy'}],[{kind:'single',id:'legacy'},{kind:'single',id:'missing'}],[{kind:'single',id:'legacy'},{kind:'single',id:'legacy'}],Array(101).fill({kind:'single',id:'legacy'})]){
    const response=await mutate(f,'cheki','delete',{items});assert.ok([400,404].includes(response.status));assert.equal((await list(f,'cheki')).total,1);
  }
  assert.equal((await list(f,'cheki','?q='+encodeURIComponent('テストキャスト'))).total,1);assert.equal((await list(f,'cheki','?q=no-match')).total,0);
  assert.equal((await f.request('/api/manage/cheki?page=-1',{user:'admin'})).status,400);
});

test('営業日を削除すると公開予定・受付・配置・リマインドから外れ、来店と配布済みチェキは残る',async t=>{
  const f=await setup(t),sent=await batch(f);
  await f.DB.prepare("INSERT INTO attendance(event_id,user_id,answer,updated_at) VALUES('event-1',?,'yes',?)").bind(ids.staff,new Date().toISOString()).run();
  await f.DB.prepare("INSERT INTO assignments(event_id,user_id,details,published) VALUES('event-1',?,'配置テスト',1)").bind(ids.staff).run();
  const before=(await list(f,'events')).events[0];assert.equal(before.visit_count,1);assert.equal(before.attendance_count,1);
  assert.equal((await eventAction(f,'delete')).status,200);
  assert.deepEqual((await (await f.request('/api/public')).json()).events,[]);assert.deepEqual((await (await f.request('/api/schedule')).json()).events,[]);
  const staff=await (await f.request('/api/staff',{user:'staff'})).json();assert.equal(staff.events.length,0);assert.equal(staff.assignments.length,0);
  assert.equal((await f.request('/api/member/checkin',{user:'customer',method:'POST',body:{event_id:'event-1',passphrase:'star-night'}})).status,403);
  assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:{event_id:'event-1',answer:'yes',duties:[]}})).status,403);
  assert.equal((await f.request('/api/staff/recipients?event_id=event-1',{user:'staff'})).status,400);
  assert.equal((await member(f)).visits.length,1);assert.ok((await member(f)).cheki.some(c=>c.id===sent.id));assert.equal((await f.request('/api/images/'+sent.image_id,{user:'customer'})).status,200);
  assert.equal((await list(f,'events')).total,0);assert.equal((await list(f,'events','?deleted=1')).total,1);
  f.env.DISCORD_BOT_TOKEN='test-bot';await f.DB.prepare('UPDATE events SET response_deadline=?').bind(new Date(Date.now()+60000).toISOString()).run();assert.equal((await sendReminders(f.env,f.fetcher)).sent,0);
  assert.equal((await eventAction(f,'restore')).status,200);const restored=(await list(f,'events')).events[0];assert.equal(restored.published,0);assert.equal(restored.visit_count,1);assert.equal(restored.assignment_count,1);assert.equal((await (await f.request('/api/public')).json()).events.length,0);
});

test('古い編集・削除リクエストで、ごみ箱の営業日を復活・上書きできない',async t=>{
  const f=await setup(t),event=(await list(f,'events')).events[0];await eventAction(f,'delete');
  assert.equal((await f.request('/api/manage/events',{user:'admin',method:'POST',body:{...event,published:true}})).status,409);
  assert.equal((await mutate(f,'events','restore',{id:event.id,updated_at:event.updated_at})).status,409);
  assert.equal((await f.request('/api/manage/assignments',{user:'admin',method:'POST',body:{event_id:event.id,user_id:ids.staff,details:'変更',published:true}})).status,400);
  assert.equal((await list(f,'events','?deleted=1')).total,1);
});

test('営業日削除がチェキ送信の確定と競合しても、新しい配布を確定しない',async t=>{
  const f=await setup(t),preview=await (await f.request('/api/staff/recipients?event_id=event-1',{user:'staff'})).json(),body=new FormData();
  for(const [key,value] of Object.entries({batch_id:crypto.randomUUID(),event_id:'event-1',audience_hash:preview.audience_hash}))body.set(key,value);body.set('image',new File([png],'test.png',{type:'image/png'}));
  let blocked=false;f.hooks.beforeBatch=async({statements})=>{if(!blocked&&statements.some(s=>s.sql.startsWith('WITH eligible AS'))){blocked=true;assert.equal((await eventAction(f,'delete')).status,200);}};
  assert.equal((await f.request('/api/staff/cheki',{user:'staff',method:'POST',body})).status,409);
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM cheki_batches WHERE state='sent'").first()).n,0);assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM cheki_deliveries').first()).n,0);
});

test('一括削除が途中で失敗した場合は、チェキと監査記録をまとめて巻き戻す',async t=>{
  const f=await setup(t),sent=await batch(f),items=[{kind:'single',id:'legacy'},{kind:'batch',id:sent.id}];
  f.DB.sqlite.exec("CREATE TRIGGER fail_delete BEFORE UPDATE OF deleted_at ON cheki_batches BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.equal((await mutate(f,'cheki','delete',{items})).status,500);
  assert.equal((await list(f,'cheki')).total,2);assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action='cheki.delete'").first()).n,0);
});

test('既存DBの追加項目を同時アクセスでも準備でき、失敗後に再試行できる',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());for(const name of ['events','cheki','cheki_batches'])db.exec(`CREATE TABLE ${name}(id TEXT,starts_at TEXT)`);
  let fail=true;
  const binding=()=>({prepare:sql=>({all:async()=>({results:db.prepare(sql).all()}),run:async()=>{if(fail&&sql.startsWith('ALTER')){fail=false;throw new Error('temporary');}return db.prepare(sql).run();}})});
  const first={DB:binding()};await assert.rejects(ensureManageTrash(first));
  await Promise.all([ensureManageTrash(first),ensureManageTrash({DB:binding()})]);
  for(const name of ['events','cheki','cheki_batches'])assert.equal(db.prepare(`PRAGMA table_info(${name})`).all().filter(c=>c.name==='deleted_at').length,1);
  await ensureManageTrash(first);
});

test('チェキ一覧はページごとに取得でき、指定したページの選択だけを削除する',async t=>{
  const f=await setup(t);for(let i=0;i<54;i++)await f.cheki({image:'page-'+String(i).padStart(2,'0')});
  const first=await list(f,'cheki'),second=await list(f,'cheki','?page=2');assert.equal(first.total,55);assert.equal(first.cheki.length,50);assert.equal(second.cheki.length,5);
  const ids=new Set(first.cheki.map(c=>c.id));assert.ok(second.cheki.every(c=>!ids.has(c.id)));
  assert.equal((await mutate(f,'cheki','delete',{items:second.cheki.map(({id,kind})=>({id,kind}))})).status,200);
  const kept=await list(f,'cheki');assert.equal(kept.total,50);assert.deepEqual(new Set(kept.cheki.map(c=>c.id)),ids);
});
