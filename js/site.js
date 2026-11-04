/*
 * Ripple Studios — homepage behaviour: nav state, scroll reveals, the light that follows the cursor.
 * The loader (loader.js) reveals #site and moves the logo into the hero.
 */
(() => {
  const root = document.documentElement;
  const nav = document.querySelector('.nav');
  const glow = document.querySelector('.site-glow');
  const year = document.querySelector('.year');
  if (year) year.textContent = new Date().getFullYear();

  // nav gets a glass backing once the page scrolls
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // sections fade up as they come into view
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.12 })
    : null;
  document.querySelectorAll('.on-scroll').forEach((el, i) => {
    el.style.transitionDelay = `${(i % 3) * 0.08}s`;
    if (io) io.observe(el); else el.classList.add('in');
  });

  // the light sweep leans gently toward the cursor
  if (glow && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let tx = 68, ty = 48, x = tx, y = ty, raf = 0;
    const step = () => {
      x += (tx - x) * 0.06; y += (ty - y) * 0.06;
      glow.style.setProperty('--gx', `${x.toFixed(2)}%`);
      glow.style.setProperty('--gy', `${y.toFixed(2)}%`);
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.05 ? requestAnimationFrame(step) : 0;
    };
    addEventListener('pointermove', (e) => {
      if (!root.classList.contains('site-on')) return;
      tx = 55 + (e.clientX / innerWidth) * 30;
      ty = 35 + (e.clientY / innerHeight) * 30;
      if (!raf) raf = requestAnimationFrame(step);
    }, { passive: true });
  }
})();
