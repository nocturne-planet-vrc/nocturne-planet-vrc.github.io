import {api,esc,safeLink} from './ui.mjs';
import {recruitContent,renderRecruitPage} from './recruit-content.mjs';

const menu=document.getElementById('menu-toggle'),nav=document.getElementById('site-menu');
menu.addEventListener('click',()=>{
  const open=menu.getAttribute('aria-expanded')!=='true';
  menu.setAttribute('aria-expanded',String(open));nav.classList.toggle('open',open);
});
nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>{
  menu.setAttribute('aria-expanded','false');nav.classList.remove('open');
}));
const icons={home:'<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-2-4"/>',user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>'};
document.querySelectorAll('[data-icon]').forEach(node=>node.insertAdjacentHTML('afterbegin',`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">${icons[node.dataset.icon]}</svg>`));

try {
  const {settings,content}=await api('/api/public');
  for(const [label,key] of [['公式X','x_url'],['公式YouTube','youtube_url']]){
    const link=document.querySelector(`.site-header [aria-label="${label}"]`);
    link.hidden=!settings[key];if(settings[key])link.href=safeLink(settings[key]);
  }
  const page=recruitContent(settings);
  document.getElementById('main').innerHTML=renderRecruitPage(page,settings.recruit_url);
  document.title=page.label+' | Nocturne Planet';
  document.querySelector('meta[name="description"]').content=page.lead.replace(/\n/g,' ').slice(0,160);
  document.getElementById('footer-pages').innerHTML=content.filter(post=>post.kind==='page').map(post=>`<a href="/pages/${esc(post.slug)}">${esc(post.title)}</a>`).join('');
}catch{
  const status=document.querySelector('#main [role="status"]');
  if(status)status.textContent='応募フォームの情報を読み込めませんでした。時間を置いて再度このページを開いてください。';
}
