import * as THREE from 'three';

// §v5 Effects: one pooled, fixed-capacity point-sprite system — the shared
// engine under the drift sparks and the dust puffs (Effects.ts). One
// THREE.Points = one draw call per effect type no matter how many karts are
// emitting, and nothing allocates after construction: spawn() writes into a
// ring of preallocated typed arrays, update() ages them in place.
//
// Sprites are sized in METRES (perspective-scaled in the vertex shader), so a
// spark is the same size on the kart in both split-screen halves and in the
// full-screen showcase. Colours may exceed 1.0: in the HDR scene target
// (PostFX) that is what makes a spark bloom; on Low quality they just clamp.
//
// A dead particle keeps its slot with size 0, so gl_PointSize is 0 and the GPU
// rasterises nothing for it — cheaper than compacting the buffer every frame.

export interface ParticlePoolOptions {
  capacity: number;
  additive: boolean; // additive glow (sparks) vs. alpha-blended (dust)
  gravity: number; // m/s^2, applied to vy
  drag: number; // 1/s exponential velocity damping
  // Alpha envelope over normalised age t: 'spark' = bright then fade (1 - t^2),
  // 'puff' = quick fade in, long fade out.
  envelope: 'spark' | 'puff';
  // Sprite falloff: 'hot' = sharp bright core (sparks), 'soft' = cotton-wool.
  falloff: 'hot' | 'soft';
  name: string;
}

export class ParticlePool {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;
  private readonly position: Float32Array;
  private readonly color: Float32Array; // rgb (may be > 1) + alpha
  private readonly size: Float32Array;
  private readonly velocity: Float32Array;
  private readonly base: Float32Array; // rgb, alpha0 at spawn
  private readonly sizes: Float32Array; // size0, size1
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private cursor = 0;
  private live = 0; // upper bound on live particles, lets update() early-out when idle

  constructor(private readonly opts: ParticlePoolOptions) {
    const n = (this.capacity = opts.capacity);
    this.position = new Float32Array(n * 3);
    this.color = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.velocity = new Float32Array(n * 3);
    this.base = new Float32Array(n * 4);
    this.sizes = new Float32Array(n * 2);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.positionAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aSize', this.sizeAttr);

    const falloff =
      opts.falloff === 'hot'
        ? 'float a = 1.0 - d; a *= a; vec3 rgb = vColor.rgb * (1.0 + 1.5 * a);'
        : 'float a = smoothstep(1.0, 0.15, d); vec3 rgb = vColor.rgb;';
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float d = dot(p, p);
          if (d > 1.0) discard;
          ${falloff}
          gl_FragColor = vec4(rgb, a * vColor.a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.name = opts.name;
    // Particles move without a bounding-sphere recompute; they're only ever
    // near the karts, which are what the cameras look at anyway.
    this.points.frustumCulled = false;
    this.points.renderOrder = 10; // after the opaque world, like any transparent
  }

  // Pixels per metre at 1m depth, roughly the camera's focal length in
  // drawing-buffer pixels. Effects sets it from the buffer height on resize.
  setScale(scale: number) {
    this.material.uniforms.uScale.value = scale;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    size0: number,
    size1: number,
    life: number,
  ) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    const i3 = i * 3;
    const i4 = i * 4;
    this.position[i3] = x;
    this.position[i3 + 1] = y;
    this.position[i3 + 2] = z;
    this.velocity[i3] = vx;
    this.velocity[i3 + 1] = vy;
    this.velocity[i3 + 2] = vz;
    this.base[i4] = r;
    this.base[i4 + 1] = g;
    this.base[i4 + 2] = b;
    this.base[i4 + 3] = alpha;
    this.sizes[i * 2] = size0;
    this.sizes[i * 2 + 1] = size1;
    this.age[i] = 0;
    this.life[i] = life;
    this.live = Math.min(this.capacity, this.live + 1);
  }

  update(dt: number) {
    if (this.live === 0) return;
    const { gravity, drag, envelope } = this.opts;
    const keep = Math.exp(-drag * dt);
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = this.age[i] + dt;
      const i3 = i * 3;
      const i4 = i * 4;
      if (age >= life) {
        this.life[i] = 0;
        this.size[i] = 0;
        this.color[i4 + 3] = 0;
        continue;
      }
      alive++;
      this.age[i] = age;
      const t = age / life;
      this.velocity[i3] *= keep;
      this.velocity[i3 + 1] = this.velocity[i3 + 1] * keep - gravity * dt;
      this.velocity[i3 + 2] *= keep;
      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;
      const env = envelope === 'spark' ? 1 - t * t : Math.min(1, t * 8) * (1 - t);
      this.color[i4] = this.base[i4];
      this.color[i4 + 1] = this.base[i4 + 1];
      this.color[i4 + 2] = this.base[i4 + 2];
      this.color[i4 + 3] = this.base[i4 + 3] * env;
      this.size[i] = this.sizes[i * 2] + (this.sizes[i * 2 + 1] - this.sizes[i * 2]) * t;
    }
    this.live = alive;
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
    this.live = 0;
    this.sizeAttr.needsUpdate = true;
  }
}
