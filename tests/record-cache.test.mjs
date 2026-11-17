import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecordCache,recordListKey} from '../public/record-cache.mjs';
import {fixture} from './helpers.mjs';

test('運営ページに営業日・チェキの先頭ページを含め、追加の所属確認なしで用意する',async t=>{
  const f=await fixture();t.after(f.close);await f.event();await f.cheki();
  const initial=await (await f.request('/api/manage?deleted=1&page=9',{user:'admin'})).json();
  assert.equal(initial.record_lists.events.events.length,1);assert.equal(initial.record_lists.cheki.cheki.length,1);
  assert.equal(initial.record_lists.events.page,1);assert.equal(initial.record_lists.cheki.page,1);
  for(const item of initial.record_lists.cheki.cheki)for(const key of ['image_id','message','recipient_id'])assert.ok(!Object.hasOwn(item,key));
  assert.equal(f.calls.filter(c=>c.url.includes('/users/@me/guilds/')).length,1);
  const dedicated=await (await f.request('/api/manage/events',{user:'admin'})).json();assert.deepEqual(initial.record_lists.events,dedicated);
});

test('先に取得した一覧と短時間の再表示は追加のリクエストを必要としない',async()=>{
  let calls=0,clock=100;const cache=createRecordCache(async()=>{calls++;return {value:'new'};},{now:()=>clock,maxAge:10});
  const key=recordListKey('events'),value={value:'initial'};cache.prime(key,value);
  assert.equal(cache.peek(key).value,value);assert.equal(await cache.load(key),value);assert.equal(calls,0);
  clock=111;assert.equal(cache.peek(key).fresh,false);assert.deepEqual(await cache.load(key),{value:'new'});assert.equal(calls,1);
  await cache.load(key,{force:true});assert.equal(calls,2);
});

test('同じ一覧の通信をまとめ、変更前の遅い応答で更新後の一覧を上書きしない',async()=>{
  const resolvers=[];let calls=0;const cache=createRecordCache(()=>{calls++;return new Promise(resolve=>resolvers.push(resolve));});
  const first=cache.load('events');assert.equal(cache.load('events'),first);await Promise.resolve();assert.equal(calls,1);
  cache.clear();const second=cache.load('events');await Promise.resolve();assert.equal(calls,2);
  resolvers[1]('new');await second;resolvers[0]('old');await first;assert.equal(cache.peek('events').value,'new');
});

test('権限エラーでは保持中の一覧を捨て、通信障害では再取得用に保持する',async()=>{
  let status=503;const cache=createRecordCache(async()=>{throw Object.assign(new Error('fixture'),{status});},{maxAge:0});
  cache.prime('events','old');cache.prime('cheki','old');await assert.rejects(cache.load('events'));assert.equal(cache.peek('events').value,'old');
  status=403;await assert.rejects(cache.load('events'));assert.equal(cache.peek('events'),null);assert.equal(cache.peek('cheki'),null);
});
