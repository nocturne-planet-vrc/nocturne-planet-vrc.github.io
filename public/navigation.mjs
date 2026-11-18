// Shared disclosure navigation for the public home and recruitment page.
export function setupNavigation(){
  const button=document.getElementById('menu-toggle'),nav=document.getElementById('site-menu');
  if(!button||!nav)return;
  const label=button.querySelector('span'),path=button.querySelector('svg path');
  const setOpen=open=>{
    button.setAttribute('aria-expanded',String(open));
    nav.classList.toggle('open',open);
    label.textContent=open?'閉じる':'メニュー';
    path.setAttribute('d',open?'M6 6l12 12M6 18 18 6':'M4 7h16M4 12h16M4 17h16');
  };
  button.addEventListener('click',()=>setOpen(button.getAttribute('aria-expanded')!=='true'));
  nav.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>setOpen(false)));
  document.addEventListener('pointerdown',event=>{
    if(!button.contains(event.target)&&!nav.contains(event.target))setOpen(false);
  });
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&button.getAttribute('aria-expanded')==='true'){
      setOpen(false);button.focus();
    }
  });
  document.addEventListener('focusin',event=>{
    if(!button.contains(event.target)&&!nav.contains(event.target))setOpen(false);
  });
  matchMedia('(min-width:1025px)').addEventListener('change',event=>{if(event.matches)setOpen(false);});
}
