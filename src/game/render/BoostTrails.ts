import * as THREE from 'three';

// §v5 Effects: boost trails — a short glowing ribbon streaming off every
// exhaust outlet while kart.boostTimer > 0 (drift release, pad, BOOST input).
//
// All ribbons of all karts are ONE mesh / one draw call. Each ribbon is a
// strip of SEGMENTS points (newest first); every point is two vertices that
// the vertex shader pushes apart sideways, perpendicular to both the ribbon's
// direction and the view ray — a camera-facing billboard strip computed on the
// GPU, which is what lets the same buffer serve both split-screen cameras (a
// CPU-built billboard would face only one of them).
//
// Point 0 is pinned to the exhaust every frame; every SAMPLE_SECONDS the strip
// shifts down one slot (copyWithin — no allocation) and a new point is laid.
// Width and brightness fall with each point's age, so the ribbon tapers to
// nothing and dissolves even after the boost ends. A fully dead ribbon has
// zero width everywhere: zero-area triangles rasterise nothing.
//
// Colour: white-hot yellow at the head fading through orange, HDR so it
// blooms (PostFX) — the brightest thing on screen on purpose.

export const TRAIL_SEGMENTS = 18;
const SAMPLE_SECONDS = 1 / 60;
const LIFETIME = 0.3; // seconds a laid point takes to fade out
const WIDTH = 0.32; // metres at the head

export class BoostTrails {
  readonly mesh: THREE.Mesh;
  private readonly count: number;
  // Per ribbon, per point: world position + birth time (CPU-side history).
  private readonly hist: Float32Array; // ribbons * SEGMENTS * 3
  private readonly born: Float32Array; // ribbons * SEGMENTS
  private readonly sampleClock: Float32Array; // per ribbon: seconds since the last laid point
  private readonly active: Uint8Array; // per ribbon: anything still visible
  private readonly position: Float32Array; // GPU: ribbons * SEGMENTS * 2 * 3
  private readonly tangent: Float32Array;
  private readonly life: Float32Array; // GPU: 0..1 (1 = fresh), 0 = collapsed
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly tangentAttr: THREE.BufferAttribute;
  private readonly lifeAttr: THREE.BufferAttribute;
  private time = 0;
  private dirty = false;

  constructor(maxRibbons: number) {
    this.count = maxRibbons;
    const pts = maxRibbons * TRAIL_SEGMENTS;
    this.hist = new Float32Array(pts * 3);
    this.born = new Float32Array(pts).fill(-1e9);
    this.sampleClock = new Float32Array(maxRibbons);
    this.active = new Uint8Array(maxRibbons);
    this.position = new Float32Array(pts * 2 * 3);
    this.tangent = new Float32Array(pts * 2 * 3);
    this.life = new Float32Array(pts * 2);
    const side = new Float32Array(pts * 2);
    for (let i = 0; i < pts; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
    }
    const along = new Float32Array(pts * 2);
    for (let r = 0; r < maxRibbons; r++) {
      for (let k = 0; k < TRAIL_SEGMENTS; k++) {
        const v = (r * TRAIL_SEGMENTS + k) * 2;
        along[v] = along[v + 1] = k / (TRAIL_SEGMENTS - 1);
      }
    }
    const index: number[] = [];
    for (let r = 0; r < maxRibbons; r++) {
      for (let k = 0; k < TRAIL_SEGMENTS - 1; k++) {
        const a = (r * TRAIL_SEGMENTS + k) * 2;
        const b = a + 2;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }

    const geo = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.tangentAttr = new THREE.BufferAttribute(this.tangent, 3).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.positionAttr);
    geo.setAttribute('aTangent', this.tangentAttr);
    geo.setAttribute('aLife', this.lifeAttr);
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    geo.setIndex(index);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uWidth: { value: WIDTH },
        uCore: { value: new THREE.Color(3.2, 2.7, 1.3) }, // white-hot yellow, HDR
        uTail: { value: new THREE.Color(2.2, 0.62, 0.12) }, // orange
      },
      vertexShader: /* glsl */ `
        attribute vec3 aTangent;
        attribute float aLife;
        attribute float aSide;
        attribute float aAlong;
        uniform float uWidth;
        varying float vLife;
        varying float vSide;
        varying float vAlong;
        void main() {
          vLife = aLife;
          vSide = aSide;
          vAlong = aAlong;
          vec3 toCam = normalize(cameraPosition - position);
          vec3 side = cross(aTangent, toCam);
          float l = length(side);
          side = l > 1e-4 ? side / l : vec3(0.0, 1.0, 0.0);
          // Flares slightly just behind the nozzle, then tapers with age.
          float w = uWidth * aLife * (0.75 + 0.5 * sin(min(aAlong * 6.0, 3.1416)));
          vec3 p = position + side * aSide * w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uCore;
        uniform vec3 uTail;
        varying float vLife;
        varying float vSide;
        varying float vAlong;
        void main() {
          float edge = 1.0 - vSide * vSide;           // soft across the strip
          float core = pow(edge, 3.0) * vLife;         // hot centre line
          vec3 col = mix(uTail, uCore, clamp(core * 1.4, 0.0, 1.0));
          float a = edge * vLife * vLife;
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'boost-trails';
    this.mesh.frustumCulled = false; // positions are rewritten every frame
    this.mesh.renderOrder = 11;
  }

  // Advances the shared clock once per render frame, before any feed().
  begin(dt: number) {
    this.time += dt;
  }

  // Ribbon `r`'s outlet this frame is (x,y,z), pointing back along (bx,bz)
  // (the kart's -forward). `boosting` decides whether it keeps laying points;
  // either way the ribbon keeps aging until it has faded out.
  feed(r: number, boosting: boolean, x: number, y: number, z: number, bx: number, bz: number, dt: number) {
    const base = r * TRAIL_SEGMENTS;
    const h = this.hist;
    if (boosting) {
      this.sampleClock[r] += dt;
      if (!this.active[r]) {
        // Fresh ribbon: collapse the whole history onto the outlet so the
        // first frame doesn't draw a streak from wherever it last died.
        for (let k = 0; k < TRAIL_SEGMENTS; k++) {
          h[(base + k) * 3] = x;
          h[(base + k) * 3 + 1] = y;
          h[(base + k) * 3 + 2] = z;
          this.born[base + k] = -1e9;
        }
        this.sampleClock[r] = SAMPLE_SECONDS;
        this.active[r] = 1;
      }
      if (this.sampleClock[r] >= SAMPLE_SECONDS) {
        this.sampleClock[r] = 0;
        h.copyWithin((base + 1) * 3, base * 3, (base + TRAIL_SEGMENTS - 1) * 3);
        this.born.copyWithin(base + 1, base, base + TRAIL_SEGMENTS - 1);
      }
      // The head rides the outlet every frame (and is always "just born").
      h[base * 3] = x;
      h[base * 3 + 1] = y;
      h[base * 3 + 2] = z;
      this.born[base] = this.time;
    } else if (!this.active[r]) {
      return;
    }

    let anyAlive = false;
    for (let k = 0; k < TRAIL_SEGMENTS; k++) {
      const p = base + k;
      const age = this.time - this.born[p];
      const life = age >= LIFETIME ? 0 : 1 - age / LIFETIME;
      if (life > 0) anyAlive = true;
      // Tangent toward the newer neighbour (the head uses the exhaust axis).
      let tx: number;
      let ty: number;
      let tz: number;
      if (k === 0) {
        tx = -bx;
        ty = 0;
        tz = -bz;
      } else {
        tx = h[(p - 1) * 3] - h[p * 3];
        ty = h[(p - 1) * 3 + 1] - h[p * 3 + 1];
        tz = h[(p - 1) * 3 + 2] - h[p * 3 + 2];
        if (tx * tx + ty * ty + tz * tz < 1e-8) {
          tx = -bx;
          ty = 0;
          tz = -bz;
        }
      }
      for (let s = 0; s < 2; s++) {
        const v = p * 2 + s;
        this.position[v * 3] = h[p * 3];
        this.position[v * 3 + 1] = h[p * 3 + 1];
        this.position[v * 3 + 2] = h[p * 3 + 2];
        this.tangent[v * 3] = tx;
        this.tangent[v * 3 + 1] = ty;
        this.tangent[v * 3 + 2] = tz;
        this.life[v] = life;
      }
    }
    if (!anyAlive && !boosting) this.active[r] = 0;
    this.dirty = true;
  }

  // Uploads whatever feed() touched this frame.
  end() {
    if (!this.dirty) return;
    this.dirty = false;
    this.positionAttr.needsUpdate = true;
    this.tangentAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
  }

  clear() {
    this.active.fill(0);
    this.life.fill(0);
    this.born.fill(-1e9);
    this.lifeAttr.needsUpdate = true;
  }

  get ribbonCount(): number {
    return this.count;
  }
}
