/* shuimo — UI, input handling, color management, render loop. */

(function () {
  'use strict';

  // ---------- Color palette ----------

  // Cream "water" base — slightly warm with a hint of cool. RGB in [0,1].
  const BACK_COLOR = [0.965, 0.948, 0.895];

  // Classical inks, RGB in [0,1].
  const INKS = {
    indigo:     hexToRGB('#1B3A6B'),
    jade:       hexToRGB('#2D6A4F'),
    mustard:    hexToRGB('#D4A017'),
    vermillion: hexToRGB('#C53030'),
  };

  function hexToRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }

  /* Absorbance = how much each channel removes from the cream background.
     Display shader does backColor - dye, so a splat of (back - ink) bends
     the visible color toward ink. Piling overlapping inks mixes subtractively
     (jade + mustard → muddier green-brown, not white). */
  function absorbance(rgb) {
    return [
      Math.max(0, BACK_COLOR[0] - rgb[0]),
      Math.max(0, BACK_COLOR[1] - rgb[1]),
      Math.max(0, BACK_COLOR[2] - rgb[2]),
    ];
  }

  function rainbowAt(t) {
    // HSL → RGB, full saturation, mid lightness.
    const h = (t * 0.18) % 1;            // cycle once every ~5.5s
    return hslToRGB(h, 0.78, 0.42);
  }

  function hslToRGB(h, s, l) {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
  }

  // ---------- Setup ----------

  const canvas = document.getElementById('stage');
  const hint = document.getElementById('hint');

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    if (sim) sim.resize(w, h);
    else { canvas.width = w; canvas.height = h; }
  }

  let sim;
  try {
    canvas.width = Math.floor(window.innerWidth * (window.devicePixelRatio || 1));
    canvas.height = Math.floor(window.innerHeight * (window.devicePixelRatio || 1));
    sim = new FluidSim(canvas, {
      SIM_RESOLUTION: 256,
      DYE_RESOLUTION: 1024,
      // Inks persist — water progressively muddies as drops accumulate.
      // The Clear button is the only way to reset.
      DENSITY_DISSIPATION: 0.0,
      VELOCITY_DISSIPATION: 0.28,
      PRESSURE: 0.8,
      PRESSURE_ITERATIONS: 20,
      CURL: 28,
      SPLAT_RADIUS: 0.20,
      SPLAT_FORCE: 6000,
      BACK_COLOR: BACK_COLOR,
    });
  } catch (e) {
    console.error(e);
    document.body.innerHTML = '<p style="position:fixed;inset:0;display:grid;place-items:center;font-family:serif;color:#3a3a3a;text-align:center;padding:24px;">水墨 needs WebGL.<br/><small>Your browser does not seem to support it.</small></p>';
    return;
  }

  // Wave-physics surface layer. Sits on top of the ink sim — the ink renders
  // into wave.inkTarget instead of straight to the canvas, then the wave
  // display shader samples it with refraction + Fresnel + specular.
  let waves = null;
  try {
    if (typeof Waves === 'function') waves = new Waves(sim);
  } catch (e) {
    console.warn('[shuimo] wave layer init failed:', e);
    waves = null;
  }

  resizeCanvas();
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (waves) waves.resize(sim.gl.drawingBufferWidth, sim.gl.drawingBufferHeight);
  });

  // ---------- Color selection ----------

  let currentColorKey = 'indigo';
  const swatches = document.querySelectorAll('.swatch');
  swatches.forEach((sw) => {
    sw.addEventListener('click', () => {
      currentColorKey = sw.dataset.color;
      swatches.forEach((s) => s.setAttribute('aria-checked', s === sw ? 'true' : 'false'));
    });
  });

  function currentInkRGB() {
    if (currentColorKey === 'rainbow') return rainbowAt(performance.now() / 1000);
    return INKS[currentColorKey];
  }

  // ---------- Input ----------

  // Pointer tracking — supports mouse, touch, pen via pointer events.
  const pointers = new Map();

  function pointerToUV(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: 1.0 - (clientY - rect.top) / rect.height,
    };
  }

  function dismissHint() {
    if (!hint || hint.classList.contains('fade')) return;
    hint.classList.add('fade');
    setTimeout(() => hint && hint.remove(), 800);
  }

  /* A tap drops ink with a small radial "bloom" — splat picks one direction;
     to feel spherical-ish we use a low-magnitude random velocity. The real
     spreading comes from the fluid solver propagating that velocity. */
  function tap(uv) {
    const ink = currentInkRGB();
    const absorb = absorbance(ink);
    // small radial nudge — random direction
    const angle = Math.random() * Math.PI * 2;
    const force = 8;
    const dx = Math.cos(angle) * force;
    const dy = Math.sin(angle) * force;
    // intensity tuned so single tap is a visible drop but not opaque
    const intensity = 0.85;
    sim.splat(uv.x, uv.y, dx, dy, absorb.map((c) => c * intensity));
    // Tap also rings the wave field so the drop visibly emanates outward.
    if (waves) waves.pulse(uv, 5.0);
  }

  function drag(prev, curr) {
    const dx = (curr.x - prev.x) * sim.canvas.width * 0.18;
    const dy = (curr.y - prev.y) * sim.canvas.height * 0.18;
    // Velocity-only injection — the inks in the water carry the swirl visibly.
    sim.splatVelocity(curr.x, curr.y, dx, dy);
    // Faint ink trail in the current color, low intensity so drag mostly swirls existing inks.
    const ink = currentInkRGB();
    const absorb = absorbance(ink);
    const trailStrength = 0.04;
    sim.splatTrail(curr.x, curr.y, absorb, trailStrength);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const uv = pointerToUV(e.clientX, e.clientY);
    // Track prevUv so the wave layer can stamp a capsule between frames.
    pointers.set(e.pointerId, { uv, prevUv: uv, moved: false, downAt: performance.now() });
    dismissHint();
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    const state = pointers.get(e.pointerId);
    // Hover (no button): emit gentle swirl so mouse can stir without clicking.
    if (!state) {
      if (e.pointerType !== 'mouse') return;
      if (!window._lastHover) { window._lastHover = pointerToUV(e.clientX, e.clientY); return; }
      const uv = pointerToUV(e.clientX, e.clientY);
      const dxClient = (uv.x - window._lastHover.x);
      const dyClient = (uv.y - window._lastHover.y);
      const mag = Math.hypot(dxClient, dyClient);
      if (mag > 0.002) {
        const dx = dxClient * sim.canvas.width * 0.06;
        const dy = dyClient * sim.canvas.height * 0.06;
        sim.splatVelocity(uv.x, uv.y, dx, dy);
      }
      window._lastHover = uv;
      return;
    }
    const uv = pointerToUV(e.clientX, e.clientY);
    const moved = Math.hypot(uv.x - state.uv.x, uv.y - state.uv.y);
    if (moved > 0.001) state.moved = true;
    drag(state.uv, uv);
    state.prevUv = state.uv;
    state.uv = uv;
    e.preventDefault();
  });

  function endPointer(e) {
    const state = pointers.get(e.pointerId);
    if (!state) return;
    const dt = performance.now() - state.downAt;
    // Quick non-drag press = tap → drop ink.
    if (!state.moved && dt < 400) tap(state.uv);
    pointers.delete(e.pointerId);
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', endPointer);

  // Auto-dismiss hint after 5s.
  setTimeout(dismissHint, 5000);

  // ---------- Buttons ----------

  document.getElementById('btn-clear').addEventListener('click', () => {
    sim.clearDye(1.0);
  });

  document.getElementById('btn-save').addEventListener('click', () => {
    // Force a render then read pixels. canvas already preserveDrawingBuffer.
    sim.render();
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `shuimo-${ts}.png`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // ---------- Render loop with adaptive resolution ----------

  let lastTime = performance.now();
  let slowFrames = 0;
  let halved = false;

  /* Build the per-frame capsule list: active pointers contribute their
     (prev → curr) UV pair; the gesture layer contributes its fingertip list
     (rebuilt at ~30 Hz inside processResult). Both feed the wave layer's
     continuous-contact stamps. Pointers also slide prev→curr per frame so
     the capsule shrinks back to a point when the user holds still. */
  function buildCapsules() {
    const caps = [];
    for (const state of pointers.values()) {
      caps.push({ curr: state.uv, prev: state.prevUv || state.uv });
      // Decay prev toward curr so a held-still pointer produces a clean
      // circular ripple rather than a streak.
      state.prevUv = state.uv;
    }
    if (window.Gestures && window.Gestures.getFingertips) {
      const tips = window.Gestures.getFingertips();
      for (let i = 0; i < tips.length; i++) caps.push(tips[i]);
    }
    return caps;
  }

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 1 / 30);
    lastTime = now;

    sim.step(dt);

    if (waves) {
      waves.setCapsules(buildCapsules());
      waves.step(dt);
      sim.render(waves.inkTarget);  // ink → offscreen
      waves.render();                // wave display shader → canvas
    } else {
      sim.render();
    }

    // Adaptive: if >5 consecutive frames over 22ms, halve sim res once.
    if (!halved) {
      if (dt > 0.022) slowFrames++;
      else slowFrames = Math.max(0, slowFrames - 1);
      if (slowFrames > 60) {
        sim.setSimResolution(Math.max(96, Math.round(sim.config.SIM_RESOLUTION / 2)));
        halved = true;
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---------- Initial flourish ----------

  // Tiny ambient drift so the water is alive before the first interaction.
  // A single faint indigo bloom near center.
  setTimeout(() => {
    sim.splat(0.5, 0.55, 0, 0, absorbance(INKS.indigo).map((c) => c * 0.5));
  }, 300);

  // ---------- API surface for gestures.js ----------

  window.shuimo = {
    sim,
    waves,
    canvas,
    currentInk: () => currentInkRGB(),
    absorbance,
    splat: (x, y, dx, dy, color) => sim.splat(x, y, dx, dy, color),
    splatVelocity: (x, y, dx, dy) => sim.splatVelocity(x, y, dx, dy),
    splatTrail: (x, y, color, strength) => sim.splatTrail(x, y, color, strength),
    clearDye: (sec) => sim.clearDye(sec),
    tap: (uv) => tap(uv),
    pulseWave: (uv, ampMul) => { if (waves) waves.pulse(uv, ampMul); },
    dismissHint,
  };

  // ---------- Gestures button (M2) ----------

  const gestBtn = document.getElementById('btn-gestures');
  gestBtn.addEventListener('click', () => {
    if (window.Gestures && window.Gestures.toggle) window.Gestures.toggle();
  });

  // ---------- Help overlay ----------

  const helpBtn = document.getElementById('btn-help');
  const helpOverlay = document.getElementById('help-overlay');
  if (helpBtn && helpOverlay) {
    const openHelp = () => {
      helpOverlay.hidden = false;
      // Move focus to the close button so Esc / Enter feel obvious.
      const close = helpOverlay.querySelector('.help-close');
      if (close) close.focus();
    };
    const closeHelp = () => { helpOverlay.hidden = true; helpBtn.focus(); };
    helpBtn.addEventListener('click', openHelp);
    helpOverlay.addEventListener('click', (e) => {
      if (e.target.dataset && 'close' in e.target.dataset) closeHelp();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !helpOverlay.hidden) closeHelp();
    });
  }
})();
