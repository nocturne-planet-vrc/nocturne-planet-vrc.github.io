export function recordListKey(kind,{page=1,q='',deleted=false,event_id=''}={}){
  return '/api/manage/'+kind+'?'+new URLSearchParams({page:String(page),q,deleted:deleted?'1':'0',...(kind==='cheki'?{event_id}:{})});
}
export function createRecordCache(request,{now=Date.now,maxAge=10000}={}){
  const entries=new Map(),pending=new Map();let generation=0;
  function prime(key,value){entries.delete(key);entries.set(key,{value,at:now()});if(entries.size>32)entries.delete(entries.keys().next().value);}
  function peek(key){const entry=entries.get(key);return entry?{value:entry.value,fresh:now()-entry.at<maxAge}:null;}
  function clear(){generation++;entries.clear();pending.clear();}
  function load(key,{force=false}={}){
    if(pending.has(key))return pending.get(key);
    const cached=peek(key);if(cached?.fresh&&!force)return Promise.resolve(cached.value);
    const version=generation;
    const work=Promise.resolve().then(()=>request(key)).then(value=>{if(version===generation)prime(key,value);return value;}).catch(error=>{if(version===generation&&(error.status===401||error.status===403))clear();throw error;}).finally(()=>{if(pending.get(key)===work)pending.delete(key);});
    pending.set(key,work);return work;
  }
  return {prime,peek,load,clear};
}
