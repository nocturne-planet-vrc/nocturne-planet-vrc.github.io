import {api,esc,dateLabel,field,select,submit,toast,empty} from './ui.mjs';

export const renderEventRecords=(root,options)=>renderRecords(root,'events',options);
export const renderChekiRecords=(root,options)=>renderRecords(root,'cheki',options);
function renderRecords(root,kind,{onEdit,onNew,onUpdated}={}){
  const mount=document.createElement('div');root.replaceChildren(mount);
  const isCheki=kind==='cheki',selected=new Set();let page=1,q='',deleted=false,eventId='',result,serial=0;
  const key=item=>item.kind+':'+item.id;
  async function load(){
    const ticket=++serial;selected.clear();mount.innerHTML='<p role="status">一覧を読み込んでいます…</p>';
    try{
      const params=new URLSearchParams({page:String(page),q,deleted:deleted?'1':'0',...(isCheki?{event_id:eventId}:{})});
      const fresh=await api('/api/manage/'+kind+'?'+params);
      if(!mount.isConnected||ticket!==serial)return;
      result=fresh;if(page>1&&page>Math.ceil(result.total/result.page_size)){page=Math.max(1,Math.ceil(result.total/result.page_size));return load();}
      draw();
    }catch(error){if(!mount.isConnected||ticket!==serial)return;mount.innerHTML=`<section class="panel"><h1>${isCheki?'チェキ管理':'営業情報'}</h1><p role="alert">${esc(error.message)}</p><button class="button secondary" id="records-retry">もう一度読み込む</button></section>`;mount.querySelector('button').onclick=load;}
  }
  function draw(){
    const rows=isCheki?result.cheki:result.events,pages=Math.max(1,Math.ceil(result.total/result.page_size));
    mount.innerHTML=`<div class="manage-top"><div><h1>${isCheki?'チェキ管理':'営業情報'}</h1><p>${isCheki?'営業回・送信者・送信日時で探し、チェキを選択して削除できます。':'営業日を編集・削除できます。削除した営業日はごみ箱から復元できます。'}</p></div>${!isCheki&&!deleted?'<button class="button small" id="records-new">営業を追加</button>':''}</div>
    <div class="tabs" role="tablist" aria-label="${isCheki?'チェキ':'営業日'}の表示"><button role="tab" aria-selected="${!deleted}" data-view="0">${isCheki?'送信履歴':'営業日の一覧'}</button><button role="tab" aria-selected="${deleted}" data-view="1">ごみ箱</button></div>
    <section class="panel"><form id="records-filter" class="records-filter">${field(isCheki?'送信者・営業名を検索':'営業名・ラベルを検索','q',q,'search','maxlength="160"')}${isCheki?select('営業回','event_id',[['','すべての営業回'],...result.events.map(e=>[e.id,`${dateLabel(e.starts_at,false)} ${e.title}${e.deleted_at?'（削除済み）':''}`])],eventId):''}<button class="button secondary" type="submit">検索</button></form><p class="quiet">${result.total}件${deleted?' ／ ごみ箱内のデータは復元できます。':''}</p>
    ${isCheki&&rows.length?`<div class="records-toolbar"><label class="check-row"><input type="checkbox" id="records-all">このページをすべて選択</label><span id="records-selected" role="status" aria-live="polite">0件を選択</span><button class="button ${deleted?'secondary':'records-delete'}" id="records-bulk" disabled>選択したチェキを${deleted?'復元':'削除'}</button></div>`:''}
    <div class="records-list">${rows.map((item,i)=>isCheki?`<label class="records-row records-cheki"><input type="checkbox" data-record="${i}" aria-label="${esc(item.sender_name)}・${esc(item.event_title)}・${esc(dateLabel(item.created_at))}のチェキを選択"><div class="records-main"><strong>${esc(item.sender_name)}</strong><p>${esc(item.event_title)}</p><small>${esc(dateLabel(item.created_at))} ／ ${item.kind==='batch'?'一斉送信':'個別送信'} ／ 配布先 ${item.recipient_count}人${item.withdrawn?' ／ 送信取り消し済み':''}${deleted?' ／ 削除 '+esc(dateLabel(item.deleted_at)):''}</small></div></label>`:`<article class="records-row"><div class="records-main"><strong>${esc(item.title)}</strong><p>${esc(dateLabel(item.starts_at))} ／ ${esc(item.category)}</p><small>来店 ${item.visit_count}件・出欠 ${item.attendance_count}件・配置 ${item.assignment_count}件・チェキ履歴 ${item.cheki_count}件${deleted?' ／ 削除 '+esc(dateLabel(item.deleted_at)):''}</small></div><span class="status-label ${item.published?'published':''}">${deleted?'ごみ箱':item.published?'公開中':'非公開'}</span><div class="records-actions">${!deleted?`<button class="button secondary small" data-edit-record="${i}">編集する</button>`:''}<button class="button ${deleted?'secondary':'records-delete'} small" data-event-action="${i}">${deleted?'復元':'削除'}</button></div></article>`).join('')||empty(deleted?'ごみ箱は空です':isCheki?'条件に一致するチェキはありません':'条件に一致する営業日はありません')}</div>
    <div class="records-pagination"><button class="button secondary small" id="records-prev" ${page<=1?'disabled':''}>前のページ</button><span>${page} / ${pages}</span><button class="button secondary small" id="records-next" ${page>=pages?'disabled':''}>次のページ</button></div></section>`;
    mount.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{deleted=button.dataset.view==='1';page=1;load();});
    mount.querySelector('#records-filter').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;q=form.elements.q.value;if(isCheki)eventId=form.elements.event_id.value;page=1;load();};
    mount.querySelector('#records-prev').onclick=()=>{page--;load();};mount.querySelector('#records-next').onclick=()=>{page++;load();};
    if(!isCheki){
      mount.querySelector('#records-new')?.addEventListener('click',onNew);
      mount.querySelectorAll('[data-edit-record]').forEach(button=>button.onclick=()=>onEdit(rows[Number(button.dataset.editRecord)]));
      mount.querySelectorAll('[data-event-action]').forEach(button=>button.onclick=()=>confirmEvent(rows[Number(button.dataset.eventAction)]));
    }else if(rows.length){
      const all=mount.querySelector('#records-all');
      function update(){mount.querySelector('#records-selected').textContent=`${selected.size}件を選択`;mount.querySelector('#records-bulk').disabled=!selected.size;all.checked=selected.size===rows.length;all.indeterminate=selected.size>0&&selected.size<rows.length;}
      mount.querySelectorAll('[data-record]').forEach(input=>input.onchange=()=>{const id=key(rows[Number(input.dataset.record)]);input.checked?selected.add(id):selected.delete(id);update();});
      all.onchange=()=>{selected.clear();mount.querySelectorAll('[data-record]').forEach(input=>{input.checked=all.checked;if(input.checked)selected.add(key(rows[Number(input.dataset.record)]));});update();};
      mount.querySelector('#records-bulk').onclick=()=>confirmCheki(rows.filter(item=>selected.has(key(item))));
    }
  }
  function confirmEvent(item){
    confirmAction(`${item.title}を${deleted?'復元':'削除'}しますか？`,deleted?'<p>営業日を非公開で復元します。公開・チェックインの受付状態は、編集画面から確認してください。</p>':`<p>公開予定、出欠回答・配置の案内、チェックイン受付、リマインドの対象から外します。</p><p>来店履歴 ${item.visit_count}件、出欠 ${item.attendance_count}件、配置 ${item.assignment_count}件、チェキ履歴 ${item.cheki_count}件は保持します。</p><p>ごみ箱から復元できます。</p>`,{id:item.id,updated_at:item.updated_at});
  }
  function confirmCheki(items){
    confirmAction(`${items.length}件のチェキを${deleted?'復元':'削除'}しますか？`,`${deleted?'<p>受取・送信履歴へ戻します。送信取り消し済みのチェキは、復元しても受取ページには表示されません。</p>':'<p>会員の受取ページと送信履歴から非表示にし、追加の配布も停止します。一斉送信のチェキは、すべての配布先が対象です。</p><p>ごみ箱から復元できます。</p>'}<ul class="records-confirm-list">${items.slice(0,8).map(item=>`<li>${esc(item.sender_name)} ／ ${esc(item.event_title)} ／ 配布先 ${item.recipient_count}人</li>`).join('')}${items.length>8?`<li>ほか ${items.length-8}件</li>`:''}</ul>`,{items:items.map(({kind,id})=>({kind,id}))});
  }
  function confirmAction(heading,body,payload){
    const dialog=document.createElement('dialog');dialog.className='records-confirm';dialog.setAttribute('aria-labelledby','records-confirm-heading');dialog.innerHTML=`<h2 id="records-confirm-heading">${esc(heading)}</h2>${body}<div class="form-actions"><button class="button secondary" type="button" data-cancel>キャンセル</button><button class="button ${deleted?'':'records-delete'}" type="button" data-confirm>${deleted?'復元する':'ごみ箱へ移す'}</button></div>`;mount.append(dialog);
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
    dialog.querySelector('[data-confirm]').onclick=event=>submit(event.currentTarget,async()=>{
      const action=deleted?'restore':'delete',response=await api('/api/manage/'+kind+'/'+action,{method:'POST',body:payload});
      dialog.close();toast(isCheki?`${response.count}件のチェキを${deleted?'復元しました':'ごみ箱へ移しました'}`:`営業日を${deleted?'非公開で復元しました':'ごみ箱へ移しました'}`);
      if(onUpdated)await onUpdated().catch(()=>{});if(mount.isConnected)await load();
    });
  }
  load();
}
