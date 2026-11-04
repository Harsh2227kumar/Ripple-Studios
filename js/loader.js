/*
 * Ripple Studios — loader.
 * Drives the splash simulation on the CPU (drop, crown, jet, spray as plain ballistics),
 * hands it to a three-pass WebGL2 pipeline every frame (scene -> bloom -> post), draws the
 * wordmark rising out of the water, then dissolves into the site.
 *
 * Dev helpers:  ?t=3.08 freezes on a moment  ·  R replays  ·  ?speed=0.5 slows down
 *               ?tier=high|mid|low forces a quality tier  ·  ?hold keeps the loader on screen
 */
(async () => {
  const TAU = Math.PI * 2;
  const params = new URLSearchParams(location.search);
  const FREEZE = params.has('t') ? parseFloat(params.get('t')) : null;
  const SPEED = parseFloat(params.get('speed') || '1');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const HOLD = params.has('hold') || FREEZE !== null;
  const FORCE_TIER = params.get('tier');

  /* ------------------------------------------------------------ timeline */
  const G = 0.87;            // slow-motion gravity (scene units / s²)
  const DROP_R = 0.095;
  const T_IMPACT = 2.0;      // matches the reference clip
  const V_IMPACT = 2.18;
  const JET_PINCH = 1.35;    // in crown time
  const BEAD_R = 0.1;
  const BEAD_VY = 0.35;
  const TEXT_DELAY = 0.35;   // after the returning bead lands
  const SHUTTER = 1 / 48;    // 180° shutter at 24 fps, like the footage
  // logo reveal, in seconds after TEXT_AT: [start, stagger, duration] per part kind.
  // The rings ripple out from the centre, the divider draws itself, then the letters rise.
  const LOGO_T = { ring: [0.0, 0.11, 1.5], bar: [0.45, 0, 1.0], big: [0.55, 0.06, 1.5], small: [1.0, 0.045, 1.3] };
  const EXIT_HOLD = 1.6, EXIT_DUR = 1.6;

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const tScale = (s) => 0.5 + 0.5 * s;

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(11);
  const rnd2 = mulberry32(29);   // the extra irregularity uses its own stream, so the calibrated layout stays put
  const NF = 14;
  // [length factor, lean, thickness, angle jitter]
  const FING = Array.from({ length: NF }, () => [0.3 + 0.7 * Math.pow(rnd(), 0.7), 0.5 + 0.45 * rnd(), 0, (rnd() - 0.5) * 0.25]);
  // arms lean further out than first calibrated: the footage's crown flares open like a tulip
  FING.forEach((f) => { f[1] += 0.2; f[2] = 0.72 + 0.6 * rnd2(); });
  // each finger throws its tip bead at its own moment
  const FDET = FING.map((f) => 0.42 + 0.1 * rnd2() + 0.04 * (1 - f[0]));
  const SPRAY2 = Array.from({ length: 6 }, () => ({
    ang: rnd() * TAU, tl: 0.1 + 0.25 * rnd(), vr: 0.3 + 0.6 * rnd(), vy: 0.5 + 0.7 * rnd(), r: 0.01 + 0.008 * rnd(),
  }));

  // crown shape as a function of crown time (mirrors the GLSL)
  const crater = (tau, s) => s * (0.28 + 0.42 * (1 - Math.exp(-tau / 0.15)) + 0.25 * Math.min(tau, 1.2));
  const sheetH = (tau, s) => s * 0.32 * Math.pow(Math.sin(Math.PI * clamp01((tau - 0.03) / 1.05)), 0.5);
  const crownTop = (Hs, a) => Hs * (0.8 + 0.06 * Math.sin(a * 3 + 0.4) + 0.045 * Math.sin(a * 5 + 2.1)
    + 0.03 * Math.sin(a * 8 + 4.3) + 0.12 * Math.cos(NF * (a + Math.PI) - Math.PI));
  const FLARE = 0.55;

  /*
   * Crown arms, as measured from the footage: each is a ligament flung from a rim lobe whose tip
   * flies ballistically (≈2.75 out, 2.4 up), so the arms keep stretching into long sweeping arcs.
   * From FDET on, each arm breaks up from the tip inward into a chain of droplets that carry on
   * along the same arc: that is what draws the V-shaped spray lines.
   */
  const ARM_T0 = 0.06, ARM_RETRACT = 0.33;
  const armAngle = (i) => -Math.PI + (i + 0.5) * (TAU / NF) + FING[i][3];
  function armBase(tau, s, i) {
    const tc = crownTop(sheetH(tau, s), armAngle(i));
    return [0.94 * crater(tau, s) + tc * FLARE, tc - 0.02 * s];
  }
  // a few long dominant arms, many short ones; in the footage the longest fly out to the
  // sides, which is what gives the crown its two wide wings
  const armK = (i) => { const side = Math.abs(Math.cos(armAngle(i))); return (0.4 + 0.6 * FING[i][0]) * (0.4 + 0.7 * side * side); };
  function armTip(tau, s, i) {
    const f = FING[i];
    const k = armK(i);
    const lf = 0.8 + 0.4 * (f[1] - 0.7) / 0.45;      // how far each one leans out
    const dt = Math.max(0, tau - ARM_T0) * tScale(s);
    return [0.43 * s + s * 2.75 * k * lf * dt, 0.05 * s + s * 2.4 * k * dt - 0.5 * G * dt * dt];
  }
  // point at parameter u (0 base .. 1 tip) along the arm: a quadratic curve bowed inward-up
  function armPoint(u, tau, s, i) {
    const b = armBase(tau, s, i), T = armTip(tau, s, i);
    const dx = T[0] - b[0], dy = T[1] - b[1];
    const c = [0.5 * (b[0] + T[0]) - dy * 0.35, 0.5 * (b[1] + T[1]) + dx * 0.35];
    const v = 1 - u;
    return [v * v * b[0] + 2 * u * v * c[0] + u * u * T[0], v * v * b[1] + 2 * u * v * c[1] + u * u * T[1]];
  }
  const armU1 = (tau, i) => 1 - clamp01((tau - FDET[i]) / ARM_RETRACT);
  const tipBeadR = (i) => 0.026 * Math.sqrt(FING[i][0]);
  const landAfter = (y0, vy) => (vy + Math.sqrt(vy * vy + 2 * G * Math.max(y0, 0))) / G;

  // droplets released by the breaking arms (main splash), with the arm's local velocity
  const release = (u, tau, i) => {
    const p = armPoint(u, tau, 1, i), q = armPoint(u, tau + 0.01, 1, i);
    return { r0: p[0], y0: p[1], vr: (q[0] - p[0]) / 0.01, vy: (q[1] - p[1]) / 0.01 };
  };
  const DROPS = [];
  const kMax = Math.max(...FING.map((_, i) => armK(i)));
  FING.forEach((f, i) => {
    const n = 2 + Math.round(4 * Math.pow(armK(i) / kMax, 1.5));   // long arms leave long chains
    for (let k = 0; k < n; k++) {
      const u = 1 - 0.85 * k / n;
      const tau = FDET[i] + (1 - u) * ARM_RETRACT;
      const rad = k === 0 ? tipBeadR(i) : (0.011 + 0.012 * rnd2()) * Math.sqrt(f[0]);
      DROPS.push({ ac: armAngle(i), t0: T_IMPACT + tau, rad, ...release(u, tau, i) });
    }
  });
  // plus a little fine mist thrown faster off the tips
  for (let k = 0; k < 8; k++) {
    const i = (k * 5 + 2) % NF, tau = 0.16 + 0.22 * rnd2(), boost = 1.05 + 0.3 * rnd2();
    const rl = release(1, tau, i);
    DROPS.push({ ac: armAngle(i) + (rnd2() - 0.5) * 0.12, t0: T_IMPACT + tau, rad: 0.005 + 0.006 * rnd2(),
      r0: rl.r0, y0: rl.y0, vr: rl.vr * boost, vy: rl.vy * boost });
  }

  // landing time of the bead thrown off the top of the jet
  const pinchT = T_IMPACT + JET_PINCH * tScale(1);
  const jetTop = 1.05;
  const beadLand = pinchT + (BEAD_VY + Math.sqrt(BEAD_VY * BEAD_VY + 2 * G * (jetTop - BEAD_R))) / G;
  const TEXT_AT = beadLand + TEXT_DELAY;
  const TEXT_END = TEXT_AT + LOGO_T.small[0] + LOGO_T.small[1] * 6 + LOGO_T.small[2];

  // where every droplet falls back: each leaves a tiny ring
  const DRIPS = DROPS.map((d) => {
    const dt = landAfter(d.y0, d.vy), r = d.r0 + d.vr * dt;
    return [Math.cos(d.ac) * r, Math.sin(d.ac) * r, d.t0 + dt, 0.07 * d.rad];
  }).sort((a, b) => b[3] - a[3]).slice(0, 24);

  function simulate(t) {
    const sph = [];   // [x, y, z, r, vx, vy, vz]
    const imps = [
      { x: 0, z: 0, t0: T_IMPACT, s: 1 },
      { x: 0, z: 0, t0: beadLand, s: 0.4 },
    ];

    // the falling drop, then merging into the surface
    {
      const dt = T_IMPACT - t;
      if (dt >= 0) {
        sph.push([0, DROP_R + V_IMPACT * dt - 0.5 * G * dt * dt, 0, DROP_R, 0, -(V_IMPACT - G * dt), 0]);
      } else if (dt > -0.2) {
        // the drop sits in its own little crown for a moment before it is swallowed
        const k = 1 + dt / 0.2;
        sph.push([0, DROP_R * k * 0.9 + 0.02, 0, DROP_R * Math.sqrt(k), 0, -0.4, 0]);
      }
    }

    // the bead pinched off the jet, its flight and return
    if (t >= pinchT) {
      const dt = t - pinchT;
      const y = jetTop + BEAD_VY * dt - 0.5 * G * dt * dt;
      const vy = BEAD_VY - G * dt;
      if (t < beadLand) sph.push([0, y, 0, BEAD_R, 0, vy, 0]);
      else if (t < beadLand + 0.06) {
        const k = 1 - (t - beadLand) / 0.06;
        sph.push([0, y, 0, BEAD_R * k, 0, vy, 0]);
      }
    }

    const out = { imp: [], crown: [], crownB: [], jet: [], box: [], armA: new Float32Array(NF * 4), armB: new Float32Array(NF * 4) };
    imps.forEach((im, idx) => {
      const tr = t - im.t0;
      const active = tr >= 0;
      out.imp.push(active ? [im.x, im.z, im.t0, im.s] : [0, 0, 0, 0]);
      if (!active) {
        out.crown.push([0, 0, 0, 0]); out.crownB.push([0, 0, 0, 0]);
        out.jet.push([0, 0, 0, 0]); out.box.push([0, 0, 0, 0]);
        return;
      }
      const s = im.s;
      const tau = tr / tScale(s);

      // crown
      const depth = s * 0.5 * smooth(0, 0.16, tau) * (1 - smooth(0.75, 1.5, tau));
      let crown = [0, 0, 0, 0], crownB = [0, 0, 0, depth];
      const Hs = sheetH(tau, s);
      const crownOn = tau > 0.05 && tau < 1.15;
      let armR = 0, armY = 0;
      if (crownOn) {
        crown = [0.94 * crater(tau, s), Hs, 1, s];
        crownB = [Math.max(0.01, s * 0.022), 0, FLARE, depth];
        for (let i = 0; i < NF; i++) {
          const T = armTip(tau, s, i);
          armR = Math.max(armR, T[0]); armY = Math.max(armY, T[1]);
          const bead = idx === 0 && tau < FDET[i] ? tipBeadR(i) * smooth(0.08, 0.22, tau) : 0;
          out.armA.set([T[0], T[1], FING[i][2], FING[i][3]], i * 4);
          out.armB.set([bead, tau > ARM_T0 ? armU1(tau, i) : 0, 0, 0], i * 4);
        }
      }

      // droplets the arms have thrown (main splash only)
      if (idx === 0) for (const d of DROPS) {
        const dt = t - d.t0;
        if (dt < 0) continue;
        const r = d.r0 + d.vr * dt, y = d.y0 + d.vy * dt - 0.5 * G * dt * dt;
        const c = Math.cos(d.ac), sn = Math.sin(d.ac);
        if (y > -0.04) sph.push([im.x + c * r, y, im.z + sn * r, d.rad, c * d.vr, d.vy - G * dt, sn * d.vr]);
      }
      if (idx === 1) for (const p of SPRAY2) {
        if (tau < p.tl) continue;
        const dt = (tau - p.tl) * tScale(s);
        const Rl = 0.94 * crater(p.tl, s) + sheetH(p.tl, s) * FLARE;
        const yl = sheetH(p.tl, s);
        const vr = p.vr * s, vy = p.vy * Math.sqrt(s);
        const r = Rl + vr * dt, y = yl + vy * dt - 0.5 * G * dt * dt;
        const c = Math.cos(p.ang), sn = Math.sin(p.ang);
        if (y > -0.04 && dt < 5) sph.push([im.x + c * r, y, im.z + sn * r, p.r * (0.6 + 0.4 * s), c * vr, vy - G * dt, sn * vr]);
      }

      // Worthington jet
      let jet = [0, 0, 0, 0];
      if (tau > 0.5 && tau < 2.1) {
        const rj = Math.max(0.022, s * 0.055);
        let H, rb;
        if (idx === 0 && tau >= JET_PINCH) {
          H = s * jetTop * (1 - smooth(JET_PINCH, 2.1, tau));
          rb = rj * 1.3 * (1 - 0.4 * smooth(JET_PINCH, 2.1, tau));
        } else {
          H = s * jetTop * smooth(0.5, 1.25, tau) * (idx === 0 ? 1 : 1 - smooth(1.3, 2.0, tau));
          rb = Math.max(rj * 1.2, s * BEAD_R * smooth(0.75, 1.15, tau));
        }
        jet = [H, rj, rb, s];
      }

      const R = Math.max(crownOn ? Math.max(crown[0] + Hs * FLARE + 0.12, armR + 0.08) : 0, jet[3] ? jet[1] + 0.2 * s + 0.15 : 0);
      const top = Math.max(crownOn ? Math.max(Hs, armY) + 0.1 : 0, jet[3] ? jet[0] + jet[2] + 0.06 : 0);
      out.crown.push(crown); out.crownB.push(crownB); out.jet.push(jet);
      out.box.push(R > 0 ? [R, top, 0, 0] : [0, 0, 0, 0]);
    });

    out.sph = sph.slice(0, 64);
    return out;
  }

  // per-part reveal progress (power3.out, like GSAP; the divider eases in and out)
  const partP = (t, part) => {
    if (REDUCED) return 1;
    const [s0, st, du] = LOGO_T[part.name];
    const x = clamp01((t - TEXT_AT - s0 - st * part.k) / du);
    return part.name === 'bar' ? x * x * (3 - 2 * x) : 1 - Math.pow(1 - x, 3);
  };

  /* ------------------------------------------------------------ page bits */
  const root = document.documentElement;
  const loaderEl = document.getElementById('loader');
  const site = document.getElementById('site');
  const skipBtn = document.querySelector('.skip');
  const replayBtn = document.querySelector('.replay');
  const brandLogo = document.querySelector('.brand-logo');
  const heroLogo = document.querySelector('.hero-logo');
  const navMark = document.querySelector('.nav-mark');

  // The logo is one SVG whose paths are the separate parts (5 rings, divider, letters), so the
  // loader can animate each one. The same file becomes the homepage logo and the nav mark.
  const logoReady = fetch('assets/logo.svg').then((r) => r.text()).then((txt) => {
    brandLogo.innerHTML = txt;
    heroLogo.innerHTML = txt;
    heroLogo.querySelector('svg').setAttribute('aria-hidden', 'true');
    const svg = brandLogo.querySelector('svg');
    const vb = svg.viewBox.baseVal;
    svg.insertAdjacentHTML('afterbegin', `<defs><linearGradient id="brand-grad" gradientUnits="userSpaceOnUse" x1="0" y1="${vb.y}" x2="0" y2="${vb.y + vb.height}"><stop offset="0" style="stop-color:var(--brand-top)"/><stop offset="1" style="stop-color:var(--brand-bottom)"/></linearGradient></defs>`);
    // nav mark: just the rings (measured in an off-screen copy: the loader may be hidden)
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:600px;visibility:hidden';
    probe.innerHTML = txt;
    document.body.appendChild(probe);
    const rings = [...probe.querySelectorAll('path[data-kind="ring"]')];
    const bb = rings.map((p) => p.getBBox());
    probe.remove();
    const x0 = Math.min(...bb.map((b) => b.x)), y0 = Math.min(...bb.map((b) => b.y));
    const x1 = Math.max(...bb.map((b) => b.x + b.width)), y1 = Math.max(...bb.map((b) => b.y + b.height));
    navMark.innerHTML = `<svg viewBox="${x0 - 2} ${y0 - 2} ${x1 - x0 + 4} ${y1 - y0 + 4}" fill="currentColor" fill-rule="evenodd" aria-hidden="true">${rings.map((p) => `<path d="${p.getAttribute('d')}"/>`).join('')}</svg>`;
    return svg;
  }).catch(() => null);

  let pageLoaded = document.readyState === 'complete';
  addEventListener('load', () => { pageLoaded = true; });

  // The homepage is revealed underneath the loader: the loader fades out while the homepage logo
  // travels from where the loader's logo sits to its own place (FLIP), so it reads as one logo.
  let siteState = 'off';
  const brandRect = () => brandLogo.getBoundingClientRect();
  function beginSite() {
    if (siteState !== 'off') return;
    siteState = 'revealing';
    const from = brandRect();
    site.hidden = false;
    window.scrollTo(0, 0);
    if (window.gsap && !REDUCED && from.width) {
      const hr = heroLogo.getBoundingClientRect();
      gsap.set(heroLogo, { xPercent: -50, yPercent: -50 });
      gsap.fromTo(heroLogo,
        { x: from.left + from.width / 2 - (hr.left + hr.width / 2), y: from.top + from.height / 2 - (hr.top + hr.height / 2), scale: from.width / hr.width, opacity: 0 },
        { x: 0, y: 0, scale: 1, opacity: 1, duration: 1.8, ease: 'power3.inOut' });
    }
    setTimeout(() => root.classList.add('site-in'), 600);
  }
  function finishSite() {
    if (siteState === 'on') return;
    siteState = 'on';
    loaderEl.style.display = 'none';
    root.classList.add('site-on', 'site-in');
    window.dispatchEvent(new CustomEvent('ripple:ready'));
  }
  function hideSite() {
    siteState = 'off';
    site.hidden = true;
    root.classList.remove('site-on', 'site-in');
    if (window.gsap) { gsap.killTweensOf([heroLogo, loaderEl]); gsap.set(heroLogo, { clearProps: 'all' }); }
    loaderEl.style.display = '';
    loaderEl.style.opacity = '';
  }
  // loader fade for the fallback paths (no WebGL, reduced motion)
  function fadeOutLoader() {
    if (HOLD) return;
    beginSite();
    if (window.gsap && !REDUCED) gsap.to(loaderEl, { opacity: 0, duration: 1.2, ease: 'power2.inOut', onComplete: finishSite });
    else finishSite();
  }

  // ?site: straight to the homepage (no intro)
  if (params.has('site')) {
    loaderEl.style.display = 'none';
    logoReady.then(() => { siteState = 'revealing'; site.hidden = false; finishSite(); });
    replayBtn.addEventListener('click', () => { location.href = location.pathname; });
    return;
  }

  /* ------------------------------------------------------------ WebGL */
  const canvas = document.getElementById('ripple-canvas');
  const gl = params.has('nogl') ? null : canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance',
  });

  function domFallback() {
    // the DOM logo, animated part by part with GSAP
    root.classList.add('no-webgl');
    skipBtn.classList.add('show');
    skipBtn.addEventListener('click', () => { if (window.gsap) gsap.globalTimeline.clear(); fadeOutLoader(); });
    replayBtn.addEventListener('click', () => location.reload());
    logoReady.then((svg) => {
      if (!svg || !window.gsap) { setTimeout(fadeOutLoader, 2500); return; }
      const q = (k) => svg.querySelectorAll(`path[data-kind="${k}"]`);
      gsap.set(svg.querySelectorAll('path'), { transformBox: 'fill-box', transformOrigin: '50% 50%' });
      const tl = gsap.timeline({ delay: 0.4, onComplete: () => setTimeout(fadeOutLoader, EXIT_HOLD * 1000) });
      tl.from(q('ring'), { scale: 0.55, opacity: 0, duration: LOGO_T.ring[2], ease: 'power3.out', stagger: LOGO_T.ring[1] }, 0)
        .from(q('bar'), { scaleY: 0, duration: LOGO_T.bar[2], ease: 'power2.inOut' }, LOGO_T.bar[0])
        .from(q('big'), { y: 60, opacity: 0, duration: LOGO_T.big[2], ease: 'power3.out', stagger: LOGO_T.big[1] }, LOGO_T.big[0])
        .from(q('small'), { y: 40, opacity: 0, duration: LOGO_T.small[2], ease: 'power3.out', stagger: LOGO_T.small[1] }, LOGO_T.small[0]);
    });
  }
  if (!gl) { domFallback(); return; }
  root.classList.add('gl-text');   // the DOM wordmark stays for screen readers; WebGL draws it

  // Shaders compile in the background (KHR_parallel_shader_compile): asking for a compile result
  // straight away would block the page, and on Windows the big scene shader takes a few seconds
  // the first time (the browser caches it afterwards). The backdrop shows meanwhile.
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }
  const vs = compile(gl.VERTEX_SHADER, RIPPLE_SHADERS.vert);
  function program(src) {
    const prog = gl.createProgram();
    const fs = compile(gl.FRAGMENT_SHADER, src);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    return { prog, fs, u: null };
  }
  function finish(P) {
    const { prog, fs } = P;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(prog));
    }
    const u = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(prog, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(prog, name);
    }
    P.u = u;
  }
  const P = {
    scene: program(RIPPLE_SHADERS.scene),
    bloom: program(RIPPLE_SHADERS.bloom),
    post: program(RIPPLE_SHADERS.post),
    sim: program(RIPPLE_SHADERS.sim),
  };
  const compileStart = performance.now();
  if (parallel) {
    const done = () => Object.values(P).every((x) => gl.getProgramParameter(x.prog, parallel.COMPLETION_STATUS_KHR));
    const ok = await new Promise((resolve) => {
      const poll = () => {
        if (gl.isContextLost()) return resolve(false);
        if (done()) return resolve(true);
        if (performance.now() - compileStart > 25000) return resolve(false);   // give up: DOM wordmark
        setTimeout(poll, 50);
      };
      poll();
    });
    if (!ok) { canvas.style.display = 'none'; root.classList.remove('gl-text'); domFallback(); return; }
  }
  try {
    Object.values(P).forEach(finish);
  } catch (err) {
    console.error(err);
    canvas.style.display = 'none'; root.classList.remove('gl-text'); domFallback(); return;
  }
  const compileMs = performance.now() - compileStart;
  gl.bindVertexArray(gl.createVertexArray());

  // render targets: half-float where the device can render to it, 8-bit (gamma-encoded) otherwise
  const floatOK = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  let enc = floatOK ? 0 : 1;
  function makeTarget() {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex, fb: gl.createFramebuffer(), w: 0, h: 0 };
  }
  function sizeTarget(T, w, h) {
    if (T.w === w && T.h === h) return;
    T.w = w; T.h = h;
    gl.bindTexture(gl.TEXTURE_2D, T.tex);
    if (!enc) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.tex, 0);
    if (!enc && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      enc = 1;            // half-float advertised but not renderable: fall back
      T.w = 0;
      sizeTarget(T, w, h);
    }
  }
  const sceneT = makeTarget();

  /* ------------------------------------------------------------ wave physics */
  // A real wave equation runs on a 256² grid under the splash: touch or move over the water and
  // it ripples, interferes and dies away physically. Needs a float target; off otherwise.
  const SIM_N = 320, SIM_SIZE = 16, SIM_X0 = -8, SIM_Z0 = -9, SIM_HZ = 120;   // covers every visible bit of water
  const SIM_C = 0.75;                                   // wave speed, scene units / s
  const simDx = SIM_SIZE / SIM_N;
  const simK = Math.pow((SIM_C / SIM_HZ) / simDx, 2);
  const simOn = !enc;
  let simA = null, simB = null;
  if (simOn) {
    simA = makeTarget(); simB = makeTarget();
    sizeTarget(simA, SIM_N, SIM_N); sizeTarget(simB, SIM_N, SIM_N);
  }
  let simActiveUntil = -1e9, simAcc = 0, simLast = 0;
  const pokes = [];                                      // queued { u, v, r, a }
  function simStep(poke) {
    const Q = P.sim;
    gl.bindFramebuffer(gl.FRAMEBUFFER, simB.fb);
    gl.viewport(0, 0, SIM_N, SIM_N);
    gl.useProgram(Q.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, simA.tex);
    gl.uniform1i(Q.u.uPrev, 0);
    gl.uniform1f(Q.u.uK, simK);
    gl.uniform1f(Q.u.uDamp, 0.9965);
    if (poke) gl.uniform4f(Q.u.uPoke, poke.u, poke.v, poke.r, poke.a);
    else gl.uniform4f(Q.u.uPoke, 0, 0, 1, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const tmp = simA; simA = simB; simB = tmp;
  }
  function simAdvance(now) {
    if (!simOn) return;
    const dt = simLast ? Math.min((now - simLast) / 1000, 0.05) : 0;
    simLast = now;
    if (now > simActiveUntil && !pokes.length) return;  // flat water: nothing to solve
    simAcc += dt * SIM_HZ;
    let n = Math.min(Math.floor(simAcc), 6);
    simAcc -= n;
    if (pokes.length && n === 0) n = 1;
    for (let i = 0; i < n; i++) simStep(pokes.shift());
  }

  // screen point -> where it lands on the water plane (same camera as the shader)
  const CAM = [0, 3.45, 13.83], PITCH = 0.2147;
  function pickWater(cx, cy) {
    const vw = Math.max(1, innerWidth), vh = Math.max(1, innerHeight), aspect = vw / vh;
    const ux = (cx - vw / 2) / (vh / 2), uy = (vh / 2 - cy) / (vh / 2);
    const shift = aspect < 1 ? 0.075 / tanH - 0.4 : 0;
    const sp = Math.sin(PITCH), cp = Math.cos(PITCH);
    const fy = -sp, fz = -cp, upy = cp, upz = -sp;
    const dx = tanH * ux, dy = fy + tanH * (uy + shift) * upy, dz = fz + tanH * (uy + shift) * upz;
    if (dy >= -1e-3) return null;
    const t = -CAM[1] / dy;
    return [CAM[0] + dx * t, CAM[2] + dz * t];
  }
  let lastPick = null;
  function poke(x, z, r, a) {
    if (!simOn) return;
    const u = (x - SIM_X0) / SIM_SIZE, v = (z - SIM_Z0) / SIM_SIZE;
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    if (pokes.length > 8) pokes.shift();
    pokes.push({ u, v, r: r / SIM_SIZE, a });
    simActiveUntil = (simLast || performance.now()) + 6000;   // on the loop's clock
  }
  addEventListener('pointermove', (e) => {
    const w = pickWater(e.clientX, e.clientY);
    if (!w) { lastPick = null; return; }
    if (lastPick) {
      const d = Math.hypot(w[0] - lastPick[0], w[1] - lastPick[1]);
      if (d > 0.05) { poke(w[0], w[1], 0.12, Math.min(0.0025, d * 0.01)); lastPick = w; }
    } else lastPick = w;
  }, { passive: true });
  addEventListener('pointerdown', (e) => {
    const w = pickWater(e.clientX, e.clientY);
    if (w) poke(w[0], w[1], 0.13, 0.008);           // a tap is a small drop landing
  }, { passive: true });
  const bloomT = makeTarget();

  // wordmark atlas (premultiplied, mipmapped so blur is just a lower mip)
  const textTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, textTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  let parts = [];              // logo parts: screen rect, atlas rect, kind, timing
  let textBox = [1, 1, 0, 0];  // atlas w, atlas h, rise (px), reflection axis y (px)
  let logoBox = [0, 0, 0, 0];  // mark centre xy, bounds bottom, bounds top (px, GL coords)
  let stillT = null;      // set when showing a single frozen frame

  /* ------------------------------------------------------------ quality tiers */
  const TIERS = [
    { name: 'high', mul: 1.0, out: 2, taps: 12, bloom: true, q: 2, drips: 24 },
    { name: 'mid', mul: 0.72, out: 1.5, taps: 8, bloom: true, q: 1, drips: 16 },
    { name: 'low', mul: 0.5, out: 1.25, taps: 6, bloom: false, q: 0, drips: 10 },
  ];
  let tier = 0, extra = 1;
  const forced = TIERS.findIndex((x) => x.name === FORCE_TIER);

  let outS = 1, tanH = 0.15;
  function resize() {
    const T = TIERS[tier];
    const dpr = window.devicePixelRatio || 1;
    outS = Math.min(dpr, T.out);
    const sceneS = Math.min(dpr, 1.5) * T.mul * extra;
    const vw = Math.max(1, innerWidth), vh = Math.max(1, innerHeight);   // 0 in a hidden frame
    const W = Math.round(vw * outS), H = Math.round(vh * outS);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const sw = Math.max(16, Math.round(vw * sceneS)), sh = Math.max(16, Math.round(vh * sceneS));
    sizeTarget(sceneT, sw, sh);
    sizeTarget(bloomT, Math.max(4, Math.ceil(sw / 4)), Math.max(4, Math.ceil(sh / 4)));

    const aspect = vw / vh;
    // keep the splash in frame on tall screens by widening the lens
    tanH = 0.15 * Math.max(1, 1.25 / aspect);
    const S = P.scene;
    gl.useProgram(S.prog);
    gl.uniform1f(S.u.uTanH, tanH);
    // portrait: tilt down so the water's far edge sits ~30% from the top, splash near centre
    gl.uniform1f(S.u.uShift, aspect < 1 ? 0.075 / tanH - 0.4 : 0);
    gl.uniform2f(S.u.uRes, sw, sh);
    gl.uniform1i(S.u.uQ, T.q);
    gl.uniform1f(S.u.uEnc, enc);
    gl.uniform1i(S.u.uDripN, Math.min(T.drips, DRIPS.length));
    buildLogo();
  }

  /* ------------------------------------------------------------ logo atlas */
  // Each logo part is rasterised (blue gradient baked in) into its own padded cell of one
  // mipmapped texture; blur while it rises is just a lower mip.
  const KIND = { ring: 0, bar: 1, big: 2, small: 2 };
  function buildLogo() {
    const svg = brandLogo.querySelector('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vb = svg.viewBox.baseVal;
    const k = rect.width / vb.width, S = outS, pad = 14;
    const rs = getComputedStyle(root);
    const cTop = rs.getPropertyValue('--brand-top').trim() || '#3a7be0';
    const cBot = rs.getPropertyValue('--brand-bottom').trim() || '#173f8f';
    const MAXW = 2048;
    let x = 0, y = 0, rowH = 0, aw = 0;
    const count = {};
    const cells = [...svg.querySelectorAll('path')].map((p) => {
      const bb = p.getBBox();
      const w = Math.ceil((bb.width * k + 2 * pad) * S), h = Math.ceil((bb.height * k + 2 * pad) * S);
      if (x + w > MAXW) { x = 0; y += rowH + 2; rowH = 0; }
      const name = p.dataset.kind;
      count[name] = count[name] || 0;
      const c = { p, bb, w, h, ax: x, ay: y, name, k: count[name]++ };
      x += w + 2; aw = Math.max(aw, x); rowH = Math.max(rowH, h);
      return c;
    });
    const ah = y + rowH;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, aw); cv.height = Math.max(1, ah);
    const g = cv.getContext('2d');
    for (const c of cells) {
      g.save();
      g.beginPath(); g.rect(c.ax, c.ay, c.w, c.h); g.clip();
      g.translate(c.ax + pad * S - c.bb.x * k * S, c.ay + pad * S - c.bb.y * k * S);
      g.scale(k * S, k * S);
      const grad = g.createLinearGradient(0, vb.y, 0, vb.y + vb.height);
      grad.addColorStop(0, cTop); grad.addColorStop(1, cBot);
      g.fillStyle = grad;
      g.fill(new Path2D(c.p.getAttribute('d')), 'evenodd');
      g.restore();
    }
    gl.bindTexture(gl.TEXTURE_2D, textTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const vh = innerHeight;
    parts = cells.map((c) => {
      const left = rect.left + (c.bb.x - vb.x) * k - pad;
      const top = rect.top + (c.bb.y - vb.y) * k - pad;
      return { name: c.name, kind: KIND[c.name], k: c.k, sx: left * S, sy: (vh - top) * S - c.h, w: c.w, h: c.h, ax: c.ax, ay: c.ay };
    });
    const rc = cells.filter((c) => c.name === 'ring');
    const mx0 = Math.min(...rc.map((c) => c.bb.x)), mx1 = Math.max(...rc.map((c) => c.bb.x + c.bb.width));
    const my0 = Math.min(...rc.map((c) => c.bb.y)), my1 = Math.max(...rc.map((c) => c.bb.y + c.bb.height));
    const big = cells.find((c) => c.name === 'big');
    const axis = (vh - rect.bottom) * S;
    textBox = [cv.width, cv.height, (big ? big.bb.height * k : rect.height * 0.3) * 0.55 * S, axis];
    logoBox = [(rect.left + ((mx0 + mx1) / 2 - vb.x) * k) * S, (vh - rect.top - ((my0 + my1) / 2 - vb.y) * k) * S,
      axis - rect.height * 0.75 * S, (vh - rect.top + pad * 2) * S];
    if (stillT !== null) render(stillT);
  }
  logoReady.then(() => buildLogo());

  /* ------------------------------------------------------------ render */
  const B = {
    imp: new Float32Array(8), crown: new Float32Array(8), crownB: new Float32Array(8),
    jet: new Float32Array(8), box: new Float32Array(8),
    sph: new Float32Array(256), sphV: new Float32Array(256),
    drip: new Float32Array(DRIPS.flat()), letA: new Float32Array(80), letB: new Float32Array(80),
  };
  {
    const S = P.scene;
    gl.useProgram(S.prog);
    gl.uniform4fv(S.u.uDrip, B.drip);
    const Q = P.post;
    gl.useProgram(Q.prog);
    gl.uniform1i(Q.u.uScene, 0);
    gl.uniform1i(Q.u.uBloom, 1);
    gl.uniform1i(Q.u.uText, 2);
    // the dissolve settles on the homepage's deep navy, which shows through as the loader fades
    gl.uniform3f(Q.u.uBg, 20 / 255, 25 / 255, 44 / 255);
    gl.useProgram(P.bloom.prog);
    gl.uniform1i(P.bloom.u.uScene, 0);
  }

  let exitStart = null;
  const exitP = (t) => (exitStart === null ? 0 : smooth(0, 1, (t - exitStart) / EXIT_DUR));

  function drawScene(t) {
    const s = simulate(t);
    const S = P.scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fb);
    gl.viewport(0, 0, sceneT.w, sceneT.h);
    gl.useProgram(S.prog);
    gl.uniform1f(S.u.uTime, t);
    B.imp.set(s.imp.flat()); gl.uniform4fv(S.u.uImp, B.imp);
    B.crown.set(s.crown.flat()); gl.uniform4fv(S.u.uCrown, B.crown);
    B.crownB.set(s.crownB.flat()); gl.uniform4fv(S.u.uCrownB, B.crownB);
    B.jet.set(s.jet.flat()); gl.uniform4fv(S.u.uJet, B.jet);
    B.box.set(s.box.flat()); gl.uniform4fv(S.u.uBox, B.box);
    gl.uniform4fv(S.u.uArmA, s.armA);
    gl.uniform4fv(S.u.uArmB, s.armB);
    B.sph.fill(0); B.sphV.fill(0);
    s.sph.forEach((p, i) => {
      B.sph.set([p[0], p[1], p[2], p[3]], i * 4);
      const k = 0.5 * SHUTTER;
      B.sphV.set([p[4] * k, p[5] * k, p[6] * k, 0], i * 4);
    });
    gl.uniform4fv(S.u.uSph, B.sph);
    gl.uniform4fv(S.u.uSphV, B.sphV);
    gl.uniform1i(S.u.uSphN, s.sph.length);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, simOn ? simA.tex : textTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(S.u.uSim, 3);
    gl.uniform4f(S.u.uSimBox, SIM_X0, SIM_Z0, SIM_SIZE, simOn && (simLast || performance.now()) < simActiveUntil + 4000 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let shown = false;
  function render(t) {
    const T = TIERS[tier];
    drawScene(t);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
    if (T.bloom) {
      const Bp = P.bloom;
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomT.fb);
      gl.viewport(0, 0, bloomT.w, bloomT.h);
      gl.useProgram(Bp.prog);
      gl.uniform2f(Bp.u.uTexel, 1 / sceneT.w, 1 / sceneT.h);
      gl.uniform2f(Bp.u.uRes, bloomT.w, bloomT.h);
      gl.uniform1f(Bp.u.uEnc, enc);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    const Q = P.post;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(Q.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomT.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, textTex);
    gl.activeTexture(gl.TEXTURE0);
    const fpx = (canvas.height / 2) / tanH;            // focal length in output px
    gl.uniform2f(Q.u.uOut, canvas.width, canvas.height);
    gl.uniform2f(Q.u.uBloomTexel, 1 / bloomT.w, 1 / bloomT.h);
    gl.uniform1f(Q.u.uEnc, enc);
    gl.uniform1f(Q.u.uDofK, fpx * 0.0025);
    gl.uniform1f(Q.u.uDofMax, fpx * 0.0022);
    gl.uniform1f(Q.u.uSoft, fpx * 0.00026);
    gl.uniform1i(Q.u.uTaps, T.taps);
    gl.uniform1f(Q.u.uBloomK, T.bloom ? 0.32 : 0);
    gl.uniform1f(Q.u.uSeed, Math.random());
    gl.uniform1f(Q.u.uTime, t);
    gl.uniform1f(Q.u.uExit, exitP(t));
    gl.uniform1f(Q.u.uDpr, outS);
    let n = 0;
    if (t >= TEXT_AT - 0.01 || REDUCED) {
      parts.slice(0, 20).forEach((L, i) => {
        B.letA.set([L.sx, L.sy, L.w, L.h], i * 4);
        B.letB.set([L.ax, L.ay, partP(t, L), L.kind], i * 4);
        n++;
      });
    }
    gl.uniform4fv(Q.u.uLetA, B.letA);
    gl.uniform4fv(Q.u.uLetB, B.letB);
    gl.uniform1i(Q.u.uLetN, n);
    gl.uniform4f(Q.u.uTextBox, ...textBox);
    gl.uniform4f(Q.u.uLogo, ...logoBox);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!shown) { shown = true; root.classList.add('gl-ready'); }   // fade the canvas in over the CSS backdrop
  }

  // forces the GPU to finish, so CPU timers measure real GPU cost
  const px = new Uint8Array(4);
  function sync() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  // pick a tier from the cost of the heaviest moment (crown + spray), before anything is shown
  function benchmark() {
    tier = 0; extra = 1;
    resize();
    drawScene(2.5); sync();                           // warm-up: driver compiles lazily, clocks ramp up
    drawScene(2.5); sync();
    let ms = 1e9;                                     // best of four: ignores one-off hiccups
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now();
      drawScene(2.45 + i * 0.04); sync();
      ms = Math.min(ms, performance.now() - t0);
    }
    const budget = 8.5;
    tier = TIERS.length - 1;
    for (let i = 0; i < TIERS.length; i++) {
      if (ms * Math.pow(TIERS[i].mul / TIERS[0].mul, 2) < budget) { tier = i; break; }
    }
    if (tier === TIERS.length - 1) {
      const est = ms * Math.pow(TIERS[tier].mul, 2);
      extra = Math.max(0.6, Math.min(1, Math.sqrt(budget / est)));
    }
    return ms;
  }
  let benchMs = null;
  if (forced >= 0) tier = forced;
  else benchMs = benchmark();
  resize();
  addEventListener('resize', resize);

  // step down if the device still can't keep up during the splash
  let win = [], lastNow = 0;
  function adapt(now, t) {
    if (lastNow && forced < 0 && t > 2.1 && t < 6.5) {
      const dt = now - lastNow;
      if (dt < 250) {
        win.push(dt);
        if (win.length > 40) win.shift();
        if (win.length === 40 && win.reduce((a, b) => a + b, 0) / 40 > 21) {
          if (tier < TIERS.length - 1) tier++;
          else if (extra > 0.5) extra *= 0.85;
          win = [];
          resize();
        }
      }
    }
    lastNow = now;
  }

  // debugging / verification hooks
  let fpsWin = [];
  window.__ripple = {
    tier: () => TIERS[tier].name, extra: () => extra, benchMs: () => benchMs, enc: () => enc, compileMs: () => compileMs,
    fps: () => (fpsWin.length ? 1000 / (fpsWin.reduce((a, b) => a + b, 0) / fpsWin.length) : 0),
    renderAt: (t) => { render(t); },
    pick: (x, y) => pickWater(x, y),
    sim: () => ({ simOn, pokes: pokes.length, activeFor: simActiveUntil - performance.now(), simAcc }),
    sample: (fx, fy, t) => {
      if (t !== undefined) render(t);
      const o = new Uint8Array(4);
      gl.readPixels(Math.round(fx * (canvas.width - 1)), Math.round((1 - fy) * (canvas.height - 1)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, o);
      return Array.from(o.slice(0, 3));
    },
    frameMs: (t, n = 10) => {
      render(t); sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { render(t); sync(); }
      return (performance.now() - t0) / n;
    },
  };

  if (FREEZE !== null || REDUCED) {
    stillT = FREEZE !== null ? FREEZE : 9;
    if (FREEZE !== null && params.has('exit')) exitStart = FREEZE - parseFloat(params.get('exit')) * EXIT_DUR;
    render(stillT);
    addEventListener('resize', () => render(stillT));
    if (REDUCED && !HOLD) setTimeout(fadeOutLoader, 3500);
    return;
  }

  /* ------------------------------------------------------------ loop */
  let start = performance.now(), curT = 0, raf = 0, lastDraw = 0, hiddenAt = 0;
  const startExit = () => {
    if (exitStart !== null) return;
    exitStart = curT;
    skipBtn.classList.remove('show');
    beginSite();
    if (window.gsap) gsap.to(loaderEl, { opacity: 0, duration: EXIT_DUR / SPEED, ease: 'power2.in' });
  };
  skipBtn.addEventListener('click', startExit);
  function restart() {
    start = performance.now();
    exitStart = null;
    win = [];
    hideSite();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }
  replayBtn.addEventListener('click', restart);
  addEventListener('keydown', (e) => { if ((e.key === 'r' || e.key === 'R') && !e.target.closest('button')) restart(); });
  document.addEventListener('visibilitychange', () => {
    // pause the clock while the tab is hidden, so nobody misses the splash
    if (document.hidden) hiddenAt = performance.now();
    else if (hiddenAt) { start += performance.now() - hiddenAt; hiddenAt = 0; lastNow = 0; }
  });

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const t = ((now - start) / 1000) * SPEED;
    curT = t;
    adapt(now, t);
    skipBtn.classList.toggle('show', t > 1.5 && exitStart === null && t < TEXT_AT);
    if (exitStart === null && !HOLD && pageLoaded && t >= TEXT_END + EXIT_HOLD) startExit();
    if (exitStart !== null && t - exitStart >= EXIT_DUR) {
      cancelAnimationFrame(raf);
      finishSite();
      return;
    }
    simAdvance(now);
    // once only the rings are left, 30 fps is plenty and saves battery (unless someone is playing)
    if (t > 6.8 && exitStart === null && now > simActiveUntil && now - lastDraw < 31) return;
    if (lastDraw) { fpsWin.push(now - lastDraw); if (fpsWin.length > 60) fpsWin.shift(); }
    lastDraw = now;
    render(t);
  }
  // ?simtest: scripted taps, to check the wave physics without a pointer
  if (params.has('simtest')) {
    [[2.6, 1.2, 4.6], [3.0, -2.2, 3.2], [3.3, 0.6, 2.2]].forEach(([at, x, z]) =>
      setTimeout(() => poke(x, z, 0.13, 0.008), at * 1000));
  }
  raf = requestAnimationFrame(frame);
  // drive the loop by hand from devtools (e.g. when rAF is paused in a background tab)
  window.__ripple.step = (t) => frame(start + (t * 1000) / SPEED);
})();
