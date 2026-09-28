import * as THREE from 'three';
import type { TrackSample } from './TrackBuilder';
import { TUNING } from '../tuning';
import {
  CHECKPOINT_COUNT,
  GRASS_HALF,
  SHORTCUT_HALF,
  SHORTCUT_WALL_HALF,
  type SurfaceZone,
  type TrackDef,
  type TrackTag,
  type TrackZone,
} from './trackData';

// Shared by rendering and layout validation: no canvas or browser dependency,
// so scripts/track.test.ts can build the exact same samples the game races on.
export const SAMPLE_COUNT = 600;
const RAW_SAMPLE_COUNT = 4000;
const UP = new THREE.Vector3(0, 1, 0);
const MAX_SAMPLE_GRADE = 0.12;
const DEG = Math.PI / 180;
// §v5 shortcut: resampled at roughly the main line's own spacing (~1.8m).
const SHORTCUT_SAMPLE_SPACING = 1.6;

// §v5 shortcut: a second, open (non-looping) corridor. Its samples carry the
// same pos/forward/right frame as the main line's, plus `mainS` — the main
// line arc length this point *counts as* for lap progress. mainS rises
// monotonically from the junction it leaves (entryS) to the one it rejoins
// (exitS), so driving the shortcut sweeps every checkpoint in between in
// order: legal, never a way to skip one (see TrackQuery.nearestSample).
export interface ShortcutSample {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  right: THREE.Vector3;
  s: number; // own arc length from the exit junction
  mainS: number;
  grade: number;
}

export interface ShortcutData {
  samples: ShortcutSample[];
  length: number;
  entryS: number; // main-line s where the shortcut leaves
  exitS: number; // main-line s where it rejoins
  halfWidth: number;
  wallHalf: number;
}

// §v5 jump: everything downstream (TrackQuery, TrackBuilder, Environment,
// tests) needs about the jump, in main-line arc length.
export interface JumpData {
  rampStartS: number;
  lipS: number; // exactly a sample's s — the last sample on the ramp top
  gapEndS: number;
  lipIndex: number;
  rampHeight: number;
  gapDepth: number;
}

export interface TrackLayout {
  samples: TrackSample[];
  totalLength: number;
  checkpoints: number[];
  surfaceZones: SurfaceZone[];
  shortcut: ShortcutData | null;
  jump: JumpData | null;
  /** Main-line s of each control point, in authoring order. */
  controlS: number[];
}

function findIndexForS(cum: number[], targetS: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < targetS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Signed arc-length offset wrapped into [-L/2, L/2).
function wrapSigned(d: number, totalLength: number): number {
  return ((((d + totalLength / 2) % totalLength) + totalLength) % totalLength) - totalLength / 2;
}

function smoothstep01(t: number): number {
  return t * t * (3 - 2 * t);
}

// §v5: arc-length resampling of a raw polyline (closed or open), with a
// parallel scalar channel interpolated alongside (bank for the main line).
// Linear interpolation between the bracketing raw points rather than taking
// the nearer one, so sample spacing is exactly uniform.
function resample(
  raw: THREE.Vector3[],
  channel: number[],
  count: number,
  totalLength: number,
  cum: number[],
): { pos: THREE.Vector3; value: number; rawIdx: number }[] {
  const out: { pos: THREE.Vector3; value: number; rawIdx: number }[] = [];
  for (let i = 0; i < count; i++) {
    const targetS = (i / count) * totalLength;
    const idx = Math.max(1, findIndexForS(cum, targetS));
    const span = cum[idx] - cum[idx - 1];
    const t = span > 0 ? (targetS - cum[idx - 1]) / span : 0;
    out.push({
      pos: raw[idx - 1].clone().lerp(raw[idx], t),
      value: channel[idx - 1] + (channel[idx] - channel[idx - 1]) * t,
      rawIdx: idx - 1 + t,
    });
  }
  return out;
}

function cumulative(raw: THREE.Vector3[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + raw[i].distanceTo(raw[i - 1]));
  return cum;
}

// §v5: the whole map resolved into what the game and the tests consume —
// samples (with per-sample bank, zone and jump profile baked in), checkpoints,
// surface zones in arc length, the shortcut corridor and the jump's extent.
export function buildLayout(def: TrackDef): TrackLayout {
  const pts = def.points;
  const l = pts.length;
  const points = pts.map(({ p: [x, y, z] }) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  const raw = curve.getPoints(RAW_SAMPLE_COUNT);

  // Per-raw-point bank. three's closed CatmullRomCurve3 spends an equal slice
  // of `u` on every control-point segment (centripetal only shapes the
  // tangents), so raw point i sits at segment floor(i*l/RAW), fraction frac.
  // Smoothstep between neighbours keeps the roll C1 and flat at each point.
  // Authored banks are "+ = right-hander as seen on screen"; the sample's
  // `right` vector is the driver's on-screen left (see trackData.ts), and
  // TrackSample.bank lowers the +right side when positive — hence the flip.
  const bankDeg = pts.map((pt) => -(pt.bank ?? 0));
  const rawBank: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = (i / RAW_SAMPLE_COUNT) * l;
    const seg = Math.min(Math.floor(p), l - 1);
    const frac = p - seg;
    const b0 = bankDeg[seg];
    const b1 = bankDeg[(seg + 1) % l];
    rawBank.push((b0 + (b1 - b0) * smoothstep01(frac)) * DEG);
  }

  const cum = cumulative(raw);
  const totalLength = cum[cum.length - 1];

  // Control point k is raw index k*RAW/l exactly (fractional) — its s.
  const controlS = pts.map((_, k) => {
    const f = (k * RAW_SAMPLE_COUNT) / l;
    const i0 = Math.floor(f);
    const i1 = Math.min(i0 + 1, raw.length - 1);
    return cum[i0] + (cum[i1] - cum[i0]) * (f - i0);
  });

  // Zones persist from the point that names one to the next that does.
  const zoneOf: TrackZone[] = [];
  let zone: TrackZone = pts.find((pt) => pt.zone)?.zone ?? 'esplanade';
  // Seed from the last named zone so points before the first explicit one
  // (wrapping round the seam) inherit correctly.
  for (let k = l - 1; k >= 0; k--) {
    if (pts[k].zone) {
      zone = pts[k].zone!;
      break;
    }
  }
  for (let k = 0; k < l; k++) {
    if (pts[k].zone) zone = pts[k].zone!;
    zoneOf.push(zone);
  }

  const resampled = resample(raw, rawBank, SAMPLE_COUNT, totalLength, cum);
  const samples: TrackSample[] = resampled.map((r, i) => {
    const seg = Math.min(Math.floor((r.rawIdx / RAW_SAMPLE_COUNT) * l), l - 1);
    return {
      pos: r.pos,
      s: (i / SAMPLE_COUNT) * totalLength,
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      grade: 0,
      bank: r.value,
      zone: zoneOf[seg],
      feature: null,
    };
  });

  const tagS = (tag: TrackTag): { s: number; k: number } | null => {
    const k = pts.findIndex((pt) => pt.tag === tag);
    return k < 0 ? null : { s: controlS[k], k };
  };

  // §v5 jump: baked into the samples' own heights, so every consumer (ground
  // queries, the road ribbon, the terrain heightfield's cutting under the gap)
  // sees one consistent profile. The lip is snapped to a sample so the ramp
  // top is a real vertex and the very next sample is already in the gap.
  let jump: JumpData | null = null;
  const lip = tagS('jump-lip');
  if (lip && def.jump) {
    const { rampLength, rampHeight, gapLength, gapDepth } = def.jump;
    const spacing = totalLength / SAMPLE_COUNT;
    const lipIndex = Math.round(lip.s / spacing) % SAMPLE_COUNT;
    const lipS = lipIndex * spacing;
    jump = {
      rampStartS: lipS - rampLength,
      lipS,
      gapEndS: lipS + gapLength,
      lipIndex,
      rampHeight,
      gapDepth,
    };
    for (const sample of samples) {
      // Wrap-aware, so a lip authored near the start/finish seam still gets
      // its whole ramp and gap (rampStartS/gapEndS are then left unwrapped,
      // i.e. may fall outside [0, totalLength) — compare them via wrapDelta).
      const d = wrapSigned(sample.s - lipS, totalLength);
      if (d > -rampLength && d <= 0) {
        const u = (d + rampLength) / rampLength;
        sample.pos.y += rampHeight * u * u;
        sample.feature = 'ramp';
      } else if (d > 0 && d < gapLength) {
        sample.pos.y -= gapDepth * Math.sin((Math.PI * d) / gapLength);
        sample.feature = 'gap';
      }
    }
  }

  // forward/right computed from neighbor samples once all positions are known.
  // NOTE: our kart heading convention is forward = (sin(h), 0, cos(h)) (see
  // physics/Kart.ts kartForward), for which "driver's right" is up x forward.
  // §Phase 5 item 2: `right` is built from forward's *horizontal* projection so
  // it stays perfectly level. §v5: banking is NOT expressed by tilting `right`
  // — lateral maths everywhere (TrackQuery, collision, AI) relies on it being
  // horizontal — but carried separately as `bank`, applied to heights only.
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const prev = samples[(i - 1 + SAMPLE_COUNT) % SAMPLE_COUNT].pos;
    const next = samples[(i + 1) % SAMPLE_COUNT].pos;
    const forward = next.clone().sub(prev).normalize();
    const horizontalForward = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    samples[i].forward = forward;
    samples[i].right = UP.clone().cross(horizontalForward).normalize();
    samples[i].grade = forward.y;
  }

  checkGradeSafety(samples, totalLength);

  const checkpoints: number[] = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    checkpoints.push(Math.round((i * SAMPLE_COUNT) / CHECKPOINT_COUNT) % SAMPLE_COUNT);
  }

  // Wrapped into [0, totalLength): a pad straddling the seam comes out with
  // sStart > sEnd, which TrackQuery.surfaceAt already reads as spanning it.
  const wrapS = (s: number) => ((s % totalLength) + totalLength) % totalLength;
  const surfaceZones: SurfaceZone[] = (def.pads ?? []).map((pad) => ({
    type: 'boost',
    sStart: wrapS(controlS[pad.cp] + pad.from),
    sEnd: wrapS(controlS[pad.cp] + pad.to),
    latMin: pad.latMin,
    latMax: pad.latMax,
  }));

  const out = tagS('shortcut-out');
  const back = tagS('shortcut-in');
  const shortcut = out && back && def.shortcut ? buildShortcut(def, out, back, samples, totalLength) : null;

  return { samples, totalLength, checkpoints, surfaceZones, shortcut, jump, controlS };
}

// §v5 shortcut: open centripetal Catmull-Rom from the 'shortcut-out' control
// point through the authored interior points to 'shortcut-in'. Because those
// two ends are the main spline's own control points (which the closed curve
// passes through exactly), the shortcut always starts and ends precisely on
// the main centerline.
function buildShortcut(
  def: TrackDef,
  out: { s: number; k: number },
  back: { s: number; k: number },
  mainSamples: TrackSample[],
  totalLength: number,
): ShortcutData {
  const ends = [def.points[out.k].p, ...def.shortcut!.points, def.points[back.k].p];
  const points = ends.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const raw = curve.getPoints(RAW_SAMPLE_COUNT / 4);
  const cum = cumulative(raw);
  const length = cum[cum.length - 1];
  const count = Math.max(8, Math.round(length / SHORTCUT_SAMPLE_SPACING));
  const zeros = raw.map(() => 0);
  // count+1 samples so the final one lands exactly on the rejoin point.
  const resampled = resample(raw, zeros, count, length, cum);
  resampled.push({ pos: raw[raw.length - 1].clone(), value: 0, rawIdx: raw.length - 1 });

  const entryS = out.s;
  let exitS = back.s;
  if (exitS < entryS) exitS += totalLength; // unwrapped; TrackQuery wraps on output
  const samples: ShortcutSample[] = resampled.map((r, i) => ({
    pos: r.pos,
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    s: (i / count) * length,
    mainS: 0,
    grade: 0,
  }));
  const n = samples.length;

  // mainS: in the two fork zones, where the shortcut still lies inside the
  // main corridor (so a kart there is classified as on the main line — see
  // TrackQuery.nearestSample), it is simply the main line's own s at that
  // point; between them it runs linearly. So progress is continuous where a
  // kart actually switches corridor, and monotonic all the way through.
  const unwrap = (s: number) => entryS + ((((s - entryS) % totalLength) + totalLength) % totalLength);
  const legalMain = GRASS_HALF - TUNING.kartRadius;
  const proj = samples.map((p) => nearestMainS(mainSamples, totalLength, p.pos));
  let a = 0;
  while (a < n - 1 && proj[a + 1].dist < legalMain) a++;
  let b = n - 1;
  while (b > a && proj[b - 1].dist < legalMain) b--;
  const sA = a === 0 ? entryS : unwrap(proj[a].s);
  const sB = b === n - 1 ? exitS : Math.max(sA, unwrap(proj[b].s));
  for (let i = 0; i < n; i++) {
    if (i === 0) samples[i].mainS = entryS;
    else if (i === n - 1) samples[i].mainS = exitS;
    else if (i <= a) samples[i].mainS = Math.max(samples[i - 1].mainS, unwrap(proj[i].s));
    else if (i >= b) samples[i].mainS = Math.min(exitS, Math.max(samples[i - 1].mainS, unwrap(proj[i].s)));
    else samples[i].mainS = sA + ((sB - sA) * (samples[i].s - samples[a].s)) / (samples[b].s - samples[a].s);
  }
  for (let i = 0; i < n; i++) {
    const prev = samples[Math.max(0, i - 1)].pos;
    const next = samples[Math.min(n - 1, i + 1)].pos;
    const forward = next.clone().sub(prev).normalize();
    const horizontalForward = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    samples[i].forward = forward;
    samples[i].right = UP.clone().cross(horizontalForward).normalize();
    samples[i].grade = forward.y;
  }
  return { samples, length, entryS, exitS, halfWidth: SHORTCUT_HALF, wallHalf: SHORTCUT_WALL_HALF };
}

// Brute-force closest point on the main polyline (x/z): its s and distance.
// Build-time only (a few hundred shortcut samples x 600 segments).
function nearestMainS(mainSamples: TrackSample[], totalLength: number, p: THREE.Vector3): { s: number; dist: number } {
  let best = { s: 0, dist: Infinity };
  const n = mainSamples.length;
  for (let i = 0; i < n; i++) {
    const a = mainSamples[i].pos;
    const b = mainSamples[(i + 1) % n].pos;
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const lenSq = sx * sx + sz * sz;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * sx + (p.z - a.z) * sz) / lenSq)) : 0;
    const dist = Math.hypot(p.x - (a.x + sx * t), p.z - (a.z + sz * t));
    if (dist < best.dist) best = { s: mainSamples[i].s + (totalLength / n) * t, dist };
  }
  return best;
}

// §Phase 5 item 1: a cheap one-time startup sanity check on the authored
// heights -- warns (doesn't throw) if the Catmull-Rom-smoothed per-sample
// slope ever exceeds the grade budget, catching an over-steep control-point
// edit before it ships. Wrap-aware at the start/finish seam. §v5: the jump's
// ramp and gap are steep by design and are skipped.
function checkGradeSafety(samples: TrackSample[], totalLength: number) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % n];
    if (a.feature || b.feature) continue;
    const dy = b.pos.y - a.pos.y;
    let ds = b.s - a.s;
    if (ds <= 0) ds += totalLength; // wrap at the seam (n-1 -> 0)
    const grade = ds > 0 ? Math.abs(dy / ds) : 0;
    if (grade > MAX_SAMPLE_GRADE) {
      console.warn(
        `[trackData] adjacent-sample grade ${grade.toFixed(3)} exceeds ${MAX_SAMPLE_GRADE} budget near s=${a.s.toFixed(1)}m`,
      );
    }
  }
}
