import {api,esc,dateLabel,field,submit,toast} from './ui.mjs';

export function renderVrchat(root,status={configured:false,linked:null,challenge:null},area,onChange=()=>{}){
  onChange(status);
  const linked=status.linked,challenge=status.challenge;
  root.innerHTML=`<h2>VRChatアカウント</h2>${linked?`<div class="vrchat-linked"><strong>${esc(linked.display_name)}</strong><span class="quiet">本人確認済み</span><a class="text-link" href="${esc(linked.profile_url)}" target="_blank" rel="noopener noreferrer">VRChatプロフィールを開く</a><p class="quiet">確認日：${esc(dateLabel(linked.verified_at,false))}</p><button class="text-button" type="button" id="vrchat-unlink">連携を解除する</button></div>`:'<p class="quiet">確認コードをVRChatの自己紹介に載せて、本人のアカウントであることを確認します。</p>'}${!status.configured?'<p class="notice">自動本人確認は準備中です。利用できるようになり次第、お知らせします。</p>':`<form id="vrchat-start">${field(linked?'連携先を変更する場合のプロフィールURL':'VRChatプロフィールURL','profile_url',challenge?.profile_url||'','url','required maxlength="300" placeholder="https://vrchat.com/home/user/usr_…"')}<button class="button secondary small" type="submit">${challenge?'コードを発行し直す':'確認コードを発行する'}</button></form>${challenge?`<div class="vrchat-challenge"><ol><li>次の確認コードだけを、VRChatの自己紹介に1行で貼って保存してください。</li><li>このページに戻り「確認する」を押してください。</li></ol>${field('確認コード','vrchat_code',challenge.code,'text','readonly class="vrchat-code"')}<p class="quiet">有効期限：${esc(dateLabel(challenge.expires_at))}（発行から30分）</p><div class="actions"><a class="text-link" href="${esc(challenge.profile_url)}" target="_blank" rel="noopener noreferrer">VRChatプロフィールを開く</a><button class="button small" type="button" id="vrchat-verify">確認する</button></div><p class="quiet">変更の反映に時間がかかる場合があります。再確認は30秒ほど待ってください。確認が終われば、自己紹介からコードを削除できます。</p></div>`:''}`}`;
  const action=(name,body={})=>api(`/api/${area}/vrchat/${name}`,{method:'POST',body});
  const start=root.querySelector('#vrchat-start');
  if(start)start.onsubmit=event=>{event.preventDefault();submit(event.submitter,async()=>{const fresh=await action('start',Object.fromEntries(new FormData(start)));renderVrchat(root,fresh,area,onChange);toast('確認コードを発行しました');});};
  const verify=root.querySelector('#vrchat-verify');
  if(verify)verify.onclick=()=>submit(verify,async()=>{const fresh=await action('verify');renderVrchat(root,fresh,area,onChange);toast('VRChatアカウントを連携しました。自己紹介からコードを削除できます。');});
  const unlink=root.querySelector('#vrchat-unlink');
  if(unlink)unlink.onclick=()=>{if(!confirm('VRChatアカウントの連携を解除します。来店記録やチェキは残ります。よろしいですか？'))return;submit(unlink,async()=>{await action('unlink');renderVrchat(root,{configured:status.configured,linked:null,challenge:null},area,onChange);toast('VRChatアカウントの連携を解除しました');});};
}
