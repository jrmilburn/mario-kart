import * as THREE from 'three';

const MAX_PARTICLES = 300;
const PARTICLE_SIZE = 0.15;
const GRAVITY = 2;
const OFFSCREEN_Y = -1000;

// Tinted by drift tier (§Phase 11a), matching Hud's drift-bar colors.
const TIER_COLORS = [
  new THREE.Color(0x7f8c8d), // 0: gray (charging, below tier 1)
  new THREE.Color(0x3498db), // 1: blue
  new THREE.Color(0xe67e22), // 2: orange
  new THREE.Color(0x9b59b6), // 3: purple
];

// A single pooled THREE.Points burst system shared by all karts, so drift
// sparks never cost more than one draw call regardless of how many karts
// are drifting at once.
export class DriftSparks {
  points: THREE.Points;
  private positions: Float32Array;
  private colors: Float32Array;
  private velocities: Float32Array;
  private ages: Float32Array;
  private lifetimes: Float32Array;
  private cursor = 0;

  constructor() {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.ages = new Float32Array(MAX_PARTICLES).fill(Infinity);
    this.lifetimes = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) this.positions[i * 3 + 1] = OFFSCREEN_Y;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: PARTICLE_SIZE,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
  }

  emit(pos: THREE.Vector3, tier: number, count = 2) {
    const color = TIER_COLORS[Math.min(tier, TIER_COLORS.length - 1)];
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      this.positions[i * 3] = pos.x + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 1] = pos.y + Math.random() * 0.2;
      this.positions[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.3;
      this.velocities[i * 3] = (Math.random() - 0.5) * 1.5;
      this.velocities[i * 3 + 1] = Math.random() * 1.5 + 0.5;
      this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
      this.colors[i * 3] = color.r;
      this.colors[i * 3 + 1] = color.g;
      this.colors[i * 3 + 2] = color.b;
      this.ages[i] = 0;
      this.lifetimes[i] = 0.35 + Math.random() * 0.2;
    }
  }

  update(dt: number) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.ages[i] === Infinity) continue;
      this.ages[i] += dt;
      if (this.ages[i] > this.lifetimes[i]) {
        this.ages[i] = Infinity;
        this.positions[i * 3 + 1] = OFFSCREEN_Y;
        continue;
      }
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt - GRAVITY * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
