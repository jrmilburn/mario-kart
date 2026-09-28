import type { EventName } from '../../shared/protocol';

export type RaceState = 'LOBBY' | 'COUNTDOWN' | 'RACING' | 'FINISHED';

const COUNTDOWN_SECONDS = 3;

export interface RaceDirectorCallbacks {
  // Announcements relayed to the controller.
  onEvent?: (name: EventName) => void;
  onStateChange?: (state: RaceState) => void;
}

// LOBBY -> COUNTDOWN -> RACING -> FINISHED -> LOBBY on restart.
//
// §stage2: the pause-on-disconnect watchdog (PAUSED, controller-absence
// polling, notifyInputRecovered) is gone — canStart() never blocks and
// nothing waits for a phone. A versus race with no phone connected simply
// runs P2 on keyboard; a phone that drops mid-race hands off to keyboard
// instantly (see main.ts) instead of freezing the world for everyone.
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

  tick(dt: number) {
    if (this.state === 'COUNTDOWN') {
      this.countdownRemaining -= dt;
      if (this.countdownRemaining <= 0) {
        this.setState('RACING');
        this.callbacks.onEvent?.('go');
      }
    }
  }
}
