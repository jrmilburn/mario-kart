# Coast Kart

A browser arcade kart racer. Player 1 steers with their hands in front of the webcam
(keyboard fallback); in Versus, player 2 joins on a phone paired by room code / QR (or
plays on the keyboard).

`PLAN.md` is the original spec (it describes the pre-v5 design).

## Hand controls (P1, webcam)

Hold both fists up like a steering wheel; a 3-second "hold your fists level" step
calibrates the centre (C recalibrates).

| Gesture | Does |
| --- | --- |
| Tilt the wheel (one fist lower than the other) | Steer |
| Both hands closed fists | Gas |
| Both hands open | Brake — reverse from a standstill |
| One fist, one open (or in between) | Coast |
| Thumbs-up flick on either fist (thumb out from a closed fist) | Boost (the kart's 2.5s cooldown applies) |

With only one hand in view, that hand alone decides gas / brake / coast. If every hand
drops out of frame, the last gas/brake is held for 300ms and then the kart coasts. Hands
never drift — drift is on the keyboard (left / right Shift) and the phone's DRIFT button. The
debug overlay (backtick) shows each hand's openness ratio `r` (fist < 0.55, open > 0.85)
and thumb ratio `t` (thumbs-up > 0.8, release < 0.65) for tuning against a real camera.

## Development

```
npm install
npm run dev
```

- Desktop game: http://localhost:5173
- Phone controller (same Wi-Fi): http://<lan-ip>:5173/controller.html

## Production

```
npm run build
npm start
```

Serves both pages and the relay from a single Node process on :8787.

## Character models

The game ships with **zero character model files** and runs fine that way — every kart's
driver renders as a procedural fallback (head, torso, cap) colored per character. Dropping
in real 3D models is entirely optional.

If you want to add them: download fan-made GLB models — [The Models Resource](
https://www.models-resource.com/) and [Sketchfab](https://sketchfab.com/) are good sources —
converted to `.glb` with embedded textures if they aren't already. Name each file exactly to
match its character id and drop it in `public/assets/characters/`:

```
public/assets/characters/mario.glb
public/assets/characters/luigi.glb
public/assets/characters/peach.glb
public/assets/characters/yoshi.glb
public/assets/characters/toad.glb
public/assets/characters/bowser.glb
```

Target under ~5,000 triangles per model for reasonable performance with up to 6 karts on
screen. A model's fit is rarely perfect out of the box — open `src/game/characters/registry.ts`
and tweak that character's `scale` / `yOffset` / `rotationY` until it sits correctly on the
kart's seat and faces forward.

Missing files are harmless: any character without a `.glb` (or with a file that fails to
load) just keeps its procedural fallback driver, silently, with a console warning.

**IP notice:** fan-made Nintendo character models are for personal/local use only. The
`public/assets/` directory is git-ignored for this reason — never commit these files, and
never deploy a build that includes them anywhere public. The procedural-fallback mode
(i.e. the repo as checked out, before you add any models) is the only configuration safe to
share or deploy publicly.

Roster: P1 (hands) is always **Mario**, P2 (phone/keyboard) always **Luigi**; the AI field is
**Peach**, **Yoshi**, **Toad** and **Bowser**, each on their own kart kind (standard, slim,
royal, buggy, mini, heavy).

- Roster, colours and GLB fit values: `src/game/characters/registry.ts`. Optional GLB
  loading: `src/game/characters/CharacterLoader.ts`.
- Procedural drivers: `src/game/render/CharacterBuilder.ts`. Karts:
  `src/game/render/KartBuilder.ts`.
- Both render cel-shaded (`src/game/render/ToonMaterials.ts`) with soft inverted-hull outlines
  (`src/game/render/Outline.ts`; `setOutlinesEnabled(false)` turns them off for Low quality).
  A dropped-in GLB keeps its own materials and gets no outline.
- `npx tsx --test scripts/characters.test.ts` checks the triangle/draw-call budget and the
  animation hooks.

## Deployment paths (phone connectivity + tilt steering)

Tilt steering requires a **secure context** (HTTPS) on the phone — plain `http://<lan-ip>`
is not secure, so iOS (and some Android browsers) will refuse device-orientation and wake
lock permissions there. Touch steering always works regardless of path.

| Situation | Path | What you get |
|---|---|---|
| Just developing | **A — LAN http** | `npm run dev`, open the LAN URL on your phone. Touch steering only; tilt gate fails cleanly and falls back to touch. |
| Demoing live, want tilt | **B — mkcert LAN HTTPS** | Lowest latency, full tilt support. One-time cert setup below. |
| B isn't possible on the demo phone | **C — cloudflared tunnel** | Zero cert setup, works on any phone instantly. ~20–80ms extra latency through the edge. |

### Path A — LAN http (default dev)

```
npm run dev
```

Server logs its LAN URL, e.g. `http://192.168.1.23:5173`. Open that on the phone's browser
and it just works over touch. Nothing else to configure.

### Path B — mkcert LAN HTTPS (primary demo path)

One-time setup on your dev machine:

```
mkcert -install
mkcert <your-lan-ip> localhost
```

Rename the two generated files into the project's `certs/` folder (git-ignored):

```
certs/cert.pem   (the non "-key" file)
certs/key.pem    (the "-key" file)
```

Restart the server (`npm run dev` or `npm start`). It detects the certs automatically and
serves HTTPS/WSS on **:8788** alongside the existing http on :8787/:5173; the QR code and
room code will now point at the `https://` URL.

**One-time phone setup (do this once per phone):**
1. Get `rootCA.pem` onto the phone — AirDrop it (iPhone) or email/message it to yourself.
   Find the file's path with `mkcert -CAROOT`.
2. Open the file on the phone; it'll prompt to install a configuration profile. Install it.
3. **iOS only:** go to Settings → General → About → Certificate Trust Settings, and enable
   full trust for the mkcert root certificate. (Android trusts it after step 2.)
4. Scan the QR code / open the join URL as usual. Tapping "🎮 TOUCH" in the controller now
   offers tilt steering since the page is a secure context.

### Path C — cloudflared quick tunnel (fallback)

```
npm run build
npm start
```

In another terminal:

```
cloudflared tunnel --url http://localhost:8787
```

Take the `https://*.trycloudflare.com` URL it prints and re-launch the server with it:

```
PUBLIC_URL=https://your-tunnel-url.trycloudflare.com npm start
```

The QR code and room code now encode the tunnel URL instead of the LAN IP — any phone on
any network can join, no certificate installation needed.


### Track, boosts and tests

One circuit: **Capricorn Coast** (~1.1km, 3 laps) — esplanade start, a banked climb onto
the basalt headland, the harbour breakwater with three boost pads, a banked hairpin, a jump
over the cane-train rail cutting, and a dirt shortcut through the cane that only pays off
with a boost. There are no items: speed comes from drift-release mini-turbos, the boost
pads, and the BOOST input (thumbs-up flick, Space / Enter, or the phone's BOOST button),
rate-limited by the kart itself.

Run `npx tsx --test scripts/track.test.ts` for track geometry, the jump, the shortcut
(corridor union, lap accounting, junction seams) and three-lap AI simulations.

### Railway controller QR codes

The server automatically uses `RAILWAY_PUBLIC_DOMAIN` for HTTPS controller links.
Other HTTPS hosts can use the game page's WebSocket Origin. `PUBLIC_URL` remains
an explicit override for custom domains and Cloudflare tunnels.

If a QR code opens an internal IP address or an expired tunnel, set Railway's
`PUBLIC_URL` variable to the game's full HTTPS origin (for example,
`https://your-game.up.railway.app`), redeploy, and reload the game to generate a
fresh QR code. Remove any stale Cloudflare `PUBLIC_URL` override when moving hosts.
Keep one service replica: game rooms currently live in that process's memory.

Run `node --import tsx --test scripts/controller-url.test.ts` for URL regressions.
