// Single source of truth for the six playable/AI characters (§Phase 3). Both
// the game (SceneBuilder/CharacterLoader) and the controller (character
// select panel) import this — it's pure data, no THREE/DOM dependency, so
// it's safe to pull into either bundle.

// Colors used to build the improved procedural fallback driver (head sphere +
// torso box + cap) when no GLB is present — the default, shippable state.
export interface CharacterFallbackColors {
  skin: number;
  primary: number; // torso/shirt
  secondary: number; // cap/hat
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
  fallbackColors: CharacterFallbackColors;
}

const SKIN = 0xffe0bd;

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'mario',
    name: 'Mario',
    kartColor: 0xe52521,
    modelUrl: '/assets/characters/mario.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    fallbackColors: { skin: SKIN, primary: 0xe52521, secondary: 0x2e4fce }, // red shirt, blue overalls
  },
  {
    id: 'luigi',
    name: 'Luigi',
    kartColor: 0x4cbb17,
    modelUrl: '/assets/characters/luigi.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    fallbackColors: { skin: SKIN, primary: 0x4cbb17, secondary: 0x2e4fce }, // green shirt, blue overalls
  },
  {
    id: 'peach',
    name: 'Peach',
    kartColor: 0xf5a9c4,
    modelUrl: '/assets/characters/peach.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    fallbackColors: { skin: SKIN, primary: 0xf5a9c4, secondary: 0xffd447 }, // pink dress, gold crown
  },
  {
    id: 'yoshi',
    name: 'Yoshi',
    kartColor: 0x63d84c,
    modelUrl: '/assets/characters/yoshi.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    fallbackColors: { skin: 0xffffff, primary: 0x63d84c, secondary: 0xff7a1a }, // white belly, green body, orange saddle
  },
  {
    id: 'toad',
    name: 'Toad',
    kartColor: 0xf2f2f2,
    modelUrl: '/assets/characters/toad.glb',
    scale: 1,
    yOffset: 0,
    rotationY: Math.PI,
    fallbackColors: { skin: SKIN, primary: 0xffffff, secondary: 0xd23a3a }, // white cap base, red spots
  },
  {
    id: 'bowser',
    name: 'Bowser',
    kartColor: 0xf8d048,
    modelUrl: '/assets/characters/bowser.glb',
    scale: 1.15,
    yOffset: 0,
    rotationY: Math.PI,
    fallbackColors: { skin: 0xd9a441, primary: 0xd9a441, secondary: 0x3e8e41 }, // tan-orange skin, green shell
  },
];

export const CHARACTERS_BY_ID: Record<string, CharacterDef> = Object.fromEntries(
  CHARACTERS.map((c) => [c.id, c]),
);
