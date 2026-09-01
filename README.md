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
