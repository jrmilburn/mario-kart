import * as THREE from 'three';

// Fixed pool: pickup shards and item-use sparks share one instanced draw call.
export class ArcadeEffects {
  readonly mesh: THREE.InstancedMesh;
  private cursor = 0;
  private life = new Float32Array(256);
  private positions = new Float32Array(768);
  private velocity = new Float32Array(768);
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.13),
      new THREE.MeshBasicMaterial({ toneMapped: false }), 256);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.clear();
    scene.add(this.mesh);
  }

  burst(pos: THREE.Vector3, rainbow = true) {
    for (let n = 0; n < 24; n++) {
      const i = this.cursor++ % 256, j = i * 3;
      const angle = n * 2.39996;
      const speed = 2 + Math.random() * 3;
      this.life[i] = 0.7;
      this.positions[j] = pos.x; this.positions[j + 1] = pos.y + 0.5; this.positions[j + 2] = pos.z;
      this.velocity[j] = Math.cos(angle) * speed;
      this.velocity[j + 1] = 2 + Math.random() * 4;
      this.velocity[j + 2] = Math.sin(angle) * speed;
      this.color.setHSL(rainbow ? n / 24 : 0.12, 0.95, 0.65);
      this.mesh.setColorAt(i, this.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() { this.life.fill(0); this.update(0); }

  update(dt: number) {
    for (let i = 0; i < 256; i++) {
      const j = i * 3;
      this.life[i] = Math.max(0, this.life[i] - dt);
      if (this.life[i] > 0) {
        this.velocity[j + 1] -= dt * 7;
        for (let k = 0; k < 3; k++) this.positions[j + k] += this.velocity[j + k] * dt;
        this.dummy.position.fromArray(this.positions, j);
        this.dummy.rotation.set(this.life[i] * 7, i + this.life[i] * 5, i);
      }
      this.dummy.scale.setScalar(Math.min(1, this.life[i] * 4));
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
