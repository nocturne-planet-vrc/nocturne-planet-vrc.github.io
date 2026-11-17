import {HttpError,text,httpsUrl,iso,nowIso,bodyJson,formBody,randomToken,passphraseHash,equal,checkinWindow,imageType,rateLimit,snowflake} from './core.mjs';
import {actorFor,sessionFor,csrfFor,requireMutation} from './auth.mjs';
import {driveStatus,uploadDrive,downloadDrive} from './drive.mjs';
import {validateRegularHours} from '../public/schedule.mjs';
import {dutyOptions,dutyRoles} from './duties.mjs';
import {vrchatStatus,vrchatAction} from './vrchat.mjs';
import {chekiCast,chekiAudience,sendChekiBatch,grantChekiDeliveries} from './cheki.mjs';
import {syncStaffDirectory,staffUsers,isStaffCandidate} from './staff-directory.mjs';
import {sendReminders,authorizeCron,rosterFor} from './reminders.mjs';

const eventFields='id,title,description,category,starts_at,ends_at,response_deadline,published,checkin_opens_at,checkin_closes_at';
const contentFields='id,kind,slug,title,excerpt,body,status,published_at,updated_at';
export const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const rows=async statement=>(await statement.all()).results;
const sessionData=async(actor,env)=>({user:{id:actor.id,name:actor.name,avatar:actor.avatar},admin:actor.admin,csrf:await csrfFor(actor,env)});
const getSettings=async env=>JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key='site'").first())?.value||'{}');
const profileFields='id,display_name,tagline,bio,x_url,youtube_url,active,image_id';
const staffProfile=(user,env)=>env.DB.prepare(`SELECT ${profileFields} FROM casts WHERE user_id=?`).bind(user).first();
function bool(value) { if(typeof value!=='boolean') throw new HttpError(400,'公開状態を確認してください。'); return Number(value); }
function id(value) { if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new HttpError(400,'IDを確認してください。'); return value; }
async function audit(env,actor,action,resource) { await env.DB.prepare('INSERT INTO audit_log(id,actor_id,action,resource_id,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),actor.id,action,resource,nowIso()).run(); }
async function saveImage(bytes,mime,visibility,actor,env,fetcher) {
  if(bytes.length>4*1024*1024 || bytes.length<12) throw new HttpError(413,'画像は4MB以下にしてください。');
  if(imageType(bytes)!==mime) throw new HttpError(400,'画像の形式が一致しません。');
  const imageId=crypto.randomUUID(),driveId=await uploadDrive(bytes,mime,imageId,env,fetcher);
  return {id:imageId,drive_id:driveId,mime,size:bytes.length,visibility,uploaded_by:actor.id,created_at:nowIso()};
}
function imageStatement(env,image) { return env.DB.prepare('INSERT INTO images(id,drive_id,mime,size,visibility,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)').bind(image.id,image.drive_id,image.mime,image.size,image.visibility,image.uploaded_by,image.created_at); }

export async function handleApi(request,env,fetcher=fetch) {
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(path==='/api/schedule' && method==='GET') {
    return json({events:await rows(env.DB.prepare('SELECT id,title,description,category,starts_at,ends_at FROM events WHERE published=1 AND ends_at>=? ORDER BY starts_at,id').bind(nowIso()))});
  }
  if(path==='/api/public' && method==='GET') {
    const [settings,events,casts,content]=await Promise.all([getSettings(env),rows(env.DB.prepare(`SELECT ${eventFields} FROM events WHERE published=1 ORDER BY starts_at DESC LIMIT 60`)),rows(env.DB.prepare('SELECT id,display_name,tagline,bio,image_id,x_url,youtube_url FROM casts WHERE active=1 ORDER BY sort_order,display_name')),rows(env.DB.prepare(`SELECT ${contentFields} FROM content WHERE kind IN ('news','page') AND status='published' ORDER BY published_at DESC LIMIT 100`))]);
    return json({settings,events,casts,content});
  }
  if(path==='/api/session' && method==='GET') {
    const area=url.searchParams.get('area'); if(!['member','staff','manage'].includes(area)) throw new HttpError(400,'ページを確認してください。');
    const actor=await actorFor(request,env,area,fetcher);
    return json(await sessionData(actor,env));
  }
  if(path.startsWith('/api/images/') && method==='GET') {
    const imageId=id(path.split('/').pop()),image=await env.DB.prepare('SELECT * FROM images WHERE id=?').bind(imageId).first();
    if(!image) throw new HttpError(404,'画像が見つかりません。');
    let allowed=false;
    if(image.visibility==='public') {
      const used=await env.DB.prepare("SELECT id FROM casts WHERE active=1 AND image_id=? UNION ALL SELECT id FROM content WHERE kind IN ('news','page') AND status='published' AND instr(body,?)>0 UNION ALL SELECT key AS id FROM settings WHERE key='site' AND json_extract(value,'$.hero_image')=? UNION ALL SELECT settings.key AS id FROM settings, json_each(settings.value,'$.hero_images') AS hero WHERE settings.key='site' AND json_valid(settings.value) AND json_type(settings.value,'$.hero_images')='array' AND hero.value=? LIMIT 1").bind(imageId,`/api/images/${imageId}`,imageId,imageId).first(); allowed=!!used;
      if(!allowed) {
        const manual=await env.DB.prepare("SELECT id FROM content WHERE kind='manual' AND status='published' AND instr(body,?)>0 LIMIT 1").bind(`/api/images/${imageId}`).first();
        const session=await sessionFor(request,env);
        const ownCast=await env.DB.prepare('SELECT id FROM casts WHERE user_id=? AND (image_id=? OR ?=1)').bind(session.user_id,imageId,Number(image.uploaded_by===session.user_id)).first();
        const actor=await actorFor(request,env,manual||ownCast?'staff':'manage',fetcher); allowed=!!manual||!!ownCast||actor.admin;
      }
    } else {
      const session=await sessionFor(request,env);
      const cheki=await env.DB.prepare("SELECT sender_id,recipient_id,withdrawn FROM cheki WHERE image_id=? AND (recipient_id=? OR sender_id=?) UNION ALL SELECT b.sender_id,d.recipient_id,b.withdrawn FROM cheki_batches b LEFT JOIN cheki_deliveries d ON d.batch_id=b.id WHERE b.image_id=? AND b.state='sent' AND (d.recipient_id=? OR b.sender_id=?) LIMIT 1").bind(imageId,session.user_id,session.user_id,imageId,session.user_id,session.user_id).first();
      if(cheki&&!cheki.withdrawn) {
        if(session.user_id===cheki.recipient_id) {
          try { await actorFor(request,env,'member',fetcher); allowed=true; }
          catch(error) { if(error.status!==403 || session.user_id!==cheki.sender_id) throw error; }
        }
        if(!allowed && session.user_id===cheki.sender_id) { await actorFor(request,env,'staff',fetcher); allowed=true; }
      }
    }
    if(!allowed) throw new HttpError(403,'このチェキを閲覧する権限がありません。');
    return new Response(await downloadDrive(image.drive_id,env,fetcher),{headers:{'Content-Type':image.mime,'Content-Length':String(image.size),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
  }
  const area=path.startsWith('/api/manage')?'manage':path.startsWith('/api/staff')?'staff':path.startsWith('/api/member')?'member':null;
  if(path==='/api/cron/reminders' && method==='POST') { authorizeCron(request,env); return json(await sendReminders(env,fetcher)); }
  if(!area) throw new HttpError(404,'ページが見つかりません。');
  const actor=await actorFor(request,env,area,fetcher);
  if(method!=='GET') { await requireMutation(request,actor,env); await rateLimit(env.DB,`mutation:${actor.id}`,90); }
  const vrchatRoute=/^\/api\/(member|staff)\/vrchat\/(start|verify|unlink)$/.exec(path);
  if(vrchatRoute&&method==='POST')return json(await vrchatAction(vrchatRoute[2],request,actor,env,fetcher));

  if(path==='/api/member' && method==='GET') {
    await grantChekiDeliveries(actor.id,env);
    const [visits,favorites,cheki]=await Promise.all([
      rows(env.DB.prepare('SELECT v.event_id,v.checked_in_at,e.title,e.starts_at FROM visits v JOIN events e ON e.id=v.event_id WHERE user_id=? ORDER BY checked_in_at DESC').bind(actor.id)),
      rows(env.DB.prepare('SELECT cast_id FROM favorites WHERE user_id=?').bind(actor.id)),
      rows(env.DB.prepare("SELECT c.id,c.image_id,c.message,c.created_at,c.opened_at,c.sender_id,u.display_name AS sender_name,e.title AS event_title FROM cheki c JOIN users u ON u.id=c.sender_id LEFT JOIN events e ON e.id=c.event_id WHERE c.recipient_id=? AND c.withdrawn=0 UNION ALL SELECT b.id,b.image_id,b.message,b.created_at,d.opened_at,b.sender_id,u.display_name,e.title FROM cheki_batches b JOIN cheki_deliveries d ON d.batch_id=b.id JOIN users u ON u.id=b.sender_id JOIN events e ON e.id=b.event_id WHERE d.recipient_id=? AND b.state='sent' AND b.withdrawn=0 ORDER BY 4 DESC LIMIT 60").bind(actor.id,actor.id))
    ]); return json({session:await sessionData(actor,env),visits,favorites:favorites.map(x=>x.cast_id),cheki,vrchat:await vrchatStatus(actor.id,env)});
  }
  if(path==='/api/member/favorites' && method==='PUT') {
    const data=await bodyJson(request); if(!Array.isArray(data.cast_ids)||data.cast_ids.length>50) throw new HttpError(400,'キャストの選択を確認してください。');
    const selected=[...new Set(data.cast_ids.map(id))];
    for(const cast of selected) if(!await env.DB.prepare('SELECT id FROM casts WHERE id=? AND active=1').bind(cast).first()) throw new HttpError(400,'公開中のキャストを選んでください。');
    await env.DB.batch([env.DB.prepare('DELETE FROM favorites WHERE user_id=?').bind(actor.id),...selected.map(cast=>env.DB.prepare('INSERT INTO favorites(user_id,cast_id) VALUES(?,?)').bind(actor.id,cast))]); return json({ok:true});
  }
  if(path==='/api/member/checkin' && method==='POST') {
    const data=await bodyJson(request),eventId=id(data.event_id),phrase=text(data.passphrase,80,true);
    await rateLimit(env.DB,`checkin:${actor.id}`,8,600);
    const event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(eventId).first();
    if(!checkinWindow(event)) throw new HttpError(403,'この営業のチェックイン受付時間外です。','CHECKIN_CLOSED');
    const hash=await passphraseHash(event.id,event.checkin_salt,phrase,env.CHECKIN_PEPPER);
    if(!equal(hash,event.checkin_hash)) throw new HttpError(400,'合言葉を確認してください。','CHECKIN_INCORRECT');
    const timestamp=nowIso();
    const inserted=await env.DB.prepare('INSERT INTO visits(event_id,user_id,checked_in_at) SELECT id,?,? FROM events WHERE id=? AND published=1 AND checkin_hash=? AND checkin_opens_at<=? AND checkin_closes_at>=? ON CONFLICT(event_id,user_id) DO NOTHING').bind(actor.id,timestamp,event.id,hash,timestamp,timestamp).run();
    const existing=await env.DB.prepare('SELECT checked_in_at FROM visits WHERE event_id=? AND user_id=?').bind(event.id,actor.id).first();
    if(!existing) throw new HttpError(409,'受付状態が変更されました。画面を再読み込みしてください。');
    return json({ok:true,already:inserted.meta.changes===0,checked_in_at:existing.checked_in_at});
  }
  if(/^\/api\/member\/cheki\/[^/]+\/opened$/.test(path) && method==='POST') {
    const chekiId=id(path.split('/')[4]),timestamp=nowIso();
    await env.DB.batch([env.DB.prepare('UPDATE cheki SET opened_at=COALESCE(opened_at,?) WHERE id=? AND recipient_id=? AND withdrawn=0').bind(timestamp,chekiId,actor.id),env.DB.prepare("UPDATE cheki_deliveries SET opened_at=COALESCE(opened_at,?) WHERE batch_id=? AND recipient_id=? AND EXISTS(SELECT 1 FROM cheki_batches WHERE id=? AND state='sent' AND withdrawn=0)").bind(timestamp,chekiId,actor.id,chekiId)]); return json({ok:true});
  }
  if(path==='/api/staff' && method==='GET') {
    const [events,attendance,manuals,assignments,sent]=await Promise.all([
      rows(env.DB.prepare(`SELECT ${eventFields} FROM events WHERE ends_at>? ORDER BY starts_at LIMIT 60`).bind(new Date(Date.now()-86400000).toISOString())),
      rows(env.DB.prepare('SELECT * FROM attendance WHERE user_id=?').bind(actor.id)),
      rows(env.DB.prepare(`SELECT ${contentFields} FROM content WHERE kind='manual' AND status='published' ORDER BY title`)),
      rows(env.DB.prepare('SELECT a.event_id,a.details,e.title FROM assignments a JOIN events e ON e.id=a.event_id WHERE a.user_id=? AND a.published=1 ORDER BY e.starts_at DESC LIMIT 20').bind(actor.id)),
      rows(env.DB.prepare("SELECT c.id,c.message,c.created_at,c.withdrawn,e.title AS event_title,1 AS recipient_count FROM cheki c LEFT JOIN events e ON e.id=c.event_id WHERE c.sender_id=? UNION ALL SELECT b.id,b.message,b.created_at,b.withdrawn,e.title,(SELECT count(*) FROM cheki_deliveries WHERE batch_id=b.id) FROM cheki_batches b JOIN events e ON e.id=b.event_id WHERE b.sender_id=? AND b.state='sent' ORDER BY 3 DESC LIMIT 30").bind(actor.id,actor.id))
    ]); return json({session:await sessionData(actor,env),events,attendance,manuals,assignments,sent,profile:await staffProfile(actor.id,env),cheki_cast:await chekiCast(actor.id,env),duty_options:dutyOptions(actor.member,env),vrchat:await vrchatStatus(actor.id,env)});
  }
  if(path==='/api/staff/profile' && method==='POST') {
    const data=await bodyJson(request),allowed=new Set(['cast_id','tagline','bio','x_url','youtube_url','image_id']);
    if(Object.keys(data).some(key=>!allowed.has(key)))throw new HttpError(400,'変更できるのは、紹介写真・ひとこと・プロフィール・X・YouTubeです。');
    const current=await staffProfile(actor.id,env);
    if(!current)throw new HttpError(403,'運営にキャスト紹介の登録とDiscordアカウントの紐付けを依頼してください。','CAST_LINK_REQUIRED');
    if(data.cast_id!==current.id)throw new HttpError(409,'キャスト紹介の紐付けが変わりました。画面を読み込み直してください。');
    if(Object.hasOwn(data,'image_id')&&data.image_id!==null&&typeof data.image_id!=='string')throw new HttpError(400,'紹介写真を選び直してください。');
    const imageId=Object.hasOwn(data,'image_id')?(data.image_id?id(data.image_id):null):current.image_id;
    if(imageId&&imageId!==current.image_id&&!await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public' AND uploaded_by=?").bind(imageId,actor.id).first())throw new HttpError(400,'本人がアップロードした紹介写真を選んでください。');
    const values=[text(data.tagline,120),text(data.bio,3000),httpsUrl(text(data.x_url,2048)),httpsUrl(text(data.youtube_url,2048))];
    const updated=await env.DB.prepare(`UPDATE casts SET tagline=?,bio=?,x_url=?,youtube_url=?,image_id=? WHERE id=? AND user_id=? RETURNING ${profileFields}`).bind(...values,imageId,current.id,actor.id).first();
    if(!updated)throw new HttpError(409,'キャスト紹介の紐付けが変わりました。画面を読み込み直してください。');
    await audit(env,actor,'cast.self.update',current.id);
    return json({ok:true,profile:updated});
  }
  if(path==='/api/staff/profile/image' && method==='POST') {
    const current=await staffProfile(actor.id,env);
    if(!current)throw new HttpError(403,'運営にキャスト紹介の登録とDiscordアカウントの紐付けを依頼してください。','CAST_LINK_REQUIRED');
    await rateLimit(env.DB,`upload:${actor.id}`,60,3600);
    if(Number(request.headers.get('Content-Length'))>4500000)throw new HttpError(413,'画像は4MB以下にしてください。');
    const form=await formBody(request),file=form.get('image');
    if(form.get('cast_id')!==current.id)throw new HttpError(409,'キャスト紹介の紐付けが変わりました。画面を読み込み直してください。');
    if(!(file instanceof File)||file.size>4*1024*1024)throw new HttpError(400,'4MB以下の画像を選んでください。');
    const image=await saveImage(new Uint8Array(await file.arrayBuffer()),file.type,'public',actor,env,fetcher);
    await imageStatement(env,image).run();return json({id:image.id,url:`/api/images/${image.id}`});
  }
  if(path==='/api/staff/recipients' && method==='GET') {
    const audience=await chekiAudience(actor.id,url.searchParams.get('event_id'),env);
    return json({cast:audience.cast,event:audience.event,count:audience.count,audience_hash:audience.audience_hash});
  }
  if(path==='/api/staff/attendance' && method==='POST') {
    const data=await bodyJson(request),eventId=id(data.event_id),event=await env.DB.prepare('SELECT * FROM events WHERE id=?').bind(eventId).first();
    if(!event || Date.parse(event.ends_at)<Date.now() || (event.response_deadline && Date.parse(event.response_deadline)<Date.now())) throw new HttpError(403,'回答期限を過ぎています。運営へ連絡してください。');
    if(!['yes','no','maybe'].includes(data.answer)) throw new HttpError(400,'出欠を選んでください。');
    const duties=dutyRoles.map(duty=>duty.name);
    if(!Array.isArray(data.duties)||data.duties.some(d=>!duties.includes(d))) throw new HttpError(400,'担当を確認してください。');
    const allowed=new Set(dutyOptions(actor.member,env).filter(duty=>duty.available).map(duty=>duty.name));
    if(data.duties.some(duty=>!allowed.has(duty)))throw new HttpError(403,'現在のDiscordロールで選べない担当が含まれています。画面を読み込み直してください。','DUTY_ROLE_REQUIRED');
    const from=text(data.available_from||'',5),until=text(data.available_until||'',5);
    if([from,until].some(t=>t&&!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new HttpError(400,'参加できる時間を確認してください。');
    await env.DB.prepare('INSERT INTO attendance(event_id,user_id,answer,available_from,available_until,duties,note,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET answer=excluded.answer,available_from=excluded.available_from,available_until=excluded.available_until,duties=excluded.duties,note=excluded.note,updated_at=excluded.updated_at').bind(eventId,actor.id,data.answer,from,until,JSON.stringify([...new Set(data.duties)]),text(data.note||'',1000),nowIso()).run(); return json({ok:true});
  }
  if(path==='/api/staff/cheki' && method==='POST')return json(await sendChekiBatch(request,actor,env,fetcher));
  if(path==='/api/staff/cheki/withdraw' && method==='POST') {
    const data=await bodyJson(request),chekiId=id(data.id);
    await env.DB.batch([env.DB.prepare('UPDATE cheki SET withdrawn=1 WHERE id=? AND sender_id=?').bind(chekiId,actor.id),env.DB.prepare("UPDATE cheki_batches SET withdrawn=1 WHERE id=? AND sender_id=? AND state='sent'").bind(chekiId,actor.id)]); await audit(env,actor,'cheki.withdraw',chekiId); return json({ok:true});
  }
  if(path==='/api/manage' && method==='GET') {
    const directory=await syncStaffDirectory(env,fetcher);
    const [settings,events,casts,content,attendance,users,assignments,drive]=await Promise.all([
      getSettings(env), rows(env.DB.prepare(`SELECT ${eventFields} FROM events ORDER BY starts_at DESC LIMIT 100`)),rows(env.DB.prepare('SELECT * FROM casts ORDER BY sort_order,display_name')),rows(env.DB.prepare(`SELECT ${contentFields} FROM content ORDER BY updated_at DESC LIMIT 200`)),
      rows(env.DB.prepare('SELECT a.*,u.display_name FROM attendance a JOIN users u ON u.id=a.user_id JOIN events e ON e.id=a.event_id WHERE e.ends_at>? ORDER BY e.starts_at,u.display_name').bind(new Date(Date.now()-30*86400000).toISOString())),
      staffUsers(env),rows(env.DB.prepare('SELECT * FROM assignments LIMIT 1000')),driveStatus(env)
    ]); return json({session:await sessionData(actor,env),settings,events,casts,content,attendance,users,assignments,drive,directory,roster:await rosterFor(env),reminders_ready:!!env.DISCORD_BOT_TOKEN&&!!env.CRON_SECRET});
  }
  if(path==='/api/manage/staff-sync' && method==='POST') {
    await rateLimit(env.DB,'staff-sync',6,60);
    const directory=await syncStaffDirectory(env,fetcher,{force:true});
    if(!directory.configured)throw new HttpError(503,'Discord Botのトークンが設定されていません。','BOT_NOT_CONFIGURED');
    await audit(env,actor,'staff.sync','staff_directory');return json({directory,users:await staffUsers(env)});
  }
  if(path==='/api/manage/schedule' && method==='POST') {
    const data=await bodyJson(request);let regularHours;
    try{regularHours=validateRegularHours(data.regular_hours);}catch(error){throw new HttpError(400,error.message);}
    await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.regular_hours',json(?)) WHERE key='site'").bind(JSON.stringify(regularHours)).run();
    await audit(env,actor,'schedule.save','site');return json({ok:true,regular_hours:regularHours});
  }
  if(path==='/api/manage/settings' && method==='POST') {
    const data=await bodyJson(request),settings={};
    for(const field of ['x_url','youtube_url','discord_invite','vrchat_group_url']) settings[field]=httpsUrl(data[field]||'');
    settings.youtube_video=text(data.youtube_video||'',100); if(settings.youtube_video&&!/^[a-zA-Z0-9_-]{11}$/.test(settings.youtube_video)) throw new HttpError(400,'YouTubeの動画ID（11文字）を指定してください。');
    for(const field of ['about','admission','cadence']) settings[field]=text(data[field]||'',field==='about'?4000:160);
    const heroImages=data.hero_images===undefined?(data.hero_image?[data.hero_image]:[]):data.hero_images;
    if(!Array.isArray(heroImages)||heroImages.length>12) throw new HttpError(400,'トップ写真は12枚まで登録できます。');
    settings.hero_images=[...new Set(heroImages.map(id))];
    for(const imageId of settings.hero_images) if(!await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public'").bind(imageId).first()) throw new HttpError(400,'公開用画像を指定してください。');
    settings.hero_image=settings.hero_images[0]||'';
    await env.DB.prepare("UPDATE settings SET value=json_patch(value,?) WHERE key='site'").bind(JSON.stringify(settings)).run(); await audit(env,actor,'settings.save','site'); return json({ok:true});
  }
  if(path==='/api/manage/events' && method==='POST') {
    const data=await bodyJson(request),eventId=data.id?id(data.id):crypto.randomUUID(),starts=iso(data.starts_at),ends=iso(data.ends_at),deadline=iso(data.response_deadline,true),opens=iso(data.checkin_opens_at,true),closes=iso(data.checkin_closes_at,true);
    if(ends<=starts || (opens&&closes&&closes<=opens)) throw new HttpError(400,'終了は開始より後の時刻にしてください。');
    let salt=null,hash=null;
    const existing=await env.DB.prepare('SELECT checkin_salt,checkin_hash,category FROM events WHERE id=?').bind(eventId).first();
    const category=data.category===undefined?(existing?.category||'通常営業'):text(data.category,24,true);
    if(data.passphrase) { const phrase=text(data.passphrase,80,true); if(phrase.length<4) throw new HttpError(400,'合言葉は4文字以上にしてください。'); salt=randomToken(); hash=await passphraseHash(eventId,salt,phrase,env.CHECKIN_PEPPER); }
    else if(existing) {salt=existing.checkin_salt;hash=existing.checkin_hash;}
    if(data.disable_checkin) {salt=null;hash=null;}
    await env.DB.prepare('INSERT INTO events(id,title,description,category,starts_at,ends_at,response_deadline,published,checkin_opens_at,checkin_closes_at,checkin_salt,checkin_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,category=excluded.category,starts_at=excluded.starts_at,ends_at=excluded.ends_at,response_deadline=excluded.response_deadline,published=excluded.published,checkin_opens_at=excluded.checkin_opens_at,checkin_closes_at=excluded.checkin_closes_at,checkin_salt=excluded.checkin_salt,checkin_hash=excluded.checkin_hash,updated_at=excluded.updated_at').bind(eventId,text(data.title,160,true),text(data.description||'',4000),category,starts,ends,deadline,bool(data.published),opens,closes,salt,hash,nowIso(),nowIso()).run(); await audit(env,actor,'event.save',eventId); return json({ok:true,id:eventId});
  }
  if(path==='/api/manage/content' && method==='POST') {
    const data=await bodyJson(request),contentId=data.id?id(data.id):crypto.randomUUID(),slug=text(data.slug,100,true);
    if(!['news','page','manual'].includes(data.kind)||!['draft','published','archived'].includes(data.status)||! /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400,'記事の種類・状態・URL名を確認してください。');
    const existing=await env.DB.prepare('SELECT published_at FROM content WHERE id=?').bind(contentId).first();
    await env.DB.prepare('INSERT INTO content(id,kind,slug,title,excerpt,body,status,published_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,slug=excluded.slug,title=excluded.title,excerpt=excluded.excerpt,body=excluded.body,status=excluded.status,published_at=excluded.published_at,updated_at=excluded.updated_at,updated_by=excluded.updated_by').bind(contentId,data.kind,slug,text(data.title,160,true),text(data.excerpt||'',500),text(data.body||'',60000),data.status,data.status==='published'?(existing?.published_at||nowIso()):existing?.published_at||null,nowIso(),actor.id).run(); await audit(env,actor,'content.'+data.status,contentId); return json({ok:true,id:contentId});
  }
  if(path==='/api/manage/casts' && method==='POST') {
    const data=await bodyJson(request),castId=data.id?id(data.id):crypto.randomUUID(),imageId=data.image_id?id(data.image_id):null;
    const existingCast=await env.DB.prepare('SELECT user_id FROM casts WHERE id=?').bind(castId).first();
    const castUser=Object.hasOwn(data,'user_id')?(data.user_id?snowflake(data.user_id):null):(existingCast?.user_id||null);
    if(castUser&&!await isStaffCandidate(castUser,env))throw new HttpError(400,'運営用Discordサーバーにいる本人のアカウントを選んでください。');
    if(castUser&&await env.DB.prepare('SELECT id FROM casts WHERE user_id=? AND id<>?').bind(castUser,castId).first())throw new HttpError(409,'このDiscordアカウントは別のキャスト紹介に紐付いています。');
    if(imageId&&!await env.DB.prepare("SELECT id FROM images WHERE id=? AND visibility='public'").bind(imageId).first()) throw new HttpError(400,'公開用画像を選んでください。');
    const sort=Number(data.sort_order||0); if(!Number.isSafeInteger(sort)||Math.abs(sort)>10000) throw new HttpError(400,'表示順を確認してください。');
    try{await env.DB.prepare('INSERT INTO casts(id,display_name,tagline,bio,image_id,x_url,youtube_url,sort_order,active,user_id) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,tagline=excluded.tagline,bio=excluded.bio,image_id=excluded.image_id,x_url=excluded.x_url,youtube_url=excluded.youtube_url,sort_order=excluded.sort_order,active=excluded.active,user_id=excluded.user_id').bind(castId,text(data.display_name,80,true),text(data.tagline||'',120),text(data.bio||'',3000),imageId,httpsUrl(data.x_url||''),httpsUrl(data.youtube_url||''),sort,bool(data.active),castUser).run();}
    catch(error){if(/UNIQUE constraint failed: casts.user_id/.test(error.message))throw new HttpError(409,'このDiscordアカウントは別のキャスト紹介に紐付いています。');throw error;}
    await audit(env,actor,'cast.save',castId); return json({ok:true,id:castId});
  }
  if(path==='/api/manage/images' && method==='POST') {
    await rateLimit(env.DB,`upload:${actor.id}`,60,3600);
    if(Number(request.headers.get('Content-Length'))>4500000) throw new HttpError(413,'画像は4MB以下にしてください。');
    const form=await formBody(request),file=form.get('image'); if(!(file instanceof File)||file.size>4*1024*1024) throw new HttpError(400,'4MB以下の画像を選んでください。');
    const image=await saveImage(new Uint8Array(await file.arrayBuffer()),file.type,'public',actor,env,fetcher); await imageStatement(env,image).run(); return json({id:image.id,url:`/api/images/${image.id}`});
  }
  if(path==='/api/manage/assignments' && method==='POST') {
    const data=await bodyJson(request),eventId=id(data.event_id),userId=snowflake(data.user_id);
    if(!await isStaffCandidate(userId,env) || !await env.DB.prepare('SELECT id FROM events WHERE id=?').bind(eventId).first()) throw new HttpError(400,'営業回と運営用サーバーにいるスタッフを選んでください。');
    await env.DB.prepare('INSERT INTO assignments(event_id,user_id,details,published) VALUES(?,?,?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET details=excluded.details,published=excluded.published').bind(eventId,userId,text(data.details||'',3000),bool(data.published)).run(); await audit(env,actor,'assignment.save',eventId); return json({ok:true});
  }
  throw new HttpError(404,'ページが見つかりません。');
}
