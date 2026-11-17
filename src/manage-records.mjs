import {HttpError,bodyJson,text,nowIso} from './core.mjs';

// Pages deployments do not run D1 migrations. Upgrade these additive fields once
// per binding, like the existing reminder tables, before any reader uses them.
const schemas=new WeakMap();
export function ensureManageTrash(env){
  if(!schemas.has(env.DB)){
    const ready=(async()=>{
      for(const table of ['events','cheki','cheki_batches']){
        const hasColumn=async()=> (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.some(column=>column.name==='deleted_at');
        if(!await hasColumn())try{await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`).run();}catch(error){if(!await hasColumn())throw error;}
      }
      await env.DB.prepare('CREATE INDEX IF NOT EXISTS event_deleted_start ON events(deleted_at,starts_at)').run();
    })().catch(error=>{schemas.delete(env.DB);throw error;});
    schemas.set(env.DB,ready);
  }
  return schemas.get(env.DB);
}

const identifier=value=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value))throw new HttpError(400,'対象を選び直してください。');return value;};
function pageOptions(url){
  const raw=url.searchParams.get('page')||'1';if(!/^[1-9]\d{0,5}$/.test(raw))throw new HttpError(400,'ページ番号を確認してください。');
  return {page:Number(raw),q:text(url.searchParams.get('q')||'',160),deleted:url.searchParams.get('deleted')==='1',size:50};
}
const eventCounts=`(SELECT count(*) FROM visits WHERE event_id=e.id) AS visit_count,(SELECT count(*) FROM attendance WHERE event_id=e.id) AS attendance_count,(SELECT count(*) FROM assignments WHERE event_id=e.id) AS assignment_count,((SELECT count(*) FROM cheki WHERE event_id=e.id)+(SELECT count(*) FROM cheki_batches WHERE event_id=e.id AND state='sent')) AS cheki_count`;
const chekiRows=`SELECT 'single' AS kind,c.id,c.event_id,coalesce(e.title,'営業回の指定なし') AS event_title,c.sender_id,coalesce(profile.display_name,u.display_name) AS sender_name,c.created_at,c.deleted_at,c.withdrawn,1 AS recipient_count FROM cheki c JOIN users u ON u.id=c.sender_id LEFT JOIN casts profile ON profile.user_id=c.sender_id LEFT JOIN events e ON e.id=c.event_id UNION ALL SELECT 'batch',b.id,b.event_id,e.title,b.sender_id,coalesce(profile.display_name,u.display_name),b.created_at,b.deleted_at,b.withdrawn,(SELECT count(*) FROM cheki_deliveries WHERE batch_id=b.id) FROM cheki_batches b JOIN users u ON u.id=b.sender_id JOIN casts profile ON profile.id=b.cast_id JOIN events e ON e.id=b.event_id WHERE b.state='sent'`;

export async function manageRecords(path,method,url,request,actor,env){
  if(path==='/api/manage/events'&&method==='GET'){
    const {page,q,deleted,size}=pageOptions(url),where=`deleted_at IS ${deleted?'NOT ':''}NULL AND instr(lower(title||' '||category),lower(?))>0`;
    const total=(await env.DB.prepare(`SELECT count(*) AS n FROM events WHERE ${where}`).bind(q).first()).n;
    const {results:events}=await env.DB.prepare(`SELECT e.id,e.title,e.description,e.category,e.starts_at,e.ends_at,e.response_deadline,e.published,e.checkin_opens_at,e.checkin_closes_at,e.updated_at,e.deleted_at,${eventCounts} FROM events e WHERE ${where} ORDER BY starts_at DESC,id LIMIT ? OFFSET ?`).bind(q,size,(page-1)*size).all();
    return {events,total,page,page_size:size};
  }
  if(path==='/api/manage/cheki'&&method==='GET'){
    const {page,q,deleted,size}=pageOptions(url),eventId=url.searchParams.get('event_id')||'';if(eventId)identifier(eventId);
    const where=`deleted_at IS ${deleted?'NOT ':''}NULL AND instr(lower(sender_name||' '||event_title),lower(?))>0 AND (?='' OR event_id=?)`;
    const total=(await env.DB.prepare(`WITH records AS (${chekiRows}) SELECT count(*) AS n FROM records WHERE ${where}`).bind(q,eventId,eventId).first()).n;
    const {results:cheki}=await env.DB.prepare(`WITH records AS (${chekiRows}) SELECT * FROM records WHERE ${where} ORDER BY created_at DESC,kind,id LIMIT ? OFFSET ?`).bind(q,eventId,eventId,size,(page-1)*size).all();
    const {results:events}=await env.DB.prepare("SELECT id,title,starts_at,deleted_at FROM events WHERE EXISTS(SELECT 1 FROM cheki WHERE event_id=events.id) OR EXISTS(SELECT 1 FROM cheki_batches WHERE event_id=events.id AND state='sent') ORDER BY starts_at DESC LIMIT 500").all();
    return {cheki,events,total,page,page_size:size};
  }
  const eventAction=/^\/api\/manage\/events\/(delete|restore)$/.exec(path);
  if(eventAction&&method==='POST'){
    const data=await bodyJson(request),eventId=identifier(data.id),version=text(data.updated_at,80,true),action=eventAction[1],deleted=action==='delete';
    const event=await env.DB.prepare('SELECT id,deleted_at,updated_at FROM events WHERE id=?').bind(eventId).first();
    if(!event)throw new HttpError(404,'営業日が見つかりません。');
    const timestamp=new Date(Math.max(Date.now(),Date.parse(event.updated_at)+1)).toISOString(),where=`id=? AND updated_at=? AND deleted_at IS ${deleted?'':'NOT '}NULL`;
    const result=await env.DB.batch([
      env.DB.prepare(`INSERT INTO audit_log(id,actor_id,action,resource_id,created_at) SELECT ?,?,?,id,? FROM events WHERE ${where}`).bind(crypto.randomUUID(),actor.id,'event.'+action,timestamp,eventId,version),
      env.DB.prepare(`UPDATE events SET deleted_at=?,published=0,updated_at=? WHERE ${where}`).bind(deleted?timestamp:null,timestamp,eventId,version)
    ]);
    if(!result[1].meta.changes)throw new HttpError(409,'営業日が変更されました。一覧を読み込み直してください。');
    return {ok:true};
  }
  const chekiAction=/^\/api\/manage\/cheki\/(delete|restore)$/.exec(path);
  if(chekiAction&&method==='POST'){
    const data=await bodyJson(request),action=chekiAction[1],deleting=action==='delete';
    if(!Array.isArray(data.items)||!data.items.length||data.items.length>100)throw new HttpError(400,'チェキを1〜100件選んでください。');
    const groups={single:[],batch:[]},seen=new Set();
    for(const item of data.items){
      if(!item||!Object.hasOwn(groups,item.kind))throw new HttpError(400,'チェキの選択を確認してください。');
      const id=identifier(item.id),key=item.kind+':'+id;if(seen.has(key))throw new HttpError(400,'同じチェキが重複しています。');seen.add(key);groups[item.kind].push(id);
    }
    const timestamp=nowIso(),statements=[];
    for(const [kind,ids] of Object.entries(groups))if(ids.length){
      const table=kind==='single'?'cheki':'cheki_batches',list=JSON.stringify(ids),sent=kind==='batch'?" AND state='sent'":'';
      const existing=await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE id IN (SELECT value FROM json_each(?))${sent}`).bind(list).first();
      if(existing.n!==ids.length)throw new HttpError(404,'選択したチェキが見つかりません。一覧を読み込み直してください。');
      const where=`id IN (SELECT value FROM json_each(?)) AND deleted_at IS ${deleting?'':'NOT '}NULL${sent}`;
      statements.push(env.DB.prepare(`INSERT INTO audit_log(id,actor_id,action,resource_id,created_at) SELECT lower(hex(randomblob(16))),?,?,?||id,? FROM ${table} WHERE ${where}`).bind(actor.id,'cheki.'+action,kind+':',timestamp,list));
      statements.push(env.DB.prepare(`UPDATE ${table} SET deleted_at=? WHERE ${where}`).bind(deleting?timestamp:null,list));
    }
    const results=await env.DB.batch(statements);
    return {ok:true,count:results.filter((_,i)=>i%2===1).reduce((sum,r)=>sum+r.meta.changes,0)};
  }
  throw new HttpError(404,'ページが見つかりません。');
}
