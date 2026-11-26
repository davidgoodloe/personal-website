// The climb: the printed 3D model stays pinned behind the page, and scrolling moves the camera
// up David's route (trailhead -> lower and upper glacier -> southeast ridge -> summit). The line keeps
// climbing the whole time you scroll, easing a little as it nears each camp so the stops still register.
// Scrolling is completely native - the 3D scene just reads the scroll position.
(function () {
  const T = window.TERRAIN;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const S = 1 / 1000, RELIEF = 0.62, YAW0 = Math.PI + 0.5;
  const MIN_M = 376, SPAN_M = 2385;  // DEM range used at build, to turn heights back into metres
  const layers = T.layers.map((L) => {
    const rings = L.r.map((r) => r.map((v) => v * S));
    const lens = rings.map((r) => { let s = 0; for (let k = 2; k < r.length; k += 2) s += Math.hypot(r[k] - r[k - 2], r[k + 1] - r[k - 1]); return s; });
    return { z: L.z * S, index: !!L.i, rings, lens, total: lens.reduce((a, b) => a + b, 0) };
  });
  const route = [];
  for (let k = 0; k < T.route.length; k += 3) route.push([T.route[k] * S, T.route[k + 1] * S, T.route[k + 2] * S]);
  const metres = (h) => (h - 0.01) * SPAN_M + MIN_M;
  const idxAt = (m) => { const i = route.findIndex((p) => metres(p[2]) >= m); return i < 0 ? route.length - 1 : i; };

  // Camps along the real line. u = position along the route, 0..1
  const N = route.length - 1;
  const CAMPS = [
    { i: 0, label: 'Trailhead' },
    { i: idxAt(2124), label: 'Lower glacier' },
    { i: idxAt(2300), label: 'Upper glacier' },
    { i: idxAt(2453), label: 'Southeast Ridge' },
    { i: N, label: 'Summit' },
  ].map((c) => ({ ...c, u: c.i / N }));
  // "at" a camp = within a fifth of the way to its nearest neighbour (labels, HUD)
  CAMPS.forEach((c, k) => {
    const gaps = [CAMPS[k - 1], CAMPS[k + 1]].filter(Boolean).map((o) => Math.abs(o.u - c.u));
    c.win = 0.2 * Math.min(...gaps);
  });
  window.CAMPS = CAMPS;

  const pointAt = (u) => {
    const f = Math.min(N, Math.max(0, u * N)), i = Math.floor(f), t = f - i, a = route[i], b = route[Math.min(N, i + 1)];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };

  const canvas = document.getElementById('terrain');
  // opaque canvas: the compositor doesn't have to blend a full-screen layer every frame
  const ctx = canvas.getContext('2d', { alpha: false });
  let cw = 0, ch = 0, colors = null, dirty = true;
  // Drawing ~40 filled contour layers is GPU work whose cost grows with canvas pixels (and is much
  // heavier in some browsers, e.g. Chrome on Windows on a big external monitor). Cap the backing
  // store, and drop resolution further - even below 1x - if this machine keeps dropping frames.
  const PX_CAP = 5e6;
  let quality = 1;
  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const trip = (n) => s.getPropertyValue(n).trim().split(',').map(Number);
    colors = { f0: trip('--t-fill0'), f1: trip('--t-fill1'), line: s.getPropertyValue('--t-line').trim(),
      idx: s.getPropertyValue('--t-index').trim(), accent: (s.getPropertyValue('--route') || s.getPropertyValue('--accent')).trim(),
      fg: s.getPropertyValue('--fg').trim(), muted: s.getPropertyValue('--muted').trim(), bg: (s.getPropertyValue('--table') || s.getPropertyValue('--bg')).trim() };
    for (const L of layers) { const f = colors.f0.map((c, i) => Math.round(c + (colors.f1[i] - c) * L.z)); L.fill = `rgb(${f[0]},${f[1]},${f[2]})`; }
    dirty = true;
  }
  function resize() {
    cw = innerWidth; ch = innerHeight;
    const dev = window.devicePixelRatio || 1;
    // never softer than half the screen's density (so a retina Mac stays at >= 1x), or 0.6x overall
    const dpr = Math.max(0.6, Math.min(1, dev * 0.5), Math.min(2, dev, Math.sqrt(PX_CAP / (cw * ch))) * quality);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    measure();
    dirty = true;
  }

  function render(st) {
    const { yaw, pitch, printH, zoom, target, ax, ay, u, routeIn } = st;
    ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, cw, ch);
    ctx.lineJoin = 'bevel'; ctx.lineCap = 'butt'; // cheapest joins for the many-vertex contour strokes
    const wide = cw > 900;
    const cx = cw * ax, cy = ch * ay;
    const dist = 3.6, scale = Math.min(cw * (wide ? 0.3 : 0.44), ch * 0.5) * dist * zoom;
    const c0 = Math.cos(yaw), s0 = Math.sin(yaw), ca = Math.cos(pitch), sa = Math.sin(pitch);
    const [tx, tz, th] = target;
    const p = [0, 0, 0];
    const proj = (X, Z, h) => {
      const y = (h - th) * RELIEF, x0 = X - tx, z0 = Z - tz;
      const x1 = x0 * c0 - z0 * s0, z1 = x0 * s0 + z0 * c0;
      const depth = Math.max(0.15, -y * sa + z1 * ca + dist);
      p[0] = cx + (scale * x1) / depth; p[1] = cy - (scale * (y * ca + z1 * sa)) / depth; p[2] = depth;
    };
    let prevZ = 0;
    for (const L of layers) {
      if (L.z > printH) {
        const frac = Math.max(0, Math.min(1, (printH - prevZ) / (L.z - prevZ)));
        if (frac > 0) {
          let budget = frac * L.total, end = null;
          ctx.beginPath();
          for (let r = 0; r < L.rings.length && budget > 0; r++) {
            const ring = L.rings[r];
            proj(ring[0], ring[1], L.z); ctx.moveTo(p[0], p[1]);
            for (let k = 2; k < ring.length && budget > 0; k += 2) {
              const seg = Math.hypot(ring[k] - ring[k - 2], ring[k + 1] - ring[k - 1]), t = Math.min(1, budget / (seg || 1e-9));
              proj(ring[k - 2] + (ring[k] - ring[k - 2]) * t, ring[k - 1] + (ring[k + 1] - ring[k - 1]) * t, L.z);
              ctx.lineTo(p[0], p[1]); end = [p[0], p[1]]; budget -= seg;
            }
          }
          ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.4; ctx.stroke();
          if (end) { ctx.fillStyle = colors.accent; ctx.beginPath(); ctx.arc(end[0], end[1], 2.6, 0, 7); ctx.fill(); }
        }
        break;
      }
      ctx.beginPath();
      for (const ring of L.rings) {
        for (let k = 0; k < ring.length; k += 2) { proj(ring[k], ring[k + 1], L.z); k === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); }
        ctx.closePath();
      }
      ctx.fillStyle = L.fill; ctx.fill('evenodd');
      ctx.strokeStyle = L.index ? colors.idx : colors.line; ctx.lineWidth = L.index ? 1.1 : 0.7; ctx.stroke();
      prevZ = L.z;
    }
    if (routeIn <= 0) return;
    ctx.globalAlpha = routeIn;
    // the line still ahead of you: faint and dashed
    ctx.beginPath();
    for (let i = 0; i <= N; i++) { proj(route[i][0], route[i][1], route[i][2]); i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); }
    ctx.setLineDash([3, 5]); ctx.strokeStyle = colors.accent; ctx.globalAlpha = 0.45 * routeIn; ctx.lineWidth = 1.3; ctx.stroke(); ctx.setLineDash([]);
    // the line you've climbed: solid
    ctx.globalAlpha = routeIn;
    const n = Math.floor(u * N);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) { proj(route[i][0], route[i][1], route[i][2]); i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); }
    const me = pointAt(u); proj(me[0], me[1], me[2]); ctx.lineTo(p[0], p[1]);
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    // camps
    ctx.font = '600 13px "IBM Plex Sans Condensed", "IBM Plex Sans", sans-serif'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    CAMPS.forEach((c, k) => {
      proj(route[c.i][0], route[c.i][1], route[c.i][2]);
      const here = Math.abs(u - c.u) < c.win, passed = u >= c.u - 0.004;
      ctx.beginPath(); ctx.arc(p[0], p[1], here ? 6 : 4.5, 0, 7);
      ctx.fillStyle = passed ? colors.accent : colors.bg; ctx.fill();
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.5; ctx.stroke();
      if (zoom > 1.25 ? here : (k === 0 || k === CAMPS.length - 1)) { // the left rail lists the rest
        // a halo in the table colour keeps the label legible over contour lines
        ctx.lineWidth = 4; ctx.strokeStyle = colors.bg; ctx.strokeText(c.label, p[0] + 12, p[1]);
        ctx.fillStyle = here ? colors.fg : colors.muted;
        ctx.fillText(c.label, p[0] + 12, p[1]);
      }
    });
    // you are here
    proj(me[0], me[1], me[2]);
    ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, 7); ctx.fillStyle = colors.fg; ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ---- scroll -> journey position ----
  // Each camp section has an arrival point; between two arrivals the climber moves steadily up the
  // line, slowing a little near each camp (PULL) so the stops feel like stops without ever freezing.
  const PULL = 0.55; // 0 = even pace all the way, 1 = comes to a full stop at every camp
  let marks = [];
  function measure() {
    const vh = innerHeight, maxY = document.documentElement.scrollHeight - vh;
    marks = [...document.querySelectorAll('[data-camp]')].map((el) => ({
      at: Math.max(0, Math.min(maxY, el.getBoundingClientRect().top + scrollY - vh * 0.25)), // last one must be reachable
      k: +el.dataset.camp,
    }));
    dirty = true;
  }
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / ((b - a) || 1))); return t * t * (3 - 2 * t); };
  const glide = (t) => (1 - PULL) * t + PULL * t * t * (3 - 2 * t);
  function journey(y) {
    if (!marks.length) return { u: 0, z: 0 };
    if (y < marks[0].at) return { u: 0, z: smooth(innerHeight * 0.15, marks[0].at, y) };
    for (let m = 0; m < marks.length - 1; m++) {
      const c = marks[m], next = marks[m + 1];
      if (y < next.at) {
        const t = (y - c.at) / ((next.at - c.at) || 1);
        return { u: CAMPS[c.k].u + (CAMPS[next.k].u - CAMPS[c.k].u) * glide(t), z: 1 };
      }
    }
    return { u: CAMPS[marks[marks.length - 1].k].u, z: 1 };
  }

  // ---- drag to orbit (hero and the open model areas) ----
  let yawOff = 0, pitchOff = 0, vel = 0, dragging = false, lx = 0, ly = 0, lt = 0;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; vel = 0; lx = e.clientX; ly = e.clientY; lt = performance.now(); canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing'); document.getElementById('drag-hint')?.classList.add('used'); });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now(), dt = Math.max(1, now - lt) / 1000, d = (e.clientX - lx) * 0.008;
    yawOff += d; pitchOff = Math.max(-0.3, Math.min(0.6, pitchOff + (e.clientY - ly) * 0.005)); vel = d / dt;
    lx = e.clientX; ly = e.clientY; lt = now;
  });
  const end = () => { if (!dragging) return; dragging = false; canvas.classList.remove('grabbing'); if (performance.now() - lt > 80) vel = 0; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);

  // ---- frame ----
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const easeIO = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  const hud = document.getElementById('hud'), hudCamp = document.getElementById('hud-camp'), hudM = document.getElementById('hud-m');
  let uS = 0, zS = 0, clock = 0, born = performance.now(), last = born, spin = 0, prevKey = '', zOut = '', hudText = '', hudOp = '';
  // Frame watchdog: if this machine keeps dropping frames (intervals well over the display's own
  // frame time) for two windows running, step the resolution down. A steady capped rate (30Hz
  // low-power mode) isn't a drop, and a one-off hitch (tab switch, GC) doesn't count.
  let win = [], strikes = 0;
  const watch = (interval) => {
    if (document.hidden || clock < 0.5 || interval > 250) return;
    win.push(interval);
    if (win.length < 30) return;
    const base = Math.min(...win), dropped = win.filter((v) => v > base * 1.6).length;
    strikes = dropped > 8 ? strikes + 1 : 0;
    if (strikes >= 2 && quality > 0.45) { quality *= 0.75; strikes = 0; resize(); }
    win = [];
  };
  const setText = (el, v, prev) => { if (v !== prev) el.textContent = v; return v; };
  let hudCampText = '';
  function frame(now) {
    const raw = (now - last) / 1000; last = now;
    const dt = Math.min(0.1, raw);
    // The intro runs on its own clock that never jumps more than a 30fps frame, so a stall
    // (page still loading, slow GPU) slows the print down instead of skipping ahead.
    // ...and it waits for the page to finish loading (up to ~1.2s) so the print doesn't compete with it.
    if (document.readyState === 'complete' || now - born > 1200) clock += Math.min(dt, 1 / 30);
    const t = reduce ? 99 : clock;
    const j = journey(scrollY);
    const a = reduce ? 1 : 1 - Math.exp(-dt * 5);
    uS += (j.u - uS) * a; zS += (j.z - zS) * a;
    if (Math.abs(j.u - uS) < 1e-5) uS = j.u;
    if (Math.abs(j.z - zS) < 1e-4) zS = j.z;
    if (!dragging) { yawOff += vel * dt; vel *= Math.exp(-dt * 2.2); if (Math.abs(vel) < 1e-4) vel = 0; }
    spin += (reduce ? 0 : 0.05) * (1 - zS) * dt;       // slow spin only while you're on the overview
    const wide = innerWidth > 900, k = ease(t / 3.2);
    const me = pointAt(uS);
    const st = {
      yaw: YAW0 - (1 - k) * 0.5 + spin + yawOff + zS * uS * 0.9,
      pitch: Math.min(1.35, Math.max(0.2, 0.52 + (1 - k) * 0.3 + zS * 0.22 + pitchOff)),
      printH: easeIO((t - 0.3) / 4.2),
      zoom: (0.94 + 0.06 * k) * lerp(1, wide ? 2.1 : 2.4, zS),
      target: [lerp(0, me[0], zS), lerp(0, me[1], zS), lerp(0, me[2], zS)],
      ax: wide ? lerp(0.68, 0.19, zS) : 0.5,
      ay: wide ? lerp(0.44, 0.56, zS) : lerp(0.36, 0.4, zS),
      u: uS,
      routeIn: easeIO((t - 1.2) / 4.6),
    };
    // only redraw when the picture would actually change (parked mid-page = no GPU work at all)
    const key = [st.yaw, st.pitch, st.printH, st.zoom, st.ax, st.ay, st.u, st.routeIn, ...st.target].map((v) => v.toFixed(5)).join();
    if (dirty || key !== prevKey) {
      render(st);
      if (!dirty && prevKey) watch(raw * 1000);
      prevKey = key; dirty = false;
    }
    const z = zS.toFixed(3);
    if (z !== zOut) { document.documentElement.style.setProperty('--z', z); zOut = z; }
    if (hud) {
      const m = Math.round(metres(me[2]));
      const near = CAMPS.reduce((b, c) => (Math.abs(c.u - uS) < Math.abs(b.u - uS) ? c : b));
      hudCampText = setText(hudCamp, Math.abs(near.u - uS) < near.win ? near.label : `Climbing to the ${(CAMPS.find((c) => c.u > uS + 0.005)?.label || 'summit').toLowerCase()}`, hudCampText);
      hudText = setText(hudM, (uS > 0.995 ? '9,131' : Math.round(m * 3.28084).toLocaleString()) + ' ft', hudText);
      const op = zS > 0.5 ? '1' : '0';
      if (op !== hudOp) { hud.style.opacity = op; hudOp = op; }
    }
    requestAnimationFrame(frame);
  }
  readColors(); resize();
  addEventListener('resize', resize);
  addEventListener('load', measure);
  new ResizeObserver(measure).observe(document.body);
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  requestAnimationFrame(frame);
})();
