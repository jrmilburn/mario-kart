import * as THREE from 'three';

// §v5 Rendering: the post pipeline — both split-screen viewports rendered into
// ONE HDR target, one bloom over the whole frame, one output pass.
//
// Why not three's EffectComposer + UnrealBloomPass + OutputPass: that chain
// is ~15 fullscreen draws per frame (a 5-mip separable Gaussian is 10 of them,
// then a full-res additive blend back into the scene target, then a full-res
// OutputPass copy). Here the bloom is a dual-filter pyramid — a thresholded
// 4-tap downsample to half res, four more 5-tap downsamples, four additive
// tent upsamples — and the "add bloom" step is folded into the output pass,
// so the only full-resolution post work is that single output draw. With
// MediaPipe sharing the main thread, every draw we don't issue is CPU we keep.
//
// Things worth knowing before touching this:
//  - Viewports in a render target come from `target.viewport/scissor`, NOT
//    renderer.setViewport (which only drives the canvas): three re-applies
//    the target's own rect on every setRenderTarget — including the one the
//    shadow pass does internally to restore state. renderView sets both.
//  - Rendering into a target makes three write LINEAR colour with no tone
//    mapping; the output pass is a ShaderMaterial drawn to the canvas, so its
//    <tonemapping_fragment>/<colorspace_fragment> apply renderer.toneMapping
//    (none — the toon art was tuned without it) and the sRGB encode, exactly
//    what OutputPass would do.
//  - The scene target is 4x MSAA: the canvas' own antialias doesn't apply to
//    an offscreen target, and unaliased toon edges + outlines look cheap.
//  - Bloom threshold sits just above 1.0 (linear): the lit sandy world tops
//    out around 1.0, so only HDR emitters — boost flames/trails, drift sparks
//    (Effects.ts writes them at 2-4x) and the sun disc — cross it.
//  - Disabled (Quality Low), renderView draws straight to the canvas with no
//    target at all: zero post cost, and the canvas' MSAA does the edges.

const BLOOM_LEVELS = 5; // 1/2 .. 1/32 of the drawing buffer

export interface BloomSettings {
  threshold: number; // linear luminance (max channel) where bloom starts
  knee: number; // soft-knee width below the threshold
  strength: number; // multiplier on the bloom added in the output pass
  radius: number; // 0..1 weight of each coarser mip on the way back up
}

// Tuned against the golden-hour scene (see the §v5 perf/look pass report):
// sand/sky stay clean, boost trails and tier-2+ sparks glow, the sun haloes.
export const DEFAULT_BLOOM: BloomSettings = {
  threshold: 1.1,
  knee: 0.15,
  strength: 0.85,
  radius: 0.85,
};

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

function fullscreenTriangle(): THREE.BufferGeometry {
  // One oversized triangle rather than a quad: no diagonal seam where two
  // triangles' helper lanes overlap, and one fewer triangle.
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
}

function hdrTarget(width: number, height: number, samples = 0, depth = false): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: depth,
    stencilBuffer: false,
    samples,
  });
}

export class PostFX {
  enabled = true;
  readonly bloom: BloomSettings = { ...DEFAULT_BLOOM };
  // §defect-fix: rendering to a HalfFloat target needs the WebGL2
  // EXT_color_buffer_float extension (or, on WebGL1, the separate
  // EXT_color_buffer_half_float) — without either, the HDR scene target
  // silently rasterizes to black (the GPU can't resolve/blit an
  // unsupported-for-rendering format) instead of throwing, so there is no
  // error to catch. Quality.ts checks this at startup and forces Low
  // (straight-to-canvas, no HDR target) instead.
  readonly supportsHDR: boolean;

  private readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly prefilterMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly outputMat: THREE.ShaderMaterial;
  private readonly size = new THREE.Vector2();
  private rendered = false; // any view drawn into sceneTarget since the last finish()

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.supportsHDR =
      renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
    renderer.getDrawingBufferSize(this.size);
    this.sceneTarget = hdrTarget(this.size.x, this.size.y, 4, true);
    this.sceneTarget.texture.name = 'postfx-scene';
    // three resolves the MSAA target at the end of EVERY render() call (so
    // twice a frame in split screen). Nothing reads the depth afterwards, so
    // only colour is blitted — the multisampled depth resolve is the
    // expensive half of that copy.
    this.sceneTarget.resolveDepthBuffer = false;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const t = hdrTarget(1, 1);
      t.texture.name = `postfx-bloom-${i}`;
      this.mips.push(t);
    }

    // Threshold + 4-tap box downsample (the taps sit on texel corners, so the
    // bilinear fetches average a 4x4 footprint — enough to stop sub-pixel
    // sparks from flickering in and out of the bloom as they move).
    this.prefilterMat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: 1 },
        uKnee: { value: 0.5 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 uTexel;
        uniform float uThreshold;
        uniform float uKnee;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tInput, vUv + uTexel * vec2(-1.0, -1.0)).rgb
                 + texture2D(tInput, vUv + uTexel * vec2( 1.0, -1.0)).rgb
                 + texture2D(tInput, vUv + uTexel * vec2(-1.0,  1.0)).rgb
                 + texture2D(tInput, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
          c *= 0.25;
          float b = max(c.r, max(c.g, c.b));
          float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
          soft = soft * soft / (4.0 * uKnee + 1e-4);
          float w = max(soft, b - uThreshold) / max(b, 1e-4);
          gl_FragColor = vec4(c * w, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    // Dual-filter downsample: centre x4 + four half-texel diagonals.
    this.downMat = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec2 o = uTexel * 0.5;
          vec3 c = texture2D(tInput, vUv).rgb * 4.0
                 + texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb
                 + texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb
                 + texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb
                 + texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb;
          gl_FragColor = vec4(c * 0.125, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    // 9-tap tent upsample, added onto the finer mip (additive blending), so
    // each level ends up holding itself + everything coarser: a wide soft
    // glow from a handful of tiny draws.
    this.upMat = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 uTexel;
        uniform float uWeight;
        varying vec2 vUv;
        void main() {
          vec2 o = uTexel;
          vec3 c = texture2D(tInput, vUv).rgb * 4.0
                 + (texture2D(tInput, vUv + vec2(-o.x, 0.0)).rgb + texture2D(tInput, vUv + vec2(o.x, 0.0)).rgb
                  + texture2D(tInput, vUv + vec2(0.0, -o.y)).rgb + texture2D(tInput, vUv + vec2(0.0, o.y)).rgb) * 2.0
                 + texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tInput, vUv + vec2(o.x, -o.y)).rgb
                 + texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb + texture2D(tInput, vUv + vec2(o.x,  o.y)).rgb;
          gl_FragColor = vec4(c * (uWeight / 16.0), 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    // Scene + bloom -> canvas. Tone mapping (renderer.toneMapping, i.e. none)
    // and the sRGB encode come from the two includes, as in OutputPass.
    this.outputMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform sampler2D tBloom;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(fullscreenTriangle(), this.outputMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.setSize();
  }

  // Re-reads the drawing-buffer size (call after renderer.setSize/setPixelRatio).
  setSize() {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    this.sceneTarget.setSize(w, h);
    let mw = w;
    let mh = h;
    for (const mip of this.mips) {
      mw = Math.max(1, Math.round(mw / 2));
      mh = Math.max(1, Math.round(mh / 2));
      mip.setSize(mw, mh);
    }
  }

  // Draws `camera`'s view into viewport `index` of `count` side-by-side
  // columns (1 = full frame, 2 = split screen). Callers render every view,
  // then call finish() once.
  renderView(scene: THREE.Scene, camera: THREE.Camera, index: number, count: number) {
    const r = this.renderer;
    if (!this.enabled) {
      r.setRenderTarget(null);
      const w = window.innerWidth;
      const h = window.innerHeight;
      const x0 = Math.floor((w * index) / count);
      const x1 = Math.floor((w * (index + 1)) / count);
      r.setViewport(x0, 0, x1 - x0, h);
      r.setScissor(x0, 0, x1 - x0, h);
      r.setScissorTest(count > 1);
      r.render(scene, camera);
      return;
    }
    const t = this.sceneTarget;
    const x0 = Math.floor((t.width * index) / count);
    const x1 = Math.floor((t.width * (index + 1)) / count);
    t.viewport.set(x0, 0, x1 - x0, t.height);
    t.scissor.set(x0, 0, x1 - x0, t.height);
    t.scissorTest = count > 1;
    r.setRenderTarget(t);
    r.render(scene, camera);
    this.rendered = true;
  }

  // Bloom + output for everything renderView drew this frame. A no-op beyond
  // resetting scissor state when disabled.
  finish() {
    const r = this.renderer;
    if (!this.enabled || !this.rendered) {
      r.setScissorTest(false);
      return;
    }
    this.rendered = false;
    const b = this.bloom;
    const src = this.sceneTarget;
    const autoClear = r.autoClear;
    r.autoClear = false;

    // 1. threshold + downsample into mip 0 (half res).
    this.prefilterMat.uniforms.tInput.value = src.texture;
    (this.prefilterMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
    this.prefilterMat.uniforms.uThreshold.value = b.threshold;
    this.prefilterMat.uniforms.uKnee.value = Math.max(1e-3, b.knee);
    this.blit(this.prefilterMat, this.mips[0]);

    // 2. downsample chain.
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      const from = this.mips[i - 1];
      this.downMat.uniforms.tInput.value = from.texture;
      (this.downMat.uniforms.uTexel.value as THREE.Vector2).set(1 / from.width, 1 / from.height);
      this.blit(this.downMat, this.mips[i]);
    }

    // 3. upsample back, accumulating into each finer level.
    this.upMat.uniforms.uWeight.value = b.radius;
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const from = this.mips[i];
      this.upMat.uniforms.tInput.value = from.texture;
      (this.upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / from.width, 1 / from.height);
      this.blit(this.upMat, this.mips[i - 1]);
    }

    // 4. output: scene + bloom, encoded for the canvas.
    this.outputMat.uniforms.tScene.value = src.texture;
    this.outputMat.uniforms.tBloom.value = this.mips[0].texture;
    this.outputMat.uniforms.uStrength.value = b.strength;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setViewport(0, 0, window.innerWidth, window.innerHeight);
    this.quad.material = this.outputMat;
    r.render(this.quadScene, this.quadCamera);

    r.autoClear = autoClear;
  }

  // Warms every material's shader program for BOTH output paths (HDR target
  // and canvas differ in tone-mapping/colour-space defines), so neither the
  // first frame of a race nor a Quality toggle compiles mid-play.
  compile(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    const previous = r.getRenderTarget();
    r.setRenderTarget(this.sceneTarget);
    r.compile(scene, camera);
    r.setRenderTarget(null);
    r.compile(scene, camera);
    for (const mat of [this.prefilterMat, this.downMat, this.upMat, this.outputMat]) {
      this.quad.material = mat;
      r.compile(this.quadScene, this.quadCamera);
    }
    this.quad.material = this.outputMat;
    r.setRenderTarget(previous);
  }

  // One fullscreen draw into `target`. No clear: the prefilter/downsample
  // passes overwrite every texel, and the upsample one blends onto them.
  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    const r = this.renderer;
    this.quad.material = material;
    target.viewport.set(0, 0, target.width, target.height);
    target.scissorTest = false;
    r.setRenderTarget(target);
    r.render(this.quadScene, this.quadCamera);
  }
}
