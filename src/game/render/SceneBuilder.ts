import * as THREE from 'three';

export interface KartVisual {
  group: THREE.Group; // body+wheels+head; position/rotation driven by physics
  shadow: THREE.Mesh; // flat blob shadow; position-only follow, never rotates
}

// One large flat plane beneath everything (§3.1) for far-field coverage beyond
// the modeled grass ribbon around the track.
export function buildGround(scene: THREE.Scene) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshLambertMaterial({ color: 0x3d6b32 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);
}

export function buildLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(5, 10, 5);
  scene.add(dir);
}

// Kart's local "nose" points toward +Z (matches physics/Kart.ts kartForward()).
export function buildKart(bodyColor: number): KartVisual {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.5, 2.2),
    new THREE.MeshLambertMaterial({ color: bodyColor }),
  );
  body.position.y = 0.5;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 12, 10),
    new THREE.MeshLambertMaterial({ color: 0xffe0bd }),
  );
  head.position.set(0, 0.95, -0.3);
  group.add(head);

  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.28, 12);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const wheelOffsets: Array<[number, number, number]> = [
    [0.65, 0.32, 0.75],
    [-0.65, 0.32, 0.75],
    [0.65, 0.32, -0.75],
    [-0.65, 0.32, -0.75],
  ];
  for (const [x, y, z] of wheelOffsets) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    group.add(wheel);
  }

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(1.3, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;

  return { group, shadow };
}
