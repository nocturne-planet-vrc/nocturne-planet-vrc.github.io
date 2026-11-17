// Browser verification only. This file is never copied to the public build.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fixture,ids} from './helpers.mjs';
const f=await fixture();f.env.APP_ORIGIN='http://localhost:8788';
if(process.argv.includes('--vrchat')){
  f.env.VRCHAT_AUTH_TOKEN='fixture-vrchat-token';
  const id='usr_00000000-0000-0000-0000-000000000001';
  f.vrchatUsers.set(id,async()=>({id,displayName:'動作確認用VRChatユーザー',bio:(await f.DB.prepare('SELECT code FROM vrchat_challenges WHERE vrchat_id=? ORDER BY expires_at DESC LIMIT 1').bind(id).first())?.code||''}));
  await f.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) VALUES(?,?,?,?)').bind(ids.customer,'usr_00000000-0000-0000-0000-000000000002','星空のお客さん（動作確認用）',new Date().toISOString()).run();
}
await f.event();
await f.DB.prepare("UPDATE settings SET value=json_set(value,'$.about',?) WHERE key='site'").bind('Nocturne Planet（のくぷら）は、直径24mのプラネタリウムで星空解説・キャスト接客・歌唱ライブを楽しめるVRChatイベントです。').run();
if(process.argv.includes('--populated')){
  const timestamp=new Date().toISOString();
  for(let n=1;n<=5;n++)await f.DB.prepare('INSERT INTO casts(id,display_name,tagline,bio,active,sort_order) VALUES(?,?,?,?,1,?)').bind(`preview-${n}`,`動作確認用キャスト ${n}`,'レイアウト検証用のプロフィール','本番では表示されない検証用データです。',n).run();
  for(const kind of ['news','page','manual'])await f.DB.prepare('INSERT INTO content(id,kind,slug,title,body,status,published_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(`preview-${kind}`,kind,`preview-${kind}`,`表示確認用の${kind==='news'?'お知らせ':kind==='page'?'固定ページ':'マニュアル'}`,'## 表示確認\n本番では表示されない検証用データです。\n- 見出しと本文\n- 一覧と詳細ページ','published',timestamp,timestamp,ids.admin).run();
}
const types={html:'text/html',css:'text/css',mjs:'text/javascript',svg:'image/svg+xml',txt:'text/plain'};
f.env.ASSETS.fetch=async request=>{
  const path=new URL(request.url).pathname;
  try{let data=readFileSync('public'+path);if(path.endsWith('.html'))data=data.toString().replace('<body','<body').replace(/(<body[^>]*>)/,'$1<p role="status">動作確認用の画面です。本番の会員情報は使っていません。</p>'+(process.argv.includes('--vrchat')?'<p role="status">VRChat連携もテスト応答です。検証用URL：https://vrchat.com/home/user/usr_00000000-0000-0000-0000-000000000001</p>':'')+'');return new Response(data,{headers:{'Content-Type':types[path.split('.').pop()]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
};
createServer(async(incoming,outgoing)=>{
  try{
    const url=new URL(incoming.url,f.env.APP_ORIGIN),headers=new Headers(incoming.headers);
    const area=url.pathname==='/member'||url.pathname.startsWith('/api/member')||url.searchParams.get('area')==='member'?'customer':url.pathname==='/staff'||url.pathname.startsWith('/api/staff')?'staff':url.pathname==='/manage'||url.pathname.startsWith('/api/manage')?'admin':null;
    const remembered=/test_actor=(customer|staff|admin)/.exec(headers.get('Cookie')||'')?.[1];
    const account=area||remembered||'admin';headers.set('Cookie',`np_session=${f.tokens[account]}`);
    // Keep fixture identities usable while this localhost-only preview is running.
    const epoch=Math.floor(Date.now()/1000);
    await f.DB.prepare('UPDATE sessions SET token_expires_at=?,expires_at=? WHERE user_id=?').bind(epoch+3600,epoch+86400,ids[account]).run();
    const body=Buffer.concat(await Array.fromAsync(incoming));
    const response=await f.worker.fetch(new Request(url,{method:incoming.method,headers,body:['GET','HEAD'].includes(incoming.method)?undefined:body}),f.env,{});
    outgoing.writeHead(response.status,{...Object.fromEntries(response.headers),...(area&&['/member','/staff','/manage'].includes(url.pathname)?{'Set-Cookie':`test_actor=${area}; Path=/; HttpOnly; SameSite=Lax`}:{}),'X-Test-Fixture':'true'});
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){outgoing.writeHead(500);outgoing.end(error.message);}
}).listen(8788,'127.0.0.1',()=>console.log('検証用画面 http://localhost:8788 — production credentials are not used'));
