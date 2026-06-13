/*
 * shuimo — water-surface height-field layer (M2.5)
 *
 * A pure 2D wave-equation simulation overlaid on top of the existing Pavel
 * Navier-Stokes ink solver. The ink sim is NOT touched — it now renders into
 * an offscreen "ink target" FBO instead of straight to the canvas. This
 * module's display shader then samples that ink texture with refraction +
 * chromatic aberration + Fresnel + specular + sheen driven by the height
 * field, producing visible water-surface ripples that distort the ink
 * underneath. Matches the 希彼赫 reference spec verbatim where possible.
 *
 *   Ping-pong: two RGBA half-float textures hold (H_curr, H_prev) in .rg.
 *   Wave step shader: 2*H - H_prev + speed * 9-tap-laplacian, times damping,
 *                     plus a loop over up to MAX_CAPSULES finger capsule SDFs.
 *   Branch-free loop: step(float(i), count - 0.5) masks inactive slots.
 *   Display shader: refraction, RGB chromatic split, Laplacian lens bright,
 *                   Schlick Fresnel, sharp specular + broad sheen.
 *
 * Public API:
 *   const waves = new Waves(sim);
 *   waves.setCapsules(arr)  // continuous tracked positions (fingers + active pointers)
 *   waves.pulse(uv, ampMul) // single-frame burst at a point (tap / pinch)
 *   waves.step(dt)          // run wave equation pass
 *   waves.render()          // composite display → screen
 *   waves.resize(w, h)      // call when canvas resizes
 *   waves.inkTarget         // FBO for fluid sim to render into
 */

(function (global) {
  'use strict';

  const MAX_CAPSULES = 10;

  // ---------- Tuning constants (top of module so Frank can dial them) ----------
  const WAVE = {
    GRID_WIDTH: 512,        // height grid resolution; auto-aspected to canvas
    // "Focused on the fingers" — slower propagation + faster decay keep
    // visible motion local to each finger. Amplitude + radius bumped so
    // five-fingertip contact reads as five distinct strong ripples rather
    // than a faint shimmer.
    WAVE_SPEED: 0.35,       // c² in (2H - H_prev + c²·∇²H) · damping
    DAMPING: 0.985,         // per-step exponential decay
    IMPULSE_AMP: 0.14,      // capsule stamp height per frame (per-pixel inside cap)
    IMPULSE_RADIUS: 0.032,  // capsule radius in normalized UV — readable rings
    // Absorbing-boundary "sponge" — without this, CLAMP_TO_EDGE sampling
    // makes waves reflect back from the canvas edges and the pool gets
    // chaotic. We instead damp aggressively in a thin margin around the
    // edge so waves traveling outward simply die at the edge, as if the
    // pool extended to infinity.
    SPONGE_WIDTH: 0.08,     // margin (normalized UV) over which sponge ramps in
    SPONGE_DAMP: 0.86,      // per-frame damping multiplier AT the edge
    REFRACT: 0.75,          // wave gradient → ink UV offset multiplier (stronger distortion at finger contacts)
    LENS_GAIN: 0.9,         // Laplacian → brightness multiplier (crest magnify)
    NORMAL_SCALE: 2.6,      // gradient → surface normal scale (refraction physics)
    F0: 0.04,               // Schlick F0 for water
    SPEC_POW: 80.0,         // sharp specular exponent
    SPEC_GAIN: 0.40,        // sharp specular intensity
    SHEEN_GAIN: 0.12,       // broad sheen intensity
    CHROMA_G: 1.05,         // green channel refraction scale (vs 1.0 red)
    CHROMA_B: 1.10,         // blue channel refraction scale → rainbow edges
  };

  // ---------- Shaders ----------

  const baseVertex = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  /* Wave-step shader.
     Reads the packed (H_curr, H_prev) from .rg, computes 9-tap Laplacian
     (cardinal weight 0.5, diagonal weight 0.25, center weight -3 → balanced),
     advances the wave equation, applies per-step damping, then loops over
     active capsules adding their SDF-based impulse. Loop is branch-free
     (step() mask). Output: new (H_next, H_curr) packed in .rg. */
  const waveStepShader = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uHeight;
    uniform vec2 uTexel;
    uniform float uWaveSpeed;
    uniform float uDamping;
    uniform float uRadius;
    uniform float uAmp;
    uniform float uSpongeWidth;
    uniform float uSpongeDamp;
    uniform vec4 uCapsules[${MAX_CAPSULES}];   // .xy = curr, .zw = prev
    uniform float uCapAmps[${MAX_CAPSULES}];   // per-capsule amp multiplier
    uniform float uCount;                       // float (branch-free with step())

    void main () {
      vec2 c = texture2D(uHeight, vUv).rg;
      float curr = c.r;
      float prev = c.g;

      vec2 dx = vec2(uTexel.x, 0.0);
      vec2 dy = vec2(0.0, uTexel.y);
      float R  = texture2D(uHeight, vUv + dx).r;
      float L  = texture2D(uHeight, vUv - dx).r;
      float T  = texture2D(uHeight, vUv + dy).r;
      float B  = texture2D(uHeight, vUv - dy).r;
      float TR = texture2D(uHeight, vUv + dx + dy).r;
      float TL = texture2D(uHeight, vUv - dx + dy).r;
      float BR = texture2D(uHeight, vUv + dx - dy).r;
      float BL = texture2D(uHeight, vUv - dx - dy).r;
      float lap = (R + L + T + B) * 0.5 + (TR + TL + BR + BL) * 0.25 - curr * 3.0;

      float next = (2.0 * curr - prev + uWaveSpeed * lap) * uDamping;

      // Absorbing-boundary sponge — distance to nearest edge in normalized
      // UV; 0 at the canvas edge, 0.5 at the center. smoothstep ramps the
      // damping from uSpongeDamp at the edge up to 1.0 (no extra damping)
      // by the time we're uSpongeWidth into the interior. Applied to the
      // propagated wave term BEFORE the capsule stamp loop so impulses at
      // the edge still land cleanly — only the outgoing wave dies.
      float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
      float spongeFactor = smoothstep(0.0, uSpongeWidth, edgeDist);
      next *= mix(uSpongeDamp, 1.0, spongeFactor);

      // Branch-free capsule loop — bounds must be a compile-time constant in WebGL1.
      for (int i = 0; i < ${MAX_CAPSULES}; i++) {
        float active = step(float(i), uCount - 0.5);
        vec4 cap = uCapsules[i];
        vec2 a = cap.xy;
        vec2 b = cap.zw;
        vec2 pa = vUv - a;
        vec2 ba = b - a;
        float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        float d = length(pa - ba * t);
        float intensity = uAmp * uCapAmps[i] * (1.0 - smoothstep(uRadius * 0.55, uRadius, d));
        next += intensity * active;
      }

      gl_FragColor = vec4(next, curr, 0.0, 1.0);
    }
  `;

  /* Display shader.
     Samples the ink target (cream + ink composite from FluidSim) with a
     refraction offset driven by the wave's height gradient, splits the RGB
     channels by slightly different multipliers for chromatic aberration,
     adds Laplacian-based lens crest brightening, then computes a surface
     normal from the gradient and runs Schlick Fresnel + a sharp specular
     and broad sheen lobe. No `if` statements. */
  const displayShader = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uHeight;
    uniform sampler2D uInk;
    uniform vec2 uTexel;
    uniform float uRefract;
    uniform float uLensGain;
    uniform float uNormalScale;
    uniform float uF0;
    uniform float uSpecPow;
    uniform float uSpecGain;
    uniform float uSheenGain;
    uniform float uChromaG;
    uniform float uChromaB;

    void main () {
      float h  = texture2D(uHeight, vUv).r;
      float hR = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
      float hL = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
      float hU = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
      float hD = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;
      // NOT normalized — steeper slope → larger offset (per spec).
      vec2 grad = vec2(hR - hL, hU - hD) * 0.5;
      float lap = (hR + hL + hU + hD) - 4.0 * h;

      // Refraction with chromatic aberration — channels offset by slightly
      // different scales → rainbow edges at steep gradients.
      vec2 off = grad * uRefract;
      float r = texture2D(uInk, vUv - off              ).r;
      float g = texture2D(uInk, vUv - off * uChromaG   ).g;
      float b = texture2D(uInk, vUv - off * uChromaB   ).b;
      vec3 base = vec3(r, g, b);

      // Lens crest brightening — positive Laplacian (crest) acts like a
      // magnifying lens; trough darkens.
      base += vec3(lap) * uLensGain;

      // Surface normal from gradient (height field treated as displacement
      // in z; spec said gradient drives normal, NOT normalized).
      vec3 N = normalize(vec3(-grad * uNormalScale, 1.0));
      vec3 V = vec3(0.0, 0.0, 1.0);

      // Schlick Fresnel — grazing angles reflect more.
      float NoV = max(dot(N, V), 0.0);
      float F = uF0 + (1.0 - uF0) * pow(1.0 - NoV, 5.0);
      // Subtle cream sky reflection that tilts cooler with normal.y.
      vec3 envRefl = mix(vec3(0.90, 0.88, 0.82), vec3(0.72, 0.82, 0.96), N.y * 0.5 + 0.5);
      base = mix(base, envRefl, F);

      // Sharp specular + broad sheen.
      vec3 Ldir = normalize(vec3(0.3, 0.7, 0.7));
      vec3 Rdir = reflect(-Ldir, N);
      float RdotV = max(dot(Rdir, V), 0.0);
      float spec = pow(RdotV, uSpecPow);
      float sheen = pow(RdotV, 4.0);
      base += vec3(spec) * uSpecGain + vec3(sheen) * uSheenGain;

      gl_FragColor = vec4(base, 1.0);
    }
  `;

  // ---------- Shader helpers (mirroring fluid.js's style) ----------

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('[waves] shader compile failed:\n' + gl.getShaderInfoLog(sh) + '\n\nSource:\n' + src);
      throw new Error('waves shader compile failed');
    }
    return sh;
  }

  function makeProgram(gl, vertSrc, fragSrc) {
    const v = compile(gl, gl.VERTEX_SHADER, vertSrc);
    const f = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('[waves] link failed:\n' + gl.getProgramInfoLog(p));
      throw new Error('waves program link failed');
    }
    const uniforms = {};
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(p, info.name);
    }
    return { program: p, uniforms };
  }

  // ---------- Waves class ----------

  class Waves {
    constructor(sim) {
      this.sim = sim;
      this.gl = sim.gl;
      this.ext = sim.ext;
      this.canvas = sim.canvas;

      this._continuous = [];
      this._oneshots = [];

      this._initQuad();
      this._initPrograms();
      this._initBuffers();
    }

    _initQuad() {
      const gl = this.gl;
      this._quadBuffer = gl.createBuffer();
      this._indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    }

    _initPrograms() {
      const gl = this.gl;
      this._waveProg = makeProgram(gl, baseVertex, waveStepShader);
      this._displayProg = makeProgram(gl, baseVertex, displayShader);
    }

    _initBuffers() {
      const gl = this.gl;
      const canvasW = gl.drawingBufferWidth;
      const canvasH = gl.drawingBufferHeight;
      const aspect = canvasW / canvasH;
      const gridW = WAVE.GRID_WIDTH;
      const gridH = Math.max(64, Math.round(gridW / aspect));
      this._gridW = gridW;
      this._gridH = gridH;
      // Use sim's createFBO helper so format/filter conventions match.
      this._heightA = this.sim.createFBO(gridW, gridH, { filter: 'linear' });
      this._heightB = this.sim.createFBO(gridW, gridH, { filter: 'linear' });
      // Ink target at canvas resolution — what FluidSim renders into.
      this._inkFBO = this.sim.createFBO(canvasW, canvasH, { filter: 'linear' });
    }

    resize(w, h) {
      // The wave grid is independent of canvas size — keep it constant for
      // consistent ripple physics across resolutions. The ink target needs
      // to match the canvas, though.
      this._inkFBO = this.sim.createFBO(w, h, { filter: 'linear' });
    }

    get inkTarget() { return this._inkFBO; }

    /* Continuous capsules — fingertips + currently-down pointers. The frame
       loop rebuilds this array each tick from window.Gestures and the pointer
       state in app.js. Each item: { curr: {x,y}, prev: {x,y}, ampMul?: number }. */
    setCapsules(arr) {
      this._continuous = arr || [];
    }

    /* One-shot burst — fired by taps and pinches. Stamped once on the next
       step() then cleared. */
    pulse(uv, ampMul) {
      this._oneshots.push({ curr: uv, prev: uv, ampMul: ampMul == null ? 4.0 : ampMul });
    }

    _bindQuad() {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);
    }

    _draw(target) {
      const gl = this.gl;
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    }

    step(dt) {
      const gl = this.gl;

      // Build the active capsule list for this step.
      const merged = [];
      for (let i = 0; i < this._continuous.length && merged.length < MAX_CAPSULES; i++) {
        merged.push(this._continuous[i]);
      }
      for (let i = 0; i < this._oneshots.length && merged.length < MAX_CAPSULES; i++) {
        merged.push(this._oneshots[i]);
      }
      this._oneshots.length = 0; // one-shots fire once

      // Pack into uniform-friendly typed arrays.
      const capData = new Float32Array(MAX_CAPSULES * 4);
      const capAmps = new Float32Array(MAX_CAPSULES);
      for (let i = 0; i < merged.length; i++) {
        const c = merged[i];
        capData[i * 4 + 0] = c.curr.x;
        capData[i * 4 + 1] = c.curr.y;
        capData[i * 4 + 2] = c.prev.x;
        capData[i * 4 + 3] = c.prev.y;
        capAmps[i] = (c.ampMul == null ? 1.0 : c.ampMul);
      }

      this._bindQuad();
      gl.disable(gl.BLEND);

      const prog = this._waveProg;
      gl.useProgram(prog.program);
      gl.uniform1i(prog.uniforms.uHeight, this._heightA.attach(0));
      gl.uniform2f(prog.uniforms.uTexel, 1 / this._gridW, 1 / this._gridH);
      gl.uniform1f(prog.uniforms.uWaveSpeed, WAVE.WAVE_SPEED);
      gl.uniform1f(prog.uniforms.uDamping, WAVE.DAMPING);
      gl.uniform1f(prog.uniforms.uRadius, WAVE.IMPULSE_RADIUS);
      gl.uniform1f(prog.uniforms.uAmp, WAVE.IMPULSE_AMP);
      gl.uniform1f(prog.uniforms.uSpongeWidth, WAVE.SPONGE_WIDTH);
      gl.uniform1f(prog.uniforms.uSpongeDamp, WAVE.SPONGE_DAMP);
      gl.uniform1f(prog.uniforms.uCount, merged.length);
      gl.uniform4fv(prog.uniforms.uCapsules, capData);
      gl.uniform1fv(prog.uniforms.uCapAmps, capAmps);
      this._draw(this._heightB);

      // Swap — heightB now holds the freshly computed (H_next, H_curr).
      const tmp = this._heightA;
      this._heightA = this._heightB;
      this._heightB = tmp;
    }

    render() {
      const gl = this.gl;
      this._bindQuad();
      gl.disable(gl.BLEND);
      const prog = this._displayProg;
      gl.useProgram(prog.program);
      gl.uniform1i(prog.uniforms.uHeight, this._heightA.attach(0));
      gl.uniform1i(prog.uniforms.uInk, this._inkFBO.attach(1));
      gl.uniform2f(prog.uniforms.uTexel, 1 / this._gridW, 1 / this._gridH);
      gl.uniform1f(prog.uniforms.uRefract, WAVE.REFRACT);
      gl.uniform1f(prog.uniforms.uLensGain, WAVE.LENS_GAIN);
      gl.uniform1f(prog.uniforms.uNormalScale, WAVE.NORMAL_SCALE);
      gl.uniform1f(prog.uniforms.uF0, WAVE.F0);
      gl.uniform1f(prog.uniforms.uSpecPow, WAVE.SPEC_POW);
      gl.uniform1f(prog.uniforms.uSpecGain, WAVE.SPEC_GAIN);
      gl.uniform1f(prog.uniforms.uSheenGain, WAVE.SHEEN_GAIN);
      gl.uniform1f(prog.uniforms.uChromaG, WAVE.CHROMA_G);
      gl.uniform1f(prog.uniforms.uChromaB, WAVE.CHROMA_B);
      this._draw(null);
    }
  }

  global.Waves = Waves;
  global.WAVE = WAVE; // expose tuning for live-tweaking from devtools
})(window);
