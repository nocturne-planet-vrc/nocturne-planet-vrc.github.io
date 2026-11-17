import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';

const values={cast_id:'cast-1',tagline:'星が好きです',bio:'好きな星座はオリオン座です。',x_url:'https://x.com/example',youtube_url:'https://www.youtube.com/@example'};
const save=(f,body=values,extra={})=>f.request('/api/staff/profile',{user:'staff',method:'POST',body,...extra});
const castRow=f=>f.DB.prepare("SELECT * FROM casts WHERE id='cast-1'").first();
async function setup(t,active=1){const f=await fixture();t.after(f.close);await f.cast({active});return f;}

test('紐付け済みの本人が4項目を更新でき、公開HPへ反映する',async t=>{
  const f=await setup(t);await f.cast({id:'cast-2',user:ids.admin,name:'別のキャスト'});
  const before=await castRow(f),response=await save(f);assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.profile.id,'cast-1');
  for(const field of ['tagline','bio','x_url','youtube_url'])assert.equal(data.profile[field],values[field]);
  const after=await castRow(f);
  for(const field of ['display_name','image_id','sort_order','active','user_id'])assert.equal(after[field],before[field]);
  const staff=await (await f.request('/api/staff',{user:'staff'})).json();assert.equal(staff.profile.id,'cast-1');assert.equal(staff.profile.bio,values.bio);
  const admin=await (await f.request('/api/staff',{user:'admin'})).json();assert.equal(admin.profile.id,'cast-2');
  const publicCast=(await (await f.request('/api/public')).json()).casts.find(c=>c.id==='cast-1');
  assert.equal(publicCast.tagline,values.tagline);assert.equal(publicCast.x_url,values.x_url);assert.ok(!Object.hasOwn(publicCast,'user_id'));
  assert.equal((await f.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE actor_id=? AND action='cast.self.update' AND resource_id='cast-1'").bind(ids.staff).first()).n,1);
  assert.equal((await save(f,{cast_id:'cast-1',tagline:'',bio:'',x_url:'',youtube_url:''})).status,200);
  assert.equal((await castRow(f)).bio,'');
});

test('非公開の紹介は本人が編集しても非公開のまま',async t=>{
  const f=await setup(t,0);assert.equal((await save(f)).status,200);
  assert.equal((await castRow(f)).active,0);
  assert.equal((await (await f.request('/api/staff',{user:'staff'})).json()).profile.bio,values.bio);
  assert.equal((await (await f.request('/api/public')).json()).casts.length,0);
});

test('非公開の紹介写真は現在所属する本人と運営だけが確認できる',async t=>{
  const f=await setup(t,0);await f.cheki({image:'cast-photo'});
  await f.DB.prepare("UPDATE images SET visibility='public' WHERE id='cast-photo'").run();
  await f.DB.prepare("UPDATE casts SET image_id='cast-photo' WHERE id='cast-1'").run();
  const profile=(await (await f.request('/api/staff',{user:'staff'})).json()).profile;
  assert.equal(profile.image_id,'cast-photo');
  for(const user of ['staff','admin'])assert.equal((await f.request('/api/images/cast-photo',{user})).status,200);
  assert.equal((await f.request('/api/images/cast-photo')).status,401);
  assert.equal((await f.request('/api/images/cast-photo',{user:'customer'})).status,403);
  await f.DB.prepare('UPDATE casts SET user_id=NULL').run();
  assert.equal((await f.request('/api/images/cast-photo',{user:'staff'})).status,403);
  await f.DB.prepare('UPDATE casts SET user_id=?').bind(ids.staff).run();
  f.members.delete(`${ids.staff}:${f.env.STAFF_GUILD_ID}`);
  assert.equal((await f.request('/api/images/cast-photo',{user:'staff'})).status,403);
  assert.equal((await (await f.request('/api/public')).json()).casts.length,0);
});

test('名前・写真・公開・紐付けなどの追加項目は拒否し、他のキャストも変更しない',async t=>{
  const f=await setup(t);await f.cast({id:'cast-2',user:ids.admin});const before=await castRow(f);
  for(const [field,value] of Object.entries({display_name:'別名',image_id:'x',sort_order:99,active:0,user_id:ids.admin,id:'cast-2'})){
    assert.equal((await save(f,{...values,[field]:value})).status,400,field);assert.deepEqual(await castRow(f),before);
  }
  assert.equal((await save(f,{...values,cast_id:'cast-2'})).status,409);
  assert.equal((await save(f,values,{user:'admin'})).status,409);
  assert.deepEqual(await castRow(f),before);
  assert.equal((await f.DB.prepare("SELECT bio FROM casts WHERE id='cast-2'").first()).bio,'');
});

test('未紐付けでは新規作成できず、現在の所属・ログイン・CSRFが必要',async t=>{
  const f=await setup(t);const before=await castRow(f);
  assert.equal((await f.request('/api/staff/profile',{method:'POST',body:values})).status,401);
  assert.equal((await save(f,values,{user:'customer'})).status,403);
  assert.equal((await save(f,values,{csrf:false})).status,403);
  assert.equal((await save(f,values,{origin:'https://evil.example'})).status,403);
  assert.equal((await save(f,values,{user:'admin'})).status,403);
  f.members.delete(`${ids.staff}:${f.env.STAFF_GUILD_ID}`);
  assert.equal((await save(f)).status,403);assert.deepEqual(await castRow(f),before);
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[],pending:false});
  await f.DB.prepare('UPDATE casts SET user_id=NULL').run();
  assert.equal((await save(f)).status,403);
  assert.equal((await (await f.request('/api/staff',{user:'staff'})).json()).profile,null);
  assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM casts').first()).n,1);
});

test('長すぎる文章・危険なURL・不正な型は保存せず、元の紹介を守る',async t=>{
  const f=await setup(t),before=await castRow(f);
  for(const extra of [{tagline:'あ'.repeat(121)},{bio:'あ'.repeat(3001)},{bio:null},{x_url:0},{youtube_url:'javascript:alert(1)'},{x_url:'http://x.com/example'},{x_url:'https://user:password@x.com/example'},{youtube_url:'https://example.com/'+ 'x'.repeat(2048)}]){
    assert.equal((await save(f,{...values,...extra})).status,400,JSON.stringify(extra).slice(0,70));assert.deepEqual(await castRow(f),before);
  }
  assert.equal((await save(f,{cast_id:'cast-1',tagline:'ひとことだけ'})).status,400);
});

test('保存直前に紐付けが変わっても新しい所有者の紹介を更新しない',async t=>{
  const f=await setup(t),prepare=f.DB.prepare.bind(f.DB),before=await castRow(f);
  f.DB.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.startsWith('UPDATE casts SET tagline='))return statement;
    return {...statement,bind:(...args)=>{const bound=statement.bind(...args);return {...bound,first:async()=>{await prepare('UPDATE casts SET user_id=? WHERE id=?').bind(ids.admin,'cast-1').run();return bound.first();}};}};
  };
  assert.equal((await save(f)).status,409);
  assert.equal((await castRow(f)).bio,before.bio);assert.equal((await castRow(f)).user_id,ids.admin);
});
