import {api,esc,dateLabel,field,submit,toast,setSession} from './ui.mjs';
const syncTimers=new WeakMap();
const renderVersions=new WeakMap();

export function renderVrchat(root,status={configured:false,linked:null,challenge:null},area,onChange=()=>{}){
  clearTimeout(syncTimers.get(root));
  const version={};renderVersions.set(root,version);
  if(status.session)setSession(status.session);
  onChange(status);
  const linked=status.linked,challenge=status.challenge;
  root.innerHTML=`<h2>VRChatアカウント</h2>${linked?`<div class="vrchat-linked"><strong>${esc(linked.display_name)}</strong><span class="quiet">本人確認済み</span><a class="text-link" href="${esc(linked.profile_url)}" target="_blank" rel="noopener noreferrer">VRChatプロフィールを開く</a><p class="quiet">確認日：${esc(dateLabel(linked.verified_at,false))}</p><button class="text-button" type="button" id="vrchat-unlink">連携を解除する</button></div>`:'<p class="quiet">確認コードをVRChatの自己紹介に載せて、本人のアカウントであることを確認します。</p>'}${!status.configured?'<p class="notice">自動本人確認は準備中です。利用できるようになり次第、お知らせします。</p>':`<form id="vrchat-start">${field(linked?'連携先を変更する場合のプロフィールURL':'VRChatプロフィールURL','profile_url',challenge?.profile_url||'','url','required maxlength="300" placeholder="https://vrchat.com/home/user/usr_…"')}<button class="button secondary small" type="submit">${challenge?'コードを発行し直す':'確認コードを発行する'}</button></form>${challenge?`<div class="vrchat-challenge"><ol><li>次の確認コードだけを、VRChatの自己紹介に1行で貼って保存してください。</li><li>このページに戻り「確認する」を押してください。</li></ol>${field('確認コード','vrchat_code',challenge.code,'text','readonly class="vrchat-code"')}<p class="quiet">有効期限：${esc(dateLabel(challenge.expires_at))}（発行から30分）</p><div class="actions"><a class="text-link" href="${esc(challenge.profile_url)}" target="_blank" rel="noopener noreferrer">VRChatプロフィールを開く</a><button class="button small" type="button" id="vrchat-verify">確認する</button></div><p class="quiet">変更の反映に時間がかかる場合があります。再確認は30秒ほど待ってください。確認が終われば、自己紹介からコードを削除できます。</p></div>`:''}`}`;
  if(area==='member'){
    const explanation=document.createElement('p');explanation.className='quiet';
    explanation.textContent='連携後は会員ページにVRChat名を表示し、お客様用Discordサーバーのニックネームも同じ名前に更新します。';
    root.querySelector('h2').after(explanation);
    if(linked){
      const sync=document.createElement('div');sync.className='vrchat-nickname';
      sync.innerHTML=`<p class="${status.nickname?.status==='synced'?'quiet':'notice'}" role="status">${esc(status.nickname?.message||'お客様用Discordサーバーのニックネームは自動で同期します。')}</p><p class="quiet">Discord側の名前は32文字までです。連携を解除しても、Discordのニックネームは元に戻りません。</p>`;
      root.querySelector('.vrchat-linked').after(sync);
    }
  }
  const action=(name,body={})=>api(`/api/${area}/vrchat/${name}`,{method:'POST',body});
  if(area==='member'&&linked&&status.nickname?.status!=='synced'){
    const retry=async()=>{
      if(!root.isConnected)return;
      if(document.hidden){syncTimers.set(root,setTimeout(retry,30000));return;}
      try{const fresh=await action('sync-name');if(root.isConnected&&renderVersions.get(root)===version)renderVrchat(root,fresh,area,onChange);}
      catch{if(root.isConnected&&renderVersions.get(root)===version)renderVrchat(root,{...status,nickname:{status:'failed',message:'Discordの名前は時間を置いて自動で同期します。',retry_after:Math.floor(Date.now()/1000)+300}},area,onChange);}
    };
    const delay=Math.max(1000,((status.nickname?.retry_after||Math.floor(Date.now()/1000)+300)*1000-Date.now())+1000);
    syncTimers.set(root,setTimeout(retry,delay));
  }
  const start=root.querySelector('#vrchat-start');
  if(start)start.onsubmit=event=>{event.preventDefault();submit(event.submitter,async()=>{const fresh=await action('start',Object.fromEntries(new FormData(start)));renderVrchat(root,fresh,area,onChange);toast('確認コードを発行しました');});};
  const verify=root.querySelector('#vrchat-verify');
  if(verify)verify.onclick=()=>submit(verify,async()=>{const fresh=await action('verify');renderVrchat(root,fresh,area,onChange);toast('VRChatアカウントを連携しました。自己紹介からコードを削除できます。');});
  const unlink=root.querySelector('#vrchat-unlink');
  if(unlink)unlink.onclick=()=>{if(!confirm('VRChatアカウントの連携を解除します。来店記録やチェキは残ります。よろしいですか？'))return;submit(unlink,async()=>{const fresh=await action('unlink');renderVrchat(root,fresh,area,onChange);toast('VRChatアカウントの連携を解除しました');});};
}
