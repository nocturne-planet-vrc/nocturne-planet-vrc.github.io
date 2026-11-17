// Browser verification only. This file is never copied to the public build.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fixture,ids} from './helpers.mjs';
const f=await fixture();f.env.APP_ORIGIN='http://localhost:8788';
if(process.argv.includes('--populated')){
  // Simulated staff server member list so the bot-based staff list can be checked locally.
  f.env.DISCORD_BOT_TOKEN='preview-bot';
  const {dutyRoles}=await import('../src/duties.mjs');const role=name=>dutyRoles.find(d=>d.name===name).role_id;
  f.env.CRON_SECRET='preview-cron-secret-preview-cron-secret';
  f.hooks.botMembers=()=>Response.json([
    {user:{id:ids.staff,username:'staff',global_name:'動作確認用スタッフ'},roles:[role('接客キャスト')]},
    {user:{id:'100000000000000011',username:'new-cast',global_name:'ログイン前のキャスト'},roles:[role('接客キャスト'),role('歌パフォーマンス')]},
    {user:{id:'100000000000000012',username:'new-pa',global_name:'ログイン前のPA'},roles:[role('PA')]}
  ]);
}
if(process.argv.includes('--vrchat')){
  f.env.VRCHAT_AUTH_TOKEN='fixture-vrchat-token';
  const id='usr_00000000-0000-0000-0000-000000000001';
  f.vrchatUsers.set(id,async()=>({id,displayName:'動作確認用VRChatユーザー',bio:(await f.DB.prepare('SELECT code FROM vrchat_challenges WHERE vrchat_id=? ORDER BY expires_at DESC LIMIT 1').bind(id).first())?.code||''}));
  await f.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) VALUES(?,?,?,?)').bind(ids.customer,'usr_00000000-0000-0000-0000-000000000002','星空のお客さん（動作確認用）',new Date().toISOString()).run();
}
await f.event();
if(process.argv.includes('--populated')){const day=86400000,t=Date.now();await f.event('event-2',{title:'通常営業（出欠確認用）',starts_at:new Date(t+3*day).toISOString(),ends_at:new Date(t+3*day+5400000).toISOString(),response_deadline:new Date(t+2*day).toISOString(),checkin_opens_at:null,checkin_closes_at:null,checkin_salt:null,checkin_hash:null});await f.DB.prepare("INSERT INTO attendance(event_id,user_id,answer,duties,updated_at) VALUES('event-2',?,'yes','[\"接客キャスト\"]',?)").bind(ids.staff,new Date().toISOString()).run();}
await f.DB.prepare("UPDATE settings SET value=json_set(value,'$.about',?) WHERE key='site'").bind('Nocturne Planet（のくぷら）は、直径24mのプラネタリウムで星空解説・キャスト接客・歌唱ライブを楽しめるVRChatイベントです。').run();
if(process.argv.includes('--populated')){
  await f.connectDrive();
  const timestamp=new Date().toISOString();
  for(let n=1;n<=5;n++)await f.DB.prepare('INSERT INTO casts(id,display_name,tagline,bio,active,sort_order) VALUES(?,?,?,?,1,?)').bind(`preview-${n}`,`動作確認用キャスト ${n}`,'レイアウト検証用のプロフィール','本番では表示されない検証用データです。',n).run();
  await f.DB.prepare('UPDATE casts SET user_id=? WHERE id=?').bind(ids.staff,'preview-1').run();
  await f.DB.prepare('INSERT INTO favorites(user_id,cast_id) VALUES(?,?)').bind(ids.customer,'preview-1').run();
  await f.DB.prepare('INSERT INTO visits(event_id,user_id,checked_in_at) VALUES(?,?,?)').bind('event-1',ids.customer,timestamp).run();
  for(const kind of ['news','page','manual'])await f.DB.prepare('INSERT INTO content(id,kind,slug,title,body,status,published_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(`preview-${kind}`,kind,`preview-${kind}`,`表示確認用の${kind==='news'?'お知らせ':kind==='page'?'固定ページ':'マニュアル'}`,'## 表示確認\n本番では表示されない検証用データです。\n- 見出しと本文\n- 一覧と詳細ページ','published',timestamp,timestamp,ids.admin).run();
  await f.DB.prepare("UPDATE settings SET value=json_set(value,'$.hero_images',json(?)) WHERE key='site'").bind(JSON.stringify(['preview-hero-1','preview-hero-2','preview-hero-3'])).run();
}
const types={html:'text/html',css:'text/css',mjs:'text/javascript',svg:'image/svg+xml',txt:'text/plain'};
const heroColors=[['#1d2a6b','#4b3b7a','#e9c88f'],['#14204f','#2f5d8a','#f2d7a6'],['#241a4d','#6a3f74','#ffe09e']];
// Synthetic dome scenes so the slideshow can be checked without real photos.
const heroSvg=n=>{const [a,b,c]=heroColors[n%3];let stars='';for(let i=0;i<140;i++){const x=(i*733+n*97)%1600,y=(i*389+n*53)%620,r=((i*7)%3)/2+0.5;stars+=`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${0.3+(i%5)/8}"/>`;}return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><defs><radialGradient id="g" cx="${50+n*12}%" cy="30%" r="80%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient></defs><rect width="1600" height="900" fill="url(#g)"/>${stars}<ellipse cx="800" cy="980" rx="1100" ry="300" fill="#0b1029"/>${[0,1,2,3,4,5,6].map(i=>`<g transform="translate(${640+i*110+n*30} ${640-(i%2)*20})"><circle r="34" fill="#0d1330"/><rect x="-40" y="28" width="80" height="160" rx="36" fill="#0d1330"/></g>`).join('')}<text x="1500" y="860" font-size="28" fill="${c}" text-anchor="end" font-family="sans-serif">preview ${n+1}</text></svg>`;};
f.env.ASSETS.fetch=async request=>{
  const path=new URL(request.url).pathname;
  try{let data=readFileSync('public'+path);if(path.endsWith('.html'))data=data.toString().replace('<body','<body').replace(/(<body[^>]*>)/,'$1<p role="status">動作確認用の画面です。本番の会員情報は使っていません。</p>'+(process.argv.includes('--vrchat')?'<p role="status">VRChat連携もテスト応答です。検証用URL：https://vrchat.com/home/user/usr_00000000-0000-0000-0000-000000000001</p>':'')+'');return new Response(data,{headers:{'Content-Type':types[path.split('.').pop()]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
};
createServer(async(incoming,outgoing)=>{
  try{
    const url=new URL(incoming.url,f.env.APP_ORIGIN),headers=new Headers(incoming.headers);
    const heroPreview=/^\/api\/images\/preview-hero-(\d)$/.exec(url.pathname);
    if(heroPreview){outgoing.writeHead(200,{'Content-Type':'image/svg+xml'});outgoing.end(heroSvg(Number(heroPreview[1])-1));return;}
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
