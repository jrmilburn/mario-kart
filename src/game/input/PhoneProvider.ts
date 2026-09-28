import { INPUT_STALE_MS, type InputSnapshot } from '../../shared/protocol';
import type { ControlProvider, ControlState } from './ControlProvider';

// Latest phone snapshot (relayed over the network), moved verbatim out of the
// pre-v5 InputSource: seq ordering, and an opinion only while the newest
// snapshot is younger than INPUT_STALE_MS.
export class PhoneProvider implements ControlProvider {
  readonly kind = 'phone' as const;
  latestSnapshot: InputSnapshot | null = null;
  private latestReceivedAt = 0;
  // §stage2 review fix: BOOST is sent as a *held* level, sampled once per
  // snapshot (30Hz). A tap shorter than one send interval (~33ms) could land
  // entirely between two snapshots and never appear as `boost: 1` in any of
  // them, and even a tap that DOES land in one snapshot could be overwritten
  // by a newer `boost: 0` snapshot before the physics tick ever samples it.
  // Latch the edge the instant any snapshot reports it, independent of
  // whichever snapshot ends up "latest" by the time sample() is called, and
  // clear it once a sample has actually consumed it.
  private boostLatched = false;

  onSnapshot(snapshot: InputSnapshot) {
    // Discard out-of-order/duplicate snapshots, except a seq reset that arrives
    // more than 1s after the last one (a fresh controller session reconnected).
    if (
      this.latestSnapshot &&
      snapshot.seq <= this.latestSnapshot.seq &&
      performance.now() - this.latestReceivedAt < 1000
    ) {
      return;
    }
    if (snapshot.boost === 1) this.boostLatched = true;
    this.latestSnapshot = snapshot;
    this.latestReceivedAt = performance.now();
  }

  isActive(now: number): boolean {
    return this.latestSnapshot !== null && now - this.latestReceivedAt < INPUT_STALE_MS;
  }

  sample(now: number): ControlState | null {
    if (!this.isActive(now)) return null;
    const s = this.latestSnapshot!;
    const boost: 0 | 1 = s.boost === 1 || this.boostLatched ? 1 : 0;
    this.boostLatched = false; // consumed — the kart's own edge detection takes it from here
    return { steer: s.steer, throttle: s.throttle, brake: s.brake, drift: s.drift, boost };
  }

  // Raw snapshot age regardless of freshness — feeds RaceDirector's
  // pause-on-disconnect watchdog (§3.6) and the diagnostics panel.
  ageMs(now: number): number | null {
    return this.latestSnapshot ? now - this.latestReceivedAt : null;
  }
}
