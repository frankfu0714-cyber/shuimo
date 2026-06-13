# 水墨 · shuimo

Real-time WebGL fluid simulation of ink in water. Tap to drop a drop, drag to swirl. Classical inks (indigo, jade, mustard, vermillion) mix subtractively like real pigments.

## Stack

- Single-page static site — no build step, no bundler.
- `fluid.js` — Navier-Stokes solver (advection + pressure projection + vorticity confinement). Adapted from [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) (MIT). Subtractive dye rendering so blue + yellow muddies into green-brown rather than washing out.
- `app.js` — UI, input handling, color management.
- Deployed on Vercel as a static site.

## Local

Any static server. e.g. `python3 -m http.server 8000` then open `http://localhost:8000`.

## Roadmap

- **M1 — mouse / touch.** ✅ Shipped.
- **M2 — webcam gestures.** MediaPipe Tasks Vision JS (newer API) — fingertip swirl, pinch-to-drop, two-hand simultaneous, palm wave sweep.
- **M3 — mic / blow detection.** Threshold-based turbulence injection at the cursor / fingertip.
