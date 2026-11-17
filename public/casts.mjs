import {esc,safeLink} from './ui.mjs';

const arrow='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>';
export function castCard(cast){
  return `<button class="cast-card" data-cast="${esc(cast.id)}">${cast.image_id?`<img src="/api/images/${encodeURIComponent(cast.image_id)}" alt="${esc(cast.display_name)}" loading="lazy" width="900" height="1200">`:'<div class="cast-photo-empty"><img src="/assets/logo-dark.svg" alt="" width="160" height="160"></div>'}<span class="cast-card-body"><strong>${esc(cast.display_name)}</strong><span>${esc(cast.tagline)}</span><span class="cast-more"><span>プロフィール</span>${arrow}</span></span></button>`;
}
export function castProfile(cast){
  return `${cast.image_id?`<img class="cast-portrait" src="/api/images/${encodeURIComponent(cast.image_id)}" alt="${esc(cast.display_name)}">`:''}<p class="quiet">${esc(cast.tagline)}</p><h2>${esc(cast.display_name)}</h2><p class="preserve">${esc(cast.bio)}</p><div class="actions">${cast.x_url?`<a href="${esc(safeLink(cast.x_url))}" target="_blank" rel="noopener noreferrer" class="text-link"><span>X</span>${arrow}</a>`:''}${cast.youtube_url?`<a href="${esc(safeLink(cast.youtube_url))}" target="_blank" rel="noopener noreferrer" class="text-link"><span>YouTube</span>${arrow}</a>`:''}<a href="/member" class="button small pill">お気に入りキャストに登録</a></div>`;
}
export function showCastPreview(cast,{onSave,saveLabel='この内容で保存する'}={}){
  const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','キャスト紹介のプレビュー');
  dialog.innerHTML=`<button class="dialog-close" aria-label="プレビューを閉じる" type="button">×</button><p class="quiet">プレビュー（未保存）</p><div class="tabs" role="tablist" aria-label="プレビューの表示"><button type="button" role="tab" aria-selected="true" aria-controls="cast-preview-profile" id="cast-preview-profile-tab">プロフィール</button><button type="button" role="tab" aria-selected="false" aria-controls="cast-preview-list" id="cast-preview-list-tab">一覧での表示</button></div><div role="tabpanel" id="cast-preview-profile" aria-labelledby="cast-preview-profile-tab">${castProfile(cast)}</div><div role="tabpanel" id="cast-preview-list" aria-labelledby="cast-preview-list-tab" hidden><div class="cast-preview-card">${castCard(cast)}</div></div>`;
  const tabs=[...dialog.querySelectorAll('[role=tab]')],panels=[...dialog.querySelectorAll('[role=tabpanel]')];
  function show(index){tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;panels[i].hidden=i!==index;});tabs[index].focus();}
  tabs.forEach((tab,index)=>{tab.onclick=()=>show(index);tab.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();show(event.key==='Home'?0:event.key==='End'?1:1-index);}};});
  tabs[1].tabIndex=-1;
  dialog.querySelector('.cast-card').onclick=()=>show(0);
  const favorite=dialog.querySelector('a[href="/member"]');favorite.setAttribute('aria-disabled','true');favorite.tabIndex=-1;favorite.onclick=event=>event.preventDefault();
  let saving=false;
  if(onSave){
    const footer=document.createElement('div');footer.className='cast-preview-footer';
    footer.innerHTML=`<p class="notice error" role="alert" hidden></p><div class="actions"><button class="button secondary" type="button" data-preview-back>編集に戻る</button><button class="button" type="button" data-preview-save>${esc(saveLabel)}</button></div>`;
    dialog.append(footer);footer.querySelector('[data-preview-back]').onclick=()=>dialog.close();
    const save=footer.querySelector('[data-preview-save]'),error=footer.querySelector('[role=alert]');
    save.onclick=async()=>{
      if(saving)return;saving=true;error.hidden=true;
      const buttons=[...dialog.querySelectorAll('button')],states=buttons.map(button=>button.disabled);buttons.forEach(button=>button.disabled=true);
      save.textContent='保存しています…';dialog.setAttribute('aria-busy','true');
      try{await onSave();dialog.close();}
      catch(problem){error.textContent=problem.message||'保存できませんでした。もう一度お試しください。';error.hidden=false;}
      finally{saving=false;dialog.removeAttribute('aria-busy');buttons.forEach((button,index)=>button.disabled=states[index]);save.textContent=saveLabel;}
    };
  }
  dialog.querySelector('.dialog-close').onclick=()=>dialog.close();
  dialog.addEventListener('click',event=>{if(event.target===dialog&&!saving)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  document.body.append(dialog);dialog.showModal();
}
