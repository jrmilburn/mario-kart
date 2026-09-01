import * as THREE from 'three';
import { buildGrassTexture } from './textures';

// §Phase 4 item 2. Replaces the old flat sky-blue background + single-color
// ground plane with: a gradient sky dome, a low-poly distant mountain ring,
// a handful of billboard clouds, fog retuned to the new palette, and a
// grass-textured ground plane matching the track's grass ribbon tone. Called
// once at scene setup; returns the pieces main.ts might want a handle to
// (currently just the ground, for parity with the old buildGround signature).

const SKY_RADIUS = 450;
const MOUNTAIN_RING_RADIUS = 260;
const GROUND_SIZE = 1000;
const GROUND_TEXTURE_TILE_METERS = 12;

const SKY_TOP = new THREE.Color(0x2f7fd6);
const SKY_HORIZON = new THREE.Color(0xbde3ff);
const FOG_COLOR = SKY_HORIZON.clone();
const FOG_NEAR = 90;
const FOG_FAR = 340;

export interface EnvironmentHandles {
  group: THREE.Group;
  ground: THREE.Mesh;
}

// Inverted sphere, vertically gradiented via vertex colors (horizon tone at
// the equator/below, sky-top tone overhead) — cheap, no custom shader needed.
// `fog: false` keeps the dome's own gradient readable; letting scene fog
// tint it would just wash the whole sphere to a flat fog color.
function buildSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(y, -SKY_RADIUS * 0.1, SKY_RADIUS * 0.9, 0, 1), 0, 1);
    c.copy(SKY_HORIZON).lerp(SKY_TOP, t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
  return new THREE.Mesh(geometry, material);
}

// A ring of irregular low-poly cones scattered around the track at a large
// radius, tinted blue-purple for atmospheric-perspective distance haze.
// Fog stays enabled here so they fade toward the horizon color at the edges.
function buildMountainRing(): THREE.Group {
  const group = new THREE.Group();
  const count = 26;
  const geometry = new THREE.ConeGeometry(1, 1, 5);
  geometry.translate(0, 0.5, 0); // base sits at local y=0, so per-instance scale.y controls height cleanly
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(geometry, material, count);

  const dummy = new THREE.Object3D();
  const baseColor = new THREE.Color(0x5c6f92);
  const shaded = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
    const radius = MOUNTAIN_RING_RADIUS + (Math.random() - 0.5) * 50;
    const height = 45 + Math.random() * 75;
    const widthX = 35 + Math.random() * 45;
    const widthZ = 35 + Math.random() * 45;
    dummy.position.set(Math.sin(angle) * radius, -8, Math.cos(angle) * radius);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.scale.set(widthX, height, widthZ);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    shaded.copy(baseColor).multiplyScalar(0.75 + Math.random() * 0.45);
    mesh.setColorAt(i, shaded);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
  return group;
}

function buildCloudTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// A handful of camera-facing (THREE.Sprite auto-billboards) soft white blobs
// scattered high overhead. One shared material/texture across all of them.
function buildClouds(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.SpriteMaterial({
    map: buildCloudTexture(),
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const count = 12;
  for (let i = 0; i < count; i++) {
    const sprite = new THREE.Sprite(material);
    const angle = Math.random() * Math.PI * 2;
    const radius = 110 + Math.random() * 170;
    const scale = 28 + Math.random() * 38;
    sprite.position.set(Math.sin(angle) * radius, 55 + Math.random() * 45, Math.cos(angle) * radius);
    sprite.scale.set(scale, scale * 0.55, 1);
    group.add(sprite);
  }
  return group;
}

// Large flat plane beneath everything for far-field coverage beyond the
// modeled grass ribbon, textured with the same procedural grass so the two
// blend seamlessly instead of the old flat-color ground meeting a
// vertex-colored ribbon at a visible tone mismatch.
function buildGroundPlane(): THREE.Mesh {
  const texture = buildGrassTexture();
  texture.repeat.set(GROUND_SIZE / GROUND_TEXTURE_TILE_METERS, GROUND_SIZE / GROUND_TEXTURE_TILE_METERS);
  const material = new THREE.MeshLambertMaterial({ map: texture });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE), material);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  return ground;
}

export function buildEnvironment(scene: THREE.Scene): EnvironmentHandles {
  scene.background = SKY_HORIZON.clone();
  scene.fog = new THREE.Fog(FOG_COLOR.getHex(), FOG_NEAR, FOG_FAR);

  const group = new THREE.Group();
  group.add(buildSkyDome());
  group.add(buildMountainRing());
  group.add(buildClouds());
  const ground = buildGroundPlane();
  group.add(ground);
  scene.add(group);

  return { group, ground };
}
