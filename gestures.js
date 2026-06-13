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
  // Pinch detector — false positives were firing on relaxed hand poses
  // because the old 0.45 ratio could be satisfied by a curled-up resting
  // hand. Tightened: ratio must drop below 0.28 for a real fingertip
  // touch, with a wider 0.55 open threshold. Plus a state machine that
  // requires the hand to first be cleanly open for several frames and
  // the closed state to persist for at least 2 frames before firing.
  const PINCH_RATIO_CLOSE = 0.28;
  const PINCH_RATIO_OPEN = 0.55;
  const PINCH_OPEN_FRAMES_REQ = 4;        // clean-open debounce before arming
  const PINCH_CLOSE_FRAMES_REQ = 2;       // close-state debounce before firing
  const HAND_CONF_MIN = 0.70;             // skip jittery low-confidence hands
  const SWIRL_FORCE_GAIN = 0.22;          // tuning knob for fingertip-driven velocity
  const TRAIL_STRENGTH = 0.0;             // fingertip leaves no trail — pure swirl
  const FIST_HOLD_DURATION_SEC = 0.8;     // fist hold to trigger Clear
  const FIST_HOLD_DRIFT_MAX = 0.08;       // normalized drift that cancels the hold
  const FIST_RATIO_MAX = 0.6;             // tip-to-MCP / hand-scale below this = curled
  const FINGERTIP_INDICES = [4, 8, 12, 16, 20];
  /* Wave-layer parameters. Fingertip continuous-contact capsules are stamped
     into the wave height field every frame by app.js via getFingertips().
     A pinch fires a one-shot pulse so the drop visibly rings out — kept
     gentle so the ink can spread on its own rather than getting blasted. */
  const PINCH_PULSE_AMP = 1.2;            // ampMul on pinch one-shot

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

  /* Fingertip list, rebuilt each detect frame. Each entry:
       { curr: {x, y}, prev: {x, y} } in wave/fluid UV (mirrored x, bottom-up y).
     The frame loop in app.js reads this and feeds it to waves.setCapsules
     for continuous-contact ripple stamping. */
  const fingertips = [];

  function getFingertips() { return fingertips; }
  function clearFingertips() { fingertips.length = 0; }

  function newHandState() {
    return {
      lastTip: null,
      // Pinch state machine. New hands start with hasBeenCleanlyOpen=false,
      // so a user who enters the frame with an already-curled hand can't
      // fire a phantom pinch — they have to show a clean open pose first.
      pinchPhase: 'open',       // 'open' | 'closing' | 'closed'
      pinchFramesInPhase: 0,
      pinchHasBeenCleanlyOpen: false,
      // Fist-hold-to-clear state.
      holdStart: null,
      holdOrigin: null,
      // Per-fingertip last UV — used to build the (prev, curr) capsule
      // endpoints stamped into the wave field.
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

  /* Landmark → display coordinates.
     MediaPipe returns landmarks in normalized [0,1] over the *raw* video
     frame (e.g. 640×480, 4:3). The video element uses CSS `object-fit:
     cover` to fill a typically-not-4:3 viewport, which scales-then-crops
     the raw frame around its center. The browser shows a band of the raw
     frame, not the whole thing — but MediaPipe still hands back coords
     over the *whole* frame. The visible position of a landmark therefore
     differs from `lm.y` (or `lm.x`) by exactly that crop. We invert it:
     stretch the cropped axis around 0.5 by viewAspect/videoAspect (or
     videoAspect/viewAspect, whichever crops). Then mirror x for the CSS
     scaleX(-1). Returns top-down screen-normalized coords. */
  function landmarkToScreenUV(lm) {
    const vw = video ? video.videoWidth : 0;
    const vh = video ? video.videoHeight : 0;
    if (!vw || !vh) {
      // Video metadata not loaded yet — best-effort 1:1 with mirror.
      return { x: 1 - lm.x, y: lm.y };
    }
    const videoAspect = vw / vh;
    const viewAspect = window.innerWidth / Math.max(1, window.innerHeight);
    let dx = lm.x;
    let dy = lm.y;
    if (viewAspect > videoAspect) {
      // Wider viewport: object-fit:cover crops top + bottom of raw video.
      // Visible y range is narrower than [0,1]; stretch around the middle.
      dy = 0.5 + (lm.y - 0.5) * (viewAspect / videoAspect);
    } else if (viewAspect < videoAspect) {
      // Taller viewport: cover crops left + right of raw video.
      dx = 0.5 + (lm.x - 0.5) * (videoAspect / viewAspect);
    }
    return { x: 1 - dx, y: dy };
  }

  /* Same transform, expressed in wave/fluid UV (bottom-up y). All splat /
     capsule / pulse / tap calls into the sim use this convention. */
  function landmarkToWaveUV(lm) {
    const s = landmarkToScreenUV(lm);
    return { x: s.x, y: 1 - s.y };
  }

  function fistCenterUV(lm) {
    // Mean of wrist + the five MCP joints in raw-landmark space, then
    // mapped through landmarkToScreenUV so the palm progress ring lands
    // at the visible fist position (top-down for DOM placement).
    const mx = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
    const my = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
    return landmarkToScreenUV({ x: mx, y: my });
  }

  // ---------- Per-frame processing ----------

  function processResult(result, now) {
    const api = window.shuimo;
    if (!api) return;

    const landmarks = result.landmarks || [];
    const handedness = result.handedness || [];
    const seen = new Set();

    // Rebuild the fingertip list from scratch this frame; missing hands ⇒ no
    // entries. The frame loop reads getFingertips() each tick.
    clearFingertips();

    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      const label = (handedness[i] && handedness[i][0] && handedness[i][0].categoryName) || `H${i}`;
      // Disambiguate if two hands somehow share a label (rare): suffix the index.
      let key = label;
      if (seen.has(key)) key = `${label}#${i}`;
      seen.add(key);

      const state = handStates.get(key) || newHandState();
      handStates.set(key, state);

      // Index fingertip → swirl. Aspect-aware mapping so the velocity push
      // lands exactly where the user sees the fingertip on screen.
      const tipUV = landmarkToWaveUV(lm[8]);
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

      // Pinch detection — debounced state machine. Three gates protect
      // against false positives:
      //   1. Hand classification score must clear HAND_CONF_MIN.
      //   2. Hand must have been *cleanly* open (ratio > OPEN) for
      //      PINCH_OPEN_FRAMES_REQ consecutive frames before any close
      //      event can fire. Resets when the hand leaves the frame.
      //   3. Close state (ratio < CLOSE) must persist for
      //      PINCH_CLOSE_FRAMES_REQ consecutive frames before firing —
      //      one-frame landmark noise won't trigger.
      // After a fire, hasBeenCleanlyOpen resets, requiring another
      // clean open before the next pinch can fire.
      const handScore = (handedness[i] && handedness[i][0] && handedness[i][0].score) || 0;
      if (handScore >= HAND_CONF_MIN) {
        const handScale = dist2D(lm[0], lm[9]) || 0.001;
        const pinchRatio = dist2D(lm[4], lm[8]) / handScale;
        if (pinchRatio > PINCH_RATIO_OPEN) {
          if (state.pinchPhase !== 'open') {
            state.pinchPhase = 'open';
            state.pinchFramesInPhase = 0;
          }
          state.pinchFramesInPhase++;
          if (state.pinchFramesInPhase >= PINCH_OPEN_FRAMES_REQ) {
            state.pinchHasBeenCleanlyOpen = true;
          }
        } else if (pinchRatio < PINCH_RATIO_CLOSE && state.pinchHasBeenCleanlyOpen) {
          if (state.pinchPhase !== 'closing' && state.pinchPhase !== 'closed') {
            state.pinchPhase = 'closing';
            state.pinchFramesInPhase = 0;
          }
          if (state.pinchPhase === 'closing') {
            state.pinchFramesInPhase++;
            if (state.pinchFramesInPhase >= PINCH_CLOSE_FRAMES_REQ) {
              // FIRE — landmarks → aspect-aware UV so the drop lands at
              // the visible pinch midpoint, not the raw image midpoint.
              const pinchUV = landmarkToWaveUV({
                x: (lm[4].x + lm[8].x) * 0.5,
                y: (lm[4].y + lm[8].y) * 0.5,
              });
              api.tap(pinchUV);
              if (api.pulseWave) api.pulseWave(pinchUV, PINCH_PULSE_AMP);
              api.dismissHint();
              state.pinchPhase = 'closed';
              state.pinchFramesInPhase = 0;
              state.pinchHasBeenCleanlyOpen = false;
            }
          }
        }
        // Else (hysteresis band, or close without prior clean-open): no
        // state change, no fire.
      }

      // Fingertip → wave-field capsule. Each frame the five fingertips
      // contribute a (prev, curr) capsule that gets stamped into the
      // height field by waves.step. Continuous contact builds up gradually;
      // motion elongates the capsule into a bow-wave; stationary tips
      // produce clean circular ripples (capsule degenerates to a point).
      for (const tipIdx of FINGERTIP_INDICES) {
        const curr = landmarkToWaveUV(lm[tipIdx]);
        const ts = state.tipState.get(tipIdx) || { prev: null };
        state.tipState.set(tipIdx, ts);
        const prev = ts.prev || curr;          // first frame: zero-length capsule
        fingertips.push({ curr, prev });
        ts.prev = curr;
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
      showToast(denied ? tr('gestures.toast.denied') : tr('gestures.toast.failed'));
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
        showToast(tr('gestures.toast.failed'));
        cleanupStream();
        return;
      }
    }

    video.classList.add('visible');
    setState('on');
    running = true;
    lastDetect = 0;
    requestAnimationFrame(loop);
    showToast(tr('gestures.toast.enabled'), 3500);
    maybePulseHelp();
  }

  function disable() {
    running = false;
    cleanupStream();
    if (video) video.classList.remove('visible');
    hidePalmRing();
    handStates.clear();
    clearFingertips();
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

  function tr(key) {
    return (window.shuimo && window.shuimo.t) ? window.shuimo.t(key) : key;
  }

  function setState(s) {
    internalState = s;
    const btn = document.getElementById('btn-gestures');
    if (!btn) return;
    const label = btn.querySelector('.action-label');
    btn.classList.toggle('is-active', s === 'on');
    btn.classList.toggle('is-loading', s === 'loading');
    btn.disabled = (s === 'loading');
    switch (s) {
      case 'off':     if (label) label.textContent = tr('gestures.button'); break;
      case 'loading': if (label) label.textContent = tr('gestures.loading'); break;
      case 'on':      if (label) label.textContent = tr('gestures.disable'); break;
      case 'denied':  if (label) label.textContent = tr('gestures.denied.label'); setTimeout(() => internalState === 'denied' && setState('off'), 2500); break;
      case 'failed':  if (label) label.textContent = tr('gestures.failed.label'); setTimeout(() => internalState === 'failed' && setState('off'), 2500); break;
    }
  }

  // Re-run setState for the current state so its label picks up a freshly
  // translated string after a language toggle.
  function refreshLabels() { setState(internalState); }

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

  window.Gestures = {
    toggle,
    enable,
    disable,
    getFingertips,
    refreshLabels,
    get state() { return internalState; },
  };
})();
