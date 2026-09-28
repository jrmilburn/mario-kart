import type { PlayerSlot } from '../../shared/protocol';

// §stage2: pure finish-screen formatting, split out of main.ts so the
// winner/title/lap-time logic can be unit tested without dragging in THREE,
// the DOM, or the whole race loop. FinishScreen.ts (the DOM layer) just calls
// buildFinishSummary() and renders whatever comes back.

export interface FinishPlayerResult {
  slot: PlayerSlot;
  name: string;
  colorHex: string;
  position: number; // 1-based finish rank among ALL karts (humans + AI)
  lapTimes: number[]; // seconds, one entry per completed lap, in order
}

export interface FinishSummary {
  mode: 'single' | 'multi';
  title: string; // e.g. "MARIO WINS!" / "YOU FINISHED 2ND"
  winner: FinishPlayerResult | null; // the better-placed human (versus); null only if `players` is empty
  players: FinishPlayerResult[]; // human players, slot order preserved
}

function ordinal(n: number): string {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

// mm:ss.mmm — always this shape (no dropping the minutes) so a results column
// lines up regardless of how long any one lap took.
export function formatLapTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const secStr = s.toFixed(3).padStart(6, '0');
  return `${m}:${secStr}`;
}

export function totalTime(lapTimes: number[]): number {
  return lapTimes.reduce((a, b) => a + b, 0);
}

// `players` are just the currently-active human seats (Solo: P1 only; Versus:
// P1 and, if active, P2), each already carrying their final finish position
// among the whole field. The winner in versus is whoever placed better; solo
// has no "winner" concept beyond the player's own position, so `winner` is
// simply that lone player for a uniform title-building path.
export function buildFinishSummary(mode: 'single' | 'multi', players: FinishPlayerResult[]): FinishSummary {
  const winner =
    players.length === 0
      ? null
      : players.reduce((best, p) => (p.position < best.position ? p : best));

  let title: string;
  if (mode === 'single') {
    const p = players[0];
    title = !p ? 'FINISHED' : p.position === 1 ? 'YOU WIN!' : `YOU FINISHED ${ordinal(p.position).toUpperCase()}`;
  } else {
    title = winner ? `${winner.name.toUpperCase()} WINS!` : 'FINISHED';
  }

  return { mode, title, winner, players };
}
