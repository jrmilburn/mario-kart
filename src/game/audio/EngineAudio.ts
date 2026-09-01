// Two detuned saw oscillators, pitch mapped to speed; short noise bursts for
// drift/collision hits. No audio files (§Phase 11b). AudioContext can't start
// before a user gesture, so construction is deferred to ensureStarted().
const IDLE_HZ = 70;
const TOP_SPEED_HZ = 260;
const DETUNE_CENTS = 12;
const ENGINE_GAIN = 0.05;
const RAMP_SECONDS = 0.08;

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private oscA: OscillatorNode | null = null;
  private oscB: OscillatorNode | null = null;
  private gain: GainNode | null = null;

  // Call from inside a user-gesture handler (click/keydown) — browsers block
  // AudioContext creation/resume outside one.
  ensureStarted() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    this.gain = gain;

    this.oscA = this.makeOscillator(ctx, -DETUNE_CENTS, gain);
    this.oscB = this.makeOscillator(ctx, DETUNE_CENTS, gain);
  }

  private makeOscillator(ctx: AudioContext, detune: number, gain: GainNode): OscillatorNode {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = IDLE_HZ;
    osc.detune.value = detune;
    osc.connect(gain);
    osc.start();
    return osc;
  }

  // speedFrac: 0 (idle) .. 1 (top speed, before any boost overshoot).
  setSpeed(speedFrac: number) {
    if (!this.ctx || !this.oscA || !this.oscB || !this.gain) return;
    const frac = Math.max(0, Math.min(1.3, speedFrac)); // allow a little headroom for boost
    const freq = IDLE_HZ + frac * (TOP_SPEED_HZ - IDLE_HZ);
    const t = this.ctx.currentTime;
    this.oscA.frequency.setTargetAtTime(freq, t, RAMP_SECONDS);
    this.oscB.frequency.setTargetAtTime(freq, t, RAMP_SECONDS);
    this.gain.gain.setTargetAtTime(ENGINE_GAIN, t, RAMP_SECONDS);
  }

  // Short noise burst for a drift boost or a wall/kart collision hit.
  burst(volume = 0.15, durationSeconds = 0.15) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const length = Math.max(1, Math.floor(ctx.sampleRate * durationSeconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = volume;
    source.connect(noiseGain).connect(ctx.destination);
    source.start();
  }
}
