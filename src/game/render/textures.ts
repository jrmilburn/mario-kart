import * as THREE from 'three';

// §Phase 4 item 1. Procedural CanvasTexture road/grass surfaces, with an
// optional real-image override at public/assets/textures/*.jpg — same
// fallback pattern as CharacterLoader (loader.load never throws on the
// caller, a 404/parse failure just console.warns and keeps whatever texture
// is already on the material). Procedural is always the synchronous default
// so the track never waits on a network round-trip to look right.
const textureLoader = new THREE.TextureLoader();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return { canvas, ctx: canvas.getContext('2d')! };
}

// Mid-gray asphalt base with a fine speckle of lighter/darker flecks to read
// as aggregate at driving distance without being a distinct repeating pattern.
export function buildAsphaltTexture(): THREE.CanvasTexture {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#6a6a6e';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 4000; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const shade = 70 + Math.random() * 90;
    ctx.fillStyle = `rgba(${shade | 0},${shade | 0},${(shade + 4) | 0},${0.12 + Math.random() * 0.22})`;
    const r = 0.4 + Math.random() * 1.1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Green base with short angled blade-like strokes for a mottled grass look.
export function buildGrassTexture(): THREE.CanvasTexture {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#4f9a44';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const g = 100 + Math.random() * 80;
    ctx.fillStyle = `rgba(30,${g | 0},30,${0.18 + Math.random() * 0.28})`;
    const w = 1 + Math.random() * 1.6;
    const h = 3 + Math.random() * 5;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.random() * Math.PI);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

// Eight jewel tiles across the road, with staggered colours along its length.
// UVs repeat every road-width in metres so the tiles remain approximately square.
// Fine dark grout and bright bevels keep the mosaic readable at racing speed.
export function buildRainbowTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(512);
  const palette = ['#ff3564', '#ff922e', '#ffe64c', '#52ef77', '#31dcea', '#4286ff', '#9258ff', '#ff66cf'];
  const tile = 64;
  ctx.fillStyle = '#251b49';
  ctx.fillRect(0, 0, 512, 512);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const x = col * tile, y = row * tile;
      ctx.fillStyle = palette[(col + row) % 8];
      ctx.fillRect(x + 1, y + 1, tile - 2, tile - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.38)';
      ctx.fillRect(x + 2, y + 2, tile - 4, 3);
      ctx.fillRect(x + 2, y + 2, 2, tile - 4);
      ctx.fillStyle = 'rgba(18,10,50,0.24)';
      ctx.fillRect(x + 3, y + tile - 4, tile - 5, 3);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// Swaps in a real image at `url` if present, keeping the procedural texture
// already on `material.map` as the permanent fallback on any load error (a
// missing file under public/assets/textures/ is the expected default state).
export function tryLoadTextureOverride(url: string, material: THREE.MeshLambertMaterial) {
  textureLoader.load(
    url,
    (tex) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      const prev = material.map;
      material.map = tex;
      material.needsUpdate = true;
      prev?.dispose();
    },
    undefined,
    (err) => {
      console.warn(`[textures] no override at "${url}", using procedural texture:`, err);
    },
  );
}
