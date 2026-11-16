import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {seal,sha256,passphraseHash} from '../src/core.mjs';
import {createWorker} from '../src/worker.mjs';
import {dutyRoles} from '../src/duties.mjs';
export const ids={customer:'100000000000000001',other:'100000000000000002',staff:'100000000000000003',admin:'100000000000000004'};
class D1 {
  constructor(){this.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('migrations').sort())this.sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));}
  prepare(sql){const statement=this.sqlite.prepare(sql);const build=(args=[])=>({bind:(...values)=>build(values),first:async()=>statement.get(...args)||null,all:async()=>({results:statement.all(...args)}),run:async()=>({meta:{changes:Number(statement.run(...args).changes)}})});return build();}
  async batch(statements){this.sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
export async function fixture(){
  const DB=new D1(),members=new Map(),calls=[];
  const env={DB,APP_ORIGIN:'https://nocturne-planet.test',STAFF_GUILD_ID:'1571575964633403463',CUSTOMER_GUILD_ID:'1571801120664191027',ADMIN_ROLE_IDS:'200000000000000001',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,42).toString('base64'),CHECKIN_PEPPER:'test-only-pepper-longer-than-24-characters',DISCORD_CLIENT_ID:'test-client',DISCORD_CLIENT_SECRET:'test-secret',GOOGLE_CLIENT_ID:'test-google-client',GOOGLE_CLIENT_SECRET:'test-google-secret',ASSETS:{fetch:async request=>{let path=new URL(request.url).pathname;try{return new Response(readFileSync('public'+path),{headers:{'Content-Type':path.endsWith('.html')?'text/html':'text/plain'}});}catch{return new Response('Not found',{status:404});}}}};
  const epoch=Math.floor(Date.now()/1000),tokens={};
  for(const [name,id] of Object.entries(ids)){
    const token=`session-${name}`,hash=await sha256(token);tokens[name]=token;
    await DB.prepare('INSERT INTO users(id,display_name,joined_as_customer,joined_as_staff,last_seen_at) VALUES(?,?,?,?,?)').bind(id,name,Number(['customer','other'].includes(name)),Number(['staff','admin'].includes(name)),new Date().toISOString()).run();
    await DB.prepare('INSERT INTO sessions(id_hash,user_id,tokens,token_expires_at,expires_at,created_at) VALUES(?,?,?,?,?,?)').bind(hash,id,await seal({access_token:`user:${id}`,refresh_token:`refresh:${id}`},env.TOKEN_ENCRYPTION_KEY),epoch+3600,epoch+86400,epoch).run();
    members.set(`${id}:${['customer','other'].includes(name)?env.CUSTOMER_GUILD_ID:env.STAFF_GUILD_ID}`,{roles:name==='admin'?[env.ADMIN_ROLE_IDS]:name==='staff'?dutyRoles.filter(duty=>['星空解説','歌パフォーマンス','動画編集'].includes(duty.name)).map(duty=>duty.role_id):[],pending:false});
  }
  const fetcher=async(url,options={})=>{
    url=String(url);calls.push({url,method:options.method||'GET'});
    if(url.includes('/users/@me/guilds/')){const user=options.headers.Authorization.slice('Bearer user:'.length),guild=/guilds\/(\d+)\/member/.exec(url)[1];return Response.json(members.get(`${user}:${guild}`)||{message:'Unknown Member'},{status:members.has(`${user}:${guild}`)?200:404});}
    if(url==='https://discord.com/api/oauth2/token')return Response.json({access_token:`user:${ids.customer}`,refresh_token:'rotated',expires_in:3600});
    if(url.endsWith('/users/@me'))return Response.json({id:ids.customer,global_name:'新しい表示名',username:'customer',avatar:null});
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'drive-test-token',expires_in:3600});
    if(url.includes('www.googleapis.com/drive/v3/files/'))return new Response(new Uint8Array([1,2,3,4]));
    throw new Error('Unexpected remote request: '+url);
  };
  const worker=createWorker(fetcher);
  async function request(path,{user,method='GET',body,csrf=true,origin=env.APP_ORIGIN,cookie:extraCookie,headers:extraHeaders={}}={}){
    const headers={...extraHeaders};if(user)headers.Cookie=`__Host-np_session=${tokens[user]}`;if(extraCookie)headers.Cookie=extraCookie;
    if(method!=='GET'){headers.Origin=origin;if(csrf&&user)headers['X-CSRF-Token']=await sha256(`${await sha256(tokens[user])}:${env.TOKEN_ENCRYPTION_KEY}:csrf`);}
    if(body){headers['Content-Type']='application/json';body=JSON.stringify(body);}
    return worker.fetch(new Request(env.APP_ORIGIN+path,{method,body,headers}),env,{});
  }
  async function event(id='event-1',overrides={}){
    const start=new Date(Date.now()-3600000).toISOString(),end=new Date(Date.now()+3600000).toISOString(),hash=await passphraseHash(id,'salt','ほしぞら',env.CHECKIN_PEPPER);
    const row={id,title:'テスト営業',description:'',starts_at:start,ends_at:end,response_deadline:end,published:1,checkin_opens_at:start,checkin_closes_at:end,checkin_salt:'salt',checkin_hash:hash,created_at:start,updated_at:start,...overrides};
    const keys=Object.keys(row);await DB.prepare(`INSERT INTO events(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>row[k])).run();return row;
  }
  async function cheki({image='cheki-image',sender=ids.staff,recipient=ids.customer,withdrawn=0}={}){
    await DB.prepare('INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(image,'private-drive-'+image,'image/webp',4,'private',sender,new Date().toISOString()).run();
    await DB.prepare('INSERT INTO cheki(id,image_id,sender_id,recipient_id,created_at,withdrawn) VALUES(?,?,?,?,?,?)').bind(image,image,sender,recipient,new Date().toISOString(),withdrawn).run();
    await DB.prepare("INSERT OR IGNORE INTO integrations(key,value) VALUES('drive',?)").bind(await seal({refresh_token:'drive-refresh',folder_id:'private-folder',email:'event@example.test'},env.TOKEN_ENCRYPTION_KEY)).run();
  }
  return {DB,env,worker,request,event,cheki,members,calls,tokens,close:()=>DB.sqlite.close()};
}
