import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Standalone hand-tracking preview (npm run hands -> http://localhost:5183).
// Rooted in this folder so "/" is the preview itself, but sharing the game's
// public/ dir so the self-hosted MediaPipe model + wasm resolve at /mediapipe/.
export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, '..', 'public'),
  server: { port: 5183, strictPort: true },
});
