import {esc,field,textarea,select,submit} from './ui.mjs';
import {photoFields,bindContentPhotos} from './content-settings.mjs';
import {blockTypes,recruitContent,renderRecruitPage} from './recruit-content.mjs';

export function renderRecruitEditor(root,settings,connected,onChange,onSave){
  let draft=recruitContent(settings),url=settings.recruit_url||'';
  function read(){
    const form=root.querySelector('#recruit-form'),value=name=>form.elements.namedItem(name).value;
    const page={label:value('label'),title:value('title'),lead:value('lead'),image:value('recruit.image'),image_side:value('image_side'),sections:draft.sections.map((s,i)=>{
      const key='section.'+i;
      return {...s,title:value(key+'.title'),body:value(key+'.body'),enabled:form.elements.namedItem(key+'.enabled').checked,columns:Number(value(key+'.columns')),tone:value(key+'.tone'),items:s.items.map((item,n)=>({title:value(key+'.item.'+n+'.title'),body:value(key+'.item.'+n+'.body')}))};
    }),contact:{title:value('contact.title'),body:value('contact.body'),button_label:value('contact.button_label'),items:value('contact.items').split('\n').map(s=>s.trim()).filter(Boolean)}};
    url=value('recruit_url');draft=page;return page;
  }
  function draw(openId=''){
    root.innerHTML=`<div class="manage-top"><div><h1>募集ページ</h1><p>文章や募集要項、セクションの並び・列数・背景を変更できます。</p></div><a class="button secondary small" href="/recruit" target="_blank" rel="noopener noreferrer">公開ページを確認</a></div>
    <form id="recruit-form"><section class="panel"><h2>ページの冒頭</h2>${field('ページのラベル','label',draft.label,'text','required maxlength="80"')}${textarea('大きな見出し','title',draft.title,'required maxlength="120"')}${textarea('紹介文','lead',draft.lead,'maxlength="4000"')}${select('文章の位置','image_side',[['right','左寄せ'],['left','右寄せ']],draft.image_side)}${photoFields('recruit',draft.image,connected)}<p class="inline-help">写真はトップ全体の背景になります。スマホでは、文章を左寄せで表示します。</p></section>
    <section class="panel"><h2>ページの構成</h2><p class="inline-help">各セクションを開いて編集できます。上へ・下へで並べ替え、チェックを外すと非表示になります。</p><div class="recruit-editor-blocks">${draft.sections.map((s,i)=>{
      const key='section.'+i;
      return `<details class="settings-card recruit-editor-block" data-section="${esc(s.id)}" ${s.id===openId?'open':''}><summary><span>${i+1}. ${esc(s.title)}</span><small>${blockTypes[s.type]}${s.enabled?'':'・非表示'}</small></summary><div class="recruit-editor-actions"><button class="button secondary small" type="button" data-move="${i}" data-direction="-1" ${i===0?'disabled':''}>上へ</button><button class="button secondary small" type="button" data-move="${i}" data-direction="1" ${i===draft.sections.length-1?'disabled':''}>下へ</button><button class="button secondary small" type="button" data-remove="${i}">このセクションを削除</button></div><label class="check-row"><input type="checkbox" name="${key}.enabled" ${s.enabled?'checked':''}>このセクションを表示する</label>${field('セクションの見出し',key+'.title',s.title,'text','required maxlength="120"')}${textarea(s.type==='text'?'本文':'見出しの下の説明（任意）',key+'.body',s.body,'maxlength="6000"')}<div class="field-pair">${select('背景',key+'.tone',[['paper','白い紙'],['cream','クリーム']],s.tone)}${select('カード・ステップの列数',key+'.columns',[[1,'1列'],[2,'2列'],[3,'3列']],s.columns)}</div>${s.type==='requirements'||s.type==='text'?'<p class="inline-help">募集要項と文章は、読みやすい1列で表示します。</p>':''}${s.type!=='text'?`<div class="recruit-editor-items">${s.items.map((item,n)=>`<fieldset class="recruit-editor-item"><legend>項目 ${n+1}</legend>${field('項目名',key+'.item.'+n+'.title',item.title,'text','required maxlength="120"')}${textarea('内容',key+'.item.'+n+'.body',item.body,'maxlength="4000"')}<button class="button secondary small" type="button" data-remove-item="${i}" data-item="${n}">この項目を削除</button></fieldset>`).join('')}</div><button class="button secondary small" type="button" data-add-item="${i}" ${s.items.length>=12?'disabled':''}>項目を追加</button>`:''}</details>`;
    }).join('')}</div><div class="recruit-editor-add">${select('追加するセクション','new_type',Object.entries(blockTypes),'text')}<button class="button secondary" type="button" id="add-recruit-section" ${draft.sections.length>=12?'disabled':''}>セクションを追加</button></div><p class="inline-help">セクションは12個まで、各セクションの項目も12個まで追加できます。</p></section>
    <section class="panel"><h2>応募の案内</h2>${field('応募先のGoogleフォームURL','recruit_url',url,'url','maxlength="2048"')}${field('案内の見出し','contact.title',draft.contact.title,'text','required maxlength="120"')}${textarea('案内文','contact.body',draft.contact.body,'maxlength="4000"')}${textarea('応募時に必要な情報（1行に1項目）','contact.items',draft.contact.items.join('\n'),'maxlength="2400"')}${field('応募ボタンの文字','contact.button_label',draft.contact.button_label,'text','required maxlength="80"')}<p class="inline-help">応募先URLが空欄の場合は、受付準備中と表示します。</p></section>
    <div class="form-actions recruit-editor-save"><button type="button" class="button secondary" id="preview-recruit">プレビュー</button><button type="submit" class="button">募集ページを保存して公開</button></div><p class="inline-help">編集内容は保存するまで公開ページに反映されません。</p></form>
    <dialog class="recruit-preview-dialog" aria-label="募集ページのプレビュー"><div class="recruit-preview-toolbar"><strong>保存前のプレビュー</strong><button class="button secondary small" type="button" id="close-recruit-preview">編集に戻る</button></div><div class="public-site recruit-page recruit-preview-surface"><main class="recruit-main" id="recruit-preview-main"></main></div></dialog>`;
    const form=root.querySelector('#recruit-form');
    form.addEventListener('input',onChange);form.addEventListener('change',onChange);
    bindContentPhotos(form,onChange);
    root.querySelectorAll('[data-move]').forEach(button=>button.onclick=()=>{
      read();const i=Number(button.dataset.move),next=i+Number(button.dataset.direction),id=draft.sections[i].id;
      [draft.sections[i],draft.sections[next]]=[draft.sections[next],draft.sections[i]];onChange();draw(id);focusSection(id);
    });
    root.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{read();draft.sections.splice(Number(button.dataset.remove),1);onChange();draw();});
    root.querySelectorAll('[data-add-item]').forEach(button=>button.onclick=()=>{read();const section=draft.sections[Number(button.dataset.addItem)];section.items.push({title:'新しい項目',body:''});onChange();draw(section.id);focusSection(section.id);});
    root.querySelectorAll('[data-remove-item]').forEach(button=>button.onclick=()=>{read();const section=draft.sections[Number(button.dataset.removeItem)];section.items.splice(Number(button.dataset.item),1);onChange();draw(section.id);focusSection(section.id);});
    root.querySelector('#add-recruit-section').onclick=()=>{
      const type=form.elements.new_type.value;read();const id='section-'+crypto.randomUUID();draft.sections.push({id,type,title:type==='text'?'新しいセクション':blockTypes[type],body:'',items:type==='text'?[]:[{title:'新しい項目',body:''}],enabled:true,columns:type==='cards'?2:1,tone:'paper'});onChange();draw(id);focusSection(id);
    };
    const dialog=root.querySelector('dialog');
    root.querySelector('#preview-recruit').onclick=()=>{if(!form.reportValidity())return;read();root.querySelector('#recruit-preview-main').innerHTML=renderRecruitPage(draft,url,'preview-');dialog.showModal();};
    root.querySelector('#close-recruit-preview').onclick=()=>dialog.close();dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
    form.onsubmit=event=>{event.preventDefault();read();submit(event.submitter,()=>onSave({recruit_url:url,recruit_page:draft}));};
  }
  function focusSection(id){root.querySelector(`[data-section="${id}"] summary`)?.focus();}
  draw();
}
