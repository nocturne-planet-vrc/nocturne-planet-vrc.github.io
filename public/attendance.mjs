import {api,dateLabel,empty,esc,field,localDateTime,textarea,toast} from './ui.mjs';
import {attendanceTimes,jstTime} from './schedule.mjs';

const answers=[['yes','○','参加'],['maybe','△','未定'],['no','×','欠席']];
const weekday=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',weekday:'long'});
const timeFields=['available_from','available_until'];
const isOpen=(event,now)=>Date.parse(event.ends_at)>=now&&(!event.response_deadline||Date.parse(event.response_deadline)>=now);

function detailsMarkup(answer,open,duties){
  if(!open){
    if(!answer)return '';
    const {available_from:from,available_until:until,note}=answer;
    return `<details class="attendance-details"><summary>回答の詳細</summary><dl class="attendance-readonly">
      <div><dt>参加可能時間</dt><dd>${from||until?`${esc(from||'—')}〜${esc(until||'—')}`:'未入力'}</dd></div>
      <div><dt>対応できる担当</dt><dd>${esc(JSON.parse(answer.duties).join('・')||'未選択')}</dd></div>
      <div><dt>運営への連絡</dt><dd class="preserve">${esc(note||'未入力')}</dd></div>
    </dl></details>`;
  }
  const available=duties.filter(duty=>duty.available);
  return `<details class="attendance-details"><summary>回答の詳細</summary>
    <form class="attendance-form">
      <fieldset class="form-section"><legend>参加可能時間（日本時間）</legend><div class="field-pair">
        ${field('参加できる時刻','available_from','','time')}${field('退出予定の時刻','available_until','','time')}
      </div></fieldset>
      <fieldset class="form-section"><legend>対応できる担当</legend>
        ${available.length?`<div class="duty-checks">${available.map(duty=>`<label class="check-row"><input type="checkbox" name="duties" value="${esc(duty.name)}"><span>${esc(duty.name)}</span></label>`).join('')}</div>`:'<p class="quiet">選べる担当がありません。担当の追加は運営へ連絡してください。</p>'}
        <p class="attendance-role-note quiet" hidden></p>
      </fieldset>
      ${textarea('運営への連絡（任意）','note','','maxlength="1000"')}
      <div class="form-actions"><p class="quiet" data-attendance-prompt>先に日程の出欠を選んでください。</p><p class="attendance-feedback" role="status"></p><button class="button small" type="submit">詳細を保存する</button></div>
    </form></details>`;
}

function attendanceRow(event,answer,open,duties){
  const start=localDateTime(event.starts_at),end=localDateTime(event.ends_at);
  const monthDay=`${Number(start.slice(5,7))}/${Number(start.slice(8,10))}`;
  const endDate=start.slice(0,10)===end.slice(0,10)?'':`${dateLabel(event.ends_at,false)} `;
  const saved=answers.find(([value])=>value===answer?.answer);
  return `<li class="attendance-row" data-event-id="${esc(event.id)}">
    <div class="attendance-row-top">
      <div class="attendance-date"><time datetime="${esc(event.starts_at)}"><strong>${monthDay}</strong><span>${weekday.format(new Date(event.starts_at))}</span></time></div>
      <div class="attendance-event-info">
        <div class="attendance-state" data-attendance-state>${open?'':`<span class="attendance-badge">受付終了</span> <span>${saved?`回答済み · ${saved[2]}`:'未回答'}</span>`}</div>
        <h3 id="attendance-title-${esc(event.id)}">${esc(event.title)}</h3>
        <p class="attendance-hours">${jstTime(event.starts_at)}〜${esc(endDate)}${jstTime(event.ends_at)}</p>
        <p class="attendance-deadline">${event.response_deadline?`回答期限 ${esc(dateLabel(event.response_deadline))}`:'回答期限の設定なし'}</p>
      </div>
      ${open?`<div class="attendance-choices" role="group" aria-labelledby="attendance-title-${esc(event.id)}">
        ${answers.map(([value,symbol,label])=>`<button type="button" data-attendance-answer="${value}" aria-pressed="false"><span aria-hidden="true">${symbol}</span>${label}</button>`).join('')}
      </div>`:''}
    </div>
    <p class="attendance-feedback" role="status"></p>
    ${detailsMarkup(answer,open,duties)}
  </li>`;
}

export function createAttendanceView({events,attendance,duty_options:duties=[]},regularHours){
  const view=document.createElement('section');
  view.className='attendance-panel';
  view.setAttribute('aria-labelledby','attendance-heading');
  const now=Date.now();
  const answersByEvent=new Map(attendance.map(answer=>[answer.event_id,answer]));
  const openEvents=events.filter(event=>isOpen(event,now));
  const closedEvents=events.filter(event=>!isOpen(event,now));
  view.innerHTML=`<div class="panel attendance-overview">
    <h2 id="attendance-heading">出欠・シフト</h2>
    <p class="attendance-count">未回答 <strong></strong> 件</p>
    <p class="quiet">日程ごとに出欠を選ぶと、その場で保存されます。時刻は日本時間です。</p>
  </div>${events.length?`<div class="attendance-filter" role="group" aria-label="営業日程の絞り込み">
    <button class="button secondary small" type="button" aria-pressed="true" data-attendance-filter="all">すべて</button>
    <button class="button secondary small" type="button" aria-pressed="false" data-attendance-filter="pending">未回答のみ</button>
  </div><ul class="attendance-list" aria-label="営業日程">
    ${openEvents.map(event=>attendanceRow(event,answersByEvent.get(event.id),true,duties)).join('')}
    ${closedEvents.map(event=>attendanceRow(event,answersByEvent.get(event.id),false,duties)).join('')}
  </ul><div class="panel attendance-empty" hidden>${empty('回答受付中の未回答の日程はありません')}</div>`:`<div class="panel">${empty('表示できる営業日程はありません')}</div>`}`;

  const filters=[...view.querySelectorAll('[data-attendance-filter]')];
  const rows=[...view.querySelectorAll('.attendance-row')];
  const count=view.querySelector('.attendance-count strong');
  let pendingOnly=false;
  function updateFilter(){
    const timestamp=Date.now();
    const pending=new Set(openEvents.filter(event=>isOpen(event,timestamp)&&!answersByEvent.has(event.id)).map(event=>event.id));
    count.textContent=pending.size;
    rows.forEach(row=>{row.hidden=pendingOnly&&!pending.has(row.dataset.eventId);});
    if(filters.length)view.querySelector('.attendance-empty').hidden=!pendingOnly||pending.size>0;
    filters.forEach(button=>button.setAttribute('aria-pressed',String((button.dataset.attendanceFilter==='pending')===pendingOnly)));
  }
  filters.forEach(button=>button.addEventListener('click',()=>{pendingOnly=button.dataset.attendanceFilter==='pending';updateFilter();}));
  openEvents.forEach((event,index)=>{
    const row=rows[index];
    bindOpenRow(row,event,answersByEvent.get(event.id),regularHours,saved=>{
      answersByEvent.set(event.id,saved);
      const focusInRow=row.contains(document.activeElement);
      updateFilter();
      if(row.hidden&&view.isConnected){
        if(focusInRow)filters.find(button=>button.dataset.attendanceFilter==='pending').focus();
        toast('回答を保存しました');
      }
    });
  });
  updateFilter();
  return view;
}

function bindOpenRow(row,event,answer,regularHours,onSave){
  const form=row.querySelector('form');
  const buttons=[...row.querySelectorAll('[data-attendance-answer]')];
  const saveDetails=form.querySelector('[type=submit]');
  const quickFeedback=row.querySelector('.attendance-feedback');
  const detailsFeedback=form.querySelector('.attendance-feedback');
  const state=row.querySelector('[data-attendance-state]');
  const dutyBoxes=[...form.querySelectorAll('[name=duties]')];
  let saving=false,draft=false,revision=0;

  function fillForm(){
    const times=attendanceTimes(answer,event,regularHours);
    for(const key of timeFields)form.elements[key].value=times[key];
    form.elements.note.value=answer?.note||'';
    const previous=JSON.parse(answer?.duties||'[]');
    for(const box of dutyBoxes)box.checked=previous.includes(box.value);
    const unavailable=previous.filter(name=>!dutyBoxes.some(box=>box.value===name));
    const roleNote=form.querySelector('.attendance-role-note');
    roleNote.hidden=!unavailable.length;
    roleNote.textContent=unavailable.length?`現在のロールで選べない担当（${unavailable.join('・')}）は、詳細を保存すると回答から外れます。`:'';
  }

  function updateControls(){
    state.innerHTML=answer?'<span class="attendance-badge is-answered">回答済み</span>':'<span class="attendance-badge is-pending">未回答</span>';
    form.querySelector('[data-attendance-prompt]').hidden=Boolean(answer);
    saveDetails.setAttribute('aria-disabled',String(saving||!answer));
    for(const button of buttons){
      button.setAttribute('aria-pressed',String(button.dataset.attendanceAnswer===answer?.answer));
      button.setAttribute('aria-disabled',String(saving));
    }
  }

  async function save(body,isDetails){
    saving=true;
    const beforeSave=revision;
    const feedback=isDetails?detailsFeedback:quickFeedback;
    quickFeedback.textContent='';
    detailsFeedback.textContent='';
    updateControls();
    feedback.classList.remove('is-error');
    feedback.textContent='保存中…';
    try{
      const result=await api('/api/staff/attendance',{method:'POST',body:{event_id:event.id,...body}});
      answer=result.attendance;
      if(isDetails&&revision===beforeSave)draft=false;
      if(!draft)fillForm();
      feedback.textContent=isDetails?'詳細を保存しました':'回答を保存しました';
      onSave(answer);
    }catch(error){
      feedback.classList.add('is-error');
      feedback.textContent=error.message;
    }finally{
      saving=false;
      updateControls();
    }
  }

  for(const button of buttons)button.addEventListener('click',()=>{
    const value=button.dataset.attendanceAnswer;
    if(!saving&&value!==answer?.answer)void save({answer:value,status_only:true},false);
  });
  form.addEventListener('input',()=>{draft=true;revision++;});
  form.addEventListener('submit',event=>{
    event.preventDefault();
    if(saving||!answer)return;
    const fields=new FormData(form);
    void save({...Object.fromEntries(fields),duties:fields.getAll('duties'),answer:answer.answer},true);
  });
  fillForm();
  updateControls();
}
