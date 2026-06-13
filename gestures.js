/*
 * shuimo — M2 webcam gesture stack
 *
 * Builds on MediaPipe Tasks Vision (HandLandmarker, the new JS API —
 * NOT legacy @mediapipe/hands). Loaded lazily via dynamic import the first
 * time the user enables gestures, so M1 stays zero-cost for visitors who
 * never opt in.
 *
 * Visual design (per Frank's 希彼赫 reference): the user's actual hand is
 * composited over the fluid via a mirrored <video> with mix-blend-mode.
 * Landmarks drive splat events; the user sees themselves "in the water."
 *
 * Gestures:
 *   - Index fingertip motion → velocity injection (swirl)
 *   - Thumb+index pinch (edge-debounced) → drop ink in current swatch color
 *   - Two hands → two independent swirl+pinch tracks
 *   - One open palm held still ≥ 1.5s → trigger Clear (progress ring shown)
 */

(function () {
  'use strict';

  // ---------- Config ----------

  const TASKS_VISION_VERSION = '0.10.18';
  const TASKS_VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
  const HAND_MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  const DETECT_INTERVAL_MS = 33;          // ~30 fps detection (fluid stays 60 fps)
  const PINCH_RATIO_CLOSE = 0.45;         // pinch-close threshold (relative to hand size)
  const PINCH_RATIO_OPEN = 0.60;          // hysteresis: must open past this to re-arm
  const SWIRL_FORCE_GAIN = 0.22;          // tuning knob for fingertip-driven velocity
  const TRAIL_STRENGTH = 0.0;             // M2 fingertip leaves no trail by default — pure swirl
  const FIST_HOLD_DURATION_SEC = 0.8;     // fist hold to trigger Clear
  const FIST_HOLD_DRIFT_MAX = 0.08;       // normalized drift that cancels the hold
  const FIST_RATIO_MAX = 0.6;             // tip-to-MCP / hand-scale below this = curled
  /* Fingertip ripples — fluid-only now. Each fingertip emits a small velocity
     pulse into the sim at a tight cadence, in a direction rotated by the
     golden angle so consecutive pulses fan out radially. Vorticity
     confinement turns the stream into visible ring-like ripples. Gated to
     stationary fingertips (swirling fingers do something else). */
  const RIPPLE_INTERVAL_MS = 75;
  const RIPPLE_MOVE_GATE = 0.030;
  const RIPPLE_VELOCITY_MAG = 6.0;
  const RIPPLE_RADIUS_SCALE = 0.28;
  const GOLDEN_ANGLE = 2.39996323;        // ≈137.5°
  const FINGERTIP_INDICES = [4, 8, 12, 16, 20];

  // ---------- State ----------

  let internalState = 'off';   // 'off' | 'loading' | 'on' | 'denied' | 'failed'
  let stream = null;
  let landmarker = null;       // cached across enable/disable cycles
  let mpModule = null;
  let running = false;
  let lastDetect = 0;
  let video = null;
  let ring = null;
  let toast = null;
  const handStates = new Map(); // key: handedness label, value: per-hand state

  function newHandState() {
    return {
      lastTip: null,
      wasPinching: false,
      pinchArmed: true,
      // Fist-hold-to-clear state.
      holdStart: null,
      holdOrigin: null,
      // Per-fingertip ripple state, keyed by fingertip landmark index.
      tipState: new Map(),
    };
  }

  // ---------- DOM ----------

  function ensureDOM() {
    video = document.getElementById('webcam');
    ring = document.getElementById('palm-ring');
    toast = document.getElementById('gesture-toast');
  }

  function showToast(msg, ms = 2500) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('visible'), ms);
  }

  function showPalmRing(palmCenter, progress) {
    if (!ring) return;
    // palmCenter is in mirrored UV (0..1, y top-down). Convert to screen px.
    const px = palmCenter.x * window.innerWidth;
    const py = palmCenter.y * window.innerHeight;
    ring.style.left = (px - 36) + 'px';
    ring.style.top = (py - 36) + 'px';
    ring.style.setProperty('--p', Math.min(1, progress));
    ring.classList.add('visible');
  }

  function hidePalmRing() {
    if (ring) ring.classList.remove('visible');
  }

  // ---------- Math helpers ----------

  function dist2D(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function isFist(lm) {
    // All four non-thumb fingertips curled in: dist(tip, MCP) tiny vs hand-scale.
    // Thumb can be wrapped or sticking out — we don't check it.
    const handScale = dist2D(lm[0], lm[9]);
    if (handScale < 0.001) return false;
    return (
      dist2D(lm[8],  lm[5])  < FIST_RATIO_MAX * handScale &&
      dist2D(lm[12], lm[9])  < FIST_RATIO_MAX * handScale &&
      dist2D(lm[16], lm[13]) < FIST_RATIO_MAX * handScale &&
      dist2D(lm[20], lm[17]) < FIST_RATIO_MAX * handScale
    );
  }

  function fistCenterUV(lm) {
    // Mean of wrist + the five MCP joints (mirrored x, top-down y) — lands
    // near the visual center of a closed hand.
    const xs = [lm[0].x, lm[5].x, lm[9].x, lm[13].x, lm[17].x];
    const ys = [lm[0].y, lm[5].y, lm[9].y, lm[13].y, lm[17].y];
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    return { x: 1 - mx, y: my };
  }

  // ---------- Per-frame processing ----------

  function processResult(result, now) {
    const api = window.shuimo;
    if (!api) return;

    const landmarks = result.landmarks || [];
    const handedness = result.handedness || [];
    const seen = new Set();

    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      const label = (handedness[i] && handedness[i][0] && handedness[i][0].categoryName) || `H${i}`;
      // Disambiguate if two hands somehow share a label (rare): suffix the index.
      let key = label;
      if (seen.has(key)) key = `${label}#${i}`;
      seen.add(key);

      const state = handStates.get(key) || newHandState();
      handStates.set(key, state);

      // Index fingertip → swirl
      // Mirror x; flip y (image y goes top-down, fluid UV goes bottom-up).
      const tipUV = { x: 1 - lm[8].x, y: 1 - lm[8].y };
      if (state.lastTip) {
        const dx = tipUV.x - state.lastTip.x;
        const dy = tipUV.y - state.lastTip.y;
        const mag = Math.hypot(dx, dy);
        if (mag > 0.0015) {
          const fx = dx * api.canvas.width * SWIRL_FORCE_GAIN;
          const fy = dy * api.canvas.height * SWIRL_FORCE_GAIN;
          api.splatVelocity(tipUV.x, tipUV.y, fx, fy);
          if (TRAIL_STRENGTH > 0) {
            const ink = api.currentInk();
            api.splatTrail(tipUV.x, tipUV.y, api.absorbance(ink), TRAIL_STRENGTH);
          }
        }
      }
      state.lastTip = tipUV;

      // Pinch detection (edge-debounced with hysteresis)
      const handScale = dist2D(lm[0], lm[9]) || 0.001;
      const pinchRatio = dist2D(lm[4], lm[8]) / handScale;
      if (state.pinchArmed && pinchRatio < PINCH_RATIO_CLOSE) {
        // Drop ink at the pinch midpoint, in mirrored UV
        const mx = 1 - (lm[4].x + lm[8].x) * 0.5;
        const my = 1 - (lm[4].y + lm[8].y) * 0.5;
        api.tap({ x: mx, y: my });
        api.dismissHint();
        state.pinchArmed = false;
        state.wasPinching = true;
      } else if (!state.pinchArmed && pinchRatio > PINCH_RATIO_OPEN) {
        state.pinchArmed = true;
        state.wasPinching = false;
      }

      // Fingertip ripples — each of 5 fingertips dumps a small velocity
      // pulse into the fluid sim while stationary. Direction rotates by the
      // golden angle each pulse so the energy fans out radially over the
      // next few emissions; vorticity confinement amplifies them into
      // ring-like ripples in the water itself (no DOM overlay). Movement
      // gate keeps fast-moving fingers from double-firing with the swirl.
      for (const tipIdx of FINGERTIP_INDICES) {
        const uvX = 1 - lm[tipIdx].x;          // mirrored
        const uvY = 1 - lm[tipIdx].y;          // fluid UV is bottom-up
        const screenY = lm[tipIdx].y;          // top-down for motion gating
        const ts = state.tipState.get(tipIdx) || { last: null, lastEmit: 0, angle: null };
        state.tipState.set(tipIdx, ts);
        const moved = ts.last
          ? Math.hypot(uvX - ts.last.x, screenY - ts.last.y)
          : 0;
        ts.last = { x: uvX, y: screenY };
        if (now - ts.lastEmit < RIPPLE_INTERVAL_MS) continue;
        if (moved > RIPPLE_MOVE_GATE) continue;
        ts.angle = (ts.angle == null ? Math.random() * Math.PI * 2 : ts.angle + GOLDEN_ANGLE);
        const a = ts.angle;
        api.splatRipple(
          uvX,
          uvY,
          Math.cos(a) * RIPPLE_VELOCITY_MAG,
          Math.sin(a) * RIPPLE_VELOCITY_MAG,
          RIPPLE_RADIUS_SCALE
        );
        ts.lastEmit = now;
      }
    }

    // Clean up state for hands no longer detected.
    for (const k of [...handStates.keys()]) {
      if (!seen.has(k)) handStates.delete(k);
    }

    // Fist-hold-to-clear — only meaningful when exactly one hand is up.
    if (landmarks.length === 1) {
      const lm = landmarks[0];
      const state = handStates.values().next().value;
      if (state && isFist(lm)) {
        const center = fistCenterUV(lm);
        if (!state.holdStart) {
          state.holdStart = now;
          state.holdOrigin = center;
        } else {
          const drift = Math.hypot(center.x - state.holdOrigin.x, center.y - state.holdOrigin.y);
          if (drift > FIST_HOLD_DRIFT_MAX) {
            state.holdStart = now;
            state.holdOrigin = center;
          }
        }
        const heldSec = (now - state.holdStart) / 1000;
        showPalmRing(center, heldSec / FIST_HOLD_DURATION_SEC);
        if (heldSec >= FIST_HOLD_DURATION_SEC) {
          api.clearDye(1.0);
          state.holdStart = null;
          hidePalmRing();
        }
      } else if (state) {
        state.holdStart = null;
        hidePalmRing();
      }
    } else {
      hidePalmRing();
      for (const s of handStates.values()) s.holdStart = null;
    }
  }

  // ---------- Loop ----------

  function loop() {
    if (!running) return;
    const now = performance.now();
    if (
      landmarker &&
      video &&
      video.readyState >= 2 &&
      now - lastDetect >= DETECT_INTERVAL_MS
    ) {
      try {
        const result = landmarker.detectForVideo(video, now);
        processResult(result, now);
      } catch (e) {
        console.warn('[shuimo] detect failed:', e);
      }
      lastDetect = now;
    }
    requestAnimationFrame(loop);
  }

  // ---------- Lifecycle ----------

  async function enable() {
    setState('loading');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      console.warn('[shuimo] camera denied:', err);
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setState(denied ? 'denied' : 'failed');
      showToast(denied ? 'No camera — mouse and touch still work.' : 'Camera failed — try again.');
      cleanupStream();
      return;
    }

    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      // Autoplay restrictions; play() may reject silently in some browsers but the video still loads.
    }

    if (!landmarker) {
      try {
        if (!mpModule) {
          mpModule = await import(/* @vite-ignore */ `${TASKS_VISION_CDN}/vision_bundle.mjs`);
        }
        const vision = await mpModule.FilesetResolver.forVisionTasks(`${TASKS_VISION_CDN}/wasm`);
        landmarker = await mpModule.HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (err) {
        console.warn('[shuimo] MediaPipe load failed:', err);
        setState('failed');
        showToast('MediaPipe could not load — check your network.');
        cleanupStream();
        return;
      }
    }

    video.classList.add('visible');
    setState('on');
    running = true;
    lastDetect = 0;
    requestAnimationFrame(loop);
    showToast('Gestures on · pinch to drop · fist to clear', 3500);
    maybePulseHelp();
  }

  function disable() {
    running = false;
    cleanupStream();
    if (video) video.classList.remove('visible');
    hidePalmRing();
    handStates.clear();
    setState('off');
  }

  // Pulse the "?" help button briefly the first time gestures come on, so the
  // user notices help is there without us hijacking the canvas.
  let helpPulseShown = false;
  function maybePulseHelp() {
    if (helpPulseShown) return;
    helpPulseShown = true;
    const help = document.getElementById('btn-help');
    if (!help) return;
    help.classList.add('pulse');
    setTimeout(() => help.classList.remove('pulse'), 3300);
  }

  function cleanupStream() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
  }

  function toggle() {
    if (internalState === 'loading') return;
    if (internalState === 'on') disable();
    else enable();
  }

  // ---------- Button state ----------

  function setState(s) {
    internalState = s;
    const btn = document.getElementById('btn-gestures');
    if (!btn) return;
    const label = btn.querySelector('.action-label');
    btn.classList.toggle('is-active', s === 'on');
    btn.classList.toggle('is-loading', s === 'loading');
    btn.disabled = (s === 'loading');
    switch (s) {
      case 'off':     if (label) label.textContent = 'Gestures'; break;
      case 'loading': if (label) label.textContent = 'Loading…'; break;
      case 'on':      if (label) label.textContent = 'Disable'; break;
      case 'denied':  if (label) label.textContent = 'No camera'; setTimeout(() => internalState === 'denied' && setState('off'), 2500); break;
      case 'failed':  if (label) label.textContent = 'Failed'; setTimeout(() => internalState === 'failed' && setState('off'), 2500); break;
    }
  }

  // ---------- Init ----------

  function init() {
    ensureDOM();
    if (!video) {
      console.warn('[shuimo] #webcam not found — gestures disabled');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const btn = document.getElementById('btn-gestures');
      if (btn) { btn.disabled = true; btn.title = 'Camera APIs unavailable'; }
      return;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.Gestures = { toggle, enable, disable, get state() { return internalState; } };
})();
