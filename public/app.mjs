import {setupNavigation} from './navigation.mjs';
import {esc,safeLink,dateLabel,markdown,api} from './ui.mjs';
import {regularHoursLabel,jstTime} from './schedule.mjs';
import {castCard,castProfile} from './casts.mjs';
import {siteContent,siteImageSrc,durationLabel} from './site-content.mjs';

setupNavigation();
const icons={home:'<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>'};
document.querySelectorAll('[data-icon]').forEach(node=>node.insertAdjacentHTML('afterbegin',`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">${icons[node.dataset.icon]}</svg>`));
const dialog=document.getElementById('cast-dialog');dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});

const arrowRight='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>';
const arrowUpRight='<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg>';

let data;
try {data=await api('/api/public');}
catch {data={settings:{x_url:'https://x.com/NoctuPla_VRC'},events:[],casts:[],content:[]};}
const settings=siteContent(data.settings);
document.querySelector('meta[name="description"]').content=settings.about;
const venueMarkup=()=>settings.venue_url?`<a class="venue-link" href="${esc(safeLink(settings.venue_url))}" target="_blank" rel="noopener noreferrer">${esc(settings.venue)} ${arrowUpRight}</a>`:esc(settings.venue);
document.querySelectorAll('[data-venue]').forEach(node=>node.innerHTML=venueMarkup());
document.querySelectorAll('[data-duration]').forEach(node=>node.textContent=durationLabel(settings));
document.querySelector('.duration-main b').textContent=settings.main_minutes;
document.querySelector('.about-after b').textContent=settings.after_minutes;
document.querySelector('.about-duration').setAttribute('aria-label',durationLabel(settings));
document.querySelector('.program-note').textContent=`本編${settings.main_minutes}分には入場案内・交代・終了挨拶を含みます。${settings.after_minutes?'終了後は'+settings.after_minutes+'分のアフターを予定しています。':''}`;
document.querySelectorAll('.program-card').forEach((card,index)=>{
  const program=settings.programs[index],photo=card.querySelector('img');
  card.querySelector('h3').textContent=program.title;photo.src=siteImageSrc(program.image);photo.alt=program.title;
  const caption=card.querySelector('figcaption');caption.textContent=program.caption;caption.hidden=!program.caption;
  card.querySelector('.program-time').innerHTML=`<b>${program.minutes}</b>分${program.detail?'<span>（'+esc(program.detail)+'）</span>':''}`;
  card.querySelector('.program-body > p:last-child').textContent=program.description;
});
const facilityIntro=document.querySelector('.world-lead');facilityIntro.textContent=settings.facility_intro;facilityIntro.hidden=!settings.facility_intro;
document.querySelectorAll('.world-photo').forEach((card,index)=>{
  const facility=settings.facilities[index],photo=card.querySelector('img');photo.src=siteImageSrc(facility.image);photo.alt=facility.title;
  card.querySelector('strong').textContent=facility.title;card.querySelector('figcaption span').textContent=facility.description;
});
document.querySelectorAll('.site-header [aria-label="公式X"], #official-x').forEach(node=>node.hidden=!settings.x_url);
document.querySelectorAll('.site-header [aria-label="公式YouTube"], #youtube-link').forEach(node=>node.hidden=!settings.youtube_url);
document.getElementById('discord-invite').hidden=!settings.discord_invite;
if(settings.x_url){const link=document.getElementById('official-x');link.href=safeLink(settings.x_url);link.children[1].textContent=new URL(link.href).pathname.slice(1)?'@'+new URL(link.href).pathname.slice(1):'公式X';document.querySelector('.site-header [aria-label="公式X"]').href=link.href;}
if(settings.about)document.getElementById('about-text').textContent=settings.about;
const cadence=document.getElementById('about-cadence');cadence.textContent=settings.cadence;cadence.parentElement.hidden=!settings.cadence&&!settings.regular_hours;
if(settings.regular_hours){
  const label=regularHoursLabel(settings.regular_hours),regular=document.getElementById('regular-hours');
  regular.textContent='通常営業：'+label;regular.hidden=false;
  const fact=document.getElementById('about-cadence');fact.textContent=label+(settings.cadence?'\n'+settings.cadence:'');fact.previousElementSibling.textContent='通常営業';
}
document.querySelectorAll('[data-admission]').forEach(node=>node.textContent=settings.admission);
if(settings.discord_invite)document.getElementById('discord-invite').href=safeLink(settings.discord_invite);
const worldSlides=['/assets/world/dome.webp','/assets/world/seating.webp','/assets/world/lounge-view.webp'];
heroSlideshow(Array.isArray(settings.hero_images)&&settings.hero_images.length?settings.hero_images:settings.hero_image?[settings.hero_image]:worldSlides);
function heroSlideshow(images){
  if(!images.length)return;
  const stage=document.getElementById('hero-slides'),dots=document.getElementById('hero-dots'),hero=stage.closest('.hero');
  const source=image=>image.startsWith('/assets/')?image:'/api/images/'+encodeURIComponent(image);
  stage.innerHTML=images.map((image,index)=>`<img class="hero-slide${index===0?' is-active':''}" src="${source(image)}" alt="" ${index===0?'fetchpriority="high"':'loading="lazy"'}>`).join('');
  hero.classList.add('has-photo');
  if(images.length<2)return;
  const slides=[...stage.children];let current=0,timer;
  dots.innerHTML=slides.map((_,index)=>`<button type="button" aria-label="${index+1}枚目の写真を表示" ${index===0?'aria-current="true"':''}></button>`).join('');dots.hidden=false;
  const buttons=[...dots.children];
  const show=index=>{slides[current].classList.remove('is-active');buttons[current].removeAttribute('aria-current');current=(index+slides.length)%slides.length;slides[current].classList.add('is-active');buttons[current].setAttribute('aria-current','true');};
  let paused=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pause=document.createElement('button');pause.type='button';pause.className='slide-pause';dots.append(pause);
  const label=()=>{pause.textContent=paused?'再生':'一時停止';pause.setAttribute('aria-label',paused?'写真の自動切り替えを再生':'写真の自動切り替えを一時停止');};label();
  const start=()=>{clearInterval(timer);if(!paused)timer=setInterval(()=>show(current+1),6000);};
  pause.addEventListener('click',()=>{paused=!paused;label();start();});
  buttons.forEach((button,index)=>button.addEventListener('click',()=>{show(index);start();}));
  document.addEventListener('visibilitychange',()=>document.hidden?clearInterval(timer):start());
  start();
}
const upcoming=data.events.filter(event=>Date.parse(event.ends_at)>=Date.now()).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at));
if(!upcoming.length&&!settings.x_url)document.querySelector('#event-area .event-main > p').textContent='開催日が決まり次第、このページでお知らせします。';
if(upcoming[0]){
  const ticketDate=document.getElementById('hero-next-date'),ticketState=document.getElementById('hero-next-state');
  if(ticketDate){ticketDate.textContent=dateLabel(upcoming[0].starts_at);ticketState.textContent=upcoming[0].category||'通常営業';}
  const next=upcoming[0];
  document.getElementById('event-area').innerHTML=`<div class="event-main"><span class="event-category">${esc(next.category||'通常営業')}</span><h3>${esc(dateLabel(next.starts_at))}</h3><p class="event-title">${esc(next.title)}</p><p class="preserve">${esc(next.description)}</p>${settings.vrchat_group_url?`<a class="text-link" href="${esc(safeLink(settings.vrchat_group_url))}" target="_blank" rel="noopener noreferrer"><span>VRChatグループへ</span>${arrowUpRight}</a>`:''}</div><dl class="event-meta"><div><dt>終了予定</dt><dd>${esc(dateLabel(next.ends_at))}</dd></div><div><dt>開催場所</dt><dd data-venue>${venueMarkup()}</dd></div><div><dt>入場方法</dt><dd data-admission>${esc(settings.admission)}</dd></div><div class="event-cta"><a class="button secondary pill small" href="/member">会員ページでチェックイン</a></div></dl>`;
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
else if(!settings.x_url)document.querySelector('#news-list .empty-inline').textContent='お知らせはまだありません。';
document.querySelector('.social-intro').textContent=settings.x_url&&settings.youtube_url?'営業予定やイベントの様子は、公式XとYouTubeでお知らせしています。':settings.x_url?'営業予定やイベントの様子は、公式Xでお知らせしています。':settings.youtube_url?'営業予定やイベントの様子は、公式YouTubeでお知らせしています。':'公式SNSのリンクは準備中です。';
if(settings.youtube_url){document.querySelector('.site-header [aria-label="公式YouTube"]').href=safeLink(settings.youtube_url);document.getElementById('youtube-link').innerHTML=`<a class="social-row" href="${esc(safeLink(settings.youtube_url))}" target="_blank" rel="noopener noreferrer"><span class="social-badge youtube" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="1" y="4" width="22" height="16" rx="5" fill="currentColor"/><path d="m10 8 7 4-7 4z" fill="#fff"/></svg></span><span>YouTube 公式チャンネル</span>${arrowUpRight}</a>`;}
if(/^[a-zA-Z0-9_-]{11}$/.test(settings.youtube_video||'')){
  const video=document.getElementById('video-area');video.innerHTML='<button class="video-play"><span class="play-circle" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span><span>YouTube動画を再生</span></button>';
  video.querySelector('button').addEventListener('click',()=>{const iframe=document.createElement('iframe');iframe.src=`https://www.youtube-nocookie.com/embed/${settings.youtube_video}?autoplay=1`;iframe.title='Nocturne Planet 公式YouTube';iframe.allow='autoplay; encrypted-media; picture-in-picture';iframe.allowFullscreen=true;iframe.referrerPolicy='strict-origin-when-cross-origin';video.replaceChildren(iframe);});
}
homeEffects();
function homeEffects(){
  const hero=document.querySelector('.hero');if(!hero)return;
  const header=document.querySelector('.site-header'),dots=document.querySelector('.section-dots'),ticket=document.querySelector('.member-ticket');
  new IntersectionObserver(([entry])=>{const past=!entry.isIntersecting;header.classList.toggle('is-scrolled',past);dots?.classList.toggle('is-visible',past);ticket?.classList.toggle('is-visible',past);},{rootMargin:'-84px 0px 0px'}).observe(hero);
  const links=[...document.querySelectorAll('.section-dots a, #site-menu a')];
  const sections=[...new Set(links.map(link=>link.hash))].map(hash=>document.querySelector(hash)).filter(Boolean);
  const spy=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)links.forEach(link=>link.hash==='#'+entry.target.id?link.setAttribute('aria-current','true'):link.removeAttribute('aria-current'));},{rootMargin:'-45% 0px -50% 0px'});
  sections.forEach(section=>spy.observe(section));
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const reveal=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('is-in');reveal.unobserve(entry.target);}},{rootMargin:'0px 0px -10% 0px'});
  document.querySelectorAll('.section-title, .event-panel, .program-card, .about-facts, .member-guide, .world-photo, .news-list, .social-layout').forEach((node,index)=>{node.classList.add('reveal');node.style.transitionDelay=(node.matches('.program-card, .world-photo')?(index%3)*90:0)+'ms';reveal.observe(node);});
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
