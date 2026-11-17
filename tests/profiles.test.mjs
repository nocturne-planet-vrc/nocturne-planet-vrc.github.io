import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';

const values={cast_id:'cast-1',tagline:'星が好きです',bio:'好きな星座はオリオン座です。',x_url:'https://x.com/example',youtube_url:'https://www.youtube.com/@example'};
const save=(f,body=values,extra={})=>f.request('/api/staff/profile',{user:'staff',method:'POST',body,...extra});
const castRow=f=>f.DB.prepare("SELECT * FROM casts WHERE id='cast-1'").first();
async function setup(t,active=1){const f=await fixture();t.after(f.close);await f.cast({active});return f;}
// Same synthetic 1px PNG as cheki-batches.test.mjs; all Drive requests use the fixture.
const png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=','base64'));
function imageForm({castId='cast-1',bytes=png,mime='image/png'}={}){
  const form=new FormData();form.set('cast_id',castId);form.set('image',new File([bytes],'profile.png',{type:mime}));return form;
}
const upload=(f,form=imageForm(),options={})=>f.request('/api/staff/profile/image',{user:'staff',method:'POST',body:form,...options});
const imageRow=(f,id)=>f.DB.prepare('SELECT * FROM images WHERE id=?').bind(id).first();
const publicData=async f=>(await f.request('/api/public')).json();
const imageCount=async f=>(await f.DB.prepare('SELECT count(*) AS n FROM images').first()).n;
async function uploaded(f,form=imageForm(),options={}){
  const response=await upload(f,form,options),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));
  assert.equal(data.url,`/api/images/${data.id}`);return data;
}
async function seedImage(f,id,{uploader=ids.admin,visibility='public'}={}){
  await f.DB.prepare('INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,'profile-drive-'+id,'image/png',png.length,visibility,uploader,new Date().toISOString()).run();
  f.driveFiles.set('profile-drive-'+id,{bytes:png});await f.connectDrive();
}

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

test('名前・公開・紐付けなどの追加項目は拒否し、他のキャストも変更しない',async t=>{
  const f=await setup(t);await f.cast({id:'cast-2',user:ids.admin});const before=await castRow(f);
  for(const [field,value] of Object.entries({display_name:'別名',sort_order:99,active:0,user_id:ids.admin,id:'cast-2'})){
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
  const f=await setup(t);await seedImage(f,'previous-photo');await f.DB.prepare("UPDATE casts SET image_id='previous-photo' WHERE id='cast-1'").run();
  const draft=await uploaded(f),prepare=f.DB.prepare.bind(f.DB),before=await castRow(f);
  f.DB.prepare=sql=>{
    const statement=prepare(sql);
    if(!sql.startsWith('UPDATE casts SET tagline='))return statement;
    return {...statement,bind:(...args)=>{const bound=statement.bind(...args);return {...bound,first:async()=>{await prepare('UPDATE casts SET user_id=? WHERE id=?').bind(ids.admin,'cast-1').run();return bound.first();}};}};
  };
  assert.equal((await save(f,{...values,image_id:draft.id})).status,409);
  assert.equal((await castRow(f)).bio,before.bio);assert.equal((await castRow(f)).user_id,ids.admin);
  assert.equal((await castRow(f)).image_id,before.image_id);assert.equal((await f.request(draft.url,{user:'staff'})).status,403);
});

for(const active of [1,0])test(`紹介写真はuploadだけではcastも公開APIも変えず、保存時にだけ反映する（active=${active}）`,async t=>{
  const f=await setup(t,active);await f.connectDrive();await f.cast({id:'cast-2',user:ids.other});
  f.members.set(`${ids.other}:${f.env.STAFF_GUILD_ID}`,{roles:[],pending:false});
  const before=(await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results,publicBefore=await publicData(f);
  const data=await uploaded(f),image=await imageRow(f,data.id);
  assert.equal(image.visibility,'public');assert.equal(image.uploaded_by,ids.staff);assert.equal(image.mime,'image/png');assert.equal(image.size,png.length);
  assert.equal(await imageCount(f),1);assert.equal(f.uploads.length,1);assert.deepEqual(f.uploads[0].bytes,png);assert.equal(f.uploads[0].mime,'image/png');
  assert.equal(image.drive_id,f.uploads[0].id);assert.deepEqual(f.uploads[0].metadata.parents,['private-folder']);assert.ok(!Object.hasOwn(f.uploads[0].metadata,'permissions'));
  assert.deepEqual((await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results,before);assert.deepEqual(await publicData(f),publicBefore);
  for(const table of ['audit_log','cheki','cheki_batches'])assert.equal((await f.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n,0,table);
  assert.equal((await (await f.request('/api/staff',{user:'staff'})).json()).profile.image_id,before[0].image_id);
  for(const user of ['staff','admin']){
    const response=await f.request(data.url,{user});assert.equal(response.status,200,user);assert.equal(response.headers.get('Content-Type'),'image/png');
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),png);
  }
  const calls=f.calls.length;
  for(const [user,status] of [[undefined,401],['customer',403],['other',403]])assert.equal((await f.request(data.url,{user})).status,status,String(user));
  assert.equal(f.calls.slice(calls).filter(c=>c.url.includes('googleapis')).length,0);
  const response=await save(f,{...values,image_id:data.id});assert.equal(response.status,200);assert.equal((await response.json()).profile.image_id,data.id);
  const after=await castRow(f);for(const field of ['display_name','sort_order','active','user_id'])assert.equal(after[field],before[0][field],field);
  assert.deepEqual(await f.DB.prepare("SELECT * FROM casts WHERE id='cast-2'").first(),before[1]);
  assert.equal((await publicData(f)).casts.find(c=>c.id==='cast-1')?.image_id,active?data.id:undefined);
  assert.equal((await f.request(data.url)).status,active?200:401);assert.equal(await imageCount(f),1);assert.equal(f.uploads.length,1);
});

test('写真uploadはログイン・現在のstaff所属・CSRF・Origin・本人のcast紐付けを必須にする',async t=>{
  const f=await setup(t);await f.connectDrive();const before=await castRow(f);
  for(const [options,status] of [[{user:undefined},401],[{user:'customer'},403],[{user:'admin'},403],[{csrf:false},403],[{origin:'https://evil.example'},403]]){
    assert.equal((await upload(f,imageForm(),options)).status,status,JSON.stringify(options));
  }
  assert.deepEqual(await castRow(f),before);assert.equal(await imageCount(f),0);assert.equal(f.uploads.length,0);
});

test('写真uploadで別cast・古いcast・cast_id省略を指定すると409で保存しない',async t=>{
  const f=await setup(t);await f.connectDrive();await f.cast({id:'cast-2',user:ids.admin});
  const before=(await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results;
  for(const castId of ['cast-2','missing',''])assert.equal((await upload(f,imageForm({castId}))).status,409,castId);
  const missing=imageForm();missing.delete('cast_id');assert.equal((await upload(f,missing)).status,409);
  assert.equal((await upload(f,imageForm(),{user:'admin'})).status,409);
  assert.deepEqual((await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results,before);assert.equal(await imageCount(f),0);assert.equal(f.uploads.length,0);
});

test('写真uploadはmultipart・画像必須・MIME実体一致・4MB上限を保存前に検証する',async t=>{
  const f=await setup(t);await f.connectDrive();const before=await castRow(f);
  const jpeg=new Uint8Array([255,216,255,0,0,0,0,0,0,0,0,0]);
  for(const [options,status] of [[{mime:'image/jpeg'},400],[{bytes:jpeg,mime:'image/png'},400],[{mime:'image/svg+xml'},400],[{bytes:new Uint8Array(12)},400],[{bytes:new Uint8Array(11)},413],[{bytes:new Uint8Array(4*1024*1024+1)},400]]){
    assert.equal((await upload(f,imageForm(options))).status,status,JSON.stringify({mime:options.mime,size:options.bytes?.length}));
  }
  const missing=imageForm();missing.delete('image');assert.equal((await upload(f,missing)).status,400);
  const textFile=imageForm();textFile.set('image','not a file');assert.equal((await upload(f,textFile)).status,400);
  assert.equal((await upload(f,{cast_id:'cast-1',image:'not multipart'})).status,400);
  const oversized=imageForm();oversized.set('padding','x'.repeat(4500000));assert.equal((await upload(f,oversized)).status,413);
  assert.equal((await upload(f,imageForm(),{headers:{'Content-Length':'4500001'}})).status,413);
  assert.deepEqual(await castRow(f),before);assert.equal(await imageCount(f),0);assert.equal(f.uploads.length,0);
  const boundary=new Uint8Array(4*1024*1024);boundary.set(png);
  const data=await uploaded(f,imageForm({bytes:boundary}));assert.equal((await imageRow(f,data.id)).size,boundary.length);
  assert.equal(f.uploads.length,1);assert.equal(await imageCount(f),1);assert.deepEqual(await castRow(f),before);
});

test('image_id省略と既存と同じ運営提供写真は保持でき、自分の新しい公開用画像へ変更できる',async t=>{
  const f=await setup(t);await seedImage(f,'admin-photo');await f.DB.prepare("UPDATE casts SET image_id='admin-photo' WHERE id='cast-1'").run();
  for(const body of [values,{...values,image_id:'admin-photo'}]){
    const response=await save(f,body);assert.equal(response.status,200);assert.equal((await response.json()).profile.image_id,'admin-photo');assert.equal((await castRow(f)).image_id,'admin-photo');
  }
  const draft=await uploaded(f);assert.equal((await castRow(f)).image_id,'admin-photo');assert.equal((await publicData(f)).casts[0].image_id,'admin-photo');
  assert.equal((await save(f,{...values,image_id:draft.id})).status,200);assert.equal((await castRow(f)).image_id,draft.id);
  const before=await castRow(f);assert.equal((await save(f,{...values,bio:'写真を維持して更新'})).status,200);
  assert.equal((await castRow(f)).image_id,before.image_id);assert.equal((await imageRow(f,'admin-photo')).uploaded_by,ids.admin);
  assert.equal((await save(f,{...values,image_id:'admin-photo'})).status,400);assert.equal((await castRow(f)).image_id,draft.id);
});

for(const imageId of [0,false])test(`image_idの不正な型${JSON.stringify(imageId)}を写真解除として扱わず拒否する`,async t=>{
  const f=await setup(t);await seedImage(f,'existing-photo');await f.DB.prepare("UPDATE casts SET image_id='existing-photo' WHERE id='cast-1'").run();
  const before=await castRow(f),publicBefore=await publicData(f);
  const response=await save(f,{...values,image_id:imageId});
  assert.equal(response.status,400,`image_id=${JSON.stringify(imageId)}は不正な型なので既存写真を解除せず拒否する`);
  assert.deepEqual(await castRow(f),before);assert.deepEqual(await publicData(f),publicBefore);
});

test('写真保存はprivateチェキ・他人の公開用下書き・他castの写真やID・不正IDを拒否する',async t=>{
  const f=await setup(t);await f.cheki({image:'own-private'});await f.cheki({image:'other-private',sender:ids.admin});
  await seedImage(f,'other-draft');await seedImage(f,'other-photo');await f.cast({id:'cast-2',user:ids.admin});
  await f.DB.prepare("UPDATE casts SET image_id='other-photo' WHERE id='cast-2'").run();
  const before=(await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results,publicBefore=await publicData(f),count=await imageCount(f);
  for(const imageId of ['own-private','other-private','other-draft','other-photo','cast-2','missing','../own-private',42,{},true]){
    assert.equal((await save(f,{...values,image_id:imageId})).status,400,JSON.stringify(imageId));
    assert.deepEqual((await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results,before);assert.deepEqual(await publicData(f),publicBefore);
  }
  const own=await uploaded(f);
  assert.equal((await save(f,{...values,cast_id:'cast-2',image_id:own.id})).status,409);
  assert.deepEqual((await f.DB.prepare('SELECT * FROM casts ORDER BY id').all()).results,before);
  assert.equal(await imageCount(f),count+1);assert.equal((await f.DB.prepare('SELECT count(*) AS n FROM audit_log').first()).n,0);
});

for(const revoked of ['unlink','remap','leave','pending'])test(`保存前の自画像は紐付け解除・所属失効後に閲覧・upload・保存できない（${revoked}）`,async t=>{
  const f=await setup(t);await f.connectDrive();const data=await uploaded(f);assert.equal((await f.request(data.url,{user:'staff'})).status,200);
  if(revoked==='unlink')await f.DB.prepare("UPDATE casts SET user_id=NULL WHERE id='cast-1'").run();
  if(revoked==='remap')await f.DB.prepare("UPDATE casts SET user_id=? WHERE id='cast-1'").bind(ids.admin).run();
  if(revoked==='leave')f.members.delete(`${ids.staff}:${f.env.STAFF_GUILD_ID}`);
  if(revoked==='pending')f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[],pending:true});
  f.members.set(`${ids.staff}:${f.env.CUSTOMER_GUILD_ID}`,{roles:[],pending:false});
  const before=await castRow(f),calls=f.calls.length;
  assert.equal((await f.request(data.url,{user:'staff'})).status,403);
  assert.equal((await upload(f)).status,403);assert.equal((await save(f,{...values,image_id:data.id})).status,403);
  assert.equal(f.calls.slice(calls).filter(c=>c.url.includes('googleapis')).length,0);
  assert.deepEqual(await castRow(f),before);assert.equal(await imageCount(f),1);assert.equal(f.uploads.length,1);
  assert.equal((await publicData(f)).casts[0].image_id,null);
});

test('自画像の閲覧例外は従来の運営・マニュアル・本人割当写真の権限を広げない',async t=>{
  const f=await setup(t,0);await seedImage(f,'unrelated');await seedImage(f,'assigned');await seedImage(f,'manual-photo');
  await f.DB.prepare("UPDATE casts SET image_id='assigned' WHERE id='cast-1'").run();
  assert.equal((await f.request('/api/images/assigned',{user:'staff'})).status,200);
  assert.equal((await f.request('/api/images/unrelated',{user:'staff'})).status,403);
  assert.equal((await f.request('/api/images/unrelated',{user:'admin'})).status,200);
  await f.DB.prepare("INSERT INTO content(id,kind,slug,title,body,status,updated_at,updated_by) VALUES('manual','manual','manual','Manual','![図](/api/images/manual-photo)','published',?,?)").bind(new Date().toISOString(),ids.admin).run();
  await f.DB.prepare("UPDATE casts SET user_id=NULL WHERE id='cast-1'").run();
  assert.equal((await f.request('/api/images/assigned',{user:'staff'})).status,403);
  assert.equal((await f.request('/api/images/manual-photo',{user:'staff'})).status,200);
  assert.equal((await f.request('/api/images/manual-photo',{user:'customer'})).status,403);
  assert.equal((await f.request('/api/images/manual-photo')).status,401);
});
