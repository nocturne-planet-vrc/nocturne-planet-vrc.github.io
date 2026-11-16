// Browser verification only. This file is never copied to the public build.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fixture,ids} from './helpers.mjs';
const f=await fixture();f.env.APP_ORIGIN='http://localhost:8788';
await f.event();
const types={html:'text/html',css:'text/css',mjs:'text/javascript',svg:'image/svg+xml',txt:'text/plain'};
f.env.ASSETS.fetch=async request=>{
  const path=new URL(request.url).pathname;
  try{let data=readFileSync('public'+path);if(path.endsWith('.html'))data=data.toString().replace('<body','<body').replace(/(<body[^>]*>)/,'$1<p role="status">動作確認用の画面です。本番の会員情報は使っていません。</p>');return new Response(data,{headers:{'Content-Type':types[path.split('.').pop()]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
};
createServer(async(incoming,outgoing)=>{
  try{
    const url=new URL(incoming.url,f.env.APP_ORIGIN),headers=new Headers(incoming.headers);
    const area=url.pathname==='/member'||url.pathname.startsWith('/api/member')||url.searchParams.get('area')==='member'?'customer':url.pathname==='/staff'||url.pathname.startsWith('/api/staff')?'staff':null;
    const remembered=/test_actor=(customer|staff|admin)/.exec(headers.get('Cookie')||'')?.[1];
    const account=area||remembered||'admin';headers.set('Cookie',`np_session=${f.tokens[account]}`);
    const body=Buffer.concat(await Array.fromAsync(incoming));
    const response=await f.worker.fetch(new Request(url,{method:incoming.method,headers,body:['GET','HEAD'].includes(incoming.method)?undefined:body}),f.env,{});
    outgoing.writeHead(response.status,{...Object.fromEntries(response.headers),...(area&&['/member','/staff'].includes(url.pathname)?{'Set-Cookie':`test_actor=${area}; Path=/; HttpOnly; SameSite=Lax`}:{}),'X-Test-Fixture':'true'});
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){outgoing.writeHead(500);outgoing.end(error.message);}
}).listen(8788,'127.0.0.1',()=>console.log('検証用画面 http://localhost:8788 — production credentials are not used'));
