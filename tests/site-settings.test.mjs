import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {siteContent,siteDefaults,durationLabel} from '../public/site-content.mjs';

const save=(f,body,extra={})=>f.request('/api/manage/settings',{user:'admin',method:'POST',body,...extra});
const settings=async f=>(await (await f.request('/api/public')).json()).settings;
async function setup(t){const f=await fixture();t.after(f.close);return f;}
async function image(f,id,visibility='public'){
  await f.DB.prepare('INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,'drive-'+id,'image/webp',4,visibility,ids.admin,new Date().toISOString()).run();
}

test('開催場所・会場URL・所要時間・プログラム・施設紹介を運営だけが保存できる',async t=>{
  const f=await setup(t),body={...structuredClone(siteDefaults),venue:'新しい星空ワールド',venue_url:'https://vrchat.com/home/world/wrld_123',main_minutes:90,after_minutes:20,facility_intro:'新しい施設の案内\n2行目です。'};
  body.programs[0].title='今夜の天体';body.programs[0].minutes=20;body.facilities[0].title='新しいドーム';
  for(const [user,status] of [[undefined,401],['customer',403],['staff',403]])assert.equal((await save(f,body,{user})).status,status);
  assert.equal((await save(f,body,{csrf:false})).status,403);
  assert.equal((await save(f,body)).status,200);
  const saved=await settings(f);for(const key of Object.keys(body))assert.deepEqual(saved[key],body[key]);
  assert.equal(durationLabel(siteContent(saved)),'本編90分 ＋ アフター20分');
});

test('従来の設定の保存や一部だけの更新で、開催場所・紹介写真・通常営業を消さない',async t=>{
  const f=await setup(t),original=await settings(f);
  const hours={interval_weeks:2,weekday:6,start_time:'22:00',end_time:'23:30'};
  await f.request('/api/manage/schedule',{user:'admin',method:'POST',body:{regular_hours:hours}});
  await save(f,{venue:'変更した会場',programs:siteDefaults.programs,facilities:siteDefaults.facilities});
  assert.equal((await save(f,{...original,about:'更新した概要'})).status,200);
  assert.equal((await save(f,{cadence:'祝日は変更する場合があります'})).status,200);
  const saved=await settings(f);assert.equal(saved.venue,'変更した会場');assert.equal(saved.about,'更新した概要');assert.deepEqual(saved.programs,siteDefaults.programs);assert.deepEqual(saved.facilities,siteDefaults.facilities);assert.deepEqual(saved.regular_hours,hours);assert.equal(saved.x_url,original.x_url);
});

test('不正な会場URL・時間・紹介内容は設定を一部も更新せず拒否する',async t=>{
  const f=await setup(t),original=await settings(f);
  const bad=[{venue:''},{venue:'x'.repeat(161)},{venue_url:'javascript:alert(1)'},{venue_url:'http://example.test/world'},{main_minutes:-1},{main_minutes:600.5},{after_minutes:601},{main_minutes:30},{main_minutes:'90'},{programs:[]},{facilities:{}},{programs:[null,null,null]}];
  for(const body of bad){assert.equal((await save(f,{about:'保存されない説明',...body})).status,400,JSON.stringify(body));assert.deepEqual(await settings(f),original);}
  const programs=structuredClone(siteDefaults.programs);programs[0].minutes=601;
  assert.equal((await save(f,{programs})).status,400);
});

test('紹介写真は同梱写真か公開用画像に限定し、使用をやめた写真は公開しない',async t=>{
  const f=await setup(t);await f.connectDrive();await image(f,'program-photo');await image(f,'facility-photo');await image(f,'private-photo','private');
  const programs=structuredClone(siteDefaults.programs),facilities=structuredClone(siteDefaults.facilities);programs[0].image='program-photo';facilities[0].image='facility-photo';
  assert.equal((await f.request('/api/images/program-photo')).status,401);
  assert.equal((await save(f,{programs,facilities})).status,200);
  assert.equal((await f.request('/api/images/program-photo')).status,200);assert.equal((await f.request('/api/images/facility-photo')).status,200);
  for(const ref of ['private-photo','missing','/assets/unknown.webp','https://example.test/photo.jpg','../secret']){
    programs[0].image=ref;assert.equal((await save(f,{programs})).status,400,ref);
  }
  assert.equal((await f.request('/api/images/private-photo')).status,401);
  assert.equal((await save(f,{programs:siteDefaults.programs,facilities:siteDefaults.facilities})).status,200);
  assert.equal((await f.request('/api/images/program-photo')).status,401);assert.equal((await f.request('/api/images/facility-photo')).status,401);
});

test('未設定のサイトでも管理画面とホームが同じ初期値を使い、HTMLを含む文章をそのまま保存する',async t=>{
  const f=await setup(t),first=siteContent(await settings(f));assert.equal(first.venue,siteDefaults.venue);assert.equal(first.main_minutes,75);assert.deepEqual(first.facilities,siteDefaults.facilities);
  first.programs[0].title='コピーを変えても初期値を変更しない';assert.equal(siteDefaults.programs[0].title,'星空解説');
  const name='<img src=x onerror=alert(1)>',programs=structuredClone(siteDefaults.programs);programs[0].description='<script>alert(1)</script>';
  assert.equal((await save(f,{venue:name,programs})).status,200);const saved=siteContent(await settings(f));assert.equal(saved.venue,name);assert.equal(saved.programs[0].description,'<script>alert(1)</script>');
  assert.equal((await save(f,{x_url:'',youtube_url:'',discord_invite:'',cadence:''})).status,200);const cleared=await settings(f);for(const key of ['x_url','youtube_url','discord_invite','cadence'])assert.equal(cleared[key],'');
});
