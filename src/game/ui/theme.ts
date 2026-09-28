// §stage2: shared palette + fonts for every UI surface built this stage
// (StartMenu, Hud, PlayerHud, FinishScreen). Values straight from the brief so
// every screen reads as one system instead of each file inventing its own
// near-miss hex. THREE-free and DOM-free — safe for StartMenu.ts, which is
// deliberately kept out of the three.js bundle (see StartMenu.ts's own note).
export const THEME = {
  sand: '#F4D9A6',
  oceanShallow: '#1FA7B8',
  oceanDeep: '#0B5E7A',
  accent: '#FFD23F',
  p1: '#FF5A4E', // coral-red — Mario (P1)
  p2: '#2FB84F', // green — Luigi (P2)
  ink: '#0B2430', // dark text on light chrome (sand/accent backgrounds)
  fontDisplay: "'Lilita One', system-ui, sans-serif",
  fontLabel: "'Fredoka', system-ui, sans-serif",
} as const;

export type PlayerColorSlot = 0 | 1;

export function playerColor(slot: PlayerColorSlot): string {
  return slot === 0 ? THEME.p1 : THEME.p2;
}
