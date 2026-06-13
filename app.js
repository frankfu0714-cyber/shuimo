/* shuimo — UI, input handling, color management, render loop. */

(function () {
  'use strict';

  // ---------- i18n ----------

  // Traditional Chinese (zh-Hant) + English. All user-facing strings live
  // here; markup uses data-i18n / data-i18n-aria / data-i18n-title to bind.
  const STRINGS = {
    en: {
      'canvas.label':              'Ink in water canvas',
      'controls.label':            'Controls',
      'swatches.label':            'Ink color',
      'swatch.indigo':             'Indigo',
      'swatch.jade':               'Jade',
      'swatch.mustard':            'Mustard',
      'swatch.vermillion':         'Vermillion',
      'swatch.rainbow':            'Rainbow',
      'clear':                     'Clear',
      'clear.tooltip':             'Clear water',
      'save':                      'Save',
      'save.tooltip':              'Save PNG',
      'gestures.button':           'Gestures',
      'gestures.loading':          'Loading…',
      'gestures.disable':          'Disable',
      'gestures.denied.label':     'No camera',
      'gestures.failed.label':     'Failed',
      'gestures.tooltip':          'Toggle webcam gestures',
      'gestures.toast.enabled':    'Gestures on · pinch to drop · fist to clear',
      'gestures.toast.denied':     'No camera, no problem — mouse / touch still works',
      'gestures.toast.failed':     'Could not load gestures',
      'help':                      '?',
      'help.tooltip':              'Gesture guide',
      'help.title':                'Gestures',
      'help.stir.title':           'Stir',
      'help.stir.body':            'Move your fingertip — the water swirls around you.',
      'help.drop.title':           'Drop ink',
      'help.drop.body':            'Pinch thumb + index. One drop in the selected color.',
      'help.clear.title':          'Clear',
      'help.clear.body':           'Close into a fist for 0.8 seconds.',
      'help.mouse.title':          'Mouse / touch',
      'help.mouse.body':           'Tap to drop, drag to swirl. Always works, even without webcam.',
      'help.foot.pre':             'Tap outside or press ',
      'help.foot.post':            ' to close.',
      'lang':                      '中',
      'lang.tooltip':              'Switch language',
      'hint.center':               'Tap to drop ink · Drag to swirl',
      'noscript':                  '水墨 requires JavaScript and WebGL.',
      'edit_palette':              'Edit palette',
      'edit.tooltip':              'Customize ink palette',
      'done':                      'Done',
      'reset':                     'Reset',
      'reset.tooltip':             'Reset to default colors',
      'add_color':                 'Add color',
      'swatch.remove':             'Remove color',
      'swatch.custom':             'Custom color',
    },
    zh: {
      'canvas.label':              '水墨畫布',
      'controls.label':            '控制面板',
      'swatches.label':            '墨色選擇',
      'swatch.indigo':             '藍靛',
      'swatch.jade':               '翠綠',
      'swatch.mustard':            '鵝黃',
      'swatch.vermillion':         '朱紅',
      'swatch.rainbow':            '七彩',
      'clear':                     '清除',
      'clear.tooltip':             '清除水面',
      'save':                      '儲存',
      'save.tooltip':              '儲存為 PNG',
      'gestures.button':           '手勢',
      'gestures.loading':          '載入中…',
      'gestures.disable':          '停用',
      'gestures.denied.label':     '無攝影機',
      'gestures.failed.label':     '載入失敗',
      'gestures.tooltip':          '切換手勢',
      'gestures.toast.enabled':    '手勢已開啟 · 捏合滴墨 · 握拳清除',
      'gestures.toast.denied':     '沒關係 — 滑鼠 / 觸控仍可使用',
      'gestures.toast.failed':     '手勢載入失敗',
      'help':                      '?',
      'help.tooltip':              '手勢說明',
      'help.title':                '手勢說明',
      'help.stir.title':           '攪動',
      'help.stir.body':            '移動指尖 — 水會在你周圍旋轉。',
      'help.drop.title':           '滴墨',
      'help.drop.body':            '拇指與食指捏合，會滴下選定顏色的墨水。',
      'help.clear.title':          '清除',
      'help.clear.body':           '握拳維持 0.8 秒。',
      'help.mouse.title':          '滑鼠 / 觸控',
      'help.mouse.body':           '點擊滴墨，拖曳攪動。即使沒有開啟攝影機也能使用。',
      'help.foot.pre':             '點擊外側或按 ',
      'help.foot.post':            ' 鍵關閉。',
      'lang':                      'EN',
      'lang.tooltip':              '切換語言',
      'hint.center':               '點擊滴墨 · 拖曳攪動',
      'noscript':                  '水墨需要 JavaScript 與 WebGL。',
      'edit_palette':              '編輯顏色',
      'edit.tooltip':              '自訂墨色',
      'done':                      '完成',
      'reset':                     '重設',
      'reset.tooltip':             '回復預設顏色',
      'add_color':                 '新增顏色',
      'swatch.remove':             '移除顏色',
      'swatch.custom':             '自訂顏色',
    },
  };

  let currentLang = 'en';
  function t(key) {
    const d = STRINGS[currentLang] || STRINGS.en;
    return d[key] != null ? d[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
  }
  function detectInitialLang() {
    try {
      const saved = localStorage.getItem('shuimo.lang');
      if (saved === 'en' || saved === 'zh') return saved;
    } catch (e) {}
    return (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
  function applyLang(lang) {
    currentLang = lang;
    document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.setAttribute('title', t(el.dataset.i18nTitle));
    });
    if (window.Gestures && window.Gestures.refreshLabels) window.Gestures.refreshLabels();
  }
  function setLang(lang) {
    if (lang === currentLang) return;
    try { localStorage.setItem('shuimo.lang', lang); } catch (e) {}
    // Subtle fade across all translatable labels during the swap.
    document.body.classList.add('lang-fading');
    setTimeout(() => {
      applyLang(lang);
      document.body.classList.remove('lang-fading');
    }, 180);
  }

  // ---------- Color palette ----------

  // Cream "water" base — slightly warm with a hint of cool. RGB in [0,1].
  const BACK_COLOR = [0.965, 0.948, 0.895];

  // Original 4 classical inks — used as the default palette and as the
  // "Reset" target. Each entry has an i18n key so the aria-label translates;
  // user-added colors carry only their hex (aria-labelled by the hex string).
  const DEFAULT_PALETTE = [
    { id: 'indigo',     hex: '#1B3A6B', i18n: 'swatch.indigo' },
    { id: 'jade',       hex: '#2D6A4F', i18n: 'swatch.jade' },
    { id: 'mustard',    hex: '#D4A017', i18n: 'swatch.mustard' },
    { id: 'vermillion', hex: '#C53030', i18n: 'swatch.vermillion' },
  ];
  const MAX_PALETTE = 6;
  const NEW_COLOR_DEFAULT = '#E879A8';   // soft pink for newly-added slots

  function hexToRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }

  function isValidHex(h) { return typeof h === 'string' && /^#[0-9A-Fa-f]{6}$/.test(h); }

  // Mutable palette state — restored from localStorage on first render,
  // saved on every change. Each entry is { id, hex, i18n? }.
  let palette = (function load() {
    try {
      const raw = localStorage.getItem('shuimo.palette');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cleaned = [];
          for (const p of parsed) {
            if (p && typeof p.id === 'string' && isValidHex(p.hex)) {
              const def = DEFAULT_PALETTE.find((d) => d.id === p.id);
              cleaned.push(def
                ? { id: p.id, hex: p.hex, i18n: def.i18n }
                : { id: p.id, hex: p.hex });
            }
          }
          if (cleaned.length > 0) return cleaned;
        }
      }
    } catch (e) {}
    return DEFAULT_PALETTE.map((p) => ({ ...p }));
  })();

  function savePalette() {
    try {
      localStorage.setItem(
        'shuimo.palette',
        JSON.stringify(palette.map((p) => ({ id: p.id, hex: p.hex })))
      );
    } catch (e) {}
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
      // Velocity decays slowly so drag / waving / fingertip swirl
      // carries momentum and ink spreads like real water (instead of
      // damping out a quarter-second after the user moves).
      VELOCITY_DISSIPATION: 0.05,
      // Dye diffuses on its own — a still drop softens and slowly blooms
      // outward over many seconds, like real ink in still water. Live-
      // tunable as window.FLUID.DYE_DIFFUSION. Kept gentle: ambient
      // turbulence carries dye physically, so we don't lean on local
      // averaging too hard (otherwise drops "fade" instead of moving).
      DYE_DIFFUSION: 0.06,
      // Ambient water turbulence — tiny divergence-free curl-noise velocity
      // injected each step so existing dye drifts and swirls even with no
      // user input. Live-tunable as FLUID.AMBIENT_STRENGTH / SCALE / SPEED.
      AMBIENT_STRENGTH: 0.05,
      AMBIENT_SCALE: 2.5,
      AMBIENT_SPEED: 0.08,
      PRESSURE: 0.8,
      PRESSURE_ITERATIONS: 20,
      CURL: 28,
      SPLAT_RADIUS: 0.20,
      // Dye-drop knobs (independent of velocity splat). Live-tunable via
      // FLUID.DYE_SPLAT_RADIUS and FLUID.DROP_INK_INTENSITY from devtools.
      DYE_SPLAT_RADIUS: 0.50,
      // Each drop carries more ink — survives the diffusion + ambient
      // turbulence longer so visible identity persists.
      DROP_INK_INTENSITY: 2.0,
      SPLAT_FORCE: 6000,
      BACK_COLOR: BACK_COLOR,
    });
  } catch (e) {
    console.error(e);
    document.body.innerHTML = '<p style="position:fixed;inset:0;display:grid;place-items:center;font-family:serif;color:#3a3a3a;text-align:center;padding:24px;">水墨 needs WebGL.<br/><small>Your browser does not seem to support it.</small></p>';
    return;
  }

  // Expose the fluid config for live tuning from devtools, mirroring how
  // window.WAVE works for the wave layer. e.g. `FLUID.DYE_DIFFUSION = 0.06`.
  window.FLUID = sim.config;

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

  // ---------- Color selection + palette editor ----------

  let currentColorKey = palette[0] ? palette[0].id : 'rainbow';
  let editingPalette = false;
  let pickerTargetId = null;     // which slot the hidden <input type=color> is editing
  const swatchesEl = document.querySelector('.swatches');
  const picker = document.getElementById('palette-picker');

  function currentInkRGB() {
    if (currentColorKey === 'rainbow') return rainbowAt(performance.now() / 1000);
    const entry = palette.find((p) => p.id === currentColorKey);
    return entry ? hexToRGB(entry.hex) : hexToRGB(DEFAULT_PALETTE[0].hex);
  }

  function renderSwatches() {
    if (!swatchesEl) return;
    swatchesEl.innerHTML = '';
    for (const p of palette) {
      const btn = document.createElement('button');
      btn.className = 'swatch';
      btn.dataset.color = p.id;
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', p.id === currentColorKey ? 'true' : 'false');
      btn.style.setProperty('--c', p.hex);
      if (p.i18n) {
        btn.dataset.i18nAria = p.i18n;
        btn.setAttribute('aria-label', t(p.i18n));
      } else {
        btn.setAttribute('aria-label', t('swatch.custom') + ' ' + p.hex);
      }
      const x = document.createElement('span');
      x.className = 'swatch-x';
      x.dataset.role = 'remove';
      x.dataset.i18nAria = 'swatch.remove';
      x.setAttribute('aria-label', t('swatch.remove'));
      x.setAttribute('aria-hidden', editingPalette ? 'false' : 'true');
      x.textContent = '×';
      btn.appendChild(x);
      swatchesEl.appendChild(btn);
    }
    // Rainbow always present.
    const rb = document.createElement('button');
    rb.className = 'swatch rainbow';
    rb.dataset.color = 'rainbow';
    rb.type = 'button';
    rb.setAttribute('role', 'radio');
    rb.setAttribute('aria-checked', currentColorKey === 'rainbow' ? 'true' : 'false');
    rb.dataset.i18nAria = 'swatch.rainbow';
    rb.setAttribute('aria-label', t('swatch.rainbow'));
    swatchesEl.appendChild(rb);
    // "+" slot — only in edit mode, only if we have room.
    if (editingPalette && palette.length < MAX_PALETTE) {
      const plus = document.createElement('button');
      plus.className = 'swatch swatch-add';
      plus.type = 'button';
      plus.dataset.role = 'add';
      plus.dataset.i18nAria = 'add_color';
      plus.setAttribute('aria-label', t('add_color'));
      plus.textContent = '+';
      swatchesEl.appendChild(plus);
    }
    swatchesEl.classList.toggle('editing', editingPalette);
  }

  function openPicker(id) {
    const entry = palette.find((p) => p.id === id);
    if (!entry || !picker) return;
    pickerTargetId = id;
    picker.value = entry.hex;
    // Programmatic .click() works because we're inside a trusted click handler chain.
    picker.click();
  }

  // Event delegation on the swatches row — survives renderSwatches() rebuilds.
  if (swatchesEl) {
    swatchesEl.addEventListener('click', (e) => {
      // × remove takes priority over selecting the underlying swatch.
      const rm = e.target.closest('[data-role="remove"]');
      if (rm && editingPalette) {
        e.stopPropagation();
        const sw = rm.closest('.swatch');
        if (!sw) return;
        const id = sw.dataset.color;
        palette = palette.filter((p) => p.id !== id);
        if (currentColorKey === id) {
          currentColorKey = palette[0] ? palette[0].id : 'rainbow';
        }
        savePalette();
        renderSwatches();
        return;
      }
      const add = e.target.closest('[data-role="add"]');
      if (add && editingPalette && palette.length < MAX_PALETTE) {
        const id = 'custom-' + Date.now().toString(36);
        palette.push({ id, hex: NEW_COLOR_DEFAULT });
        currentColorKey = id;
        savePalette();
        renderSwatches();
        openPicker(id);
        return;
      }
      const sw = e.target.closest('.swatch');
      if (!sw) return;
      const id = sw.dataset.color;
      if (editingPalette && id !== 'rainbow') {
        // In edit mode, clicking a normal swatch opens its color picker
        // rather than selecting it as the active color.
        openPicker(id);
        return;
      }
      currentColorKey = id;
      swatchesEl.querySelectorAll('.swatch').forEach((s) => {
        s.setAttribute('aria-checked', s === sw ? 'true' : 'false');
      });
    });
  }

  if (picker) {
    picker.addEventListener('input', (e) => {
      const entry = palette.find((p) => p.id === pickerTargetId);
      if (!entry || !isValidHex(e.target.value)) return;
      entry.hex = e.target.value;
      savePalette();
      // Live preview — re-render to update the swatch background.
      renderSwatches();
    });
  }

  function setEditingPalette(on) {
    editingPalette = !!on;
    const btn = document.getElementById('btn-edit-palette');
    const reset = document.getElementById('btn-reset-palette');
    if (btn) {
      const label = btn.querySelector('.action-label');
      if (label) {
        label.dataset.i18n = editingPalette ? 'done' : 'edit_palette';
        label.textContent = t(editingPalette ? 'done' : 'edit_palette');
      }
      btn.classList.toggle('is-active', editingPalette);
    }
    if (reset) reset.hidden = !editingPalette;
    renderSwatches();
  }

  const editBtn = document.getElementById('btn-edit-palette');
  if (editBtn) editBtn.addEventListener('click', () => setEditingPalette(!editingPalette));
  const resetBtn = document.getElementById('btn-reset-palette');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      palette = DEFAULT_PALETTE.map((p) => ({ ...p }));
      currentColorKey = palette[0].id;
      savePalette();
      renderSwatches();
    });
  }

  // First render — has to happen after applyLang so the aria-labels use
  // the right language; applyLang is called from the init block below.
  renderSwatches();

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
    // Gentler radial nudge — the drop should mostly stay put and let
    // diffusion + ambient flow carry it. Force ~62% softer than before.
    const angle = Math.random() * Math.PI * 2;
    const force = 3;
    const dx = Math.cos(angle) * force;
    const dy = Math.sin(angle) * force;
    // Peak color magnitude per drop. Live-tunable via FLUID.DROP_INK_INTENSITY.
    // The splat itself uses FLUID.DYE_SPLAT_RADIUS for puddle size.
    const intensity = sim.config.DROP_INK_INTENSITY != null
      ? sim.config.DROP_INK_INTENSITY
      : 1.5;
    sim.splat(uv.x, uv.y, dx, dy, absorb.map((c) => c * intensity));
    // Tap rings the wave field — gently, so it doesn't blast the ink away.
    if (waves) waves.pulse(uv, 1.0);
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
    t,
    lang: () => currentLang,
    setLang,
  };

  // ---------- Gestures button (M2) ----------

  const gestBtn = document.getElementById('btn-gestures');
  gestBtn.addEventListener('click', () => {
    if (window.Gestures && window.Gestures.toggle) window.Gestures.toggle();
  });

  // ---------- Language toggle ----------

  applyLang(detectInitialLang());
  const langBtn = document.getElementById('btn-lang');
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      setLang(currentLang === 'zh' ? 'en' : 'zh');
    });
  }

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
