// §v5 Rendering: shared cel-shaded materials.
//
// Every toon surface in the game samples the same 3-texel gradient map, so the
// whole cast (and anything else that opts in) lands on the same three light
// bands — lit, mid, shade — instead of each material inventing its own ramp.
// NearestFilter is the entire trick: linear filtering would blend the texels
// back into a smooth Lambert falloff.
//
// Materials are cached and SHARED. That is a change from the v3 builders,
// which made a fresh material per bucket per kart so setKartColor could tint
// one kart without repainting another; the karts are now vertex-coloured
// (PartAssembler) and retint by rewriting their own colour attribute, so one
// material instance can serve all six. Consequence for callers: never
// dispose() a material obtained from here — dispose geometry only (see
// PartAssembler.disposeGeometries).
import * as THREE from 'three';

// Shade / mid / lit, as 0-255 multipliers on the DIRECT light only (ambient
// and hemisphere light are added on top un-banded by MeshToonMaterial). §v5
// cleanup: this is now the ONE ramp for the whole game — the cast and the
// world (track, terrain, props) used to carry two slightly different ones.
// The shade step is deliberately not dark: at golden hour the hemisphere fill
// does most of the work on the shaded side, and a toy-like world reads better
// with soft, warm shade than with hard contrast (and it never goes muddy).
const GRADIENT_STEPS = [117, 189, 255];

let gradient: THREE.DataTexture | null = null;

export function toonGradientMap(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array(GRADIENT_STEPS);
  gradient = new THREE.DataTexture(data, GRADIENT_STEPS.length, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

const byColor = new Map<number, THREE.MeshToonMaterial>();

// One cached MeshToonMaterial per hex colour.
export function getToonMaterial(color: number): THREE.MeshToonMaterial {
  let mat = byColor.get(color);
  if (!mat) {
    mat = new THREE.MeshToonMaterial({ color, gradientMap: toonGradientMap() });
    mat.name = `toon#${color.toString(16).padStart(6, '0')}`;
    byColor.set(color, mat);
  }
  return mat;
}

let vertexMat: THREE.MeshToonMaterial | null = null;

// The material every kart/driver mesh uses: white base, colour from the
// geometry's `color` attribute. One material for the whole cast means the
// renderer never switches program between karts.
export function getToonVertexMaterial(): THREE.MeshToonMaterial {
  if (!vertexMat) {
    vertexMat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonGradientMap() });
    vertexMat.name = 'toon-vertex';
  }
  return vertexMat;
}

// §v5 world materials (track ribbon, verges, barriers, terrain, props): a
// fresh, UNSHARED toon material on the shared gradient, because those callers
// pass per-mesh parameters (polygon offset, double-siding, a texture map) that
// a colour-keyed cache can't express. Safe to dispose, unlike the cached ones.
export function toonMaterial(params: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ gradientMap: toonGradientMap(), ...params });
}

// Vertex-coloured variant, the common case for merged/instanced world props.
export function toonVertexMaterial(params: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return toonMaterial({ vertexColors: true, ...params });
}
