# public/assets/

This whole directory (except this file) is git-ignored — see the repo's
`.gitignore`. It's where you drop in your own character model files; the
game runs fine with none of them present (see `README.md` at the repo root,
"Character models" section, for the full how-to and the personal/local-use-only
IP warning).

Expected layout:

```
public/assets/characters/mario.glb
public/assets/characters/luigi.glb
public/assets/characters/peach.glb
public/assets/characters/yoshi.glb
public/assets/characters/toad.glb
public/assets/characters/bowser.glb
```

§Phase 4: the track's road/grass surfaces also check for optional real-image
overrides, same fallback pattern as the characters above — drop in
`public/assets/textures/asphalt.jpg` and/or `public/assets/textures/grass.jpg`
to replace the built-in procedural CanvasTexture surfaces. Neither file is
required; the game looks correct with zero textures dropped in (the default,
shippable state).
