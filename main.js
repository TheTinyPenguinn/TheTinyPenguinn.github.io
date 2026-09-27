/* ==========================================================================
   main.js: starfield, reveal-on-scroll, reading time. No dependencies.
   ========================================================================== */

/* --------------------------------------------------------------------------
   STARFIELD: every tunable lives here.
   -------------------------------------------------------------------------- */
const STARFIELD = {
  seed: 20260926,          // same seed = same sky on every page
  maxStars: 380,           // hard cap, whatever the screen size
  density: 0.00026,        // stars per CSS px² (390×844 ≈ 86, 1440×900 ≈ 337)

  // Far → near. share: fraction of stars; size: core radius in CSS px;
  // alpha: peak brightness; depth: 0 to 1, how much it drifts and parallaxes;
  // softness: 0 = crisp point, 1 = out of focus (lower peak, wider halo).
  layers: [
    { share: 0.62, size: 0.5,  alpha: 0.34, depth: 0.22, softness: 0.95 },
    { share: 0.28, size: 0.75, alpha: 0.6,  depth: 0.5,  softness: 0.5 },
    { share: 0.10, size: 1.1,  alpha: 0.92, depth: 1.0,  softness: 0.1 },
  ],
  sizeVariance: 1.0,       // occasional larger stars (power-law), 0 = uniform
  glow: 4.5,               // halo radius as a multiple of core radius

  // Colour temperature: cool white → faint blue-white. share must sum to 1.
  tints: [
    { rgb: [246, 247, 255], share: 0.55 },
    { rgb: [226, 234, 255], share: 0.3 },
    { rgb: [204, 219, 255], share: 0.15 },
  ],

  drift: { x: 2.2, y: -0.7 }, // px per second for a depth-1 star
  parallax: 0.07,          // scroll factor for a depth-1 star (0.07 = 7% of scroll)

  // Scroll easing is a critically damped spring, stepped at a fixed 1/120s so
  // it behaves identically at 60Hz and 120Hz.
  scrollStiffness: 5.5,    // higher = catches up faster (≈ settles in 4/stiffness s)
  scrollMaxSpeed: 2400,    // px/s cap on the eased scroll, so fast flicks don't whip the sky

  edgeFalloff: 0.55,       // how much dimmer stars are at the viewport edges (0 to 1)
  quietDim: 0.6,           // star brightness on pages with <body data-sky="quiet"> (posts)
  // Posts sit slightly "further in" than home: moving between them dollies the
  // sky forward or back, with near layers spreading more than far ones.
  quietZoom: 1.035,
  arrivalMs: 1900,         // how long the dolly and brightness change take

  // Backdrop: faint nebula wash + centre lift + edge vignette, drawn once per resize.
  nebula: {
    blobs: 4,
    strength: 1,           // multiplies every nebula alpha; 0 = off
    palette: [[58, 70, 138], [34, 62, 104], [74, 62, 128]],
    centreLift: 0.35,      // brightens the middle of the sky slightly
    vignette: 0.75,        // darkens the corners
    parallax: 0.012,       // how much the wash moves with scroll
    travel: 140,           // max px the wash can move
  },

  idleFps: 30,             // redraw rate once scrolling has settled (drift only)
  fadeInMs: 1800,          // first visit of a session only
  introDelayMs: 320,       // first visit: the sky starts first, the hero follows
  maxDpr: 1.5,             // star-canvas resolution cap; soft sprites don't need more
  resizeDebounceMs: 150,
  storageKey: "sky",
  background: [8, 8, 10], // must match --bg in style.css
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* Small seeded PRNG (mulberry32). */
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readSkyState() {
  try {
    return JSON.parse(sessionStorage.getItem(STARFIELD.storageKey));
  } catch (e) {
    return null;
  }
}

function writeSkyState(state) {
  try {
    sessionStorage.setItem(STARFIELD.storageKey, JSON.stringify(state));
  } catch (e) {
    /* storage unavailable (private mode etc.): sky just restarts */
  }
}

function rgba(rgb, a) {
  return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
}

/* Scroll is read only in the scroll event and in ResizeObserver callbacks,
   never inside the paint loop. Shared by the starfield and the reveals. */
const scrollState = { y: window.scrollY, max: Infinity, velocity: 0, at: 0 };

function trackScroll() {
  const now = performance.now();
  const y = window.scrollY;
  const dt = now - scrollState.at;
  const v = dt > 0 && dt < 200 ? ((y - scrollState.y) / dt) * 1000 : 0;
  scrollState.velocity = scrollState.velocity * 0.5 + v * 0.5;
  scrollState.y = y;
  scrollState.at = now;
}

function scrollSpeed() {
  return performance.now() - scrollState.at > 120 ? 0 : Math.abs(scrollState.velocity);
}

function updateMaxScroll() {
  scrollState.max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
}

window.addEventListener("scroll", trackScroll, { passive: true });
window.addEventListener("resize", updateMaxScroll, { passive: true });
if ("ResizeObserver" in window) new ResizeObserver(updateMaxScroll).observe(document.body);

const firstVisitOfSession = !readSkyState();

function initStarfield() {
  const canvas = document.querySelector(".sky");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const backdrop = document.createElement("canvas");
  backdrop.className = "sky-backdrop";
  backdrop.setAttribute("aria-hidden", "true");
  canvas.parentNode.insertBefore(backdrop, canvas);
  const bctx = backdrop.getContext("2d");

  const cfg = STARFIELD;
  const saved = readSkyState();
  const N = cfg.maxStars;

  // Stars live in normalised 0 to 1 space, generated once from the seed, so every
  // page and viewport shares the same sky. Typed arrays: no per-frame garbage.
  const sx = new Float32Array(N);
  const sy = new Float32Array(N);
  const sLayer = new Uint8Array(N);
  const sTint = new Uint8Array(N);
  const sScale = new Float32Array(N);
  const sAlpha = new Float32Array(N);
  // Per-resize, in device pixels.
  const sRadius = new Float32Array(N);

  const rand = seededRandom(cfg.seed);
  const layerShare = cfg.layers.reduce((s, l) => s + l.share, 0);
  for (let i = 0; i < N; i++) {
    let pick = rand() * layerShare;
    let layer = 0;
    while (layer < cfg.layers.length - 1 && pick > cfg.layers[layer].share) {
      pick -= cfg.layers[layer].share;
      layer++;
    }
    let tpick = rand();
    let tint = 0;
    while (tint < cfg.tints.length - 1 && tpick > cfg.tints[tint].share) {
      tpick -= cfg.tints[tint].share;
      tint++;
    }
    sx[i] = rand();
    sy[i] = rand();
    sLayer[i] = layer;
    sTint[i] = tint;
    sScale[i] = 0.7 + Math.pow(rand(), 4) * cfg.sizeVariance;
    sAlpha[i] = 0.5 + Math.pow(rand(), 1.5) * 0.5;
  }

  const maxScale = 0.7 + cfg.sizeVariance;
  const layerDepth = new Float32Array(cfg.layers.map((l) => l.depth));
  const layerAlpha = new Float32Array(cfg.layers.map((l) => l.alpha));
  const tintCount = cfg.tints.length;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let count = 0;
  let sprites = [];       // [layer * tintCount + tint] → canvas
  let spriteRadius = [];  // same index → radius of the sprite at scale 1

  // Soft sprite: bright core, faint halo. Rendered once per layer × tint.
  function makeSprite(layer, rgb) {
    const s = layer.softness;
    const core = layer.size * dpr;
    const radius = Math.max(3, Math.ceil(core * cfg.glow * maxScale));
    const c = document.createElement("canvas");
    c.width = c.height = radius * 2;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
    const edge = Math.min(0.9, (1 / cfg.glow) * (1 + s * 0.9));
    grad.addColorStop(0, rgba(rgb, 1 - 0.45 * s));
    grad.addColorStop(edge * 0.55, rgba(rgb, 0.78 - 0.35 * s));
    grad.addColorStop(edge, rgba(rgb, 0.2 + 0.05 * s));
    grad.addColorStop(Math.min(0.95, edge * 2), rgba(rgb, 0.05 + 0.03 * s));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, radius * 2, radius * 2);
    return { canvas: c, radius: radius / maxScale };
  }

  // Backdrop at CSS-pixel resolution (smooth gradients don't need more), opaque,
  // dithered so the faint gradients never band.
  function renderBackdrop() {
    const neb = cfg.nebula;
    const w = width;
    const h = height + neb.travel;
    backdrop.width = w;
    backdrop.height = h;
    backdrop.style.height = h + "px";
    const g = bctx;
    const bg = cfg.background;
    g.fillStyle = rgba(bg, 1);
    g.fillRect(0, 0, w, h);

    const diag = Math.sqrt(width * width + height * height);
    const cx = w * 0.5;
    const cy = height * 0.4;

    if (neb.centreLift > 0) {
      const lift = g.createRadialGradient(cx, cy, 0, cx, cy, diag * 0.62);
      lift.addColorStop(0, "rgba(19, 21, 30," + neb.centreLift + ")");
      lift.addColorStop(1, "rgba(19, 21, 30, 0)");
      g.fillStyle = lift;
      g.fillRect(0, 0, w, h);
    }

    const nrand = seededRandom(cfg.seed + 1);
    for (let i = 0; i < neb.blobs; i++) {
      const rgb = neb.palette[i % neb.palette.length];
      const bx = w * (0.08 + nrand() * 0.84);
      const by = h * (0.05 + nrand() * 0.9);
      const r = Math.max(w, height) * (0.35 + nrand() * 0.35);
      const a = (0.022 + nrand() * 0.028) * neb.strength;
      const squash = 0.45 + nrand() * 0.35;
      const angle = nrand() * Math.PI;
      g.save();
      g.translate(bx, by);
      g.rotate(angle);
      g.scale(1, squash);
      const blob = g.createRadialGradient(0, 0, 0, 0, 0, r);
      blob.addColorStop(0, rgba(rgb, a));
      blob.addColorStop(0.5, rgba(rgb, a * 0.4));
      blob.addColorStop(1, rgba(rgb, 0));
      g.fillStyle = blob;
      g.fillRect(-r, -r, r * 2, r * 2);
      g.restore();
    }

    if (neb.vignette > 0) {
      const vcy = h * 0.46;
      const vig = g.createRadialGradient(cx, vcy, diag * 0.28, cx, vcy, diag * 0.8);
      vig.addColorStop(0, "rgba(4, 4, 6, 0)");
      vig.addColorStop(1, "rgba(4, 4, 6," + neb.vignette + ")");
      g.fillStyle = vig;
      g.fillRect(0, 0, w, h);
    }

    // Under ±1 level of seeded noise per channel removes 8-bit banding.
    try {
      const img = g.getImageData(0, 0, w, h);
      const d = img.data;
      const drand = seededRandom(cfg.seed + 2);
      for (let p = 0; p < d.length; p += 4) {
        const n = (drand() - 0.5) * 1.6;
        d[p] += n;
        d[p + 1] += n;
        d[p + 2] += n;
      }
      g.putImageData(img, 0, 0);
    } catch (e) {
      /* dithering is optional */
    }
  }

  function resize(force) {
    const nextDpr = Math.min(window.devicePixelRatio || 1, cfg.maxDpr);
    const nextW = canvas.clientWidth || window.innerWidth;
    const nextH = canvas.clientHeight || window.innerHeight;
    if (!force && nextW === width && nextH === height && nextDpr === dpr) return false;
    width = nextW;
    height = nextH;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    count = Math.min(N, Math.round(width * height * cfg.density));
    sprites = [];
    spriteRadius = [];
    for (let l = 0; l < cfg.layers.length; l++) {
      for (let t = 0; t < tintCount; t++) {
        const sp = makeSprite(cfg.layers[l], cfg.tints[t].rgb);
        sprites.push(sp.canvas);
        spriteRadius.push(sp.radius);
      }
    }
    for (let i = 0; i < N; i++) {
      sRadius[i] = spriteRadius[sLayer[i] * tintCount + sTint[i]] * sScale[i];
    }
    renderBackdrop();
    return true;
  }

  const quiet = document.body.getAttribute("data-sky") === "quiet";
  const pageZoom = quiet ? cfg.quietZoom : 1;
  const pageDim = quiet ? cfg.quietDim : 1;

  // Clamped so rubber-band overscroll at either end never drags the sky.
  function scrollGoal() {
    const y = scrollState.y;
    return y < 0 ? 0 : y > scrollState.max ? scrollState.max : y;
  }

  let time = 0;
  let scrollPos = scrollGoal();
  let scrollVel = 0;
  let zoom = pageZoom;
  let dim = pageDim;
  let arrival = null; // { z0, d0, start }

  // Arriving from another page: carry over its drift time, parallax, depth and
  // brightness, then ease to this page's values, so it reads as one sky.
  function arrive(state) {
    if (!state || typeof state.t !== "number") return;
    time = state.t + Math.max(0, (Date.now() - state.at) / 1000);
    if (typeof state.scroll === "number") scrollPos = state.scroll;
    scrollVel = 0;
    const z0 = typeof state.z === "number" ? state.z : pageZoom;
    const d0 = typeof state.dim === "number" ? state.dim : pageDim;
    if (reducedMotion.matches) return;
    zoom = z0;
    dim = d0;
    if (z0 !== pageZoom || d0 !== pageDim) arrival = { z0, d0, start: -1 };
  }
  arrive(saved);

  let backdropY = NaN;

  function draw() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const dx = time * cfg.drift.x * dpr;
    const dy = time * cfg.drift.y * dpr;
    const sp = scrollPos * cfg.parallax * dpr;
    const fall = cfg.edgeFalloff;
    const invW = 1 / W;
    const invH = 1 / H;
    const cx = W * 0.5;
    const cy = H * 0.42;
    const zk = zoom - 1;
    for (let i = 0; i < count; i++) {
      const d = layerDepth[sLayer[i]];
      const r = sRadius[i];
      const spanW = W + 2 * r;
      const spanH = H + 2 * r;
      let x = (sx[i] * W + dx * d + r) % spanW;
      if (x < 0) x += spanW;
      x -= r;
      let y = (sy[i] * H + (dy - sp) * d + r) % spanH;
      if (y < 0) y += spanH;
      y -= r;
      if (zk !== 0) {
        const z = 1 + zk * d;
        x = cx + (x - cx) * z;
        y = cy + (y - cy) * z;
      }
      // Soft radial falloff: stars near the edges are dimmer.
      const nx = x * invW - 0.5;
      const ny = y * invH - 0.42;
      let e = (nx * nx + ny * ny) * 2.4 - 0.12;
      e = e < 0 ? 0 : e > 1 ? 1 : e;
      ctx.globalAlpha = layerAlpha[sLayer[i]] * sAlpha[i] * dim * (1 - fall * e * e * (3 - 2 * e));
      ctx.drawImage(sprites[sLayer[i] * tintCount + sTint[i]], x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    const by = -Math.min(cfg.nebula.travel, Math.max(0, scrollPos * cfg.nebula.parallax));
    if (Math.abs(by - backdropY) > 0.05 || backdropY !== backdropY) {
      backdropY = by;
      backdrop.style.transform = "translate3d(0," + by.toFixed(2) + "px,0)";
    }
  }

  const STEP = 1 / 120;
  function stepScroll(dt) {
    const target = scrollGoal();
    const w = cfg.scrollStiffness;
    const maxV = cfg.scrollMaxSpeed;
    let left = dt;
    while (left > 1e-6) {
      const h = left < STEP ? left : STEP;
      const acc = w * w * (target - scrollPos) - 2 * w * scrollVel;
      scrollVel += acc * h;
      if (scrollVel > maxV) scrollVel = maxV;
      else if (scrollVel < -maxV) scrollVel = -maxV;
      scrollPos += scrollVel * h;
      left -= h;
    }
    return Math.abs(scrollVel) < 0.5 && Math.abs(target - scrollPos) < 0.5;
  }

  function stepArrival(now) {
    if (!arrival) return true;
    if (arrival.start < 0) arrival.start = now;
    const k = Math.min(1, (now - arrival.start) / cfg.arrivalMs);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    zoom = arrival.z0 + (pageZoom - arrival.z0) * e;
    dim = arrival.d0 + (pageDim - arrival.d0) * e;
    if (k >= 1) arrival = null;
    return false;
  }

  let rafId = 0;
  let last = 0;
  let lastDraw = 0;
  const idleInterval = 1000 / cfg.idleFps;

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    time += dt;
    const settled = stepScroll(dt) & stepArrival(now);
    if (settled && now - lastDraw < idleInterval) return;
    lastDraw = now;
    draw();
  }

  function start() {
    if (rafId || reducedMotion.matches || document.hidden) return;
    last = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function save() {
    writeSkyState({ t: time, at: Date.now(), scroll: scrollPos, z: zoom, dim: dim });
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (resize(false)) draw();
    }, cfg.resizeDebounceMs);
  }

  function onVisibility() {
    if (document.hidden) {
      stop();
      save();
    } else {
      start();
    }
  }

  // Back/forward cache: the page resumes as it was left, so re-arrive from
  // wherever the sky is now.
  function onPageShow(ev) {
    if (!ev.persisted) return;
    arrive(readSkyState());
    draw();
    start();
  }

  function onMotionChange() {
    if (reducedMotion.matches) {
      stop();
      scrollPos = scrollVel = 0;
      arrival = null;
      zoom = pageZoom;
      dim = pageDim;
      draw();
    } else {
      scrollPos = scrollGoal();
      start();
    }
  }

  resize(true);
  if (reducedMotion.matches) scrollPos = 0;
  draw(); // first frame is drawn synchronously so the sky is there on first paint

  // Fade in once per session; instant on every page after that.
  const layers = [backdrop, canvas];
  if (!saved && !reducedMotion.matches) {
    layers.forEach((el) => { el.style.transition = "opacity " + cfg.fadeInMs + "ms cubic-bezier(0.33, 0, 0.2, 1)"; });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      layers.forEach((el) => { el.style.opacity = "1"; });
    }));
  } else {
    layers.forEach((el) => { el.style.opacity = "1"; });
  }
  save();

  // Listeners are added exactly once.
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", save);
  window.addEventListener("pageshow", onPageShow);
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener("change", onMotionChange);
  }

  start();
}

/* --------------------------------------------------------------------------
   REVEAL: entrances, once, when an element scrolls into view.
     data-reveal          rise: fade + rise + light blur (list items, cards)
     data-reveal="focus"  focus pull: blur clears with almost no movement (hero)
     data-reveal="fade"   opacity only (section labels)
   Section hairlines draw in from the left as their section arrives.
   Timings are CSS variables in style.css.
   -------------------------------------------------------------------------- */
const REVEAL = {
  fastScroll: 1800,        // px/s: above this, items appear with a short fade instead
  maxStaggerSteps: 5,      // later items in a big batch don't wait forever
  rootMargin: "0px 0px -12% 0px", // fire once an item is 12% clear of the bottom edge
};

function initReveal() {
  const items = Array.from(document.querySelectorAll("[data-reveal]"));
  const lines = Array.from(document.querySelectorAll(".section"));
  const showAll = () => {
    items.forEach((el) => el.classList.add("is-visible", "is-done"));
    lines.forEach((el) => el.classList.add("is-drawn"));
  };

  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    showAll();
    return;
  }

  const root = document.documentElement;
  if (firstVisitOfSession) {
    root.style.setProperty("--intro-delay", STARFIELD.introDelayMs + "ms");
    setTimeout(() => root.style.removeProperty("--intro-delay"), 2000);
  }

  function finish(el) {
    el.addEventListener("transitionend", function done(ev) {
      if (ev.target !== el || (ev.propertyName !== "transform" && ev.propertyName !== "opacity")) return;
      el.classList.add("is-done");
      el.removeEventListener("transitionend", done);
    });
  }

  const order = new Map(items.concat(lines).map((el, i) => [el, i]));
  const observer = new IntersectionObserver(
    (entries) => {
      const entering = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => order.get(a.target) - order.get(b.target));
      const fast = scrollSpeed() > REVEAL.fastScroll;
      let step = 0;
      entering.forEach((entry) => {
        const el = entry.target;
        observer.unobserve(el);
        if (el.classList.contains("section")) {
          el.classList.add("is-drawn");
          return;
        }
        if (entry.boundingClientRect.top < 0) {
          // Already scrolled past (back navigation, scrolling up): no show.
          el.classList.add("is-instant", "is-visible", "is-done");
        } else if (fast) {
          el.classList.add("is-quick", "is-visible");
          finish(el);
        } else {
          el.style.setProperty("--reveal-i", Math.min(step++, REVEAL.maxStaggerSteps));
          el.classList.add("is-visible");
          finish(el);
        }
      });
    },
    { rootMargin: REVEAL.rootMargin, threshold: 0 }
  );

  items.forEach((el) => observer.observe(el));
  lines.forEach((el) => observer.observe(el));
}

/* --------------------------------------------------------------------------
   READING TIME: counts words in .prose, at 220 words per minute.
   -------------------------------------------------------------------------- */
function initReadingTime() {
  const out = document.querySelector("[data-reading-time]");
  const body = document.querySelector(".prose");
  if (!out || !body) return;
  const words = (body.textContent.trim().match(/\S+/g) || []).length;
  out.textContent = Math.max(1, Math.round(words / 220)) + " min read";
  out.hidden = false;
  const sep = document.querySelector("[data-reading-time-sep]");
  if (sep) sep.hidden = false;
}

window.__siteReady = true;
initStarfield();
initReveal();
initReadingTime();
