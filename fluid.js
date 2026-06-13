/*
 * shuimo — WebGL fluid simulation engine
 *
 * Adapted from PavelDoGreat / WebGL-Fluid-Simulation (MIT License)
 *   https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 *
 * Modifications for shuimo:
 *   - Subtractive display (cream "water" base, dye stores absorbance) so
 *     classical inks mix like real pigments (blue + yellow → muddy green).
 *   - Lower density dissipation; ink lingers in water.
 *   - Adaptive resolution: halve sim res when frame time exceeds budget.
 *   - Exposed splat / splatVelocity / clear / save APIs for the host page.
 */

(function (global) {
  'use strict';

  // ---------- WebGL context + extensions ----------

  function getWebGLContext(canvas) {
    const params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: true,
    };
    let gl = canvas.getContext('webgl2', params);
    const isWebGL2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
    if (!gl) throw new Error('WebGL not supported');

    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
    } else {
      halfFloat = gl.getExtension('OES_texture_half_float');
      supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    }

    gl.clearColor(0, 0, 0, 0);

    const halfFloatTexType = isWebGL2
      ? gl.HALF_FLOAT
      : (halfFloat ? halfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE);

    let formatRGBA, formatRG, formatR;
    if (isWebGL2) {
      formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
    } else {
      formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
      formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    }

    return {
      gl,
      ext: {
        formatRGBA,
        formatRG,
        formatR,
        halfFloatTexType,
        supportLinearFiltering,
      },
      isWebGL2,
    };
  }

  function getSupportedFormat(gl, internalFormat, format, type) {
    if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
      switch (internalFormat) {
        case gl.R16F: return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
        case gl.RG16F: return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
        default: return null;
      }
    }
    return { internalFormat, format };
  }

  function supportRenderTextureFormat(gl, internalFormat, format, type) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status === gl.FRAMEBUFFER_COMPLETE;
  }

  // ---------- Shader helpers ----------

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      throw new Error('Shader compile failed');
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      throw new Error('Program link failed');
    }
    return program;
  }

  function getUniforms(gl, program) {
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return uniforms;
  }

  class Material {
    constructor(gl, vertex, fragment) {
      this.gl = gl;
      this.program = createProgram(gl, vertex, fragment);
      this.uniforms = getUniforms(gl, this.program);
    }
    bind() { this.gl.useProgram(this.program); }
  }

  // ---------- FBOs ----------

  function createFBO(gl, w, h, internalFormat, format, type, filter) {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      attach(id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO(gl, w, h, internalFormat, format, type, filter) {
    let fbo1 = createFBO(gl, w, h, internalFormat, format, type, filter);
    let fbo2 = createFBO(gl, w, h, internalFormat, format, type, filter);
    return {
      width: w,
      height: h,
      texelSizeX: 1 / w,
      texelSizeY: 1 / h,
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
    };
  }

  // ---------- Shader sources ----------

  const baseVertexShader = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main () {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;

  const copyShader = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    void main () { gl_FragColor = texture2D(uTexture, vUv); }
  `;

  const clearShader = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;
    void main () { gl_FragColor = value * texture2D(uTexture, vUv); }
  `;

  /* Subtractive display: dye texture stores absorbance per channel.
     screen = clamp(backColor - dye, 0, 1). Cream water (backColor) shows
     where dye is empty; piling on absorbance darkens toward ink colors. */
  const displayShader = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 backColor;
    void main () {
      vec3 dye = texture2D(uTexture, vUv).rgb;
      vec3 color = clamp(backColor - dye, 0.0, 1.0);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const splatShader = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;
    void main () {
      vec2 p = vUv - point.xy;
      p.x *= aspectRatio;
      vec3 splat = exp(-dot(p, p) / radius) * color;
      vec3 base = texture2D(uTarget, vUv).xyz;
      gl_FragColor = vec4(base + splat, 1.0);
    }
  `;

  /* Ambient turbulence — adds a tiny divergence-free curl field to the
     velocity every step so the water is never perfectly still. Even with
     no user input, existing dye drifts and slowly blooms instead of
     sitting frozen in place. The field is two perpendicular sine waves
     (an analytic stream function whose curl is the field itself, so
     div = ∂(sin(ky))/∂x + ∂(−sin(kx))/∂y = 0 exactly — no pressure
     projection needed to keep incompressibility). A second smaller-scale
     layer adds texture. uTime morphs the field slowly. */
  const ambientShader = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform float uAmbientStrength;
    uniform float uAmbientScale;
    uniform float uTime;
    void main () {
      float k = uAmbientScale * 6.28318;
      float t = uTime;
      vec2 amb = vec2(
         sin(vUv.y * k        + t * 0.70),
        -sin(vUv.x * k        + t * 0.70 + 1.0)
      ) * 0.6
      + vec2(
         sin(vUv.y * k * 2.3 + t * 1.10 + 1.7),
        -sin(vUv.x * k * 2.3 + t * 1.10 + 0.3)
      ) * 0.3;
      vec2 v = texture2D(uVelocity, vUv).xy;
      gl_FragColor = vec4(v + amb * uAmbientStrength, 0.0, 1.0);
    }
  `;

  /* Dye diffusion — molecular spread so an undisturbed drop slowly softens
     and blooms instead of sitting as a hard-edged blob. 4-neighbor weighted
     average mixed with the center at strength uDyeDiffusion. Mass-preserving
     by symmetry: integrating over the grid, every k·c "outflow" from a
     pixel is exactly cancelled by the k·avg "inflow" to its neighbors. */
  const diffusionShader = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uDye;
    uniform float uDyeDiffusion;
    void main () {
      vec4 c = texture2D(uDye, vUv);
      vec4 l = texture2D(uDye, vL);
      vec4 r = texture2D(uDye, vR);
      vec4 t = texture2D(uDye, vT);
      vec4 b = texture2D(uDye, vB);
      vec4 avg = (l + r + t + b) * 0.25;
      gl_FragColor = mix(c, avg, uDyeDiffusion);
    }
  `;

  const advectionShader = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;
    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
      vec2 st = uv / tsize - 0.5;
      vec2 iuv = floor(st);
      vec2 fuv = fract(st);
      vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
      vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
      vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
      vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
      return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }
    void main () {
      #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
      #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
      #endif
      float decay = 1.0 + dissipation * dt;
      gl_FragColor = result / decay;
    }
  `;

  const divergenceShader = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).x;
      float R = texture2D(uVelocity, vR).x;
      float T = texture2D(uVelocity, vT).y;
      float B = texture2D(uVelocity, vB).y;
      vec2 C = texture2D(uVelocity, vUv).xy;
      if (vL.x < 0.0) { L = -C.x; }
      if (vR.x > 1.0) { R = -C.x; }
      if (vT.y > 1.0) { T = -C.y; }
      if (vB.y < 0.0) { B = -C.y; }
      float div = 0.5 * (R - L + T - B);
      gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
  `;

  const curlShader = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uVelocity, vL).y;
      float R = texture2D(uVelocity, vR).y;
      float T = texture2D(uVelocity, vT).x;
      float B = texture2D(uVelocity, vB).x;
      float vorticity = R - L - T + B;
      gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
  `;

  const vorticityShader = `
    precision highp float;
    precision highp sampler2D;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;
    void main () {
      float L = texture2D(uCurl, vL).x;
      float R = texture2D(uCurl, vR).x;
      float T = texture2D(uCurl, vT).x;
      float B = texture2D(uCurl, vB).x;
      float C = texture2D(uCurl, vUv).x;
      vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
      force /= length(force) + 0.0001;
      force *= curl * C;
      force.y *= -1.0;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity += force * dt;
      velocity = min(max(velocity, -1000.0), 1000.0);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
  `;

  const pressureShader = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      float C = texture2D(uPressure, vUv).x;
      float divergence = texture2D(uDivergence, vUv).x;
      float pressure = (L + R + B + T - divergence) * 0.25;
      gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
  `;

  const gradientSubtractShader = `
    precision mediump float;
    precision mediump sampler2D;
    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    void main () {
      float L = texture2D(uPressure, vL).x;
      float R = texture2D(uPressure, vR).x;
      float T = texture2D(uPressure, vT).x;
      float B = texture2D(uPressure, vB).x;
      vec2 velocity = texture2D(uVelocity, vUv).xy;
      velocity.xy -= vec2(R - L, T - B);
      gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
  `;

  // ---------- FluidSim ----------

  class FluidSim {
    constructor(canvas, config) {
      this.canvas = canvas;
      this.config = Object.assign({
        SIM_RESOLUTION: 256,
        DYE_RESOLUTION: 1024,
        DENSITY_DISSIPATION: 0.35,
        VELOCITY_DISSIPATION: 0.25,
        DYE_DIFFUSION: 0.04,     // per-step 4-tap blur strength on the dye
        AMBIENT_STRENGTH: 0.04,  // ambient curl-noise velocity injection magnitude
        AMBIENT_SCALE: 2.5,      // ambient spatial frequency (lower = bigger swirls)
        AMBIENT_SPEED: 0.08,     // ambient time evolution rate
        PRESSURE: 0.8,
        PRESSURE_ITERATIONS: 20,
        CURL: 28,
        SPLAT_RADIUS: 0.2,
        DYE_SPLAT_RADIUS: 0.36,    // dye-only puddle size (≈1.8× velocity radius)
        DROP_INK_INTENSITY: 1.5,    // peak color magnitude per ink drop
        SPLAT_FORCE: 6000,
        BACK_COLOR: [0.965, 0.948, 0.895],
      }, config || {});

      const { gl, ext, isWebGL2 } = getWebGLContext(canvas);
      this.gl = gl;
      this.ext = ext;
      this.isWebGL2 = isWebGL2;

      this._initBlit();
      this._initPrograms();
      this._initFramebuffers();

      this._splatStack = [];
      this._fadeAmount = 0;
      this._fadeStart = 0;
    }

    _initBlit() {
      const gl = this.gl;
      // Store buffer handles so we can re-bind in _blit. Other modules
      // sharing the gl context (waves.js) may bind their own quad buffers
      // between fluid steps; re-binding makes this loop interop-safe.
      this._quadBuffer = gl.createBuffer();
      this._indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);

      this._blit = (target, clear) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuffer);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._indexBuffer);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(0);
        if (target == null) {
          gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        } else {
          gl.viewport(0, 0, target.width, target.height);
          gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        }
        if (clear) {
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      };
    }

    _initPrograms() {
      const gl = this.gl;
      const vertex = compileShader(gl, gl.VERTEX_SHADER, baseVertexShader);
      const make = (frag, defines = '') => {
        const src = defines + frag;
        const f = compileShader(gl, gl.FRAGMENT_SHADER, src);
        return new Material(gl, vertex, f);
      };

      const supportLinear = this.ext.supportLinearFiltering;
      const advDefines = supportLinear ? '' : '#define MANUAL_FILTERING\n';

      this.programs = {
        copy: make(copyShader),
        clear: make(clearShader),
        display: make(displayShader),
        splat: make(splatShader),
        advection: make(advectionShader, advDefines),
        diffusion: make(diffusionShader),
        ambient: make(ambientShader),
        divergence: make(divergenceShader),
        curl: make(curlShader),
        vorticity: make(vorticityShader),
        pressure: make(pressureShader),
        gradientSubtract: make(gradientSubtractShader),
      };
    }

    _getResolution(resolution) {
      const gl = this.gl;
      const aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
      const min = Math.round(resolution);
      const max = Math.round(resolution * Math.max(aspectRatio, 1 / aspectRatio));
      if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
      return { width: min, height: max };
    }

    _initFramebuffers() {
      const gl = this.gl;
      const ext = this.ext;
      const simRes = this._getResolution(this.config.SIM_RESOLUTION);
      const dyeRes = this._getResolution(this.config.DYE_RESOLUTION);
      const texType = ext.halfFloatTexType;
      const rgba = ext.formatRGBA;
      const rg = ext.formatRG;
      const r = ext.formatR;
      const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

      this.dye = createDoubleFBO(gl, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
      this.velocity = createDoubleFBO(gl, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
      this.divergence = createFBO(gl, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
      this.curl = createFBO(gl, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
      this.pressure = createDoubleFBO(gl, simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

      this.simWidth = simRes.width;
      this.simHeight = simRes.height;
      this.dyeWidth = dyeRes.width;
      this.dyeHeight = dyeRes.height;
    }

    resize(width, height) {
      const canvas = this.canvas;
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      this._initFramebuffers();
    }

    setSimResolution(res) {
      this.config.SIM_RESOLUTION = res;
      this._initFramebuffers();
    }

    /* Splat dye + velocity at normalized (x, y) in [0,1].
       dx, dy are velocity (in screen-units / second-ish — tuned by SPLAT_FORCE).
       color is absorbance vec3 (cream - inkColor) — host is responsible.
       Velocity uses SPLAT_RADIUS (kept small so drag kicks stay tight); dye
       uses DYE_SPLAT_RADIUS (larger by default so an ink drop reads as a
       real puddle). The two are sized independently. */
    splat(x, y, dx, dy, color) {
      const gl = this.gl;
      const splat = this.programs.splat;
      splat.bind();
      gl.uniform1i(splat.uniforms.uTarget, this.velocity.read.attach(0));
      gl.uniform1f(splat.uniforms.aspectRatio, gl.drawingBufferWidth / gl.drawingBufferHeight);
      gl.uniform2f(splat.uniforms.point, x, y);
      gl.uniform3f(splat.uniforms.color, dx, dy, 0);
      gl.uniform1f(splat.uniforms.radius, this._correctRadius(this.config.SPLAT_RADIUS / 100));
      this._blit(this.velocity.write);
      this.velocity.swap();

      gl.uniform1i(splat.uniforms.uTarget, this.dye.read.attach(0));
      gl.uniform3f(splat.uniforms.color, color[0], color[1], color[2]);
      gl.uniform1f(splat.uniforms.radius, this._correctRadius(this.config.DYE_SPLAT_RADIUS / 100));
      this._blit(this.dye.write);
      this.dye.swap();
    }

    /* Tiny velocity splat at a custom radius scale — used by the M2 ripple
       system to emit many fast, local pulses without touching SPLAT_RADIUS.
       radiusScale multiplies the default SPLAT_RADIUS/100 (e.g. 0.28 →
       about a quarter of a normal splat). */
    splatRipple(x, y, dx, dy, radiusScale) {
      const gl = this.gl;
      const splat = this.programs.splat;
      splat.bind();
      gl.uniform1i(splat.uniforms.uTarget, this.velocity.read.attach(0));
      gl.uniform1f(splat.uniforms.aspectRatio, gl.drawingBufferWidth / gl.drawingBufferHeight);
      gl.uniform2f(splat.uniforms.point, x, y);
      gl.uniform3f(splat.uniforms.color, dx, dy, 0);
      gl.uniform1f(splat.uniforms.radius, this._correctRadius((this.config.SPLAT_RADIUS / 100) * radiusScale));
      this._blit(this.velocity.write);
      this.velocity.swap();
    }

    /* Velocity-only splat (drag motions inject swirl without adding ink). */
    splatVelocity(x, y, dx, dy) {
      const gl = this.gl;
      const splat = this.programs.splat;
      splat.bind();
      gl.uniform1i(splat.uniforms.uTarget, this.velocity.read.attach(0));
      gl.uniform1f(splat.uniforms.aspectRatio, gl.drawingBufferWidth / gl.drawingBufferHeight);
      gl.uniform2f(splat.uniforms.point, x, y);
      gl.uniform3f(splat.uniforms.color, dx, dy, 0);
      gl.uniform1f(splat.uniforms.radius, this._correctRadius(this.config.SPLAT_RADIUS / 100));
      this._blit(this.velocity.write);
      this.velocity.swap();
    }

    /* Light ink trail along drag — small absorbance bump in current color. */
    splatTrail(x, y, color, strength) {
      const gl = this.gl;
      const splat = this.programs.splat;
      splat.bind();
      gl.uniform1i(splat.uniforms.uTarget, this.dye.read.attach(0));
      gl.uniform1f(splat.uniforms.aspectRatio, gl.drawingBufferWidth / gl.drawingBufferHeight);
      gl.uniform2f(splat.uniforms.point, x, y);
      gl.uniform3f(splat.uniforms.color, color[0] * strength, color[1] * strength, color[2] * strength);
      gl.uniform1f(splat.uniforms.radius, this._correctRadius(this.config.SPLAT_RADIUS / 200));
      this._blit(this.dye.write);
      this.dye.swap();
    }

    _correctRadius(radius) {
      const aspectRatio = this.canvas.width / this.canvas.height;
      if (aspectRatio > 1) radius *= aspectRatio;
      return radius;
    }

    /* Trigger a smooth fade of the dye back toward 0 (cream water). */
    clearDye(durationSeconds) {
      this._fadeStart = performance.now();
      this._fadeDuration = durationSeconds * 1000;
    }

    _applyFade(dt) {
      if (!this._fadeDuration) return;
      const elapsed = performance.now() - this._fadeStart;
      if (elapsed >= this._fadeDuration) {
        this._fadeDuration = 0;
        return;
      }
      const gl = this.gl;
      const clear = this.programs.clear;
      clear.bind();
      gl.uniform1i(clear.uniforms.uTexture, this.dye.read.attach(0));
      // Fade factor per frame — exponential decay toward 0.
      const factor = Math.pow(0.001, dt / (this._fadeDuration / 1000));
      gl.uniform1f(clear.uniforms.value, factor);
      this._blit(this.dye.write);
      this.dye.swap();
    }

    step(dt) {
      const gl = this.gl;
      gl.disable(gl.BLEND);

      // Curl + vorticity confinement
      const curlProg = this.programs.curl;
      curlProg.bind();
      gl.uniform2f(curlProg.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      gl.uniform1i(curlProg.uniforms.uVelocity, this.velocity.read.attach(0));
      this._blit(this.curl);

      const vortProg = this.programs.vorticity;
      vortProg.bind();
      gl.uniform2f(vortProg.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      gl.uniform1i(vortProg.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(vortProg.uniforms.uCurl, this.curl.attach(1));
      gl.uniform1f(vortProg.uniforms.curl, this.config.CURL);
      gl.uniform1f(vortProg.uniforms.dt, dt);
      this._blit(this.velocity.write);
      this.velocity.swap();

      // Divergence
      const divProg = this.programs.divergence;
      divProg.bind();
      gl.uniform2f(divProg.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      gl.uniform1i(divProg.uniforms.uVelocity, this.velocity.read.attach(0));
      this._blit(this.divergence);

      // Pressure warm-start
      const clearProg = this.programs.clear;
      clearProg.bind();
      gl.uniform1i(clearProg.uniforms.uTexture, this.pressure.read.attach(0));
      gl.uniform1f(clearProg.uniforms.value, this.config.PRESSURE);
      this._blit(this.pressure.write);
      this.pressure.swap();

      // Jacobi iterations
      const pressProg = this.programs.pressure;
      pressProg.bind();
      gl.uniform2f(pressProg.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      gl.uniform1i(pressProg.uniforms.uDivergence, this.divergence.attach(0));
      for (let i = 0; i < this.config.PRESSURE_ITERATIONS; i++) {
        gl.uniform1i(pressProg.uniforms.uPressure, this.pressure.read.attach(1));
        this._blit(this.pressure.write);
        this.pressure.swap();
      }

      // Gradient subtract → divergence-free velocity
      const gradProg = this.programs.gradientSubtract;
      gradProg.bind();
      gl.uniform2f(gradProg.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      gl.uniform1i(gradProg.uniforms.uPressure, this.pressure.read.attach(0));
      gl.uniform1i(gradProg.uniforms.uVelocity, this.velocity.read.attach(1));
      this._blit(this.velocity.write);
      this.velocity.swap();

      // Ambient turbulence — small divergence-free curl injected into the
      // velocity each step. Keeps the water alive even with no input.
      // Injected here (after projection, before advection) because the
      // analytic field is already div-free → no pressure projection needed.
      if (this.config.AMBIENT_STRENGTH > 0) {
        this._ambientTime = (this._ambientTime || 0) + dt * (this.config.AMBIENT_SPEED || 0.08);
        const ambProg = this.programs.ambient;
        ambProg.bind();
        gl.uniform1i(ambProg.uniforms.uVelocity, this.velocity.read.attach(0));
        gl.uniform1f(ambProg.uniforms.uAmbientStrength, this.config.AMBIENT_STRENGTH);
        gl.uniform1f(ambProg.uniforms.uAmbientScale, this.config.AMBIENT_SCALE);
        gl.uniform1f(ambProg.uniforms.uTime, this._ambientTime);
        this._blit(this.velocity.write);
        this.velocity.swap();
      }

      // Advect velocity
      const advProg = this.programs.advection;
      advProg.bind();
      gl.uniform2f(advProg.uniforms.texelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      if (!this.ext.supportLinearFiltering) {
        gl.uniform2f(advProg.uniforms.dyeTexelSize, this.velocity.texelSizeX, this.velocity.texelSizeY);
      }
      const velocityId = this.velocity.read.attach(0);
      gl.uniform1i(advProg.uniforms.uVelocity, velocityId);
      gl.uniform1i(advProg.uniforms.uSource, velocityId);
      gl.uniform1f(advProg.uniforms.dt, dt);
      gl.uniform1f(advProg.uniforms.dissipation, this.config.VELOCITY_DISSIPATION);
      this._blit(this.velocity.write);
      this.velocity.swap();

      // Advect dye
      if (!this.ext.supportLinearFiltering) {
        gl.uniform2f(advProg.uniforms.dyeTexelSize, this.dye.texelSizeX, this.dye.texelSizeY);
      }
      gl.uniform1i(advProg.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(advProg.uniforms.uSource, this.dye.read.attach(1));
      gl.uniform1f(advProg.uniforms.dissipation, this.config.DENSITY_DISSIPATION);
      this._blit(this.dye.write);
      this.dye.swap();

      // Diffuse dye — mass-preserving 4-neighbor blur so a still drop slowly
      // softens and blooms instead of holding a hard edge forever. texelSize
      // here is the dye buffer's so the precomputed vL/vR/vT/vB varyings
      // sample neighbors at the correct pitch.
      if (this.config.DYE_DIFFUSION > 0) {
        const diffProg = this.programs.diffusion;
        diffProg.bind();
        gl.uniform2f(diffProg.uniforms.texelSize, this.dye.texelSizeX, this.dye.texelSizeY);
        gl.uniform1i(diffProg.uniforms.uDye, this.dye.read.attach(0));
        gl.uniform1f(diffProg.uniforms.uDyeDiffusion, this.config.DYE_DIFFUSION);
        this._blit(this.dye.write);
        this.dye.swap();
      }

      this._applyFade(dt);
    }

    render(target) {
      const gl = this.gl;
      gl.disable(gl.BLEND);
      const display = this.programs.display;
      display.bind();
      gl.uniform1i(display.uniforms.uTexture, this.dye.read.attach(0));
      const back = this.config.BACK_COLOR;
      gl.uniform3f(display.uniforms.backColor, back[0], back[1], back[2]);
      this._blit(target == null ? null : target);
    }

    /* Expose the createFBO helper so waves.js can build matching FBOs on the
       same gl context with the same format/filter conventions. */
    createFBO(w, h, opts) {
      const gl = this.gl;
      const ext = this.ext;
      const filter = (opts && opts.filter === 'linear' && ext.supportLinearFiltering) ? gl.LINEAR : gl.NEAREST;
      const fmt = ext.formatRGBA;
      return createFBO(gl, w, h, fmt.internalFormat, fmt.format, ext.halfFloatTexType, filter);
    }
  }

  global.FluidSim = FluidSim;
})(window);
