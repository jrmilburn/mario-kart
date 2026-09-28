// All handling-feel constants live here (D16). Everything else in the plan
// is a fixed number, not a config knob. Starting values per PLAN.md §2.6.
export const TUNING = {
  topSpeed: 28, // m/s (~100 km/h reads fast at kart scale)
  reverseTopSpeed: 8,
  accel: 14, // m/s^2 toward topSpeed
  brakeDecel: 22,
  coastDecel: 6, // applied when throttle=0
  offRoadSpeedCap: 0.45, // fraction of topSpeed while on grass
  offRoadDecel: 18, // extra decel while above the cap on grass
  sandSpeedCap: 0.22, // fraction of topSpeed while on a sand surface zone -- noticeably lower than offRoadSpeedCap so cutting a corner through sand actually costs more than just running wide onto grass (§Phase 4 finding #1)
  sandDecel: 30, // extra decel while above the cap on sand, stronger than offRoadDecel
  steerMaxYawRate: 2.4, // rad/s at low speed
  steerYawRateAtTop: 1.1, // rad/s at topSpeed (lerp by speed/topSpeed)
  steerRamp: 12, // how fast actual steer chases input (1/s, exponential damp)
  driftMinSpeed: 12, // below this, drift won't start / cancels
  driftYawBonus: 1.28, // x yaw rate toward drift dir (§v3 polish: eased from 1.35 — the *bonus* over plain steering drops ~20%, so a drift still rotates the kart faster, just less violently)
  driftCounterRange: 0.5, // steering inside drift maps to [dir*(1+-this)] of drift yaw
  driftLateralSlip: 5, // m/s outward slip while drifting (decays after) (§v3 polish: eased from 6 — a bit less sideways skate, so a drift holds closer to the line it's pointed at)
  driftTierTimes: [0.8, 1.6, 2.6], // sec held -> tier 1/2/3
  boostDurations: [0.7, 1.2, 1.8], // sec per tier
  boostSpeedMult: 1.35, // boost target = topSpeed x this
  boostAccel: 40,
  wallRestitution: 0.25,
  wallSpeedPenalty: 0.5, // keep 50% of speed on wall hit
  kartRadius: 1.1,
  kartMass: 1,
  camDistance: 7.5,
  camHeight: 3.2,
  camLookAhead: 4,
  camPosDamp: 4,
  fovBase: 60,
  fovMax: 76,
  fovDamp: 3,
  aiTopSpeedJitter: 0.04, // +-4% per AI kart personality
  aiLookaheadBase: 8,
  aiLookaheadPerSpeed: 0.45, // meters
  rubberBandAhead: -0.1,
  rubberBandBehind: 0.12,
  rubberBandRange: 60, // see §3.4
  tiltMaxAngleDeg: 35,
  tiltDeadzoneDeg: 2.5,
  tiltSmoothing: 0.25,
  splitPixelRatioCap: 1.25, // devicePixelRatio cap while split-screen is active (2x draw calls, §Phase 2c); §v5: 1.5 -> 1.25 to leave frame budget for MediaPipe + bloom (High quality only — Low is always 1, render/Quality.ts)
  shadowMapSize: 2048, // directional-light shadow map resolution; drop to 1024 if split-screen shadow cost is too high (§Phase 4 item 3)
  manualBoostDuration: 0.8, // sec; §v5 BOOST button/thumbs-up/key, same boostTimer as pads and drift releases
  boostCooldown: 2.5, // sec between manual boosts, owned by the kart so every input source is rate-limited alike (§v5)
  padBoostDuration: 0.9, // sec; boost-pad surface-zone timer, reuses the manual/drift boostTimer mechanism (§Phase 4 item 4)
  // §v5 Capricorn Coast: shortcut dirt + jump.
  dirtSpeedCap: 0.66, // fraction of topSpeed on the shortcut's dirt -- a little slower than the tarmac S-bend it cuts when taken flat, a clear win with a boost (scripts/track.test.ts logs both lap times)
  dirtDecel: 20, // decel while above the dirt cap; must beat `accel` (it fights full throttle every tick) or the cap never bites
  gravity: 24, // m/s^2 for airborne karts -- heavier than real so jumps read snappy, not floaty
  airSteerAuthority: 0.35, // fraction of normal yaw rate while airborne
};
