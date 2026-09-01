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
  steerMaxYawRate: 2.4, // rad/s at low speed
  steerYawRateAtTop: 1.1, // rad/s at topSpeed (lerp by speed/topSpeed)
  steerRamp: 12, // how fast actual steer chases input (1/s, exponential damp)
  driftMinSpeed: 12, // below this, drift won't start / cancels
  driftYawBonus: 1.35, // x yaw rate toward drift dir
  driftCounterRange: 0.5, // steering inside drift maps to [dir*(1+-this)] of drift yaw
  driftLateralSlip: 6, // m/s outward slip while drifting (decays after)
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
  splitPixelRatioCap: 1.5, // devicePixelRatio cap while split-screen is active (2x draw calls, §Phase 2c)
  shadowMapSize: 2048, // directional-light shadow map resolution; drop to 1024 if split-screen shadow cost is too high (§Phase 4 item 3)
};
