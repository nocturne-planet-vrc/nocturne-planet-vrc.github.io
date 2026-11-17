import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';

async function image(f,id,visibility='public'){
  await f.DB.prepare('INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,'drive-'+id,'image/webp',4,visibility,ids.admin,new Date().toISOString()).run();
}

test('トップ写真は複数枚を順番どおり保存し、選んでいる間だけ誰でも表示できる',async t=>{
  const f=await fixture();t.after(f.close);
  for(const id of ['hero-a','hero-b','hero-c'])await image(f,id);
  const original=(await (await f.request('/api/public')).json()).settings;
  assert.equal((await f.request('/api/manage/settings',{user:'admin',method:'POST',body:{...original,hero_images:['hero-b','hero-a']}})).status,200);
  const settings=(await (await f.request('/api/public')).json()).settings;
  assert.deepEqual(settings.hero_images,['hero-b','hero-a']);assert.equal(settings.hero_image,'hero-b');
  assert.notEqual((await f.request('/api/images/hero-a')).status,401);
  assert.equal((await f.request('/api/images/hero-c')).status,401);
  assert.equal((await f.request('/api/manage/settings',{user:'admin',method:'POST',body:{...settings,hero_images:['hero-b']}})).status,200);
  assert.equal((await f.request('/api/images/hero-a')).status,401);
});

test('トップ写真は公開用画像だけを12枚まで受け付ける',async t=>{
  const f=await fixture();t.after(f.close);
  await image(f,'private-photo','private');
  const original=(await (await f.request('/api/public')).json()).settings;
  for(const hero_images of [['private-photo'],['missing'],'hero-a',Array.from({length:13},(_,i)=>'hero-'+i),['../x']])assert.equal((await f.request('/api/manage/settings',{user:'admin',method:'POST',body:{...original,hero_images}})).status,400);
  assert.deepEqual((await (await f.request('/api/public')).json()).settings.hero_images??[],[]);
});
