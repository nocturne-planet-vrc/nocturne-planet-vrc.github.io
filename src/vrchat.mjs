import {HttpError,text,bodyJson,nowIso,rateLimit,limitedBytes} from './core.mjs';

const epoch=()=>Math.floor(Date.now()/1000);
const userId=/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const token=/^[A-Za-z0-9_.-]{16,512}$/;
const profileUrl=id=>`https://vrchat.com/home/user/${id}`;
export function vrchatUserId(value){
  const input=text(value,300,true);
  if(userId.test(input))return input;
  try{
    const url=new URL(input),match=/^\/home\/user\/(usr_[0-9a-f-]+)\/?$/.exec(url.pathname);
    if(url.origin==='https://vrchat.com'&&!url.username&&!url.password&&match&&userId.test(match[1]))return match[1];
  }catch{}
  throw new HttpError(400,'VRChatのプロフィールURLまたはusr_から始まるユーザーIDを入力してください。');
}
export const vrchatConfigured=env=>token.test(env.VRCHAT_AUTH_TOKEN||'')&&(!env.VRCHAT_TWO_FACTOR_TOKEN||token.test(env.VRCHAT_TWO_FACTOR_TOKEN));
export async function vrchatStatus(user,env){
  const linked=await env.DB.prepare('SELECT vrchat_id,display_name,verified_at FROM vrchat_links WHERE user_id=?').bind(user).first();
  const challenge=await env.DB.prepare('SELECT vrchat_id,code,expires_at FROM vrchat_challenges WHERE user_id=? AND expires_at>?').bind(user,epoch()).first();
  return {configured:vrchatConfigured(env),linked:linked?{...linked,profile_url:profileUrl(linked.vrchat_id)}:null,challenge:challenge?{...challenge,profile_url:profileUrl(challenge.vrchat_id),expires_at:new Date(challenge.expires_at*1000).toISOString()}:null};
}
function retry(message,seconds){const error=new HttpError(503,message,'VRCHAT_BUSY');error.retryAfter=seconds;return error;}
async function profile(id,env,fetcher){
  const now=epoch(),backoff=await env.DB.prepare("SELECT resets_at FROM rate_limits WHERE key='vrchat:backoff'").first();
  if(backoff?.resets_at>now)throw retry('VRChatへの確認を少し待っています。時間を置いて、もう一度確認してください。',backoff.resets_at-now);
  await rateLimit(env.DB,'vrchat:profile',30,60);
  const cookies=`auth=${env.VRCHAT_AUTH_TOKEN}${env.VRCHAT_TWO_FACTOR_TOKEN?`; twoFactorAuth=${env.VRCHAT_TWO_FACTOR_TOKEN}`:''}`;
  let response;
  try{response=await fetcher(`https://api.vrchat.cloud/api/1/profile/${id}`,{headers:{Cookie:cookies,'User-Agent':'NocturnePlanet/1.0 (https://nocturne-planet.pages.dev)'},redirect:'error',signal:AbortSignal.timeout(8000)});}
  catch{throw new HttpError(503,'VRChatに接続できませんでした。少し時間を置いて確認してください。');}
  if(response.status===429){
    const seconds=Math.min(3600,Math.max(30,Math.ceil(Number(response.headers.get('Retry-After'))||60)));
    await env.DB.prepare("INSERT INTO rate_limits(key,count,resets_at) VALUES('vrchat:backoff',0,?) ON CONFLICT(key) DO UPDATE SET resets_at=MAX(resets_at,excluded.resets_at)").bind(now+seconds).run();
    throw retry('VRChatへの確認が混み合っています。時間を置いて、もう一度確認してください。',seconds);
  }
  if(response.status===404)throw new HttpError(404,'VRChatアカウントが見つかりません。プロフィールURLを確認してください。');
  if(response.status===401||response.status===403)throw new HttpError(503,'確認用アカウントからプロフィールを取得できません。運営へご連絡ください。','VRCHAT_CONNECTION');
  if(!response.ok)throw new HttpError(503,'VRChatからプロフィールを取得できませんでした。');
  let data;try{data=JSON.parse(new TextDecoder().decode(await limitedBytes(response,256000)));}catch{throw new HttpError(503,'VRChatのプロフィールを読み取れませんでした。');}
  if(data.id!==id||typeof data.bio!=='string'||typeof data.displayName!=='string'||!data.displayName.trim()||data.displayName.length>200)throw new HttpError(503,'VRChatのプロフィールを確認できませんでした。');
  return {id:data.id,name:data.displayName,bio:data.bio};
}

export async function vrchatAction(action,request,actor,env,fetcher){
  if(action==='unlink'){
    await env.DB.batch([env.DB.prepare('DELETE FROM vrchat_links WHERE user_id=?').bind(actor.id),env.DB.prepare('DELETE FROM vrchat_challenges WHERE user_id=?').bind(actor.id)]);
    return {ok:true};
  }
  if(!vrchatConfigured(env))throw new HttpError(503,'VRChatの自動本人確認は準備中です。','VRCHAT_NOT_CONFIGURED');
  if(action==='start'){
    await rateLimit(env.DB,`vrchat:start:${actor.id}`,5,3600);
    const data=await bodyJson(request),id=vrchatUserId(data.profile_url);
    const occupied=await env.DB.prepare('SELECT user_id FROM vrchat_links WHERE vrchat_id=? AND user_id<>?').bind(id,actor.id).first();
    if(occupied)throw new HttpError(409,'このVRChatアカウントは連携済みです。変更は運営へご相談ください。');
    const code='NP-'+Array.from(crypto.getRandomValues(new Uint8Array(10)),n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
    await env.DB.prepare('INSERT INTO vrchat_challenges(user_id,vrchat_id,code,expires_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET vrchat_id=excluded.vrchat_id,code=excluded.code,expires_at=excluded.expires_at,checked_at=0,attempts=0').bind(actor.id,id,code,epoch()+1800).run();
    return vrchatStatus(actor.id,env);
  }
  if(action!=='verify')throw new HttpError(404,'ページが見つかりません。');
  const now=epoch(),challenge=await env.DB.prepare('SELECT * FROM vrchat_challenges WHERE user_id=?').bind(actor.id).first();
  if(!challenge||challenge.expires_at<=now)throw new HttpError(410,'確認コードの期限が切れました。もう一度発行してください。');
  if(challenge.attempts>=10)throw new HttpError(429,'確認回数の上限に達しました。コードをもう一度発行してください。');
  const claimed=await env.DB.prepare('UPDATE vrchat_challenges SET checked_at=?,attempts=attempts+1 WHERE user_id=? AND code=? AND expires_at>? AND checked_at<=? RETURNING user_id').bind(now,actor.id,challenge.code,now,now-30).first();
  if(!claimed)throw new HttpError(429,'前回の確認から30秒ほど待ってください。');
  const user=await profile(challenge.vrchat_id,env,fetcher);
  if(!user.bio.split(/\r?\n/).some(line=>line.trim()===challenge.code))throw new HttpError(400,'自己紹介に確認コードが見つかりません。コードだけを1行に貼って保存し、反映まで少し待ってから確認してください。','VRCHAT_CODE_MISSING');
  let saved;
  try{
    saved=await env.DB.batch([
      env.DB.prepare('INSERT INTO vrchat_links(user_id,vrchat_id,display_name,verified_at) SELECT user_id,vrchat_id,?,? FROM vrchat_challenges WHERE user_id=? AND code=? AND expires_at>? ON CONFLICT(user_id) DO UPDATE SET vrchat_id=excluded.vrchat_id,display_name=excluded.display_name,verified_at=excluded.verified_at').bind(user.name,nowIso(),actor.id,challenge.code,epoch()),
      env.DB.prepare('DELETE FROM vrchat_challenges WHERE user_id=? AND code=?').bind(actor.id,challenge.code)
    ]);
  }catch(error){if(/UNIQUE constraint failed: vrchat_links.vrchat_id/.test(error.message))throw new HttpError(409,'このVRChatアカウントは連携済みです。変更は運営へご相談ください。');throw error;}
  if(!saved[0].meta.changes)throw new HttpError(409,'確認コードが変更されたか、期限が切れました。画面を読み込み直してください。');
  return {ok:true,...await vrchatStatus(actor.id,env)};
}
