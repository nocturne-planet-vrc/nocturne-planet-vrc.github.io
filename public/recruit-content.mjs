import {esc} from './ui.mjs';
import {siteImageSrc} from './site-content.mjs';

export const blockTypes={cards:'紹介カード',requirements:'募集要項（項目と内容）',steps:'ステップ・流れ',text:'文章'};
export const recruitDefaults={
  label:'キャスト・スタッフ募集',title:'一緒にイベントを\n盛り上げませんか？',
  lead:'星空を眺めて、話して、歌声に耳を傾ける。\nNocturne Planet（のくぷら）は、VRChatのプラネタリウムイベントです。\n\nお客様と過ごす時間をつくるキャストも、その時間を支えるスタッフも。\nあなたの好きなことや得意なことで、イベントに関わってみませんか？',
  image:'/assets/world/seating.webp',image_side:'right',
  sections:[
    {id:'work',type:'cards',title:'のくぷらで関われること',body:'',enabled:true,columns:2,tone:'paper',items:[
      {title:'キャスト',body:'星空の下でお客様をお迎えし、会話や解説、歌声を通して、一緒に過ごす時間をつくる役割です。\n\n・お客様との会話・テーブルでの接客\n・星空解説\n・歌パフォーマンス\n・ほかのキャストやスタッフとの連携'},
      {title:'スタッフ',body:'会場の案内や演出、制作など、それぞれの担当からイベントを支えます。興味のある分野を教えてください。\n\n・当日の案内・運営サポート・バーでのドリンク作成\n・音響（PA）・照明\n・撮影\n・動画編集（公式YouTubeチャンネル等）'}
    ]},
    {id:'requirements',type:'requirements',title:'募集要項',body:'キャスト・スタッフともに、次の条件で募集しています。',enabled:true,columns:1,tone:'cream',items:[
      {title:'募集対象',body:'女性キャスト\n会場スタッフ（バー担当・ご案内係）\n技術スタッフ（撮影・PA・照明・動画編集等）'},
      {title:'開催予定',body:'第1・第3土曜日 21:30〜'},
      {title:'年齢',body:'年齢不問'},
      {title:'参加環境（必須）',body:'VR環境（PC接続・単体型いずれも可）\nボイスチャット（VC）での参加'},
      {title:'優遇する環境',body:'PCVR・フルトラッキング'},
      {title:'参加頻度',body:'月1回以上の参加'},
      {title:'経験',body:'経験不問。初心者の方にも研修でしっかりお教えします。'},
      {title:'情報の取り扱い',body:'面接や活動時に知り得た情報、およびダウンロード可能なデータを外部へ流出させないこと。'},
      {title:'連絡・相談',body:'報告・連絡・相談をしっかりと行えること。'}
    ]},
    {id:'flow',type:'steps',title:'応募から参加まで',body:'',enabled:true,columns:1,tone:'paper',items:[
      {title:'応募フォームを送信',body:'募集要項をご確認のうえ、希望の担当や参加しやすい時間帯をフォームからお送りください。'},
      {title:'運営が内容を確認・ご連絡',body:'ご記入のXまたはDiscordアカウントへ運営からご連絡します。公式XからのDMを受け取れる設定をお願いします。'},
      {title:'活動内容をご案内',body:'担当ごとの詳しい活動内容や、参加までの流れをご案内します。'}
    ]}
  ],
  contact:{title:'応募フォームからご連絡ください',body:'希望の担当や参加しやすい時間帯を教えてください。詳しい活動内容や参加までの流れは、運営からXまたはDiscordでご案内します。\n\n現在ほかのイベントに所属している方は、イベント名と開催日時もお知らせください。公式XからのDMを受け取れる設定をお願いします。',items:['VRChatでのお名前・プロフィールURL（必須）','VRChat用のメインXアカウントURL（必須）','連絡先となるDiscordのユーザー名（必須）','興味のある担当・参加しやすい曜日や時間帯'],button_label:'キャスト・スタッフ応募フォームへ'}
};
export function recruitContent(settings={}){
  return structuredClone(settings.recruit_page||recruitDefaults);
}
const paragraphs=value=>String(value||'').split(/\n\s*\n/).filter(Boolean).map(p=>{
  const lines=p.split('\n');
  return lines.every(line=>/^[・-]\s*/.test(line))?`<ul class="recruit-copy-list">${lines.map(line=>`<li>${esc(line.replace(/^[・-]\s*/,''))}</li>`).join('')}</ul>`:`<p class="preserve">${esc(p)}</p>`;
}).join('');
function contactUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function renderRecruitPage(page,url='',prefix=''){
  const sections=page.sections.filter(s=>s.enabled),contact=prefix+'contact',apply=contactUrl(url);
  return `<div class="wrap"><a class="text-link recruit-breadcrumb" href="/">ホームへ戻る</a><section class="recruit-hero image-${esc(page.image_side)}" aria-labelledby="${prefix}recruit-heading"><div><p class="recruit-label">${esc(page.label)}</p><h1 id="${prefix}recruit-heading" class="preserve">${esc(page.title)}</h1>${paragraphs(page.lead)}<a class="button pill" href="#${contact}">応募について見る</a></div><img src="${esc(siteImageSrc(page.image))}" alt="Nocturne Planetの星空ドーム" width="1920" height="1080" fetchpriority="high"></section>${sections.length?`<nav class="recruit-contents" aria-label="このページの内容">${sections.map(s=>`<a href="#${prefix}${esc(s.id)}">${esc(s.title)}</a>`).join('')}</nav>`:''}</div>
  ${sections.map(s=>`<section id="${prefix}${esc(s.id)}" class="recruit-block tone-${esc(s.tone)}" aria-labelledby="${prefix}${esc(s.id)}-heading"><div class="wrap"><h2 id="${prefix}${esc(s.id)}-heading" class="recruit-section-heading">${esc(s.title)}</h2>${s.body?`<div class="recruit-block-intro">${paragraphs(s.body)}</div>`:''}${s.type==='cards'?`<div class="recruit-role-grid columns-${esc(s.columns)}">${s.items.map(item=>`<article class="recruit-role"><h3>${esc(item.title)}</h3>${paragraphs(item.body)}</article>`).join('')}</div>`:s.type==='requirements'?`<dl class="recruit-requirements">${s.items.map(item=>`<div><dt>${esc(item.title)}</dt><dd>${paragraphs(item.body)}</dd></div>`).join('')}</dl>`:s.type==='steps'?`<ol class="recruit-steps columns-${esc(s.columns)}">${s.items.map((item,i)=>`<li><span class="recruit-step-no" aria-hidden="true">${String(i+1).padStart(2,'0')}</span><div><h3>${esc(item.title)}</h3>${paragraphs(item.body)}</div></li>`).join('')}</ol>`:''}</div></section>`).join('')}
  <section id="${contact}" class="recruit-contact" aria-labelledby="${prefix}contact-heading"><div class="wrap"><div class="recruit-contact-panel"><h2 id="${prefix}contact-heading">${esc(page.contact.title)}</h2>${paragraphs(page.contact.body)}${page.contact.items.length?`<ul>${page.contact.items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:''}${apply?`<a class="button pill" href="${esc(apply)}" target="_blank" rel="noopener noreferrer">${esc(page.contact.button_label)} <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg></a><p class="quiet">Googleフォームが別のタブで開きます。</p>`:'<p role="status">応募フォームは準備中です。受付開始までしばらくお待ちください。</p>'}</div></div></section>`;
}
