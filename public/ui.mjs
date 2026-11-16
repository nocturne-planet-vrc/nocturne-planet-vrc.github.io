export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeLink(value) { try { const url=new URL(value,location.origin); return (url.protocol==='https:'||url.origin===location.origin)&&!url.username&&!url.password?url.href:'#'; } catch {return '#';} }
export function dateLabel(value,includeTime=true) { if(!value)return '未定'; return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'short',...(includeTime?{hour:'2-digit',minute:'2-digit'}:{})}).format(new Date(value)); }
export function localDateTime(value) { if(!value)return ''; const time=new Date(value); return new Date(time.getTime()+9*3600000).toISOString().slice(0,16); }
export function inputIso(value) { return value?new Date(value+'+09:00').toISOString():null; }
export const empty=(message)=>`<div class="empty-inline">${esc(message)}</div>`;
function inline(value) {
  return esc(value).replace(/!\[([^\]]*)\]\((\/api\/images\/[a-zA-Z0-9_-]+)\)/g,'<img src="$2" alt="$1" loading="lazy">').replace(/\[([^\]]+)\]\(([^\s)]+)\)/g,(_,label,url)=>`<a href="${esc(safeLink(url.replaceAll('&amp;','&')))}" target="_blank" rel="noopener noreferrer">${label}</a>`).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
}
export function markdown(value) {
  const lines=String(value||'').split('\n'); let result='',inList=false;
  for(const line of lines) {
    const list=/^[-*] (.+)$/.exec(line);
    if(list){ if(!inList){result+='<ul>';inList=true;} result+=`<li>${inline(list[1])}</li>`;continue; }
    if(inList){result+='</ul>';inList=false;}
    const heading=/^(#{1,3}) (.+)$/.exec(line);
    if(heading)result+=`<h${heading[1].length+1}>${inline(heading[2])}</h${heading[1].length+1}>`;
    else if(line.trim())result+=`<p>${inline(line)}</p>`;
  }
  return result+(inList?'</ul>':'');
}
export let session=null;
export function setSession(value) { session=value; }
export async function api(path,options={}) { return request(path,options); }
export async function apiBlob(path) { return request(path,{},true); }
async function request(path,{method='GET',body}={},blob=false) {
  const headers={}; if(method!=='GET')headers['X-CSRF-Token']=session?.csrf||'';
  if(body && !(body instanceof FormData)) {headers['Content-Type']='application/json';body=JSON.stringify(body);}
  let waited=0;
  for(let attempt=0;attempt<4;attempt++) {
    const response=await fetch(path,{method,body,headers,credentials:'same-origin',cache:'no-store'});
    if(response.ok&&blob)return response.blob();
    const data=await response.json();
    if(data.code==='TOKEN_REFRESH' && attempt<3){await new Promise(resolve=>setTimeout(resolve,1500));continue;}
    const retry=Number(data.retry_after);
    // DISCORD_BUSY is returned by the permission check before any write or upload starts.
    if(data.code==='DISCORD_BUSY'&&attempt<3&&retry>0&&retry<=60&&waited+retry<=90){waited+=retry;await new Promise(resolve=>setTimeout(resolve,Math.ceil(retry*1000)+500));continue;}
    if(!response.ok){const error=new Error(data.error||'処理できませんでした。');error.status=response.status;error.code=data.code;throw error;}return data;
  }
}
export function toast(message,error=false) { const node=document.getElementById('toast'); if(!node)return; node.textContent=message;node.hidden=false;node.classList.toggle('error',error);clearTimeout(window.npToast);window.npToast=setTimeout(()=>node.hidden=true,5000); }
export async function submit(button,callback) {const buttons=[...new Set([button,...(button.form?.querySelectorAll('button[type=submit]')||[])])],states=buttons.map(b=>b.disabled);buttons.forEach(b=>b.disabled=true);try{await callback();}catch(error){toast(error.message,true);}finally{buttons.forEach((b,i)=>b.disabled=states[i]);} }
export function field(label,name,value='',type='text',attrs='') { return `<label class="field"><span>${esc(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" ${attrs}></label>`; }
export function textarea(label,name,value='',attrs='') {return `<label class="field"><span>${esc(label)}</span><textarea name="${name}" ${attrs}>${esc(value)}</textarea></label>`;}
export function select(label,name,options,value='') {return `<label class="field"><span>${esc(label)}</span><select name="${name}">${options.map(([v,l])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;}
export async function optimizedImage(file) {
  if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('JPEG・PNG・WebPの画像を選んでください。');
  if(file.size>20*1024*1024)throw new Error('元画像は20MB以下にしてください。');
  const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas'),scale=Math.min(1,2400/Math.max(bitmap.width,bitmap.height));
  canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.92));
  if(!blob||blob.size>4*1024*1024)throw new Error('画像を小さくしてから選んでください（保存時4MBまで）。');
  return new File([blob],'image.webp',{type:'image/webp'});
}
