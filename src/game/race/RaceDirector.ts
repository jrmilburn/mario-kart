import { CONTROLLER_ABSENT_MS, type EventName } from '../../shared/protocol';

export type RaceState = 'LOBBY' | 'COUNTDOWN' | 'RACING' | 'PAUSED' | 'FINISHED';

const COUNTDOWN_SECONDS = 3;

export interface RaceDirectorCallbacks {
  // Announcements relayed to the controller.
  onEvent?: (name: EventName) => void;
  onStateChange?: (state: RaceState) => void;
}

// LOBBY -> COUNTDOWN -> RACING -> FINISHED, with PAUSED interruptible from
// COUNTDOWN/RACING on controller absence (§3.6) and FINISHED -> LOBBY on restart.
export class RaceDirector {
  state: RaceState = 'LOBBY';
  countdownRemaining = 0;

  constructor(private callbacks: RaceDirectorCallbacks) {}

  private setState(next: RaceState) {
    this.state = next;
    this.callbacks.onStateChange?.(next);
  }

  private beginCountdown() {
    this.countdownRemaining = COUNTDOWN_SECONDS;
    this.setState('COUNTDOWN');
    this.callbacks.onEvent?.('countdown');
  }

  requestStart() {
    if (this.state === 'LOBBY') this.beginCountdown();
  }

  requestRestart() {
    if (this.state === 'FINISHED') {
      this.setState('LOBBY');
      this.callbacks.onEvent?.('restart');
      this.callbacks.onEvent?.('lobby');
    }
  }

  notifyFinished() {
    if (this.state === 'RACING') {
      this.setState('FINISHED');
      this.callbacks.onEvent?.('finished');
    }
  }

  // Called whenever a fresh controller snapshot arrives or a keyboard key is
  // pressed while PAUSED: resumes through a fresh 3-2-1 countdown (§3.6), but
  // only once every active human's controller is fresh again (Phase 2b) —
  // one player recovering doesn't un-pause a race the other is still absent from.
  notifyInputRecovered(allActiveFresh: boolean) {
    if (this.state === 'PAUSED' && allActiveFresh) this.beginCountdown();
  }

  // `controllerAges` is one entry per *active* human player (Phase 2b) — solo
  // play passes a single-element array, so behavior there is unchanged.
  // Pauses the instant ANY active human's controller goes stale.
  tick(dt: number, controllerAges: (number | null)[]) {
    if (this.state === 'COUNTDOWN' || this.state === 'RACING') {
      const absent = controllerAges.some((age) => age !== null && age > CONTROLLER_ABSENT_MS);
      if (absent) {
        this.setState('PAUSED');
        this.callbacks.onEvent?.('paused');
        return;
      }
    }

    if (this.state === 'COUNTDOWN') {
      this.countdownRemaining -= dt;
      if (this.countdownRemaining <= 0) {
        this.setState('RACING');
        this.callbacks.onEvent?.('go');
      }
    }
  }
}
