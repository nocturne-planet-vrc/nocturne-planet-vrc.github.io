import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {seal,sha256,passphraseHash} from '../src/core.mjs';
import {createWorker} from '../src/worker.mjs';
import {dutyRoles} from '../src/duties.mjs';
export const ids={customer:'100000000000000001',other:'100000000000000002',staff:'100000000000000003',admin:'100000000000000004'};
class D1 {
  constructor(hooks){this.hooks=hooks;this.sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('migrations').sort())this.sqlite.exec(readFileSync(`migrations/${file}`,'utf8'));}
  prepare(sql){const statement=this.sqlite.prepare(sql);const build=(args=[])=>({sql,bind:(...values)=>build(values),first:async()=>statement.get(...args)||null,all:async()=>({results:statement.all(...args)}),run:async()=>({meta:{changes:Number(statement.run(...args).changes)}})});return build();}
  async batch(statements){await this.hooks.beforeBatch?.({DB:this,statements});this.sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());this.sqlite.exec('COMMIT');return results;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
}
export async function fixture(hooks={}){
  const DB=new D1(hooks),members=new Map(),calls=[],vrchatUsers=new Map(),driveFiles=new Map(),uploads=[],deletions=[],dms={opened:[],sent:[]};
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
    if(url.startsWith('https://api.vrchat.cloud/api/1/profile/')){
      let profile=vrchatUsers.get(url.split('/').pop());if(typeof profile==='function')profile=await profile(options);
      return profile instanceof Response?profile:Response.json(profile||{error:{message:'Not found'}},{status:profile?200:404});
    }
    if(url.includes('/users/@me/guilds/')){const user=options.headers.Authorization.slice('Bearer user:'.length),guild=/guilds\/(\d+)\/member/.exec(url)[1];return Response.json(members.get(`${user}:${guild}`)||{message:'Unknown Member'},{status:members.has(`${user}:${guild}`)?200:404});}
    if(url==='https://discord.com/api/oauth2/token')return Response.json({access_token:`user:${ids.customer}`,refresh_token:'rotated',expires_in:3600});
    if(url.endsWith('/users/@me'))return Response.json({id:ids.customer,global_name:'新しい表示名',username:'customer',avatar:null});
    if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'drive-test-token',expires_in:3600});
    if(/^https:\/\/discord\.com\/api\/v10\/guilds\/\d+\/members\/\d+$/.test(url)&&options.method==='PATCH'){
      const match=/guilds\/(\d+)\/members\/(\d+)$/.exec(url),body=JSON.parse(options.body);
      if(options.headers.Authorization!=='Bot '+env.DISCORD_BOT_TOKEN)return Response.json({code:0},{status:401});
      const overridden=await hooks.nicknamePatch?.({guild:match[1],user:match[2],body,options});
      if(overridden)return overridden;
      const member=members.get(match[2]+':'+match[1]);if(!member)return Response.json({code:10007},{status:404});
      member.nick=body.nick;return Response.json({nick:body.nick});
    }
    if(/^https:\/\/discord\.com\/api\/v10\/guilds\/\d+\/members\?/.test(url)){
      if(options.headers?.Authorization!=='Bot '+env.DISCORD_BOT_TOKEN)return Response.json({message:'401: Unauthorized'},{status:401});
      return hooks.botMembers?.(url)||Response.json([]);
    }
    if(url==='https://discord.com/api/v10/users/@me/channels'&&options.method==='POST'){
      const {recipient_id}=JSON.parse(options.body);dms.opened.push(recipient_id);
      return hooks.dmOpen?.(recipient_id)||Response.json({id:'dm-'+recipient_id});
    }
    if(/^https:\/\/discord\.com\/api\/v10\/channels\/[^/]+\/messages$/.test(url)&&options.method==='POST'){
      const channel=url.split('/')[6],body=JSON.parse(options.body);dms.sent.push({channel,content:body.content,allowed_mentions:body.allowed_mentions});
      return hooks.dmSend?.(channel,body)||Response.json({id:'msg-'+dms.sent.length});
    }
    if(url.startsWith('https://www.googleapis.com/upload/drive/v3/files?')&&options.method==='POST'){
      const payload=Buffer.from(await options.body.arrayBuffer()),boundary=options.headers['Content-Type'].split('boundary=')[1];
      const metadataStart=payload.indexOf('\r\n\r\n')+4,metadataEnd=payload.indexOf('\r\n--'+boundary,metadataStart);
      const metadata=JSON.parse(payload.subarray(metadataStart,metadataEnd).toString());
      const bytesStart=payload.indexOf('\r\n\r\n',metadataEnd)+4,bytesEnd=payload.lastIndexOf('\r\n--'+boundary+'--');
      const upload={id:'uploaded-drive-'+(uploads.length+1),metadata,bytes:new Uint8Array(payload.subarray(bytesStart,bytesEnd)),mime:/Content-Type: ([^\r]+)/.exec(payload.subarray(metadataEnd,bytesStart).toString())[1]};
      uploads.push(upload);
      const response=await hooks.uploadHook?.(upload);
      if(response instanceof Response&&!response.ok)return response;
      driveFiles.set(upload.id,upload);
      return response instanceof Response?response:Response.json({id:upload.id});
    }
    if(url.startsWith('https://www.googleapis.com/drive/v3/files/')){
      const driveId=decodeURIComponent(new URL(url).pathname.split('/').pop());
      if(options.method==='DELETE'){
        deletions.push(driveId);const response=await hooks.deleteHook?.(driveId);
        if(response instanceof Response&&!response.ok)return response;
        driveFiles.delete(driveId);return response instanceof Response?response:new Response(null,{status:204});
      }
      return new Response(driveFiles.get(driveId)?.bytes||new Uint8Array([1,2,3,4]));
    }
    throw new Error('Unexpected remote request: '+url);
  };
  const worker=createWorker(fetcher);
  async function request(path,{user,method='GET',body,csrf=true,origin=env.APP_ORIGIN,cookie:extraCookie,headers:extraHeaders={}}={}){
    const headers={...extraHeaders};if(user)headers.Cookie=`__Host-np_session=${tokens[user]}`;if(extraCookie)headers.Cookie=extraCookie;
    if(method!=='GET'){headers.Origin=origin;if(csrf&&user)headers['X-CSRF-Token']=await sha256(`${await sha256(tokens[user])}:${env.TOKEN_ENCRYPTION_KEY}:csrf`);}
    if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
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
    await connectDrive();
  }
  async function connectDrive(){await DB.prepare("INSERT OR IGNORE INTO integrations(key,value) VALUES('drive',?)").bind(await seal({refresh_token:'drive-refresh',folder_id:'private-folder',email:'event@example.test'},env.TOKEN_ENCRYPTION_KEY)).run();}
  async function cast({id='cast-1',user=ids.staff,active=1,name='テストキャスト'}={}){await DB.prepare('INSERT INTO casts(id,display_name,user_id,active) VALUES(?,?,?,?)').bind(id,name,user,active).run();return id;}
  async function favorite(user=ids.customer,castId='cast-1'){await DB.prepare('INSERT INTO favorites(user_id,cast_id) VALUES(?,?)').bind(user,castId).run();}
  async function visit(user=ids.customer,eventId='event-1'){await DB.prepare('INSERT INTO visits(event_id,user_id,checked_in_at) VALUES(?,?,?)').bind(eventId,user,new Date().toISOString()).run();}
  return {DB,env,worker,request,event,cheki,cast,favorite,visit,connectDrive,members,calls,tokens,vrchatUsers,hooks,uploads,deletions,driveFiles,dms,fetcher,close:()=>DB.sqlite.close()};
}
