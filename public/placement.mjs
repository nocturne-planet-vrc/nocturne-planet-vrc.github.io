import {api,dateLabel,empty,esc,select,submit,toast} from './ui.mjs';
import {placementStaffRoles} from './placement-roles.mjs';

const deskRows=[[9,8,7],[6,5,4],[3,2,1]];
const rotation=[1,2,3,9,8,7,4,5,6];
const seatCount=9;
// North is up, so the south-east desk is at the bottom right.
const deskPoints=new Map(deskRows.flatMap((row,y)=>row.map((number,x)=>[number,{x:60+120*x,y:45+90*y}])));
const instanceLimit=12;
const staffLimit=24;
const instanceName=index=>`第${index+1}インスタンス`;
const noAssignee=()=>({user_id:'',name:''});
const newInstance=()=>({
  seats:Array.from({length:seatCount},()=>({in_use:true,...noAssignee()})),
  staff:[]
});

function personSelect(options,person,label,attribute,disabled=false){
  const unavailable=person.name&&!options.some(option=>option.id===person.user_id);
  return `<select aria-label="${esc(label)}" ${attribute} ${disabled?'disabled':''}>
    <option value="">— 選択なし —</option>
    ${unavailable?`<option value="unavailable" disabled selected>${esc(person.name)}（選び直してください）</option>`:''}
    ${options.map(({id,label})=>`<option value="${esc(id)}" ${id===person.user_id?'selected':''}>${esc(label)}</option>`).join('')}
  </select>`;
}

function seatTable(seats,options=null,instance=''){
  const editable=options!==null;
  return `<table class="placement-table${editable?' placement-table-edit':''}">
    <thead><tr><th scope="col">卓</th><th scope="col">使用</th><th scope="col">初回の担当</th></tr></thead>
    <tbody>${seats.map((seat,index)=>{
      const number=index+1;
      return `<tr data-seat="${index}" ${seat.in_use?'':'class="seat-unused"'}>
        <th scope="row" class="placement-seat-number seat-tone-${number}"><span class="seat-number">${number}</span></th>
        <td>${editable?`<input type="checkbox" data-seat-used aria-label="${instance}の卓${number} 使用" ${seat.in_use?'checked':''}>`:seat.in_use?'✓':'×'}</td>
        <td>${editable?personSelect(options,seat,`${instance}の卓${number} 初回の担当`,'data-seat-user',!seat.in_use):esc((seat.in_use&&seat.name)||'—')}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function routePath(from,to,reciprocal){
  const start=deskPoints.get(from),end=deskPoints.get(to);
  const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy);
  const crossesDesk=Math.abs(dx)!==120&&Math.abs(dy)!==90&&length>=180;
  const bend=crossesDesk?(from===3&&to===9?-72:72):reciprocal?22:0;
  const control={
    x:Math.max(0,Math.min(360,(start.x+end.x)/2-dy/length*bend)),
    y:Math.max(0,Math.min(270,(start.y+end.y)/2+dx/length*bend))
  };
  function edge(point){
    const x=control.x-point.x,y=control.y-point.y;
    const scale=Math.max(Math.abs(x)/31,Math.abs(y)/23);
    return `${(point.x+x/scale).toFixed(1)} ${(point.y+y/scale).toFixed(1)}`;
  }
  return `M ${edge(start)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${edge(end)}`;
}

function seatMap(seats,instanceIndex){
  const active=rotation.filter(number=>seats[number-1]?.in_use);
  const destinations=new Map(active.length>1?active.map((number,index)=>[number,active[(index+1)%active.length]]):[]);
  const desk=number=>{
    const to=destinations.get(number);
    const className=`placement-map-seat seat-tone-${number}${seats[number-1]?.in_use?'':' seat-unused'}`;
    return to
      ?`<button type="button" class="${className}" data-table-number="${number}" data-destination="${to}" aria-label="卓${number}から卓${to}への移動" aria-pressed="false">${number}</button>`
      :`<span class="${className}" data-table-number="${number}">${number}</span>`;
  };
  const marker=`placement-arrowhead-${instanceIndex}`;
  const hint=destinations.size?'卓を選ぶと、そこから次の卓への矢印が強調されます。':'使用する卓が1つ以下のため、卓間の移動はありません。';
  return `<figure class="placement-figure" data-placement-map>
    <figcaption>卓配置とローテーション</figcaption>
    <div class="placement-orientation"><span>西</span><span>北</span><span>東</span></div>
    <div class="placement-map">
      ${destinations.size?`<svg class="placement-routes" viewBox="0 0 360 270" aria-hidden="true" focusable="false">
        <defs><marker id="${marker}" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 Z" /></marker></defs>
        ${[...destinations].map(([from,to])=>`<path class="placement-route" data-route-from="${from}" d="${routePath(from,to,destinations.get(to)===from)}" marker-end="url(#${marker})" />`).join('')}
      </svg>`:''}
      <div class="placement-desk-grid">${deskRows.flat().map(desk).join('')}</div>
    </div>
    <div class="placement-stage">南（舞台側）</div>
    <p class="placement-map-caption" data-route-hint="${hint}" role="status">${hint}</p>
  </figure>`;
}

function bindPlacementMaps(root){
  for(const map of root.querySelectorAll('[data-placement-map]')){
    const hint=map.querySelector('[data-route-hint]');
    map.addEventListener('click',event=>{
      const button=event.target.closest('[data-destination]');
      if(!button)return;
      const {tableNumber,destination}=button.dataset;
      const selected=button.getAttribute('aria-pressed')!=='true';
      map.classList.toggle('has-selected-route',selected);
      for(const desk of map.querySelectorAll('[data-table-number]')){
        if(desk.hasAttribute('aria-pressed'))desk.setAttribute('aria-pressed',String(selected&&desk===button));
        desk.classList.toggle('is-destination',selected&&desk.dataset.tableNumber===destination);
      }
      for(const path of map.querySelectorAll('[data-route-from]'))path.classList.toggle('is-selected',selected&&path.dataset.routeFrom===tableNumber);
      hint.textContent=selected?`卓${tableNumber} → 卓${destination}`:hint.dataset.routeHint;
    });
  }
}

function staffGroups(staff){
  const groups=placementStaffRoles.map(([role,label])=>({role,label,people:[]}));
  const uncategorized={role:'',label:'担当未分類',people:[]};
  staff.forEach((entry,index)=>{
    const person=typeof entry==='string'?{name:entry}:entry;
    const group=groups.find(item=>item.role===person.role)??uncategorized;
    group.people.push({person,index});
  });
  if(uncategorized.people.length)groups.push(uncategorized);
  return groups;
}

function staffEditor(staff,options,instance){
  return `<div class="placement-staff-editor"><h3>スタッフ</h3>
    ${staffGroups(staff).map(({role,label,people})=>`<section class="placement-role-editor">
      <div class="placement-role-heading">
        <h4>${label}</h4>
        ${role?`<button class="button secondary small" type="button" data-add-staff="${role}" aria-label="${instance}の${label}を追加" ${staff.length>=staffLimit||!options.length?'disabled':''}>追加</button>`:''}
      </div>
      ${people.map(({person,index},position)=>`<div class="placement-staff-row">
        ${personSelect(options,person,`${instance}の${label} ${position+1}`,`data-staff-user="${index}"`)}
        <button class="button secondary small" type="button" data-remove-staff="${index}" aria-label="${instance}の${label} ${position+1} を外す">外す</button>
        ${role?'':`<select data-staff-role="${index}" aria-label="${instance}の担当未分類 ${position+1} の担当">
          <option value="">担当を選択</option>
          ${placementStaffRoles.map(([id,name])=>`<option value="${id}">${name}</option>`).join('')}
        </select>`}
      </div>`).join('')}
    </section>`).join('')}
  </div>`;
}

export function placementCards(instances){
  return instances.map((instance,index)=>`<article class="placement-instance">
    <h3>${instanceName(index)}</h3>
    <div class="placement-layout">
      <div class="placement-seat-list">${seatTable(instance.seats)}</div>
      ${seatMap(instance.seats,index)}
      <div class="placement-staff">
        <h4>スタッフ</h4>
        <dl class="placement-staff-roles">${staffGroups(instance.staff).map(({label,people})=>`<div>
          <dt>${label}</dt>
          <dd>${people.length?`<ul>${people.map(({person})=>`<li>${esc(person.name)}</li>`).join('')}</ul>`:'—'}</dd>
        </div>`).join('')}</dl>
      </div>
    </div>
  </article>`).join('');
}

export function renderStaffPlacement(root,{event,instances},personal){
  root.innerHTML=`<section class="panel"><h2>今回の配置</h2>
    ${event?`<p class="placement-event">${esc(dateLabel(event.starts_at))}　${esc(event.title)}</p>`:''}
    ${placementCards(instances)||empty(event?'全体の配置はまだ公開されていません':'開催中・開催予定の営業はありません')}
    ${personal.length?`<details class="placement-personal"><summary>あなたへの配置の案内</summary>${personal.map(note=>`<article><h3>${esc(note.title)}</h3><p class="preserve">${esc(note.details)}</p></article>`).join('')}</details>`:''}
  </section>`;
  bindPlacementMaps(root);
}

export function renderPlacementEditor(root,{events,onDirty}){
  if(!events.length){
    root.innerHTML=`<section class="panel">${empty('先に「営業情報」から営業回を追加してください')}</section>`;
    return;
  }
  const ordered=[...events].sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
  const current=ordered.find(event=>Date.parse(event.ends_at)>Date.now())??ordered.at(-1);
  root.innerHTML=`<div class="panel">
    ${select('営業回','placement_event',ordered.map(event=>[event.id,`${dateLabel(event.starts_at,false)}　${event.title}`]),current.id)}
    <div data-placement-editor></div>
  </div>`;
  const eventSelect=root.querySelector('[name=placement_event]');
  const editor=root.querySelector('[data-placement-editor]');
  let eventId,plan,dirty=false,request=0;
  function setDirty(value){dirty=value;onDirty(value);}
  async function load(nextEventId){
    const loading=++request;
    eventId=nextEventId;
    editor.innerHTML='<p role="status">配置を読み込んでいます…</p>';
    try{
      const result=await api('/api/manage/placement?event_id='+encodeURIComponent(eventId));
      if(loading!==request||!editor.isConnected)return;
      plan=result;
      draw();
    }catch(error){
      if(loading!==request||!editor.isConnected)return;
      editor.innerHTML=`<p class="notice error">${esc(error.message)}</p><button class="button secondary small" type="button" data-retry>読み込み直す</button>`;
      editor.querySelector('[data-retry]').onclick=()=>load(eventId);
    }
  }
  function draw(){
    const nameCounts=new Map();
    for(const {name} of plan.attendees)nameCounts.set(name,(nameCounts.get(name)||0)+1);
    const options=plan.attendees.map(person=>({...person,label:nameCounts.get(person.name)>1?`${person.name}（ID末尾 ${person.id.slice(-6)}）`:person.name}));
    editor.innerHTML=`<form>
      <div class="placement-roster">
        <p class="quiet">${options.length?`この営業回に「参加」と回答した ${options.length} 人から選べます。`:'この営業回に「参加」と回答した人はまだいません。'}</p>
        <button class="button secondary small" type="button" data-refresh-attendees>参加者を更新</button>
      </div>
      <div data-placement-instances>${plan.instances.map((instance,index)=>`<section class="placement-edit-instance" data-instance="${index}">
        <div class="placement-edit-title"><h2>${instanceName(index)}</h2><button class="button secondary small" type="button" data-remove-instance>取り除く</button></div>
        <div class="placement-edit-layout">${seatTable(instance.seats,options,instanceName(index))}
          ${staffEditor(instance.staff,options,instanceName(index))}
        </div>
      </section>`).join('')||empty('インスタンスを追加して席とスタッフを入力してください')}</div>
      <div class="placement-edit-actions">
        <button class="button secondary small" type="button" data-add-instance ${plan.instances.length>=instanceLimit?'disabled':''}>インスタンスを追加</button>
        <button class="button secondary small" type="button" data-preview ${plan.instances.length?'':'disabled'}>表示を確認</button>
      </div>
      <div class="placement-preview" data-placement-preview hidden></div>
      <div class="placement-publish">
        ${plan.event_published?'':'<p class="quiet">この営業回を「営業情報」で公開すると、公開設定が有効になります。</p>'}
        <label class="check-row"><input type="checkbox" name="published" ${plan.published?'checked':''}>キャスト・スタッフページに公開する</label>
        <div class="form-actions"><button class="button" type="submit">配置を保存する</button></div>
      </div>
    </form>`;
    const form=editor.querySelector('form');
    const preview=form.querySelector('[data-placement-preview]');
    const previewButton=form.querySelector('[data-preview]');
    function showPreview(){
      preview.innerHTML=placementCards(plan.instances.map(instance=>({...instance,staff:instance.staff.filter(person=>person.name)})));
      bindPlacementMaps(preview);
    }
    const optionNames=new Map(options.map(person=>[person.id,person.name]));
    const selectedPerson=id=>({user_id:id,name:optionNames.get(id)||''});
    form.onchange=event=>{
      const input=event.target;
      const instance=input.closest('[data-instance]');
      if(input.name==='published')plan.published=input.checked;
      else if(input.hasAttribute('data-staff-user')){
        Object.assign(plan.instances[instance.dataset.instance].staff[input.dataset.staffUser],selectedPerson(input.value));
      }else if(input.hasAttribute('data-staff-role')){
        if(!input.value)return;
        const {instance:index}=instance.dataset;
        plan.instances[index].staff[input.dataset.staffRole].role=input.value;
        setDirty(true);draw();
        editor.querySelector(`[data-instance="${index}"] [data-staff-user="${input.dataset.staffRole}"]`).focus();
        return;
      }
      else if(input.hasAttribute('data-seat-used')||input.hasAttribute('data-seat-user')){
        const row=input.closest('[data-seat]'),seat=plan.instances[instance.dataset.instance].seats[row.dataset.seat];
        if(input.type==='checkbox'){
          seat.in_use=input.checked;
          row.querySelector('[data-seat-user]').disabled=!seat.in_use;
        }else Object.assign(seat,selectedPerson(input.value));
        row.classList.toggle('seat-unused',!seat.in_use);
      }else return;
      setDirty(true);
      if(!preview.hidden)showPreview();
    };
    const refreshAttendees=form.querySelector('[data-refresh-attendees]');
    refreshAttendees.onclick=()=>submit(refreshAttendees,async()=>{
      const fresh=await api('/api/manage/placement?event_id='+encodeURIComponent(eventId));
      if(!form.isConnected)return;
      plan.attendees=fresh.attendees;
      draw();
      editor.querySelector('[data-refresh-attendees]').focus();
      toast('参加者を更新しました');
    });
    form.querySelector('[data-add-instance]').onclick=()=>{
      plan.instances.push(newInstance());setDirty(true);draw();
      editor.querySelector(`[data-instance="${plan.instances.length-1}"] [data-seat-user]`).focus();
    };
    form.querySelectorAll('[data-add-staff]').forEach(button=>button.onclick=()=>{
      const index=button.closest('[data-instance]').dataset.instance;
      const number=plan.instances[index].staff.push({...noAssignee(),role:button.dataset.addStaff})-1;
      setDirty(true);draw();
      editor.querySelector(`[data-instance="${index}"] [data-staff-user="${number}"]`).focus();
    });
    form.querySelectorAll('[data-remove-staff]').forEach(button=>button.onclick=()=>{
      const index=button.closest('[data-instance]').dataset.instance;
      const [removed]=plan.instances[index].staff.splice(Number(button.dataset.removeStaff),1);
      setDirty(true);draw();
      const section=editor.querySelector(`[data-instance="${index}"]`);
      const addButtons=[...section.querySelectorAll('[data-add-staff]')];
      (addButtons.find(button=>button.dataset.addStaff===removed.role)??addButtons[0]).focus();
    });
    form.querySelectorAll('[data-remove-instance]').forEach(button=>button.onclick=()=>{
      const index=Number(button.closest('[data-instance]').dataset.instance);
      if(!confirm(`${instanceName(index)}を配置から取り除きますか？`))return;
      plan.instances.splice(index,1);setDirty(true);draw();editor.querySelector('[data-add-instance]').focus();
    });
    previewButton.onclick=()=>{
      preview.hidden=!preview.hidden;
      previewButton.textContent=preview.hidden?'表示を確認':'表示を閉じる';
      if(!preview.hidden)showPreview();
    };
    form.onsubmit=event=>{
      event.preventDefault();
      submit(event.submitter,async()=>{
        const instances=plan.instances.map(instance=>({...instance,staff:instance.staff.filter(person=>person.user_id||person.name)}));
        const fields=[eventSelect,...form.querySelectorAll('input,select,button:not([type=submit])')];
        const previous=fields.map(node=>node.disabled);
        fields.forEach(node=>node.disabled=true);
        try{
          const saved=await api('/api/manage/placement',{method:'POST',body:{event_id:eventId,instances,published:plan.published,revision:plan.revision}});
          if(!editor.isConnected)return;
          plan={...plan,...saved};
          setDirty(false);
          draw();
          toast(plan.published&&plan.event_published?'配置を公開しました':'配置を保存しました');
        }finally{fields.forEach((node,index)=>node.disabled=previous[index]);}
      });
    };
  }
  eventSelect.onchange=()=>{
    if(dirty&&!confirm('変更を保存せずに営業回を切り替えますか？')){
      eventSelect.value=eventId;
      return;
    }
    setDirty(false);
    void load(eventSelect.value);
  };
  void load(eventSelect.value);
}
