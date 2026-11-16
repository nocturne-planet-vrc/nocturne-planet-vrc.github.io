import {esc,safeLink,dateLabel,markdown,api,empty} from './ui.mjs';

const menu=document.getElementById('menu-toggle');
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));document.getElementById('site-menu').classList.toggle('open',open);});
document.querySelectorAll('#site-menu a').forEach(link=>link.addEventListener('click',()=>{menu.setAttribute('aria-expanded','false');document.getElementById('site-menu').classList.remove('open');}));
const icons={home:'<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>'};
document.querySelectorAll('[data-icon]').forEach(node=>node.insertAdjacentHTML('afterbegin',`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">${icons[node.dataset.icon]}</svg>`));
const dialog=document.getElementById('cast-dialog');dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});

let data;
try {data=await api('/api/public');}
catch {data={settings:{x_url:'https://x.com/NoctuPla_VRC'},events:[],casts:[],content:[]};}
const settings=data.settings;
if(settings.x_url){const link=document.getElementById('official-x');link.href=safeLink(settings.x_url);link.children[1].textContent=new URL(link.href).pathname.slice(1)?'@'+new URL(link.href).pathname.slice(1):'公式X';}
if(settings.about)document.getElementById('about-text').textContent=settings.about;
for(const item of ['cadence','about-cadence']) if(settings.cadence)document.getElementById(item).textContent=settings.cadence;
if(settings.admission)document.getElementById('admission').textContent=settings.admission;
if(settings.hero_image){const hero=document.getElementById('hero-logo');hero.src='/api/images/'+encodeURIComponent(settings.hero_image);hero.alt='Nocturne Planet イベント画像';hero.classList.add('event-visual');}
const upcoming=data.events.filter(event=>Date.parse(event.ends_at)>=Date.now()).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at));
if(upcoming[0]){
  const next=upcoming[0];document.getElementById('next-strip').textContent=`次回営業 ${dateLabel(next.starts_at)} ／ ${next.title}`;
  document.getElementById('event-area').innerHTML=`<div><p class="quiet">${esc(next.title)}</p><h3>${esc(dateLabel(next.starts_at))}</h3><p class="preserve">${esc(next.description)}</p>${settings.vrchat_group_url?`<a class="text-link" href="${esc(safeLink(settings.vrchat_group_url))}" target="_blank" rel="noopener noreferrer">VRChatグループへ<span aria-hidden="true">↗</span></a>`:''}</div><div class="event-meta"><p><span>終了予定</span>${esc(dateLabel(next.ends_at))}</p><p><span>入場方法</span>${esc(settings.admission||'Group+・先着順')}</p><a class="button secondary" href="/member">会員ページでチェックイン</a></div>`;
}
if(data.casts.length){
  document.getElementById('cast-list').innerHTML=data.casts.map(cast=>`<button class="cast-card" data-cast="${esc(cast.id)}">${cast.image_id?`<img src="/api/images/${encodeURIComponent(cast.image_id)}" alt="${esc(cast.display_name)}" loading="lazy" width="400" height="500">`:'<div class="cast-photo-empty"><img src="/assets/logo-dark.svg" alt="" width="160" height="160"></div>'}<span class="cast-card-body"><strong>${esc(cast.display_name)}</strong><span>${esc(cast.tagline)}</span><span class="cast-more">プロフィール<span aria-hidden="true">↗</span></span></span></button>`).join('');
  document.querySelectorAll('[data-cast]').forEach(button=>button.addEventListener('click',()=>{
    const cast=data.casts.find(c=>c.id===button.dataset.cast);document.getElementById('cast-dialog-body').innerHTML=`${cast.image_id?`<img class="cast-portrait" src="/api/images/${encodeURIComponent(cast.image_id)}" alt="${esc(cast.display_name)}">`:''}<p class="quiet">${esc(cast.tagline)}</p><h2>${esc(cast.display_name)}</h2><p class="preserve">${esc(cast.bio)}</p><div class="actions">${cast.x_url?`<a href="${esc(safeLink(cast.x_url))}" target="_blank" rel="noopener noreferrer" class="text-link">X ↗</a>`:''}${cast.youtube_url?`<a href="${esc(safeLink(cast.youtube_url))}" target="_blank" rel="noopener noreferrer" class="text-link">YouTube ↗</a>`:''}<a href="/member" class="button small">お気に入りを登録</a></div>`;dialog.showModal();
  }));
}
const news=data.content.filter(post=>post.kind==='news');
if(news.length)document.getElementById('news-list').innerHTML=news.slice(0,8).map(post=>`<a class="news-row" href="/news/${esc(post.slug)}"><time>${esc(dateLabel(post.published_at,false))}</time><span>${esc(post.title)}</span><span aria-hidden="true">→</span></a>`).join('');
document.getElementById('footer-pages').innerHTML=data.content.filter(post=>post.kind==='page').map(post=>`<a href="/pages/${esc(post.slug)}">${esc(post.title)}</a>`).join('');
if(settings.youtube_url)document.getElementById('youtube-link').innerHTML=`<a class="social-row" href="${esc(safeLink(settings.youtube_url))}" target="_blank" rel="noopener noreferrer"><span>YouTube</span><span>公式チャンネル</span><span aria-hidden="true">↗</span></a>`;
if(/^[a-zA-Z0-9_-]{11}$/.test(settings.youtube_video||'')){
  const video=document.getElementById('video-area');video.innerHTML='<button class="video-play"><span class="play-circle" aria-hidden="true">▶</span><span>YouTube動画を再生</span></button>';
  video.querySelector('button').addEventListener('click',()=>{const iframe=document.createElement('iframe');iframe.src=`https://www.youtube-nocookie.com/embed/${settings.youtube_video}?autoplay=1`;iframe.title='Nocturne Planet 公式YouTube';iframe.allow='autoplay; encrypted-media; picture-in-picture';iframe.allowFullscreen=true;iframe.referrerPolicy='strict-origin-when-cross-origin';video.replaceChildren(iframe);});
}
const articleRoute=/^\/(news|pages)\/([a-z0-9-]+)\/?$/.exec(location.pathname);
if(articleRoute){
  const kind=articleRoute[1]==='news'?'news':'page',post=data.content.find(p=>p.kind===kind&&p.slug===articleRoute[2]);
  document.getElementById('main').innerHTML=post?`<article class="wrap section article-page"><a class="text-link" href="/${kind==='news'?'#news':''}">← ${kind==='news'?'お知らせ一覧':'ホーム'}</a><p class="quiet">${esc(dateLabel(post.published_at,false))}</p><h1>${esc(post.title)}</h1><div class="prose">${markdown(post.body)}</div></article>`:`<section class="wrap section"><h1>ページが見つかりません</h1><p>公開が終了したか、URLが変更された可能性があります。</p><a class="button" href="/">ホームへ</a></section>`;
  document.title=(post?.title||'ページが見つかりません')+' | Nocturne Planet';
}
