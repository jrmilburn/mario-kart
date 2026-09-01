// Single source of truth for the six playable/AI characters (§Phase 3). Both
// the game (SceneBuilder/CharacterLoader) and the controller (character
// select panel) import this — it's pure data, no THREE/DOM dependency, so
// it's safe to pull into either bundle. Keep it that way: adding an `import
// * as THREE` here would drag the whole renderer into the phone's controller
// bundle.

// §v3 Track B: the old three-colour CharacterFallbackColors (skin/primary/
// secondary) could only describe "head + torso + cap", which is why every
// racer used to read as the same blob in a different hue. These two style
// blocks drive CharacterBuilder/KartBuilder, which build a per-kind silhouette
// (a cap with a brim and a moustache, a gown, a snout, a spiked shell) so each
// racer is recognisable at 30m with zero GLB files present — the shipping
// state. The GLB override path (setDriver with a loaded model) ignores both.
export type DriverKind = 'plumber' | 'princess' | 'dino' | 'toad' | 'koopa';
export type KartKind = 'standard' | 'slim' | 'royal' | 'buggy' | 'mini' | 'heavy';

// The six slots mean slightly different things per kind (documented per
// character below) — they're deliberately a fixed palette rather than a
// per-kind union so the controller bundle stays plain data and so
// CharacterBuilder can share helpers (eyes, arms) across kinds.
export interface DriverStyle {
  kind: DriverKind;
  skin: number; // face/limbs (dino: belly, since the body colour lives in `shirt`)
  shirt: number; // torso/body
  overalls: number; // trousers/dress skirt/saddle/vest
  cap: number; // cap/crown/mushroom cap/shell
  hair: number; // hair, moustache, spots, spikes
  accent: number; // gloves, trim, emblem, horns
}

export interface KartStyle {
  kind: KartKind;
  accent: number; // bumper/seat/spoiler trim; the main shell uses `kartColor`
}

export interface CharacterDef {
  id: string;
  name: string;
  kartColor: number; // kart body color, also used for the controller swatch
  modelUrl: string; // public/ path; 404s are expected and harmless (fallback)
  scale: number; // per-model fit factor — real GLBs vary wildly, tune once you drop one in
  yOffset: number; // vertical seat adjustment from the driverAnchor origin
  rotationY: number; // facing correction; most fan-made exports face -Z, so PI
  // points them toward the kart's forward +Z (see physics/Kart.ts kartForward) — retune per model
  driver: DriverStyle;
  kart: KartStyle;
}

const SKIN = 0xffddb0;
const WHITE = 0xffffff;
const DENIM = 0x2e4fce;
const BROWN = 0x3a2416;

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'mario',
    name: 'Mario',
    kartColor: 0xe52521,
    modelUrl: '/assets/characters/mario.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    // Red shirt + blue overalls + red cap with a white emblem disc, brown
    // moustache/sideburns, white gloves.
    driver: { kind: 'plumber', skin: SKIN, shirt: 0xe52521, overalls: DENIM, cap: 0xe52521, hair: BROWN, accent: WHITE },
    kart: { kind: 'standard', accent: WHITE },
  },
  {
    id: 'luigi',
    name: 'Luigi',
    kartColor: 0x4cbb17,
    modelUrl: '/assets/characters/luigi.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    // Same plumber build, green livery — CharacterBuilder makes the 'slim'
    // kart's driver taller and narrower so he reads as Luigi beside Mario.
    driver: { kind: 'plumber', skin: SKIN, shirt: 0x4cbb17, overalls: DENIM, cap: 0x4cbb17, hair: BROWN, accent: WHITE },
    kart: { kind: 'slim', accent: WHITE },
  },
  {
    id: 'peach',
    name: 'Peach',
    kartColor: 0xf5a9c4,
    modelUrl: '/assets/characters/peach.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    // Pink bodice (`shirt`) over a deeper pink gown (`overalls`), gold crown
    // (`cap`), blonde hair, long white gloves (`accent`).
    driver: { kind: 'princess', skin: SKIN, shirt: 0xf7bcd2, overalls: 0xe8749d, cap: 0xffd447, hair: 0xf2d585, accent: WHITE },
    kart: { kind: 'royal', accent: 0xffd447 },
  },
  {
    id: 'yoshi',
    name: 'Yoshi',
    kartColor: 0x63d84c,
    modelUrl: '/assets/characters/yoshi.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    // `skin` is the white belly patch here, `shirt` the green body, `overalls`
    // the orange saddle, `hair` the red back spikes, `accent` the boots.
    driver: { kind: 'dino', skin: WHITE, shirt: 0x63d84c, overalls: 0xff7a1a, cap: 0x63d84c, hair: 0xd94f3d, accent: 0xff7a1a },
    kart: { kind: 'buggy', accent: 0xff7a1a },
  },
  {
    id: 'toad',
    name: 'Toad',
    kartColor: 0xf2f2f2,
    modelUrl: '/assets/characters/toad.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    // Huge white mushroom cap (`cap`) with red spots (`hair`), blue vest
    // (`overalls`) over a white body (`shirt`), yellow trim (`accent`).
    driver: { kind: 'toad', skin: SKIN, shirt: WHITE, overalls: 0x2b6fd0, cap: 0xf6f2ea, hair: 0xd23a3a, accent: 0xf2c94c },
    kart: { kind: 'mini', accent: 0xd23a3a },
  },
  {
    id: 'bowser',
    name: 'Bowser',
    kartColor: 0xf8d048,
    modelUrl: '/assets/characters/bowser.glb',
    scale: 1.15,
    yOffset: 0,
    rotationY: Math.PI,
    // Tan-orange hide (`skin`), cream belly (`shirt`), green shell
    // (`cap`/`overalls`), red hair tuft (`hair`), cream horns/spikes (`accent`).
    driver: { kind: 'koopa', skin: 0xd9a441, shirt: 0xf0d69a, overalls: 0x2f7a35, cap: 0x3e8e41, hair: 0xd8402a, accent: 0xf5e6c8 },
    kart: { kind: 'heavy', accent: 0x2f7a35 },
  },
];

export const CHARACTERS_BY_ID: Record<string, CharacterDef> = Object.fromEntries(
  CHARACTERS.map((c) => [c.id, c]),
);
