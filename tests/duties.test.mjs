import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './helpers.mjs';
import {dutyRoles} from '../src/duties.mjs';

const answer=duties=>({event_id:'event-1',answer:'yes',available_from:'22:00',available_until:'23:30',duties,note:'担当確認'});

test('8つの担当は、それぞれのDiscordロールに対応する項目だけ選べる',async t=>{
  const f=await fixture();t.after(f.close);await f.event();
  for(const duty of dutyRoles){
    f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[duty.role_id]});
    const data=await (await f.request('/api/staff',{user:'staff'})).json();
    assert.equal(data.duty_options.length,8);
    assert.deepEqual(data.duty_options.filter(option=>option.available).map(option=>option.name),[duty.name]);
    assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer([duty.name])})).status,200);
  }
});

test('複数ロールの担当を保存でき、ロールのない担当を混ぜると元の回答を守る',async t=>{
  const f=await fixture();t.after(f.close);await f.event();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[dutyRoles[0].role_id,dutyRoles[2].role_id]});
  assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer(['接客キャスト','PA','PA'])})).status,200);
  const read=()=>f.DB.prepare('SELECT duties FROM attendance WHERE user_id=?').bind(ids.staff).first();
  assert.deepEqual(JSON.parse((await read()).duties),['接客キャスト','PA']);
  const response=await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer(['接客キャスト','動画編集'])});
  assert.equal(response.status,403);assert.equal((await response.json()).code,'DUTY_ROLE_REQUIRED');
  assert.deepEqual(JSON.parse((await read()).duties),['接客キャスト','PA']);
});

test('ロールがない人も、担当を選ばず出欠と連絡を保存できる',async t=>{
  const f=await fixture();t.after(f.close);await f.event();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[]});
  const data=await (await f.request('/api/staff',{user:'staff'})).json();
  assert.ok(data.duty_options.every(duty=>!duty.available));
  assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer([])})).status,200);
  const saved=await f.DB.prepare('SELECT duties,note FROM attendance WHERE user_id=?').bind(ids.staff).first();
  assert.equal(saved.duties,'[]');assert.equal(saved.note,'担当確認');
});

test('回答画面を開いた後のロール剥奪・追加を、次の保存と読み込みで反映する',async t=>{
  const f=await fixture();t.after(f.close);await f.event();
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[dutyRoles[0].role_id]});
  await f.request('/api/staff',{user:'staff'});
  await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer(['接客キャスト'])});
  f.members.set(`${ids.staff}:${f.env.STAFF_GUILD_ID}`,{roles:[dutyRoles[2].role_id]});
  assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer(['接客キャスト'])})).status,403);
  const updated=await (await f.request('/api/staff',{user:'staff'})).json();
  assert.deepEqual(updated.duty_options.filter(duty=>duty.available).map(duty=>duty.name),['PA']);
  assert.deepEqual(JSON.parse(updated.attendance[0].duties),['接客キャスト']);
  assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer(['PA'])})).status,200);
});

test('運営ロールだけでは担当ロールの制限を迂回できず、不明な担当も拒否する',async t=>{
  const f=await fixture();t.after(f.close);await f.event();
  assert.equal((await f.request('/api/staff/attendance',{user:'admin',method:'POST',body:answer(['PA'])})).status,403);
  assert.equal((await f.request('/api/staff/attendance',{user:'admin',method:'POST',body:answer([])})).status,200);
  assert.equal((await f.request('/api/staff/attendance',{user:'staff',method:'POST',body:answer(['架空の担当'])})).status,400);
});
