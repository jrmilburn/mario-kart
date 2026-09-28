import * as THREE from 'three';

// §v5 Effects: anime speed lines — thin white streaks rushing outward around
// the edge of the view once a kart is near top speed, and hard while boosting.
//
// It is geometry in clip space, not a DOM/canvas overlay and not a post pass:
// a ring (annulus) mesh whose vertex shader writes gl_Position directly in
// NDC, so it lands in whichever viewport is being rendered — the same mesh
// serves both split-screen halves, the caller just sets `intensity` for the
// player whose half is about to be drawn (Effects.setView). Being a ring
// rather than a fullscreen quad means the centre of the screen, where the
// kart is, costs no fragment work at all. Drawn last, no depth test; hidden
// (visible = false, i.e. no draw call) whenever intensity is ~0.

const RING_SEGMENTS = 64;
const INNER = 0.62; // NDC radius (per axis, so it follows the viewport's ellipse)
const OUTER = 1.45; // past the corners

export class SpeedLines {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    const positions: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      // x/y carry the unit direction, z the ring radius (inner/outer).
      positions.push(Math.cos(a), Math.sin(a), INNER, Math.cos(a), Math.sin(a), OUTER);
      if (i < RING_SEGMENTS) {
        const v = i * 2;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vDir;
        varying float vR;
        void main() {
          vDir = position.xy;
          vR = position.z;
          gl_Position = vec4(position.xy * position.z, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vDir;
        varying float vR;
        float hash(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          // Angular bins; each bin is one streak with its own speed, phase,
          // width and on/off chance, re-rolled every cycle so the pattern
          // never repeats visibly.
          float ang = atan(vDir.y, vDir.x) / 6.2831853 + 0.5;
          float bins = 140.0;
          float id = floor(ang * bins);
          float f = fract(ang * bins);
          float speed = 1.6 + hash(id * 1.7) * 1.6;
          float cycle = uTime * speed + hash(id * 3.1);
          float gen = floor(cycle);
          float ph = fract(cycle);
          float on = step(0.72, hash(id * 5.3 + gen * 11.7));
          float width = 0.12 + 0.18 * hash(id * 7.9 + gen);
          float across = 1.0 - smoothstep(0.0, width, abs(f - 0.5));
          // A dash that travels outward from the inner edge.
          float head = mix(${INNER.toFixed(2)}, ${OUTER.toFixed(2)}, ph);
          float len = 0.14 + 0.22 * hash(id * 9.3 + gen);
          float dash = smoothstep(head - len, head, vR) * (1.0 - smoothstep(head, head + 0.04, vR));
          float fadeIn = smoothstep(${INNER.toFixed(2)}, ${(INNER + 0.3).toFixed(2)}, vR);
          float a = across * dash * on * fadeIn * uIntensity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vec3(1.0, 0.98, 0.93), a * 0.45);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'speed-lines';
    this.mesh.frustumCulled = false; // clip-space geometry, never in any frustum
    this.mesh.renderOrder = 1000;
    this.mesh.visible = false;
  }

  set time(t: number) {
    this.material.uniforms.uTime.value = t;
  }

  set intensity(v: number) {
    this.material.uniforms.uIntensity.value = v;
    this.mesh.visible = v > 0.01;
  }
}
