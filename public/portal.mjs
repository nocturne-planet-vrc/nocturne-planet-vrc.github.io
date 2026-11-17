import {renderVrchat} from './vrchat.mjs';
import {showCastPreview} from './casts.mjs';
import {api,apiBlob,setSession,session,esc,markdown,dateLabel,toast,submit,optimizedImage,empty,field,textarea,select} from './ui.mjs';
import {attendanceTimes} from './schedule.mjs';

const memberImageUrls=new Set();
window.addEventListener('pagehide',()=>{for(const url of memberImageUrls)URL.revokeObjectURL(url);});
const area=location.pathname.replaceAll('/','')||'member',labels={member:'会員ページ',staff:'キャスト・スタッフページ',manage:'運営ページ'};
document.body.classList.add('portal-'+area);
document.title=`${labels[area]} | Nocturne Planet`;
document.getElementById('area-label').textContent=labels[area];document.getElementById('login-title').textContent=labels[area];
document.getElementById('login-description').textContent=area==='manage'?'運営用Discordサーバーで「運営」ロールが付いている方が利用できます。':area==='staff'?'運営用Discordサーバーに参加している方が利用できます。':'お客さん用Discordサーバーに参加している方が利用できます。';
const remember=document.getElementById('remember'),login=document.getElementById('login-button');
function loginUrl(){login.href=`/auth/discord?area=${area}&remember=${remember.checked?'1':'0'}`;}remember.addEventListener('change',loginUrl);loginUrl();
const error=new URLSearchParams(location.search).get('error');
if(error){const message=document.getElementById('login-message');message.textContent=error;message.hidden=false;history.replaceState(null,'',location.pathname);}
let authenticated=false,initialData;
try {initialData=await api(`/api/${area}`);setSession(initialData.session);authenticated=true;}
catch(error){if(error.status!==401){const message=document.getElementById('login-message');message.textContent=error.message;message.hidden=false;}}
if(!authenticated){document.getElementById('portal-loading').hidden=true;login.closest('.login-panel').hidden=false;}
if(authenticated){
  document.getElementById('account-actions').innerHTML=`<span class="user-chip">${esc(session.user.name)}</span>${area==='staff'&&session.admin?'<a class="button secondary small pill" href="/manage">運営ページ</a>':''}<button class="button secondary small pill" id="logout">ログアウト</button>`;
  document.getElementById('logout').addEventListener('click',event=>submit(event.currentTarget,async()=>{await api('/api/logout',{method:'POST'});location.reload();}));
  try{
    if(area==='manage'){const {renderManage}=await import('./manage.mjs');await renderManage(initialData);}
    else if(area==='staff')await renderStaff(initialData);
    else await renderMember(initialData);
  }catch(error){document.getElementById('portal-main').innerHTML=`<div class="dashboard"><h1>${labels[area]}</h1><div class="notice error">${esc(error.message)}</div><button class="button" id="retry-load">読み込み直す</button></div>`;document.getElementById('retry-load').onclick=()=>location.reload();}
}

async function loadMemberImages(){
  for(const img of document.querySelectorAll('[data-private-image]')){
    try{const blob=await apiBlob(img.dataset.privateImage);if(!img.isConnected)continue;const url=URL.createObjectURL(blob);memberImageUrls.add(url);img.src=url;img.alt=img.alt.replace('（読み込み中）','');}
    catch(error){img.alt=error.message;toast(error.message,true);}
  }
}
async function renderMember(initial){
  const [data,publicData]=await Promise.all([initial||api('/api/member'),api('/api/public')]);
  for(const url of memberImageUrls)URL.revokeObjectURL(url);memberImageUrls.clear();
  const currentEvents=publicData.events.filter(e=>e.checkin_opens_at&&e.checkin_closes_at&&Date.now()>=Date.parse(e.checkin_opens_at)&&Date.now()<=Date.parse(e.checkin_closes_at));
  document.getElementById('portal-main').innerHTML=`<div class="dashboard"><div class="dashboard-title"><h1>会員ページ</h1><p>${esc(session.user.name)}さんの来店記録・お気に入り・チェキ</p></div><div class="dashboard-grid"><section class="panel"><h2>来店記録</h2><div class="stats"><div><div class="number">${data.visits.length}<small>回</small></div><p>これまでの来店</p></div><div><p>直近の来店</p><span>${data.visits[0]?esc(dateLabel(data.visits[0].checked_in_at,false)):'まだ記録がありません'}</span></div></div>${data.visits.length?`<details><summary>来店履歴を見る</summary><ul class="record-list">${data.visits.map(v=>`<li><strong>${esc(v.title)}</strong><small>${esc(dateLabel(v.checked_in_at))}</small></li>`).join('')}</ul></details>`:''}</section><section class="panel"><h2>本日のチェックイン</h2>${currentEvents.length?`<form id="checkin-form">${select('営業回','event_id',currentEvents.map(e=>[e.id,e.title]))}${field('会場で案内された合言葉','passphrase','','text','required maxlength="80" autocomplete="off"')}<button class="button pill" type="submit">チェックインする</button></form>`:empty('受付中の営業はありません')}</section><section class="panel full"><h2>お気に入りのキャスト</h2><p class="quiet">複数人を選べます。選択内容はほかのお客さんには表示されません。</p>${publicData.casts.length?`<form id="favorite-form"><div class="favorite-list">${publicData.casts.map(c=>`<label class="favorite-cast"><input type="checkbox" name="cast" value="${esc(c.id)}" ${data.favorites.includes(c.id)?'checked':''}><span class="favorite-photo${c.image_id?'':' no-photo'}"><img src="${c.image_id?'/api/images/'+encodeURIComponent(c.image_id):'/assets/logo-dark.svg'}" alt="" loading="lazy" width="900" height="1200"></span><span class="favorite-name">${esc(c.display_name)}</span></label>`).join('')}</div><div class="form-actions"><button class="button small pill" type="submit">保存する</button></div></form>`:empty('キャスト紹介の公開後に登録できます')}</section><section class="panel full"><h2>受け取ったチェキ</h2><p class="quiet">キャストからあなた宛てに届いたチェキです。</p><div class="cheki-grid">${data.cheki.map(c=>`<article class="cheki-card"><img data-private-image="/api/images/${esc(c.image_id)}" alt="${esc(c.sender_name)}さんからのチェキ（読み込み中）"><div><strong>${esc(c.sender_name)}</strong><p>${esc(c.message)}</p><small class="quiet">${esc(dateLabel(c.created_at,false))}${c.event_title?' ／ '+esc(c.event_title):''}</small><button class="button secondary small pill" data-download="${esc(c.id)}">画像を保存</button></div></article>`).join('')||empty('チェキが届くと、ここに表示されます')}</div></section></div></div>`;
  const accountPanel=document.createElement('section');accountPanel.className='panel full';accountPanel.id='vrchat-account';document.querySelector('.dashboard-grid').append(accountPanel);renderVrchat(accountPanel,data.vrchat,'member');
  void loadMemberImages();
  document.getElementById('checkin-form')?.addEventListener('submit',event=>{event.preventDefault();submit(event.submitter,async()=>{const result=await api('/api/member/checkin',{method:'POST',body:Object.fromEntries(new FormData(event.target))});toast(result.already?'この営業はチェックイン済みです':'チェックインしました');await renderMember();});});
  document.getElementById('favorite-form')?.addEventListener('submit',event=>{event.preventDefault();submit(event.submitter,async()=>{await api('/api/member/favorites',{method:'PUT',body:{cast_ids:new FormData(event.target).getAll('cast')}});toast('お気に入りを保存しました');});});
  document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',()=>submit(button,async()=>{
    const cheki=data.cheki.find(c=>c.id===button.dataset.download),blob=await apiBlob(`/api/images/${encodeURIComponent(cheki.image_id)}`);
    const blobUrl=URL.createObjectURL(blob),link=document.createElement('a');link.href=blobUrl;link.download=`nocturne-planet-${cheki.id}.webp`;link.click();setTimeout(()=>URL.revokeObjectURL(blobUrl),10000);
    await api(`/api/member/cheki/${encodeURIComponent(cheki.id)}/opened`,{method:'POST',body:{}});
  })));
}

async function renderStaff(initial){
  const [data,publicData]=await Promise.all([initial||api('/api/staff'),api('/api/public')]);
  const regular=publicData.settings.regular_hours,duties=data.duty_options||[];
  document.getElementById('portal-main').innerHTML=`<div class="dashboard staff-dashboard"><div class="dashboard-title"><h1>キャスト・スタッフページ</h1><p>出欠の回答・配置の確認・マニュアル・チェキ送信</p></div><div class="tabs" role="tablist" aria-label="スタッフメニュー"><button role="tab" aria-selected="true" data-staff-tab="attendance">出欠・シフト</button><button role="tab" aria-selected="false" data-staff-tab="assignments">今回の配置</button><button role="tab" aria-selected="false" data-staff-tab="manuals">マニュアル</button><button role="tab" aria-selected="false" data-staff-tab="cheki">チェキを送る</button><button role="tab" aria-selected="false" data-staff-tab="vrchat">VRChat連携</button><button role="tab" aria-selected="false" data-staff-tab="profile">キャスト紹介</button></div><div id="staff-content"></div></div>`;
  function switchTab(name){
    document.querySelectorAll('[data-staff-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.staffTab===name)));
    const root=document.getElementById('staff-content');
    if(name==='attendance'){
      root.innerHTML=`<section class="panel attendance-panel"><h2>出欠・シフトを回答する</h2><p class="quiet">時刻は日本時間です。配置は運営が決定します。</p>${data.events.length?`<form id="attendance-form"><div class="attendance-event">${select('営業回','event_id',data.events.map(e=>[e.id,`${dateLabel(e.starts_at,false)} ${e.title}`]))}<dl class="attendance-meta"><div><dt>この回の営業時間</dt><dd id="attendance-hours"></dd></div><div><dt>回答期限</dt><dd id="response-deadline"></dd></div></dl></div><fieldset class="form-section"><legend>出欠・参加時間</legend>${select('出欠','answer',[['yes','参加できる'],['no','参加できない'],['maybe','未定']])}<div class="field-pair">${field('参加できる時刻','available_from','','time')}${field('退出予定の時刻','available_until','','time')}</div><p class="inline-help">${regular?'未回答の場合は通常営業の時刻を入れています。':'未回答の場合は、この営業回の開始・終了時刻を入れています。'}変更があれば書き換えてください。</p></fieldset><fieldset class="form-section"><legend>対応できる担当</legend><div class="duty-checks">${duties.map(d=>`<label class="check-row"><input type="checkbox" name="duties" value="${esc(d.name)}" ${d.available?'':'disabled'}>${esc(d.name)}</label>`).join('')}</div><p class="inline-help">${data.session.admin?'運営ロールが付いているため、すべての担当を選べます。':duties.some(d=>d.available)?'Discordの担当ロールが付いている項目だけ選べます。追加・変更は運営へ連絡してください。':'担当ロールが付いていません。出欠と連絡事項は回答できます。担当の追加は運営へ連絡してください。'}</p><p class="inline-help" id="duty-role-change" hidden></p></fieldset><fieldset class="form-section"><legend>運営への連絡</legend>${textarea('連絡事項（任意）','note','','maxlength="1000"')}</fieldset><div class="form-actions"><button class="button" type="submit">回答を保存する</button></div></form>`:empty('回答受付中の営業はありません')}</section>`;
      const form=document.getElementById('attendance-form');
      if(form){
        function populate(){
          const answer=data.attendance.find(a=>a.event_id===form.elements.event_id.value),event=data.events.find(e=>e.id===form.elements.event_id.value),times=attendanceTimes(answer,event,regular);
          form.elements.answer.value=answer?.answer||'yes';
          for(const key of ['available_from','available_until'])form.elements[key].value=times[key];
          form.elements.note.value=answer?.note||'';
          const previousDuties=JSON.parse(answer?.duties||'[]');
          form.querySelectorAll('[name=duties]').forEach(box=>box.checked=!box.disabled&&previousDuties.includes(box.value));
          const unavailable=previousDuties.filter(name=>!duties.some(duty=>duty.name===name&&duty.available)),notice=document.getElementById('duty-role-change');
          notice.hidden=!unavailable.length;notice.textContent=unavailable.length?`現在のロールで選べない担当（${unavailable.join('・')}）を選択から外しています。保存すると回答に反映されます。`:'';
          document.getElementById('attendance-hours').textContent=dateLabel(event.starts_at)+'〜'+dateLabel(event.ends_at);
          document.getElementById('response-deadline').textContent=event.response_deadline?dateLabel(event.response_deadline):'運営の案内を確認してください';
        }
        form.elements.event_id.addEventListener('change',populate);populate();
        form.addEventListener('submit',event=>{event.preventDefault();submit(event.submitter,async()=>{const fields=new FormData(form),body=Object.fromEntries(fields);body.duties=fields.getAll('duties');await api('/api/staff/attendance',{method:'POST',body});data.attendance=(await api('/api/staff')).attendance;toast('回答を保存しました');});});
      }
    }else if(name==='assignments')root.innerHTML=`<section class="panel"><h2>今回の配置</h2><p class="quiet">運営が決定した担当・卓配置・交代順を確認できます。</p>${data.assignments.map(a=>`<article><h3>${esc(a.title)}</h3><p class="preserve">${esc(a.details)}</p></article>`).join('')||empty('配置はまだ公開されていません')}</section>`;
    else if(name==='manuals')root.innerHTML=`<section class="panel"><h2>マニュアル</h2>${data.manuals.map(m=>`<details><summary>${esc(m.title)}</summary><div class="prose">${markdown(m.body)}</div><p class="quiet">更新：${esc(dateLabel(m.updated_at,false))}</p></details>`).join('')||empty('マニュアルは準備中です')}</section>`;
    else if(name==='profile')renderCastProfile(root,data.profile,value=>{data.profile=value;});
    else if(name==='vrchat'){root.innerHTML='<section class="panel" id="vrchat-account"></section>';renderVrchat(root.firstElementChild,data.vrchat,'staff',value=>{data.vrchat=value;});}
    else renderCheki(root,data,publicData);
  }
  document.querySelectorAll('[data-staff-tab]').forEach(button=>button.addEventListener('click',()=>switchTab(button.dataset.staffTab)));switchTab('attendance');
}
function renderCheki(root,data,publicData){
  let audience=null,image=null,previewUrl=null,confirmed=false,batchId=crypto.randomUUID(),generation=0;
  const events=publicData.events.filter(e=>Date.parse(e.starts_at)<=Date.now());
  root.innerHTML=`<div class="staff-layout"><section class="panel"><h2>チェキを一斉送信</h2><p>自分をお気に入り登録していて、選んだ営業回にもチェックイン済みのお客さんに送ります。あとから両方の登録を済ませた人にも届きます。</p>${!data.cheki_cast?'<p class="notice">送信するには、運営にキャスト紹介と本人のDiscordアカウントの紐付けを依頼してください。</p>':!events.length?empty('送信できる営業回はまだありません'):`<p class="quiet">送信するキャスト：${esc(data.cheki_cast.display_name)}</p><form id="cheki-form">${select('来店を確認する営業回','event_id',events.map(e=>[e.id,`${dateLabel(e.starts_at,false)} ${e.title}`]))}<button class="button secondary small" type="button" id="check-audience">対象人数を確認する</button><p id="cheki-audience" class="cheki-audience" role="status">営業回を選び、対象人数を確認してください。</p>${field('書き込み済みのチェキ画像','image','','file','accept="image/jpeg,image/png,image/webp" required')}<p class="inline-help">JPEG・PNG・WebP。長辺2400pxまでに整えて保存します。</p><img id="cheki-preview" class="image-preview" alt="送信するチェキの確認" hidden>${textarea('メッセージ（任意）','message','','maxlength="500"')}<div class="cheki-confirm" id="cheki-confirm" hidden></div><div class="form-actions"><button class="button" type="submit" disabled>送信内容を確認する</button></div></form>`}</section><section class="panel"><h2>送信履歴</h2><ul class="record-list">${data.sent.map(c=>`<li><strong>${esc(c.event_title||'過去のチェキ')} ／ ${esc(c.recipient_count)}人</strong><small>${esc(dateLabel(c.created_at))}${c.withdrawn?' ／ 取り消し済み':''}</small>${c.message?`<p>${esc(c.message)}</p>`:''}${!c.withdrawn?`<div><button class="text-button" data-withdraw="${esc(c.id)}">送信を取り消す</button></div>`:''}</li>`).join('')||empty('送信履歴はありません')}</ul></section></div>`;
  const form=root.querySelector('#cheki-form');
  if(form){
    const send=form.querySelector('[type=submit]'),check=root.querySelector('#check-audience'),summary=root.querySelector('#cheki-audience'),confirmation=root.querySelector('#cheki-confirm'),preview=root.querySelector('#cheki-preview');
    function resetConfirmation(){confirmed=false;batchId=crypto.randomUUID();confirmation.hidden=true;send.textContent='送信内容を確認する';}
    form.elements.event_id.onchange=()=>{generation++;audience=null;send.disabled=true;summary.textContent='対象人数を確認してください。';resetConfirmation();};
    form.elements.message.oninput=resetConfirmation;
    check.onclick=async()=>{
      check.disabled=true;
      const version=++generation,eventId=form.elements.event_id.value;audience=null;send.disabled=true;resetConfirmation();summary.textContent='対象人数を確認しています…';
      try{const fresh=await api('/api/staff/recipients?event_id='+encodeURIComponent(eventId));if(version!==generation)return;audience=fresh;summary.textContent=fresh.count?`現在の対象：${fresh.count}人`:'現在の対象：0人。あとから条件がそろうと届きます。';send.disabled=false;}
      catch(error){if(version===generation)summary.textContent='人数を確認できませんでした。もう一度確認してください。';toast(error.message,true);}
      finally{check.disabled=false;send.disabled=!audience;}
    };
    form.elements.image.onchange=async event=>{
      image=null;resetConfirmation();preview.hidden=true;
      const file=event.target.files[0];
      try{const optimized=await optimizedImage(file);if(event.target.files[0]!==file)return;image=optimized;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(image);preview.src=previewUrl;preview.hidden=false;}
      catch(error){toast(error.message,true);}
    };
    form.onsubmit=event=>{event.preventDefault();submit(event.submitter,async()=>{
      if(!audience||audience.event.id!==form.elements.event_id.value)throw new Error('対象人数を確認してください。');
      if(!image)throw new Error('チェキ画像の準備ができてから確認してください。');
      if(!confirmed){confirmation.innerHTML=`<h3>送信内容の確認</h3><p>${esc(dateLabel(audience.event.starts_at,false))} ${esc(audience.event.title)}</p><p><strong>${audience.count}人に、この画像とメッセージを送ります。</strong></p><p class="quiet">あとからお気に入り登録とチェックインを済ませた人にも届きます。</p>${form.elements.message.value?`<p class="preserve">${esc(form.elements.message.value)}</p>`:'<p class="quiet">メッセージなし</p>'}`;confirmation.hidden=false;send.textContent=audience.count?`${audience.count}人に一斉送信する`:'チェキを登録する';confirmed=true;return;}
      const upload=new FormData();upload.set('event_id',audience.event.id);upload.set('audience_hash',audience.audience_hash);upload.set('batch_id',batchId);upload.set('image',image);upload.set('message',form.elements.message.value);
      try{const result=await api('/api/staff/cheki',{method:'POST',body:upload});toast(result.count?`${result.count}人にチェキを送りました`:'チェキを登録しました。条件がそろったお客さんに届きます');if(previewUrl)URL.revokeObjectURL(previewUrl);renderCheki(root,await api('/api/staff'),publicData);}
      catch(error){if(error.code==='AUDIENCE_CHANGED'){audience=null;send.disabled=true;summary.textContent='対象人数を確認し直してください。';resetConfirmation();}throw error;}
    }).finally(()=>{send.disabled=!audience;});};
  }
  root.querySelectorAll('[data-withdraw]').forEach(button=>button.onclick=()=>submit(button,async()=>{if(!confirm('対象のお客さん全員へのチェキ表示を取り消します。保存済みの画像は取り消せません。よろしいですか？'))return;await api('/api/staff/cheki/withdraw',{method:'POST',body:{id:button.dataset.withdraw}});toast('送信を取り消しました');if(previewUrl)URL.revokeObjectURL(previewUrl);renderCheki(root,await api('/api/staff'),publicData);}));
}

function renderCastProfile(root,profile,onChange){
  root.innerHTML=`<section class="panel"><h2>キャスト紹介を編集</h2>${!profile?'<p class="notice">運営にキャスト紹介の登録と、本人のDiscordアカウントの紐付けを依頼してください。</p>':`<p><strong>${esc(profile.display_name)}</strong><span class="quiet"> ／ ${profile.active?'公開中':'非公開'}</span></p><p class="quiet">${profile.active?'保存すると公開HPに反映されます。':'現在は非公開です。運営が公開するとHPに表示されます。'}</p><form id="cast-profile-form">${field('ひとこと','tagline',profile.tagline,'text','maxlength="120"')}${textarea('プロフィール','bio',profile.bio,'maxlength="3000"')}<div class="field-pair">${field('XのURL','x_url',profile.x_url,'url','maxlength="2048" placeholder="https://x.com/…"')}${field('YouTubeのURL','youtube_url',profile.youtube_url,'url','maxlength="2048" placeholder="https://www.youtube.com/…"')}</div><div class="form-actions"><button class="button secondary" type="button" id="preview-cast-profile">プレビュー</button><button class="button" type="submit">紹介を保存する</button></div></form>`}</section>`;
  const form=root.querySelector('#cast-profile-form');
  async function saveProfile(values){
    const result=await api('/api/staff/profile',{method:'POST',body:values});
    onChange(result.profile);renderCastProfile(root,result.profile,onChange);toast('キャスト紹介を保存しました');
  }
  const profileValues=()=>({cast_id:profile.id,...Object.fromEntries(new FormData(form))});
  root.querySelector('#preview-cast-profile')?.addEventListener('click',()=>{if(form.reportValidity()){
    const values=profileValues();showCastPreview({...profile,...values},{onSave:()=>saveProfile(values)});
  }});
  if(form)form.onsubmit=event=>{event.preventDefault();submit(event.submitter,()=>saveProfile(profileValues()));};
}
