// Shared disclosure navigation for the public home and recruitment page.
export function setupNavigation() {
  const button = document.getElementById('menu-toggle'),
    nav = document.getElementById('site-menu');
  if (!button || !nav) return;
  const mobile = matchMedia('(max-width:1024px)');
  const setOpen = open => {
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? '閉じる' : 'メニュー';
    nav.classList.toggle('open', open);
    nav.inert = mobile.matches && !open;
  };
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
  nav.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('pointerdown', event => {
    if (!button.contains(event.target) && !nav.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      button.focus();
    }
  });
  document.addEventListener('focusin', event => {
    if (!button.contains(event.target) && !nav.contains(event.target)) setOpen(false);
  });
  mobile.addEventListener('change', () => setOpen(false));
  setOpen(false);
}
