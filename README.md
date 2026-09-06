# Phone-Controlled Kart Racer

A single-player, browser-based arcade kart racer. The desktop browser renders the game;
a phone browser is the controller, paired by room code / QR.

See `PLAN.md` for the full spec.

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


### Graphics and items

Rainbow Ridge now uses a SNES-inspired jewel-tile road and twinkling star accents,
with a 1.73km layout: climbing slalom, 32m summit horseshoe, descending
switchback, low final bend and five boost pads. The start grid remains level. The countryside
has instanced wildflower verges. Procedural drivers have smoother silhouettes,
coloured irises and catchlights, plus steering and boost body movement.

Question-mark boxes tumble and burst into coloured shards when collected. Banana
peels and segmented shells replace the old placeholder shapes. Item use emits a
short spark burst; existing exhaust flames, shell trails and throw arcs remain.

The roulette now includes **Golden Mushroom** (one sustained 4.5-second boost)
and **Triple Bananas** (three peels tossed in a fan behind the kart). The existing
three-banana limit per racer still applies. Both work for human and AI racers.

Run `node --import tsx --test scripts/items.test.ts` for item behavior and geometry
checks. Run `node --import tsx --test scripts/rainbow.test.ts` for track geometry
and three-lap AI simulations. Preview each map with `?mode=single&map=rainbow` or
`?mode=single&map=circuit` on the dev server.


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
