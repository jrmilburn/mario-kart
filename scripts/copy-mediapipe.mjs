// Copies MediaPipe's wasm runtime out of node_modules into public/mediapipe/wasm
// so hand tracking is fully self-hosted (no CDN at runtime). Wired as the
// predev/prebuild npm scripts; the copy is gitignored because it is derived
// entirely from the pinned @mediapipe/tasks-vision version in package-lock.
// The model file (public/mediapipe/hand_landmarker.task) is tracked instead —
// it is not shipped in any npm package.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const dest = resolve(root, 'public/mediapipe/wasm');

if (!existsSync(src)) {
  console.error(`[copy-mediapipe] ${src} not found — run npm install first`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-mediapipe] copied wasm runtime -> ${dest}`);
