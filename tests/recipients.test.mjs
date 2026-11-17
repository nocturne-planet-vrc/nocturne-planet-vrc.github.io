import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';

const first='usr_00000000-0000-0000-0000-000000000001',second='usr_00000000-0000-0000-0000-000000000002';
const search=async(f,q,user='staff')=>f.request('/api/staff/recipients?q='+encodeURIComponent(q),{user});
const link=(f,user,id,name)=>f.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) VALUES(?,?,?,?)').bind(user,id,name,new Date().toISOString()).run();

test('チェキの送信先を連携済みVRChat名・Discord名・Discord IDから探せる',async t=>{
  const f=await fixture();t.after(f.close);
  await link(f,ids.customer,first,'星空のお客さん');
  for(const q of ['星空','customer',ids.customer]){
    const response=await search(f,q);assert.equal(response.status,200);
    const users=(await response.json()).users;
    assert.deepEqual(users,[{id:ids.customer,display_name:'customer',vrchat_display_name:'星空のお客さん'}]);
  }
  assert.deepEqual((await (await search(f,'other')).json()).users,[{id:ids.other,display_name:'other',vrchat_display_name:null}]);
  // A verification challenge is not a verified link and must not identify recipients.
  await f.DB.prepare('INSERT INTO vrchat_challenges(user_id,vrchat_id,code,expires_at) VALUES(?,?,?,?)').bind(ids.other,second,'NP-TEST',Math.floor(Date.now()/1000)+1800).run();
  assert.deepEqual((await (await search(f,'NP-TEST')).json()).users,[]);
  await f.DB.prepare('DELETE FROM vrchat_links WHERE user_id=?').bind(ids.customer).run();
  assert.deepEqual((await (await search(f,'星空')).json()).users,[]);
  assert.equal((await (await search(f,'customer')).json()).users[0].id,ids.customer);
});

test('同名のVRChat会員を区別し、検索記号を文字として扱い、スタッフ専用を維持する',async t=>{
  const f=await fixture();t.after(f.close);
  for(const [user,id] of [[ids.customer,first],[ids.other,second]])await link(f,user,id,'同名%_!');
  const users=(await (await search(f,'同名')).json()).users;
  assert.equal(users.length,2);assert.deepEqual(new Set(users.map(u=>u.id)),new Set([ids.customer,ids.other]));
  assert.equal((await (await search(f,'%_!')).json()).users.length,2);
  assert.deepEqual((await (await search(f,"' OR 1=1 --")).json()).users,[]);
  assert.deepEqual((await (await search(f,'')).json()).users,[]);
  await link(f,ids.staff,'usr_00000000-0000-0000-0000-000000000003','スタッフだけ');
  assert.deepEqual((await (await search(f,'スタッフだけ')).json()).users,[]);
  assert.equal((await search(f,'同名','customer')).status,403);
  assert.equal((await f.request('/api/staff/recipients?q=同名')).status,401);
  assert.ok(!JSON.stringify(await (await f.request('/api/public')).json()).includes('同名%_!'));
});
