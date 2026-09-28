/// <reference types="vite/client" />

// §stage2: relay discovery for a game+controller pair hosted separately from
// the relay server (e.g. static pages on Vercel, ws relay on Railway). Both
// src/game/net/GameSocket.ts and src/controller/ControllerSocket.ts fall back
// to same-origin `/ws` when this isn't set, so local/LAN dev is unaffected.
interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
