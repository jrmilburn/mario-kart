import { ROAD_HALF, type TrackDef, type TrackPoint } from './trackData';

// §v5 Capricorn Coast — the one circuit this build ships. An original layout
// on a golden-hour tropical coast. The start straight runs along +z with the
// sea off towards -x — which, in three.js's right-handed frame, is on the
// driver's right as seen on screen. "Right"/"left" in this file always mean
// as the player sees it:
//
//   1 esplanade start straight (beach on the right, palms + Norfolk pines)
//   2 wide banked right-hander climbing onto the basalt headland
//   3 descend (banked left) onto the harbour breakwater straight — boost pads
//   4 big banked left hairpin round the harbour head (the main drift corner)
//   5 back past the marina, a banked right into the cane fields, then ONE
//     jump over the cane-train rail crossing
//   6 an S-bend through the cane, with a SHORTCUT dirt track cutting straight
//     through it (rough surface, slower unless boosting)
//   7 a long banked left sweeper back onto the esplanade
//
// How to edit: see TrackPoint in trackData.ts for what `bank` / `tag` / `zone`
// mean. Move points freely, then run `npx tsx --test scripts/track.test.ts` —
// it checks the smoothed loop for self-intersection with full corridor
// clearance (both corridors), corner radius, grade, the jump's airtime and
// the shortcut's lap accounting — and that every bank leans *into* its corner.
// Bank sign: + for right-handers (the driver's right edge rolls down), - for
// left-handers. Keep tagged points flat (bank 0).
//
// Heights: the esplanade sits at y=0 with the sea surface at SEA_LEVEL (see
// Environment.ts), the headland crest at +7, the breakwater and harbour head
// at +1.6..2.2 and the cane flats at +2..3. Banked corners sit high enough
// that their low verge edge (centre - 14m x tan(bank)) stays clear of the
// sea — scripts/track.test.ts checks it. Control-point-to-point grades stay under ~9%; the sampler
// warns if the smoothed curve ever exceeds 12% outside the jump.
const POINTS: readonly TrackPoint[] = [
  // 1 esplanade
  { p: [0, 0, 0], zone: 'esplanade' }, // 0 start/finish line
  { p: [0, 0, 44] },
  { p: [-3, 0.9, 76], bank: 5 },
  // 2 banked right, climbing to the headland
  { p: [-17, 2.4, 100], bank: 10, zone: 'headland' },
  { p: [-40, 4.4, 113], bank: 11 },
  { p: [-66, 6.2, 117], bank: 5 }, // 5 crest
  { p: [-92, 6.8, 119], bank: -3 },
  // 3 descending left onto the breakwater
  { p: [-115, 5.6, 131], bank: -9 },
  { p: [-128, 3.8, 154], bank: -8, zone: 'harbour' },
  { p: [-131, 2, 184] }, // 9 breakwater straight (boost pads)
  { p: [-131, 1.6, 240] },
  // 4 big banked left hairpin round the harbour head
  { p: [-127, 2, 268], bank: -8 },
  { p: [-113, 2.2, 290], bank: -11 },
  { p: [-89, 2.2, 298], bank: -11 }, // 13 apex
  { p: [-66, 2.2, 287], bank: -11 },
  { p: [-56, 2, 264], bank: -7 },
  // 5 back past the marina, banked right into the cane
  { p: [-55, 1.9, 238], bank: 4 },
  { p: [-44, 2.2, 212], bank: 9, zone: 'cane' },
  { p: [-22, 2.6, 197], bank: 5 },
  { p: [-2, 3, 193] },
  { p: [14, 3, 192], tag: 'jump-lip' }, // 20 over the cane-train rail
  { p: [40, 3, 191] },
  { p: [62, 3, 185], bank: -6 },
  { p: [83, 3, 169], bank: -8 },
  // 6 S-bend through the cane (the shortcut goes straight down the middle)
  { p: [94, 3, 146], tag: 'shortcut-out' }, // 24
  { p: [110, 3, 126] }, // flat: still overlapping the shortcut's mouth
  { p: [136, 2.8, 110], bank: -5 },
  { p: [162, 2.6, 88], bank: 3 },
  { p: [172, 2.4, 58], bank: -6 },
  { p: [162, 2.2, 28], bank: -8 },
  { p: [140, 2, 4], bank: -4 },
  { p: [117, 1.8, -13] }, // flat: the shortcut rejoins alongside
  { p: [101, 1.6, -34], tag: 'shortcut-in' }, // 32
  // 7 long banked left sweeper back to the line
  { p: [92, 1.8, -60], bank: -8 },
  { p: [72, 2, -84], bank: -10 },
  { p: [45, 1.9, -95], bank: -10, zone: 'esplanade' }, // back to the beach
  { p: [19, 1.6, -85], bank: -9 },
  { p: [4, 0.6, -60], bank: -4 },
  { p: [0, 0, -30] },
];

export const CAPRICORN_COAST: TrackDef = {
  points: POINTS,
  // A kicker that throws a race-speed kart ~20m (about 0.7s of air) — well
  // clear of the gap — while a slow kart simply drops into the rail cutting
  // and climbs out the far side. Verified in scripts/track.test.ts.
  jump: { rampLength: 12, rampHeight: 1.5, gapLength: 12, gapDepth: 2.5 },
  shortcut: {
    points: [
      [91, 3, 118],
      [96, 2.6, 78],
      [92, 2.2, 38],
      [95, 1.9, 2],
    ],
  },
  // Three pads down the breakwater straight, alternating sides so the ideal
  // line has to weave across the road for all of them.
  pads: [
    { cp: 9, from: 6, to: 18, latMin: -ROAD_HALF, latMax: 1 },
    { cp: 9, from: 26, to: 38, latMin: -1, latMax: ROAD_HALF },
    { cp: 9, from: 46, to: 58, latMin: -ROAD_HALF, latMax: 1 },
  ],
};
