import {api,esc,field,textarea,select,optimizedImage,submit,toast} from './ui.mjs';
import {facilityPhotos,siteImageSrc} from './site-content.mjs';

export function photoFields(key,image,connected){
  const options=facilityPhotos.some(([path])=>path===image)?facilityPhotos:[...facilityPhotos,[image,'登録済みの写真']];
  return `<div class="settings-photo">${select('写真',key+'.image',options,image)}<img class="settings-photo-preview" data-photo-preview="${key}" src="${esc(siteImageSrc(image))}" alt="選択中の写真" width="320" height="180">${field('別の写真をアップロード',key+'_upload','','file',`accept="image/jpeg,image/png,image/webp" data-settings-photo="${key}" ${connected?'':'disabled'}`)}</div>`;
}
export function contentSettingsFields(s,connected){
  return `<fieldset class="form-section"><legend>開催場所</legend>${field('開催場所・ワールド名','venue',s.venue,'text','required maxlength="160"')}${field('会場・ワールドのURL（任意）','venue_url',s.venue_url,'url','maxlength="2048"')}<p class="inline-help">ホームの「次回の営業情報」と「楽しみ方」に反映します。URLを入れると会場名がリンクになります。</p></fieldset>
  <fieldset class="form-section"><legend>所要時間</legend><div class="field-pair">${field('本編（分）','main_minutes',s.main_minutes,'number','required min="0" max="600" step="1"')}${field('アフター（分）','after_minutes',s.after_minutes,'number','required min="0" max="600" step="1"')}</div><p class="inline-help">ホームの所要時間と、本編・アフターの案内文に反映します。営業回ごとの開始・終了日時は「営業情報」で設定してください。</p></fieldset>
  <fieldset class="form-section"><legend>楽しみ方の3つのプログラム</legend><p class="inline-help hero-help">見出し、時間、紹介文、写真を、ホームの並び順で変更できます。</p>${s.programs.map((p,i)=>{const key='programs.'+i;return `<details class="settings-card"><summary>${i+1}. ${esc(p.title)}</summary>${field('見出し',key+'.title',p.title,'text','required maxlength="80"')}<div class="field-pair">${field('所要時間（分）',key+'.minutes',p.minutes,'number','required min="0" max="600" step="1"')}${field('時間の補足（任意）',key+'.detail',p.detail,'text','maxlength="80" placeholder="15分×2回"')}</div>${textarea('紹介文',key+'.description',p.description,'maxlength="1000"')}${textarea('写真の吹き出し（任意）',key+'.caption',p.caption,'maxlength="120"')}${photoFields(key,p.image,connected)}</details>`;}).join('')}</fieldset>
  <fieldset class="form-section"><legend>施設紹介</legend>${textarea('施設の案内文','facility_intro',s.facility_intro,'maxlength="4000"')}${s.facilities.map((p,i)=>{const key='facilities.'+i;return `<details class="settings-card"><summary>${i+1}. ${esc(p.title)}</summary>${field('見出し',key+'.title',p.title,'text','required maxlength="80"')}${textarea('説明',key+'.description',p.description,'maxlength="160"')}${photoFields(key,p.image,connected)}</details>`;}).join('')}<p class="inline-help hero-help">写真は同梱の施設写真から選べます。新しい写真のアップロードには、下のGoogle Drive連携が必要です。</p></fieldset>`;
}
export function readContentSettings(form,values){
  for(const key of ['main_minutes','after_minutes'])values[key]=Number(values[key]);
  for(const group of ['programs','facilities'])values[group]=[0,1,2].map(i=>{
    const item={};for(const field of group==='programs'?['title','description','minutes','detail','caption','image']:['title','description','image']){
      const key=group+'.'+i+'.'+field;item[field]=field==='minutes'?Number(values[key]):values[key];delete values[key];
    }return item;
  });
  for(const key of Object.keys(values))if(key.endsWith('_upload'))delete values[key];
}
export function bindContentPhotos(form,onChange){
  for(const input of form.querySelectorAll('[data-settings-photo]')){
    const key=input.dataset.settingsPhoto,pick=form.elements.namedItem(key+'.image'),preview=form.querySelector(`[data-photo-preview="${key}"]`);
    pick.addEventListener('change',()=>{preview.src=siteImageSrc(pick.value);});
    input.addEventListener('change',event=>submit(form.querySelector('[type=submit]'),async()=>{
      const file=event.target.files[0];if(!file)return;
      const body=new FormData();body.set('image',await optimizedImage(file));const image=await api('/api/manage/images',{method:'POST',body});
      const option=new Option('アップロードした写真',image.id,true,true);pick.add(option);preview.src=image.url;input.value='';onChange();toast('写真を追加しました。設定を保存すると公開HPに反映されます。');
    }));
  }
}
