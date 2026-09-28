> Historical note: this is the original implementation spec and describes the pre-v5 design (phone-only controls, items, the old maps and characters). The current game is described in README.md.

# Phone-Controlled Kart Racer — Implementation Plan

A single-player, browser-based arcade kart racer. The desktop browser renders the game; a phone browser is the controller, paired by room code / QR. This document is the complete spec. The implementer (Claude Sonnet 5) works one phase at a time and does not deviate from it.

---

## 1. Assumptions and decisions

Every decision below is final. Where an assumption was required it is stated in one line.

| # | Decision |
|---|----------|
| D1 | **Stack:** Vite + TypeScript, Three.js for rendering. Single npm package (no workspaces) with two Vite entry points (`index.html` game, `controller.html` controller) sharing `src/shared/`. |
| D2 | **Networking: WebSockets via a dumb relay server, not WebRTC.** Trade-off: the relay adds one hop (phone → server → desktop) versus a WebRTC data channel's p2p path, but on a LAN with a locally-run server that hop costs single-digit milliseconds, while WebRTC would add signaling, ICE/STUN, and hard-to-debug network failures. At 30 Hz snapshots the added latency is imperceptible. WebSockets win on implementability and debuggability. |
| D3 | **Server:** one Node process using `express` (static file serving + health route) and `ws` (relay). It holds **no game state** — only a `Map<roomCode, {game, controllers}>` of sockets. Run with `tsx`. |
| D4 | **Physics & game logic run entirely in the desktop game client**, fixed timestep 60 Hz with an accumulator. The controller is stateless input hardware. |
| D5 | **Input protocol:** controller sends full **state snapshots at 30 Hz** (not per-event), with sequence numbers; game samples the latest snapshot each physics tick. Exact shapes in §2.4. |
| D6 | **Steering modes:** **Tilt ("steering wheel") is the flagship mode** — phone held landscape like a wheel, with an explicit calibration step (§3.7). Touch steering (a horizontal slider) is the guaranteed baseline, built first, and the automatic fallback whenever tilt is unavailable, denied, or insecure-context. |
| D7 | **Units:** 1 world unit = 1 meter, +Y up. Speeds in m/s, angles in radians unless noted. |
| D8 | **Track:** one hand-authored closed circuit from a Catmull-Rom spline, ~620 m lap, road half-width 6 m, off-road (grass) band from 6 m to 14 m, hard walls at 14 m lateral offset. Track is flat (y = 0). No ramps or airborne physics — "drift released mid-air" cannot occur; the analogous edge case (wall hit during drift) is specced in §3.2. |
| D9 | **Race:** 3 laps, player + 4 AI karts (5 total). Positions from a checkpoint-gated progress metric (§3.5). |
| D10 | **Room codes:** 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), generated server-side. QR encodes the full controller URL including the code. |
| D11 | **Input-loss safety:** if the newest snapshot is older than 400 ms, the game substitutes neutral input (steer 0, throttle 0, brake 0, drift 0) → kart coasts to a stop. After 2 s of controller absence during a race, the race pauses; on reconnect it resumes through a fresh 3-2-1 countdown. |
| D12 | **Keyboard controls exist from the first drivable phase and never get removed.** If any mapped key was pressed in the last 2 s, keyboard input overrides controller input and a "KB" badge shows in the HUD. |
| D13 | **Secure-context strategy (§4):** target **LAN http + touch steering first** (Phase 0–7). Then add HTTPS: primary demo path is **mkcert LAN HTTPS** (low latency + tilt); fallback is a **cloudflared quick tunnel** (zero cert setup, slightly higher latency). |
| D14 | **Dependencies (runtime):** `three` (rendering — mandated), `ws` (relay), `express` (static serving; smaller than hand-rolling MIME/range handling), `qrcode` (renders QR to a canvas locally — no external asset download, keeps the "no external assets" rule). **Dev:** `vite`, `typescript`, `tsx` (run TS server without a build step), `concurrently` (one `npm run dev` for vite + server). Nothing else. No physics engine — the arcade model in §3.2 is ~200 lines and a physics engine would fight the arcade feel. |
| D15 | **Aesthetic:** low-poly from Three.js primitives, `MeshLambertMaterial` with vertex colors / procedural `CanvasTexture` (checkered finish line, road edge stripes). One hemisphere + one directional light, **no dynamic shadows**; each kart gets a flat dark "blob shadow" disc. Fog + solid sky color for depth. |
| D16 | **All handling-feel constants live in `src/game/tuning.ts`** with the starting values given in this plan. Everything else in this plan is a fixed number, not a config knob. |
| D17 | Assumption: demo network is a normal home/office LAN where phone and desktop can reach the same IP; the server binds `0.0.0.0` and advertises its LAN IPv4 (from `os.networkInterfaces()`) for the QR link. |
| D18 | Assumption: one controller per room in the core plan; the room structure supports a second controller for optional Phase 10. |

---

## 2. Architecture overview

### 2.1 Repo layout

```
mario-kart/
├─ package.json               # single package; scripts: dev, build, start
├─ vite.config.ts             # two rollup inputs: index.html, controller.html
├─ tsconfig.json
├─ index.html                 # GAME entry  → src/game/main.ts
├─ controller.html            # CONTROLLER entry → src/controller/main.ts
├─ server/
│  └─ index.ts                # express static + ws relay + room registry
└─ src/
   ├─ shared/
   │  ├─ protocol.ts          # all WS message types + type guards (single source of truth)
   │  └─ mathUtils.ts         # clamp, lerp, angleWrap, damp
   ├─ game/
   │  ├─ main.ts              # bootstraps: net → scene → loop
   │  ├─ tuning.ts            # ALL handling-feel constants (§2.6)
   │  ├─ net/GameSocket.ts    # connect, room registration, reconnect, input inbox
   │  ├─ input/InputSource.ts # merges controller snapshots + keyboard → ControlState per tick
   │  ├─ core/loop.ts         # fixed-timestep accumulator (60 Hz), render on rAF
   │  ├─ race/RaceDirector.ts # state machine: LOBBY→COUNTDOWN→RACING→PAUSED→FINISHED
   │  ├─ race/LapTracker.ts   # checkpoint/lap validation + progress metric
   │  ├─ physics/Kart.ts      # kart state + physics update + drift state machine
   │  ├─ physics/collision.ts # kart-vs-wall, kart-vs-kart
   │  ├─ ai/AiDriver.ts       # lookahead steering + rubber-banding + stuck recovery
   │  ├─ track/trackData.ts   # authored control points, checkpoint count, item box spots
   │  ├─ track/TrackBuilder.ts# spline → sampled centerline → meshes + lookup tables
   │  ├─ track/TrackQuery.ts  # nearestSample(pos) → {s, lateral, sampleIdx}
   │  ├─ render/SceneBuilder.ts # lights, sky, karts (primitive assemblies), blob shadows
   │  ├─ render/FollowCamera.ts # smoothed chase cam + speed/boost FOV kick
   │  └─ ui/Hud.ts            # lap/position/speed, countdown, results, pairing panel
   │  └─ ui/Diagnostics.ts    # backtick overlay: fps, RTT, input age, seq gaps
   └─ controller/
      ├─ main.ts              # bootstraps controller UI + socket
      ├─ ControllerSocket.ts  # join room, reconnect w/ backoff, 30 Hz sender
      ├─ TouchSteering.ts     # slider zone → steer in [-1,1]
      ├─ TiltSteering.ts      # permission flow, calibration, wheel-angle math (§3.7)
      ├─ WakeLock.ts          # navigator.wakeLock + re-acquire on visibilitychange
      └─ ui.ts                # buttons (accel/brake/drift), status pill, calibrate UI
```

### 2.2 System diagram

```
 PHONE (controller.html)                NODE SERVER                 DESKTOP (index.html)
┌───────────────────────┐          ┌──────────────────┐          ┌──────────────────────────┐
│ TiltSteering / Touch  │          │  express static  │          │ GameSocket ── inbox      │
│  → ControlState       │  ws      │  ws relay        │   ws     │   (latest InputSnapshot) │
│ ControllerSocket ─────┼─────────►│  rooms: code →   ├─────────►│ InputSource (merge KB)   │
│  30Hz InputSnapshot   │          │   {game, ctrls}  │          │   ↓ sampled per tick     │
│ ◄─ events (countdown, │◄─────────┤  no game state   │◄─────────┤ loop.ts 60Hz fixed step  │
│    finish, pause)     │          └──────────────────┘          │  ├ Kart physics ×5       │
│ status pill, wakelock │                                        │  ├ collision.ts          │
└───────────────────────┘                                        │  ├ AiDriver ×4           │
                                                                 │  ├ LapTracker ×5         │
                                                                 │  └ RaceDirector          │
                                                                 │ rAF: FollowCamera, Hud,  │
                                                                 │      three.js render     │
                                                                 └──────────────────────────┘
```

### 2.3 Core data structures (type sketches)

```ts
// src/shared/protocol.ts
interface InputSnapshot {
  type: 'input';
  seq: number;          // monotonically increasing per controller session
  steer: number;        // -1 (full left) .. +1 (full right)
  throttle: 0 | 1;
  brake: 0 | 1;
  drift: 0 | 1;
  steerMode: 'touch' | 'tilt';   // for HUD badge + diagnostics
}
// game ← server ← controller: InputSnapshot
// game → server: { type:'hello', role:'game', wantRoom?: string /* reclaim after reload */ }
// server → game: { type:'room', code: string, joinUrl: string /* http(s)://<lanIP>:<port>/controller?room=CODE */ }
// controller → server: { type:'hello', role:'controller', code: string }
// server → controller: { type:'joined' } | { type:'error', reason:'bad-room'|'room-full' }
// server → game: { type:'peer', event:'controller-joined'|'controller-left' }
// server → controller: { type:'peer', event:'game-left' }
// game → controller (relayed): { type:'event', name:'lobby'|'countdown'|'go'|'paused'|'finished'|'restart' }
// both directions: { type:'ping', t:number } / { type:'pong', t:number }  (every 2s; RTT shown in diagnostics)

// src/game/physics/Kart.ts
interface KartState {
  pos: Vector3; heading: number;        // yaw
  speed: number;                        // signed scalar along heading (arcade model)
  velLateral: number;                   // small lateral slip term used during drift
  drift: { phase:'none'|'active'; dir:-1|1; charge:number /*sec held*/ };
  boostTimer: number;                   // seconds of boost remaining
  spinTimer: number;                    // >0 → spun out, inputs ignored (optional items)
  isAi: boolean;
}

// src/game/track/TrackBuilder.ts output
interface TrackData {
  samples: Sample[];                    // ~400 evenly spaced by arc length
  totalLength: number;                  // ≈620
  checkpoints: number[];                // 12 sample indices, ordered, [0] = start/finish
}
interface Sample { pos: Vector3; forward: Vector3; right: Vector3; s: number /*arc length*/ }

// src/game/race/LapTracker.ts (one per kart)
interface LapProgress { lap: number; nextCheckpoint: number; lastS: number; progress: number }
```

### 2.4 Input protocol summary

- Controller samples its steering source (tilt filter or touch slider) and button states, and sends one `InputSnapshot` every **33 ms (30 Hz)** on a `setInterval`, regardless of change — full state, never deltas, never per-event spam.
- Game keeps only the **latest** snapshot (discarding any with `seq <=` last seen) plus `receivedAt` timestamp. Each physics tick, `InputSource.sample()` returns: keyboard state if a mapped key was active in the last 2 s, else the latest snapshot if `now - receivedAt < 400 ms`, else **neutral**.
- Server relays `input` frames verbatim to the room's game socket; drops messages > 1 KB or malformed JSON.

### 2.5 System connections per frame

`loop.ts` runs: accumulate real dt (clamped to 100 ms) → while accumulator ≥ 1/60: `InputSource.sample()` → `AiDriver.think()` for each AI (produces the same `ControlState` shape as the player — AI and player share one physics code path) → `Kart.step(dt, control)` ×5 → `collision.resolve()` → `LapTracker.update()` ×5 → `RaceDirector.tick()`. Then once per rAF: `FollowCamera.update`, `Hud.update`, `renderer.render`.

### 2.6 `src/game/tuning.ts` — the one tuning file (starting values)

```ts
export const TUNING = {
  topSpeed: 28,            // m/s (~100 km/h reads fast at kart scale)
  reverseTopSpeed: 8,
  accel: 14,               // m/s² toward topSpeed
  brakeDecel: 22,
  coastDecel: 6,           // applied when throttle=0
  offRoadSpeedCap: 0.45,   // fraction of topSpeed while on grass
  offRoadDecel: 18,        // extra decel while above the cap on grass
  steerMaxYawRate: 2.4,    // rad/s at low speed
  steerYawRateAtTop: 1.1,  // rad/s at topSpeed (lerp by speed/topSpeed)
  steerRamp: 12,           // how fast actual steer chases input (1/s, exponential damp)
  driftMinSpeed: 12,       // below this, drift won't start / cancels
  driftYawBonus: 1.35,     // × yaw rate toward drift dir
  driftCounterRange: 0.5,  // steering inside drift maps to [dir*(1±this)] of drift yaw
  driftLateralSlip: 6,     // m/s outward slip while drifting (decays after)
  driftTierTimes: [0.8, 1.6, 2.6],   // sec held → tier 1/2/3
  boostDurations: [0.7, 1.2, 1.8],   // sec per tier
  boostSpeedMult: 1.35,    // boost target = topSpeed × this
  boostAccel: 40,
  wallRestitution: 0.25, wallSpeedPenalty: 0.5, // keep 50% of speed on wall hit
  kartRadius: 1.1, kartMass: 1,
  camDistance: 7.5, camHeight: 3.2, camLookAhead: 4,
  camPosDamp: 4, fovBase: 60, fovMax: 76, fovDamp: 3,
  aiTopSpeedJitter: 0.04,  // ±4% per AI kart personality
  aiLookaheadBase: 8, aiLookaheadPerSpeed: 0.45,  // meters
  rubberBandAhead: -0.10, rubberBandBehind: 0.12, rubberBandRange: 60, // see §3.4
  tiltMaxAngleDeg: 35, tiltDeadzoneDeg: 2.5, tiltSmoothing: 0.25,
};
```

---

## 3. Algorithm specs

### 3.1 Spline → track pipeline and distance-along-track

**Authoring.** `trackData.ts` exports ~16 hand-placed `Vector3` control points (y = 0) forming a closed loop with: one long straight (~110 m) containing the start/finish, a hairpin, a chicane, and two sweepers. Also exported: `ROAD_HALF = 6`, `GRASS_HALF = 14`, `CHECKPOINT_COUNT = 12`.

**Sampling (in `TrackBuilder`):**
1. `curve = new THREE.CatmullRomCurve3(points, closed=true, 'centripetal')`.
2. Sample 2000 raw points via `curve.getPoints`, compute cumulative arc length, then **resample to N = 400 samples evenly spaced by arc length** (binary-search the cumulative table). Store `pos`, `s`, `forward = normalize(next − prev)`, `right = forward × up` (so `right` points to the driver's right when traveling in sample order — this is the race direction).
3. Checkpoint sample indices: `round(i * N / 12)` for i = 0..11; index 0 is the start/finish line.

**Meshes (all merged into few geometries, vertex-colored):**
- **Road ribbon:** for each sample, two vertices at `pos ± right * ROAD_HALF`; triangulate consecutive pairs, close the loop. Slight alternating gray shades every 4 samples for motion cues; white edge-stripe quads at ±(ROAD_HALF − 0.4).
- **Grass:** same ribbon from ±ROAD_HALF to ±GRASS_HALF, green vertex colors with per-vertex jitter. Beneath everything, one large ground plane.
- **Walls:** vertical quad strips at `pos ± right * GRASS_HALF`, height 1.2 m, red/white candy-striped via vertex colors every 2 samples. Walls are **visual**; collision uses the lateral-offset test below (they coincide by construction).
- **Start/finish:** a checkered `CanvasTexture` quad across the road at sample 0, plus a primitive arch (two box pillars + box beam).

**`TrackQuery.nearestSample(pos)` — distance-along-track.** Build once: a 2D uniform grid (cell 8 m) over the track bounds mapping cell → sample indices whose `pos` falls in or adjacent to it. Query: look up the kart's cell (+ 8 neighbors), take the nearest sample by squared distance, then refine against that sample's two neighbors by projecting onto the segment. Return `{ s, lateral, sampleIdx }` where `lateral = dot(pos − sample.pos, sample.right)` (signed; |lateral| > ROAD_HALF → grass; ≥ GRASS_HALF − kartRadius → wall contact). Edge case: near the start/finish, `s` wraps — all consumers compare `s` values via `wrapDelta(a,b) = ((a − b + L/2) mod L) − L/2`.

### 3.2 Kart physics and drift state machine

Arcade model: the kart is a point with `heading` and signed scalar `speed`, plus a lateral slip channel used for drift. No suspension, no wheels, no torque.

**Per tick (dt = 1/60), given `ControlState {steer, throttle, brake, drift}`:**

1. **Longitudinal.** Target/accel selection:
   - `boostTimer > 0`: accelerate toward `topSpeed × boostSpeedMult` at `boostAccel`; decrement timer.
   - else throttle: toward `topSpeed` at `accel` (if `speed > topSpeed`, e.g. post-boost, decay toward it at `coastDecel`).
   - brake: if `speed > 0.5` decelerate at `brakeDecel`; else reverse toward `−reverseTopSpeed` at `accel × 0.7`.
   - neither: decay toward 0 at `coastDecel`.
   - **Off-road** (|lateral| > ROAD_HALF, from `TrackQuery`): if `|speed| > topSpeed × offRoadSpeedCap`, apply additional `offRoadDecel`. (Boost overrides the cap — a mushroom should power through grass.)
2. **Steering.** `steerActual = damp(steerActual, control.steer, steerRamp, dt)` (exponential smoothing so keyboard taps aren't instant). Yaw rate `ω = lerp(steerMaxYawRate, steerYawRateAtTop, clamp(|speed|/topSpeed, 0, 1))`. At near-zero speed, steering authority scales by `clamp(|speed|/3, 0, 1)` so a parked kart can't pirouette. Reverse gear steers mirrored (real reversing feel).
3. **Drift state machine** (`drift.phase`):
   - `none → active` when: drift pressed this tick AND `|speed| ≥ driftMinSpeed` AND `|steerActual| > 0.25`. Lock `dir = sign(steerActual)`, `charge = 0`. (Drift pressed while straight or slow does nothing — no hop mechanic.)
   - While `active`: `charge += dt`. Yaw rate becomes `ω × driftYawBonus × dir × (1 + steerActual·dir·driftCounterRange)` — i.e. steering into the drift tightens it, counter-steering widens it, but the kart always yaws toward `dir`. Apply outward lateral slip: kart position moves along `−dir × right(heading)` at `driftLateralSlip` m/s (gives the sideways-slide look). Charge tier = highest i with `charge ≥ driftTierTimes[i]`.
   - `active → none` when drift is **released**: if tier ≥ 1, set `boostTimer = boostDurations[tier−1]`. Slip decays to 0 over 0.3 s.
   - **Cancel without boost** (charge discarded) when, while active: `|speed| < driftMinSpeed`, or a **wall collision** occurs, or the race leaves `RACING` state. This is the specced answer to "drift interrupted by a bump": any wall contact kills the charge; there is no airborne state (D8).
4. **Integrate.** `heading += ω_effective × sign(speed) × dt` (steering flips when reversing); `pos += forward(heading) × speed × dt + slipVector × dt`.
5. **Spin-out** (optional items phase): while `spinTimer > 0`, inputs are forced neutral, heading spins at 10 rad/s, speed decays at `brakeDecel`.

Kart visual meshes are set from state after physics (body yaw = heading + a drift lean of `dir × 0.25 rad` blended in/out over 0.15 s; front wheels yawed by `steerActual × 0.4`).

### 3.3 Collision response

**Kart vs wall** (after integration, per kart): query `TrackQuery`. If `|lateral| > GRASS_HALF − kartRadius`:
- Clamp position: `pos −= right × (|lateral| − (GRASS_HALF − kartRadius)) × sign(lateral)`.
- Decompose velocity (reconstruct `v = forward(heading) × speed`): kill the into-wall component, keep tangential, apply restitution: new speed = `|v_tangential| × (1 − wallSpeedPenalty × |sin(impactAngle)|)`, heading rotated toward the wall tangent by 60% (auto-align so karts scrape along walls rather than sticking — critical for AI). Cancel any active drift (no boost). A glancing scrape (impact angle < 10°) applies clamp only, no penalty — prevents wall-riding feeling like punishment.

**Kart vs kart** (all 10 pairs, positions only): if `dist(a,b) < 2 × kartRadius`:
- Separate both along the center line by half the penetration each.
- Impulse on the speed scalars: project each kart's velocity onto the collision normal; if approaching, exchange 50% of the normal components (equal masses), then recompose each kart's `speed` as the dot of its new velocity with its own forward (heading unchanged — arcade karts bump, they don't ragdoll). Result: rear-ending shunts the front kart forward and slows the rear one; side contact nudges both laterally via a 1.5 m/s position push over the next 0.2 s.
- No drift cancel on kart-kart contact (only walls cancel drift).

### 3.4 AI driving

Each AI produces a `ControlState` per tick and then runs the identical `Kart.step`. Waypoints = the centerline samples themselves, offset per-AI by a fixed "line preference" `lane ∈ {−2, −0.7, +0.7, +2}` meters to spread karts.

1. **Lookahead target:** from the AI's current `s`, target point = sample at `s + aiLookaheadBase + |speed| × aiLookaheadPerSpeed`, plus `right × lane`.
2. **Steering:** `angleToTarget = angleWrap(atan2(target − pos) − heading)`; `steer = clamp(angleToTarget × 2.2, −1, 1)`.
3. **Throttle/brake:** measure curvature ahead — angle between `forward` at current sample and at sample `s + 18 m`. If that angle × current speed > 14 (tight corner, fast), brake; else throttle. Simple and tunable.
4. **Drift:** if the upcoming-corner angle > 0.5 rad and speed > driftMinSpeed + 3, press drift; release when the corner angle drops below 0.15 rad. (AI thus earns tier 1–2 boosts naturally on the hairpin/sweepers.)
5. **Rubber-banding:** `Δ = wrapProgress(playerProgress − aiProgress)` in meters (progress from §3.5). AI's effective top speed = `topSpeed × (1 + jitter) × band` where `band = 1 + rubberBandBehind × clamp(Δ / rubberBandRange, 0, 1)` when the AI is behind, `1 + rubberBandAhead × clamp(−Δ / rubberBandRange, 0, 1)` when ahead. So: an AI 60+ m behind the player runs +12%, 60+ m ahead runs −10%, smoothly interpolated. Applied only in `RACING` state and only to the speed cap, never to physics constants.
6. **Stuck recovery:** if `|speed| < 2` for 2 s continuously during RACING, teleport to the nearest sample center (`lateral = lane`), heading = sample forward, speed = 5. Also triggers if an AI's `lateral` sign puts it wall-scraping for > 3 s. This is the specified mitigation for "AI stuck on wall".
7. AI karts skip the human input path entirely; disconnect/pause logic never affects them except that physics halts in `PAUSED`.

### 3.5 Checkpoint and lap validation

Per kart, `LapTracker` holds `{ lap, nextCheckpoint, lastS, progress }`. 12 checkpoints; checkpoint `i` is "crossed" when the kart's wrapped `s` passes the checkpoint sample's `s` in the forward direction: i.e. `wrapDelta(s_now, s_cp) ≥ 0 && wrapDelta(lastS, s_cp) < 0` with `|wrapDelta| < 30` (guards teleport/wrap glitches).

- Only `nextCheckpoint` can be crossed; crossing it increments `nextCheckpoint` (mod 12). Crossing any other checkpoint plane does nothing → **checkpoint skipping is impossible** and cutting the grass still requires passing every gate in order (gates span the full GRASS width).
- **Lap increments** only when checkpoint 0 (finish line) is crossed as the expected next checkpoint. Lap 3 → the kart is `FINISHED` (record finish order).
- **Crossing the finish line backwards:** `nextCheckpoint` never matches (you'd be crossing gate 0 while expecting gate ≥ 1, or crossing it in the wrong direction, which fails the wrapDelta sign test) → no increment, and driving forward again re-crosses harmlessly. No wrong-way UI in core scope.
- **Progress metric** (for positions + rubber-banding): `progress = lap × L + s_of(nextCheckpoint−1) + clamp(wrapDelta(s_now, s_of(nextCheckpoint−1)), 0, gapToNextCp)`. Anchoring to the last validated checkpoint means driving backwards or cutting across can never inflate position. Race positions = descending sort of `progress` each frame; finished karts rank by finish order above all racing karts.

### 3.6 Input protocol lifecycle — pairing, reconnect, input-loss

**Pairing:**
1. Game page connects to `ws(s)://<host>/ws`, sends `hello role:game`. Server creates a room (code per D10), replies `room {code, joinUrl}` where `joinUrl` uses the server's detected LAN IP and the port the *page* was served from (server knows both; in dev the vite port, see §4). Game renders the code in 72 px text plus a QR of `joinUrl` (via `qrcode` → canvas) in the lobby panel.
2. Phone scans → opens `/controller?room=CODE` → controller sends `hello role:controller code:CODE`. Server validates: unknown code → `error bad-room` (controller shows a manual code-entry input as fallback for scan failures); full → `error room-full`. Success → `joined` to controller, `peer controller-joined` to game. Controller stores the code in `sessionStorage`.
3. Game leaves `LOBBY` when the controller taps its START button (sent as an `event`) or on keyboard Enter.

**Heartbeat & status:** both clients send `ping` every 2 s, expect `pong` (server answers its own pings from clients; clients answer relayed pings). Missing 2 pongs OR a socket `close` → status pill goes red ("reconnecting…"). Game HUD shows a persistent connection pill (green/amber/red) at all times; controller shows the same plus current RTT.

**Reconnect:**
- Controller: on close, retry with exponential backoff 0.5 s → 1 → 2 → 4 (cap), re-sending `hello` with the stored code; `seq` continues from where it left off (game only requires monotonicity, and a *new* controller session may reset seq — game accepts a seq reset when it arrives > 1 s after the last snapshot).
- Game: on close, reconnect and send `hello role:game wantRoom:<code>`; server re-binds the existing room if it still exists (rooms persist 30 s after their game socket drops, then delete and disconnect controllers with `peer game-left` → controller shows "game closed").
- Server crash: both sides reconnect; game gets a **new** code and re-shows the pairing panel; controller's rejoin fails with `bad-room` and shows the code-entry field. Acceptable for a demo; noted as a limitation.

**Input-loss safety (the demo-critical path):** implemented **game-side** and independent of socket state — the watchdog is "age of newest snapshot", so it also covers a wedged-but-open socket. Timeline: > 400 ms stale → neutral inputs (coast, per D11); > 2 s during `COUNTDOWN`/`RACING` → `RaceDirector` enters `PAUSED` (physics frozen, overlay "Controller disconnected — reconnect phone or press K for keyboard"); fresh snapshot or keyboard press → 3-2-1 countdown → resume. In `LOBBY`/`FINISHED`, staleness only affects the status pill.

### 3.7 Tilt steering — "hold the phone like a steering wheel" (with calibration)

**Availability gate (checked in order, first failure → touch mode with a one-line toast):** secure context (`window.isSecureContext`) → `DeviceOrientationEvent` exists → on iOS, `DeviceOrientationEvent.requestPermission` resolves `'granted'` (must be called inside the tap handler of an "Enable tilt steering" button — never on load). **Permission denied after pairing** is a normal flow: the controller stays connected, flips to touch UI, shows "Tilt unavailable — using touch. ⚙ retry", and the retry button re-runs the gate.

**Wheel-angle computation.** Do not use raw `beta`/`gamma` (gimbal-unstable when the phone is near-vertical). Instead:
1. On each `deviceorientation` event, build a quaternion from `(alpha, beta, gamma)` with Euler order `'ZXY'` (the device-orientation convention; use a small local copy of the standard conversion — no dependency needed).
2. Transform the device's **long axis** (portrait +Y = `(0,1,0)`) into the world frame: `v = q · (0,1,0)`.
3. `wheelAngle = asin(clamp(v.z_world_up, −1, 1))` — the angle of the phone's long axis above/below horizontal. Turning the "wheel" raises one end of the phone, so this measures exactly the steering rotation, independent of how upright the user holds the screen (works flat-ish on a lap or vertical in the air). Flip sign when `screen.orientation.angle === 270` vs `90` so left is left in both landscape orientations.
4. Filter: `filtered = filtered + tiltSmoothing × (wheelAngle − filtered)` (EMA, events ~60 Hz).

**Calibration (mandatory before first use, re-runnable any time):** after permission is granted the controller shows a full-screen "Hold your phone like a steering wheel, wheels straight → tap SET" panel with a live bubble-level bar showing the current filtered angle. Tapping SET stores `neutral = filtered`. A small ⟳ recalibrate button stays in the corner of the race UI (drivers drift their grip mid-race). Calibration survives reconnects via `sessionStorage`.

**Mapping:** `steer = clamp((filtered − neutral) / rad(tiltMaxAngleDeg), −1, 1)`, with values inside `rad(tiltDeadzoneDeg)` snapped to 0, then a mild expo curve `steer = sign · |steer|^1.3` for precision near center. The 30 Hz sender simply reads the latest mapped value. The controller UI in tilt mode replaces the slider with a steering-wheel arc that rotates with the input (instant visual confirmation), keeping accel/brake/drift as large thumb buttons in the bottom corners (landscape layout, buttons under thumbs while gripping like a wheel).

**Orientation handling:** controller page requests landscape via CSS and shows a "rotate your phone" blocker in portrait (`screen.orientation.lock` is attempted but not relied on). `touch-action: none`, `user-select: none`, viewport `maximum-scale=1` to kill scroll/zoom/double-tap.

---

## 4. Deployment & secure-context strategy

Device orientation on iOS requires a **secure context** (HTTPS) plus a user-gesture permission prompt; a phone hitting `http://192.168.x.x` is not secure, so tilt cannot work over plain LAN http on iOS (and wake lock is also HTTPS-gated in some browsers). Strategy, in the order the implementer targets it:

**Path A — LAN http (target first, Phases 0–7).** `npm run dev` runs (via `concurrently`) the relay server on **:8787** and Vite dev on **:5173** with a proxy for `/ws → :8787` (`ws: true`), both bound to `0.0.0.0`. The server detects its LAN IPv4 and reports it in the `room` message with the *page* port (5173 in dev, 8787 in prod `npm start`, where express serves `dist/`). Phone joins over http → **touch steering only**; tilt gate fails at the secure-context check and falls back cleanly. All acceptance criteria through Phase 7 use Path A.

**Path B — mkcert LAN HTTPS (primary demo path, built in Phase 8).** `mkcert -install && mkcert <lanIP> localhost` → cert files in `certs/` (git-ignored). Server reads them if present and serves HTTPS/WSS on **:8788** alongside http; `joinUrl` prefers https when certs exist. One-time phone setup: AirDrop/email `rootCA.pem` to the phone, install the profile, and (iOS) enable full trust in Settings → General → About → Certificate Trust. Result: **lowest latency + full tilt** — this is the live-demo configuration. Document the phone setup steps in the README.

**Path C — cloudflared quick tunnel (fallback, also Phase 8).** `npm run build && npm start`, then `cloudflared tunnel --url http://localhost:8787` yields a trusted `https://*.trycloudflare.com` URL; server accepts an origin override via `PUBLIC_URL` env var so the QR encodes the tunnel URL. Zero cert setup, works on any phone instantly; trade-off is ~20–80 ms extra RTT through the edge. Use when mkcert setup isn't possible on the demo phone.

The README gets a decision table: "just developing → A; demo with tilt → B; B impossible → C".

---

## 5. Phased implementation plan

Risk is sequenced forward: the phone→desktop link (the biggest demo risk) is proven in Phase 1 against a placeholder scene, before any racing exists. Keyboard driving exists from Phase 2 onward and is never removed. Every phase ends runnable.

---

**Phase 0 — Scaffold and dual entry points.**
*Goal:* repo skeleton builds and serves both pages.
*Files:* `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `controller.html`, `src/game/main.ts`, `src/controller/main.ts`, `src/shared/protocol.ts` (stub), `server/index.ts` (express static + `/ws` echo), README stub.
*Tasks:* Vite multi-page config (two rollup inputs); dev scripts (`dev` = concurrently vite+server with ws proxy, `build`, `start`); server binds 0.0.0.0 and logs its LAN URL; game page renders a spinning Three.js cube on sky-blue; controller page renders "CONTROLLER" text and a status pill.
*Accept when:* `npm run dev` → desktop `localhost:5173` shows the cube at 60 fps; phone on the same Wi-Fi opens `http://<lanIP>:5173/controller` and sees the controller page; `npm run build && npm start` serves both from :8787.

**Phase 1 — Pairing, relay, input link, safety (the risk phase).**
*Goal:* full §3.6 lifecycle moving a placeholder object.
*Files:* `server/index.ts` (rooms, relay, heartbeats, LAN-IP joinUrl), `src/shared/protocol.ts` (final message set), `src/game/net/GameSocket.ts`, `src/game/ui/Hud.ts` (pairing panel: room code + QR via `qrcode`, connection pill), `src/game/input/InputSource.ts` (snapshot inbox + staleness watchdog; keyboard merge stub), `src/controller/ControllerSocket.ts` (join, 30 Hz sender, backoff reconnect), `src/controller/TouchSteering.ts`, `src/controller/ui.ts` (slider + accel/brake/drift buttons + status pill + manual code entry).
*Tasks:* everything in §2.4 and §3.6 except race-pause behavior (no race yet — watchdog just zeroes input). Desktop scene: a cube that slides left/right with `steer` and turns green while `throttle`. Diagnostics overlay v1 (RTT, input age, seq).
*Accept when:* phone joins **via QR scan** with no typing; dragging the slider moves the cube with no perceptible lag on LAN; the game pill is green; **killing the phone's Wi-Fi (or backgrounding the browser) stops the cube within ~0.5 s** and the pill goes red; re-enabling Wi-Fi auto-rejoins within ~5 s without reloading either page; reloading the game page keeps the same room code.

**Phase 2 — Drivable kart on a flat plane (keyboard first).**
*Goal:* the kart feels like a kart.
*Files:* `src/game/tuning.ts` (full §2.6), `src/game/core/loop.ts` (fixed 60 Hz accumulator, 100 ms clamp, pause on `document.hidden`), `src/game/physics/Kart.ts` (§3.2 steps 1–2, 4 — no drift yet), `src/game/render/SceneBuilder.ts` (primitive kart: box body, 4 cylinder wheels, sphere head, blob shadow; big ground grid), `src/game/render/FollowCamera.ts` (damped chase + FOV kick 60→76 by speed), `InputSource` keyboard: W/↑ throttle, S/↓ brake, A/D/←/→ steer (ramped), Shift drift, with the 2 s keyboard-override rule + "KB" HUD badge.
*Accept when:* keyboard drives the kart smoothly at 60 fps; top speed feels fast via FOV kick; steering is duller at top speed than at low speed; phone slider steers the same kart; reversing works with mirrored steering.

**Phase 3 — Track from spline.**
*Goal:* full §3.1 pipeline + §3.3 wall collision + off-road slowdown.
*Files:* `src/game/track/trackData.ts`, `TrackBuilder.ts`, `TrackQuery.ts`, `src/game/physics/collision.ts` (wall part).
*Tasks:* build road/grass/walls/finish meshes (merged, vertex-colored); spatial-grid nearest-sample query; wire off-road cap and wall response into the kart step; spawn kart on the grid at sample 0.
*Accept when:* driving a full lap works; leaving the road visibly slows the kart; hitting a wall at speed bounces/scrapes without tunneling at top speed or getting stuck in corners (test the hairpin deliberately); frame rate stays 60 with the whole track in view.

**Phase 4 — Drift and boost.**
*Goal:* §3.2 drift state machine complete.
*Files:* `Kart.ts` (drift), `SceneBuilder.ts` (lean/wheel visuals), `Hud.ts` (charge indicator: small bar tinting blue→orange→purple by tier).
*Accept when:* holding drift through the hairpin slides with counter-steer control; releasing after ~1/1.6/2.6 s gives visibly different boost strengths; drifting into a wall cancels the charge; drift below 12 m/s refuses to start; works from both phone and keyboard.

**Phase 5 — Laps, checkpoints, race flow.**
*Goal:* §3.5 + `RaceDirector` full state machine, single-kart race.
*Files:* `src/game/race/LapTracker.ts`, `RaceDirector.ts`, `Hud.ts` (lap "1/3", speed in km/h, big countdown, results panel with restart), controller `ui.ts` (START button in lobby, event-driven "GO"/finish flashes), `GameSocket` event channel.
*Tasks:* LOBBY (pairing panel) → controller START or Enter → COUNTDOWN (3-2-1, inputs ignored) → RACING → FINISHED after 3 validated laps → results → restart (controller button or R) resets everything without reloading. Wire the §3.6 pause-on-disconnect behavior now that races exist. Verify backwards finish-line crossing does not count (drive backwards over it deliberately).
*Accept when:* a full 3-lap race runs start→results→restart; skipping a gate by cutting grass wide does not advance the lap (verify by watching `nextCheckpoint` in diagnostics); backwards crossing does nothing; pulling the phone mid-race pauses within 2 s and reconnect resumes via countdown.

**Phase 6 — AI opponents and kart-kart collision.**
*Goal:* §3.4 + kart-kart part of §3.3; a real race.
*Files:* `src/game/ai/AiDriver.ts`, `collision.ts` (pairs), `SceneBuilder.ts` (4 AI karts, distinct body colors), `Hud.ts` (position "3/5"), `RaceDirector` (grid start 5-wide staggered, per-kart LapTrackers, finish-order results listing all karts; when the player finishes, cut to results after 1.5 s ranking unfinished AI by progress).
*Accept when:* 4 AI complete clean laps unaided for 5+ minutes (leave it running); deliberately parking an AI against a wall self-recovers within ~3 s; rubber-banding is observable (fall far behind → the pack visibly slows; lead big → they close); bumping AI trades momentum without jitter or overlap; position indicator is correct including near the finish line; still 60 fps with 5 karts.

**Phase 7 — Controller polish: wake lock, layout, feel.**
*Goal:* the controller is demo-grade over Path A.
*Files:* `src/controller/WakeLock.ts` (acquire on join, re-acquire on `visibilitychange`), `ui.ts` (landscape layout with thumb-corner buttons, portrait blocker, connection pill + RTT, code-entry fallback styling), `Hud.ts` (steer-mode badge from `steerMode`).
*Accept when:* phone screen stays awake through a full 3-lap race; portrait shows the rotate prompt; buttons are comfortably thumbable while gripping the phone in landscape; a full race played entirely from the phone feels direct (subjective check, then move on — the tuning pass is Phase 9).

**Phase 8 — Tilt steering + HTTPS paths (core, not optional).**
*Goal:* §3.7 complete over §4 Paths B and C.
*Files:* `src/controller/TiltSteering.ts`, `ui.ts` (enable-tilt button, calibration panel with live level bar, steering-wheel arc UI, recalibrate button, touch/tilt toggle), `server/index.ts` (optional HTTPS from `certs/`, `PUBLIC_URL` override), README (Path A/B/C setup incl. iPhone cert-trust steps).
*Accept when:* over Path B (or C) on a real iPhone: the enable-tilt tap prompts for permission; **denying it lands cleanly in touch mode with the retry affordance**; granting it shows calibration, and after SET, holding the phone like a wheel steers the kart through a full race; the deadzone holds the kart straight on the straight; recalibrating mid-race works; over Path A the tilt option correctly never appears (insecure context) and touch still works; Android Chrome tilt works without the iOS prompt.

**Phase 9 — Aesthetic, performance and handling-tuning pass.**
*Goal:* looks like Mario Kart's cheerful cousin; runs clean; feels right.
*Tasks:* color/fog/sky pass; trackside props from primitives (cones, low-poly trees = cone+cylinder, floating ring billboards) instanced via `InstancedMesh`; verify draw calls < 100 and steady 60 fps (diagnostics overlay shows fps histogram + physics steps/frame); **dedicated tuning session** iterating only `tuning.ts` against this checklist: top-speed straights feel fast (FOV), the hairpin is driftable at tier 2, wall taps feel forgiving, tilt deadzone/max-angle comfortable across two different testers' grips.
*Accept when:* a recorded 60 s clip of a full race looks colorful and reads as "Mario-Kart-like"; no fps dips below ~57 during 5-kart pileups; the maintainer signs off on feel after the tuning session.

**Phase 10 (OPTIONAL) — Items.** Item boxes (rotating vertex-colored cubes at 6 fixed `s` positions across the road, 3 s respawn, 1 s roulette on pickup, one held item shown in HUD, fired with a new controller ITEM button + K key): **mushroom** (instant tier-2 boost), **banana** (dropped 2 m behind; any kart entering its 1.2 m radius spins out 1 s at 30% speed; max 3 live per kart), **homing shell** (follows the centerline at 40 m/s toward the next kart ahead in race order, hits within 1.5 m → spin-out, despawns after 8 s or on wall gap). AI uses items on a 1.5 s delay with 70% probability. *Accept when:* all three items function against and from AI without frame drops.

**Phase 11 (OPTIONAL) — Juice.** (a) Drift sparks: `THREE.Points` burst tinted by tier; (b) WebAudio engine: two detuned saw oscillators, pitch mapped to speed, noise burst on drift/collision, no audio files; (c) minimap: 2D canvas polyline of the centerline + colored dots, top-right; (d) controller haptics: `navigator.vibrate` (Android-only) 30 ms on countdown ticks/boost/collision events received over the event channel; (e) second controller joins the room as racer 2 with a split follow camera (two viewports, one renderer) — only attempt (e) if everything else is done; it touches RaceDirector, InputSource, and Hud.

---

## 6. Performance, latency and risks

| Risk | Mitigation (built in from the phase where it first matters) |
|---|---|
| Input latency spikes / jitter | 30 Hz full-state snapshots (a lost frame costs 33 ms, nothing compounds); latest-only sampling; seq discard of stale frames; RTT + input-age in the diagnostics overlay from Phase 1 so regressions are visible immediately; LAN-local server; Nagle irrelevant at these sizes but `perMessageDeflate: false` on `ws` to avoid compression latency. |
| Physics feel needs endless tweaking | Every feel constant in `tuning.ts` from Phase 2; a *scheduled* tuning pass in Phase 9 rather than ad-hoc fiddling; fixed 60 Hz timestep so feel is framerate-independent. |
| Frame drops breaking physics | Accumulator with 100 ms clamp (max 6 catch-up steps, then drop time); pause when `document.hidden`; merged/instanced geometry, no shadows, draw-call budget < 100 checked in Phase 9. |
| AI stuck on walls | Wall response auto-aligns heading along the wall tangent (§3.3); explicit stuck detector + respawn (§3.4.6); Phase 6 acceptance includes a 5-minute unattended soak. |
| Phone screen sleeps mid-race | Wake lock with re-acquire on visibility change (Phase 7); staleness watchdog + race pause means even a sleep is a pause, not a crash. |
| iOS tilt permission flow fails | Gate checked in strict order with clean fallback to touch at every step (§3.7); touch is the baseline built seven phases before tilt; permission requested only from a tap; denial is a designed flow with retry, not an error. |
| Secure-context confusion on demo day | §4 decision table in README; server auto-selects http/https joinUrl so the QR is always correct for the path in use. |
| Controller disconnect mid-demo | Auto-reconnect with backoff both sides; rooms survive game reload 30 s; race pause + countdown resume; keyboard override as the ultimate on-stage fallback (D12). |
| Wall tunneling at top speed | Collision is a positional lateral-offset clamp (not a raycast), so it cannot tunnel: 28 m/s × 1/60 = 0.47 m/step against an 8 m grass buffer. |

**Budgets:** 60 fps render, 60 Hz physics (≤ 0.5 ms/tick for 5 karts — trivial), glass-to-glass input latency target < 60 ms on LAN (30 Hz send interval midpoint ~17 ms + LAN RTT ~2–10 ms + up-to-one-tick sampling ~16 ms), verified by the diagnostics overlay.

---

## 7. Handoff notes for the coding agent

You are implementing this plan exactly, one phase at a time.

- **Do not start a phase until the previous phase's acceptance criteria all pass in a real browser** (and on a real phone where the criteria say so). Check them literally — they are the definition of done.
- **Do not refactor ahead of the plan.** If a later phase needs a change to earlier code, that phase's file list says so; make the change then, not preemptively.
- **Do not add dependencies** beyond D14. Do not swap WebSockets for anything else. Do not move logic onto the server — it stays a dumb relay.
- Every handling/feel number belongs in `src/game/tuning.ts`; every protocol shape belongs in `src/shared/protocol.ts`. If you find a magic number outside those files that plausibly affects feel or the wire format, move it.
- Numbers in this plan (speeds, timings, thresholds, ports) are decisions, not suggestions. Use them. Expect the Phase 9 tuning pass to change `tuning.ts` values only.
- Keyboard controls are a permanent debugging fallback — never gate them off, even in "finished" builds.
- If reality contradicts the plan (an API is unavailable, a criterion is untestable in your environment), implement the closest faithful behavior, leave a `// PLAN-DEVIATION:` comment at the site, and list all deviations in the phase's completion summary. **Ask nothing — this document is the source of truth.**
