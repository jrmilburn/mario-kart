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
  // pressed while PAUSED: resumes through a fresh 3-2-1 countdown (§3.6).
  notifyInputRecovered() {
    if (this.state === 'PAUSED') this.beginCountdown();
  }

  tick(dt: number, controllerAgeMs: number | null) {
    if (this.state === 'COUNTDOWN' || this.state === 'RACING') {
      const absent = controllerAgeMs !== null && controllerAgeMs > CONTROLLER_ABSENT_MS;
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
