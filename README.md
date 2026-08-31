# Phone-Controlled Kart Racer

A single-player, browser-based arcade kart racer. The desktop browser renders the game;
a phone browser is the controller, paired by room code / QR.

See `PLAN.md` for the full spec. This README will grow a deployment decision table
(Path A / B / C — LAN http, mkcert HTTPS, cloudflared tunnel) in Phase 8.

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
