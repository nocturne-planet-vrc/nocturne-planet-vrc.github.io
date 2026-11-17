import {esc,safeLink,dateLabel,markdown,api} from './ui.mjs';
import {regularHoursLabel,jstTime} from './schedule.mjs';
import {castCard,castProfile} from './casts.mjs';

const menu=document.getElementById('menu-toggle');
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));document.getElementById('site-menu').classList.toggle('open',open);});
document.querySelectorAll('#site-menu a').forEach(link=>link.addEventListener('click',()=>{menu.setAttribute('aria-expanded','false');document.getElementById('site-menu').classList.remove('open');}));
const icons={home:'<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>'};
document.querySelectorAll('[data-icon]').forEach(node=>node.insertAdjacentHTML('afterbegin',`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">${icons[node.dataset.icon]}</svg>`));
const dialog=document.getElementById('cast-dialog');dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});

const arrowRight='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const arrowUpRight='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>';

let data;
try {data=await api('/api/public');}
catch {data={settings:{x_url:'https://x.com/NoctuPla_VRC'},events:[],casts:[],content:[]};}
const settings=data.settings;
if(settings.x_url){const link=document.getElementById('official-x');link.href=safeLink(settings.x_url);link.children[1].textContent=new URL(link.href).pathname.slice(1)?'@'+new URL(link.href).pathname.slice(1):'公式X';document.querySelector('.site-header [aria-label="公式X"]').href=link.href;}
if(settings.about)document.getElementById('about-text').textContent=settings.about;
if(settings.cadence)document.getElementById('about-cadence').textContent=settings.cadence;
if(settings.regular_hours){
  const label=regularHoursLabel(settings.regular_hours),regular=document.getElementById('regular-hours');
  regular.textContent='通常営業：'+label;regular.hidden=false;
  const fact=document.getElementById('about-cadence');fact.textContent=label;fact.previousElementSibling.textContent='通常営業';
}
if(settings.admission)document.getElementById('admission').textContent=settings.admission;
if(settings.hero_image){
  const hero=document.getElementById('hero-logo');
  hero.src='/api/images/'+encodeURIComponent(settings.hero_image);
  hero.alt='Nocturne Planet イベント画像';
  hero.classList.add('event-visual');
  hero.closest('.hero-stage')?.classList.add('has-image');
}
const upcoming=data.events.filter(event=>Date.parse(event.ends_at)>=Date.now()).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at));
if(upcoming[0]){
  const next=upcoming[0];
  document.getElementById('next-strip').textContent=`${dateLabel(next.starts_at)} ／ ${next.title}`;
  document.getElementById('event-area').innerHTML=`<div class="event-main"><span class="event-category">${esc(next.category||'通常営業')}</span><h3>${esc(dateLabel(next.starts_at))}</h3><p class="event-title">${esc(next.title)}</p><p class="preserve">${esc(next.description)}</p>${settings.vrchat_group_url?`<a class="text-link" href="${esc(safeLink(settings.vrchat_group_url))}" target="_blank" rel="noopener noreferrer"><span>VRChatグループへ</span>${arrowUpRight}</a>`:''}</div><dl class="event-meta"><div><dt>終了予定</dt><dd>${esc(dateLabel(next.ends_at))}</dd></div><div><dt>入場方法</dt><dd>${esc(settings.admission||'Group+・先着順')}</dd></div><div class="event-cta"><a class="button secondary pill small" href="/member">会員ページでチェックイン</a></div></dl>`;
}
if(data.casts.length){
  document.getElementById('cast-list').innerHTML=data.casts.map(castCard).join('');
  document.querySelectorAll('[data-cast]').forEach(button=>button.addEventListener('click',()=>{
    const cast=data.casts.find(c=>c.id===button.dataset.cast);
    document.getElementById('cast-dialog-body').innerHTML=castProfile(cast);
    dialog.showModal();
  }));
}
const news=data.content.filter(post=>post.kind==='news');
if(news.length)document.getElementById('news-list').innerHTML=news.slice(0,8).map(post=>`<a class="news-row" href="/news/${esc(post.slug)}"><time>${esc(dateLabel(post.published_at,false))}</time><span>${esc(post.title)}</span>${arrowRight}</a>`).join('');
document.getElementById('footer-pages').innerHTML=data.content.filter(post=>post.kind==='page').map(post=>`<a href="/pages/${esc(post.slug)}">${esc(post.title)}</a>`).join('');
if(settings.youtube_url){document.querySelector('.site-header [aria-label="公式YouTube"]').href=safeLink(settings.youtube_url);document.getElementById('youtube-link').innerHTML=`<a class="social-row" href="${esc(safeLink(settings.youtube_url))}" target="_blank" rel="noopener noreferrer"><span class="social-badge youtube" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="5" fill="currentColor"/><path d="m10 8 7 4-7 4z" fill="#fff"/></svg></span><span>YouTube 公式チャンネル</span>${arrowUpRight}</a>`;}
if(/^[a-zA-Z0-9_-]{11}$/.test(settings.youtube_video||'')){
  const video=document.getElementById('video-area');video.innerHTML='<button class="video-play"><span class="play-circle" aria-hidden="true">▶</span><span>YouTube動画を再生</span></button>';
  video.querySelector('button').addEventListener('click',()=>{const iframe=document.createElement('iframe');iframe.src=`https://www.youtube-nocookie.com/embed/${settings.youtube_video}?autoplay=1`;iframe.title='Nocturne Planet 公式YouTube';iframe.allow='autoplay; encrypted-media; picture-in-picture';iframe.allowFullscreen=true;iframe.referrerPolicy='strict-origin-when-cross-origin';video.replaceChildren(iframe);});
}
const articleRoute=/^\/(news|pages)\/([a-z0-9-]+)\/?$/.exec(location.pathname);
if(/^\/schedule\/?$/.test(location.pathname)){
  document.title='今後の営業予定 | Nocturne Planet';
  document.querySelector('meta[name=description]').content='Nocturne Planet（のくぷら）の今後の営業予定。開催日時と営業内容を掲載しています。';
  const main=document.getElementById('main');
  main.innerHTML=`<section class="wrap section schedule-page"><a class="text-link" href="/#schedule">営業情報へ戻る</a><h1>今後の営業予定</h1><p class="section-lead">日時はすべて日本時間です。</p><div id="schedule-list" aria-live="polite"><p>営業予定を読み込んでいます…</p></div></section>`;
  const list=document.getElementById('schedule-list');
  try{
    const {events}=await api('/api/schedule');
    const dayFormat=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'long',day:'numeric',weekday:'short'});
    const dayKey=value=>new Date(Date.parse(value)+9*3600000).toISOString().slice(0,10);
    const endLabel=event=>{
      const start=dayKey(event.starts_at),end=dayKey(event.ends_at);
      if(start===end)return jstTime(event.ends_at);
      if(Date.parse(end)-Date.parse(start)===86400000)return '翌'+jstTime(event.ends_at);
      return dayFormat.format(new Date(event.ends_at))+' '+jstTime(event.ends_at);
    };
    list.innerHTML=events.length?`<table class="schedule-table"><caption class="visually-hidden">今後の営業予定</caption><thead><tr><th scope="col">開催日時</th><th scope="col">営業ラベル</th><th scope="col">営業名・ご案内</th></tr></thead><tbody>${events.map(event=>`<tr><td><time datetime="${esc(event.starts_at)}">${esc(dayFormat.format(new Date(event.starts_at)))}</time><span class="schedule-time">${esc(jstTime(event.starts_at))}〜${esc(endLabel(event))}</span></td><td><span class="event-category">${esc(event.category)}</span></td><td><strong>${esc(event.title)}</strong>${event.description?`<p class="preserve">${esc(event.description)}</p>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="schedule-empty"><h2>営業予定はまだありません</h2><p>日程が決まり次第、こちらに掲載します。</p></div>';
  }catch{
    list.innerHTML='<div class="schedule-empty"><p>営業予定を読み込めませんでした。</p><a class="text-link" href="/schedule">もう一度読み込む</a></div>';
  }
}
if(articleRoute){
  const kind=articleRoute[1]==='news'?'news':'page',post=data.content.find(p=>p.kind===kind&&p.slug===articleRoute[2]);
  document.getElementById('main').innerHTML=post?`<article class="wrap section article-page"><a class="text-link" href="/${kind==='news'?'#news':''}">${kind==='news'?'お知らせ一覧へ戻る':'ホームへ戻る'}</a><p class="quiet">${esc(dateLabel(post.published_at,false))}</p><h1>${esc(post.title)}</h1><div class="prose">${markdown(post.body)}</div></article>`:`<section class="wrap section article-page"><h1>ページが見つかりません</h1><p>公開が終了したか、URLが変更された可能性があります。</p><a class="button pill" href="/">ホームへ戻る</a></section>`;
  document.title=(post?.title||'ページが見つかりません')+' | Nocturne Planet';
}
