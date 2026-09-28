import type { EventName } from '../shared/protocol';
import { TUNING } from '../game/tuning';
import { ControllerSocket, getStoredRoomCode, type ConnectionStatus } from './ControllerSocket';
import { TouchSteering } from './TouchSteering';
import { TiltSteering, checkTiltAvailability, requestTiltPermission } from './TiltSteering';
import { WakeLock } from './WakeLock';

const STATUS_STYLE: Record<ConnectionStatus, [string, string]> = {
  connecting: ['connecting…', '#f39c12'],
  connected: ['connected', '#27ae60'],
  reconnecting: ['reconnecting…', '#c0392b'],
};

const AUTO_THROTTLE_STORAGE_KEY = 'kart.controller.autoThrottle';

// §stage2: every hold button is always lit now — the old lit/dim treatment
// existed only for the ITEM button (the game has no items any more, and
// the button itself is BOOST, always available). Opacity alone carries the
// press feedback.
function makeHoldButton(label: string, color: string, extraStyle = '') {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText =
    `border-radius:16px; border:none; font-size:16px; font-weight:700; ` +
    `color:#fff; background:${color}; touch-action:none; ${extraStyle}`;
  let active = false;
  const setActive = (v: boolean) => {
    active = v;
    btn.style.opacity = active ? '0.6' : '1';
  };
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    setActive(true);
  });
  btn.addEventListener('pointerup', () => setActive(false));
  btn.addEventListener('pointercancel', () => setActive(false));
  return {
    el: btn,
    get active(): 0 | 1 {
      return active ? 1 : 0;
    },
  };
}

export function initControllerUI(root: HTMLElement) {
  root.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'display:flex; flex-direction:column; height:100%; padding:16px; box-sizing:border-box; gap:16px;';
  root.appendChild(wrapper);

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
  wrapper.appendChild(header);

  const title = document.createElement('div');
  title.textContent = 'CONTROLLER';
  title.style.cssText = 'font-size:18px; letter-spacing:2px; font-weight:700;';
  header.appendChild(title);

  const statusGroup = document.createElement('div');
  statusGroup.style.cssText = 'display:flex; align-items:center; gap:8px;';
  header.appendChild(statusGroup);

  const slotBadge = document.createElement('div');
  slotBadge.style.cssText =
    'display:none; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:800; ' +
    'background:#2c3e50; color:#fff; letter-spacing:1px;';
  statusGroup.appendChild(slotBadge);

  const modeToggle = document.createElement('button');
  modeToggle.textContent = '🎮 TOUCH';
  modeToggle.style.cssText =
    'padding:4px 10px; border-radius:999px; font-size:11px; font-weight:700; border:none; background:#34495e; color:#fff;';
  statusGroup.appendChild(modeToggle);

  const autoThrottleToggle = document.createElement('button');
  autoThrottleToggle.style.cssText =
    'padding:4px 10px; border-radius:999px; font-size:11px; font-weight:700; border:none; color:#fff;';
  statusGroup.appendChild(autoThrottleToggle);

  const rttText = document.createElement('div');
  rttText.style.cssText = 'font-size:12px; opacity:0.7; font-variant-numeric:tabular-nums;';
  statusGroup.appendChild(rttText);

  const pill = document.createElement('div');
  pill.style.cssText = 'padding:4px 12px; border-radius:999px; font-size:12px; background:#f39c12;';
  pill.textContent = 'connecting…';
  statusGroup.appendChild(pill);

  const codeEntryPanel = document.createElement('div');
  codeEntryPanel.style.cssText =
    'display:none; flex-direction:column; align-items:center; justify-content:center; flex:1; gap:12px; ' +
    'background:rgba(255,255,255,0.05); border-radius:20px; padding:24px;';
  wrapper.appendChild(codeEntryPanel);

  const codeEntryMsg = document.createElement('div');
  codeEntryMsg.style.cssText = 'font-size:16px; opacity:0.85; text-align:center;';
  codeEntryPanel.appendChild(codeEntryMsg);

  const codeInput = document.createElement('input');
  codeInput.maxLength = 4;
  codeInput.placeholder = 'CODE';
  codeInput.autocapitalize = 'characters';
  codeInput.style.cssText =
    'font-size:32px; letter-spacing:8px; text-align:center; width:200px; padding:8px; ' +
    'text-transform:uppercase; border-radius:8px; border:none;';
  codeEntryPanel.appendChild(codeInput);

  const joinButton = document.createElement('button');
  joinButton.textContent = 'JOIN';
  joinButton.style.cssText =
    'font-size:18px; font-weight:700; padding:12px 32px; border-radius:12px; border:none; ' +
    'background:#27ae60; color:#fff;';
  codeEntryPanel.appendChild(joinButton);

  // Thumb-corner layout: BRAKE bottom-left; DRIFT+GO stacked bottom-right (GO
  // largest, at the very corner where the right thumb naturally rests); the
  // steering slider (or, in tilt mode, the wheel-arc visual) spans the full
  // width above the button row.
  const playPanel = document.createElement('div');
  playPanel.style.cssText = 'display:none; flex-direction:column; flex:1; gap:16px; justify-content:flex-end;';
  wrapper.appendChild(playPanel);

  const sliderContainer = document.createElement('div');
  playPanel.appendChild(sliderContainer);
  const steering = new TouchSteering(sliderContainer);

  const tiltSteering = new TiltSteering();
  let steerMode: 'touch' | 'tilt' = 'touch';
  let tiltAutoAttempted = false;

  // Auto-throttle: default OFF in touch, ON once tilt actually activates —
  // but frozen at whatever the user last explicitly chose, once they've
  // touched the toggle, so the persisted preference stays meaningful across
  // mode switches.
  const storedAutoThrottle = localStorage.getItem(AUTO_THROTTLE_STORAGE_KEY);
  let autoThrottleUserSet = storedAutoThrottle !== null;
  let autoThrottle = storedAutoThrottle !== null ? storedAutoThrottle === '1' : false;

  const wheelContainer = document.createElement('div');
  wheelContainer.style.cssText = 'display:none; align-items:center; justify-content:center; height:120px;';
  playPanel.appendChild(wheelContainer);
  const wheelDial = document.createElement('div');
  wheelDial.style.cssText = 'width:110px; height:110px; border-radius:50%; border:8px solid #fff; position:relative;';
  wheelContainer.appendChild(wheelDial);
  const wheelSpoke = document.createElement('div');
  wheelSpoke.style.cssText =
    'position:absolute; top:2px; left:50%; width:4px; height:53px; background:#fff; ' +
    'transform-origin:bottom center; transform:translateX(-50%);';
  wheelDial.appendChild(wheelSpoke);

  const controlsRow = document.createElement('div');
  controlsRow.style.cssText = 'display:flex; justify-content:space-between; gap:16px;';
  playPanel.appendChild(controlsRow);

  const leftCluster = document.createElement('div');
  leftCluster.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
  controlsRow.appendChild(leftCluster);

  const rightCluster = document.createElement('div');
  rightCluster.style.cssText = 'display:flex; flex-direction:column; gap:10px;';
  controlsRow.appendChild(rightCluster);

  // §v5: the old ITEM button (the game has no items any more) is now BOOST,
  // always lit — a boost is always available, the kart enforces the cooldown.
  // It sends a held level; the game fires on the rising edge.
  const boostBtn = makeHoldButton('BOOST', '#f39c12');
  const brakeBtn = makeHoldButton('BRAKE', '#c0392b');
  const driftBtn = makeHoldButton('DRIFT', '#8e44ad');
  const throttleBtn = makeHoldButton('GO', '#27ae60');

  // Touch mode: BRAKE bottom-left; DRIFT+GO stacked bottom-right (GO largest,
  // at the corner the right thumb rests on) — steering is the full-width slider.
  // Fixed pixel sizes here are fine since the slider above already claims most
  // of the vertical space. With auto-throttle ON, GO is dropped entirely and
  // DRIFT is promoted to GO's old primary-corner size/position.
  //
  // Tilt mode: steering is handled by the wheel, freeing both thumbs for one
  // big button each. With auto-throttle OFF, that's DRIFT (left) and GO
  // (right, the primary action), with the secondary REVERSE tucked small
  // underneath GO, mirrored by BOOST under DRIFT. With auto-throttle ON, GO is
  // dropped (throttle is computed automatically) leaving three huge buttons:
  // DRIFT alone on the left, BOOST+REVERSE stacked on the right. These use
  // flex-grow sizing (not fixed px) so the cluster stretches to fill the
  // phone's full remaining height edge-to-edge regardless of screen size,
  // instead of overflowing off the bottom on shorter phones.
  function applyButtonLayoutForMode(mode: 'touch' | 'tilt', autoThrottle: boolean) {
    throttleBtn.el.remove(); // re-appended below only when this mode/autoThrottle combo uses it

    if (mode === 'touch') {
      controlsRow.style.flex = '0 0 auto';
      controlsRow.style.alignItems = 'flex-end';
      leftCluster.style.flex = '0 0 auto';
      rightCluster.style.flex = '0 0 auto';
      leftCluster.append(boostBtn.el, brakeBtn.el);
      brakeBtn.el.textContent = 'BRAKE';
      setFixedButtonSize(boostBtn.el, 120, 64, 16);
      setFixedButtonSize(brakeBtn.el, 120, 80, 16);
      if (autoThrottle) {
        rightCluster.append(driftBtn.el);
        setFixedButtonSize(driftBtn.el, 140, 96, 20); // takes GO's old primary-corner size
      } else {
        rightCluster.append(driftBtn.el, throttleBtn.el);
        setFixedButtonSize(driftBtn.el, 140, 64, 16);
        setFixedButtonSize(throttleBtn.el, 140, 96, 20);
      }
    } else {
      controlsRow.style.flex = '1';
      controlsRow.style.alignItems = 'stretch';
      leftCluster.style.flex = '1';
      rightCluster.style.flex = '1';
      brakeBtn.el.textContent = 'REVERSE';
      if (autoThrottle) {
        leftCluster.append(driftBtn.el);
        rightCluster.append(boostBtn.el, brakeBtn.el);
        setFlexButtonSize(driftBtn.el, 4, 30);
        setFlexButtonSize(boostBtn.el, 3, 28);
        setFlexButtonSize(brakeBtn.el, 1, 16);
      } else {
        leftCluster.append(driftBtn.el, boostBtn.el);
        rightCluster.append(throttleBtn.el, brakeBtn.el);
        setFlexButtonSize(driftBtn.el, 5, 28); // bumped 26->28 to meet the grow>=3 => >=28px rule
        setFlexButtonSize(boostBtn.el, 2, 16);
        setFlexButtonSize(throttleBtn.el, 3, 28);
        setFlexButtonSize(brakeBtn.el, 1, 16);
      }
    }
  }

  function setFixedButtonSize(el: HTMLButtonElement, width: number, height: number, fontSize: number) {
    el.style.flex = '0 0 auto';
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.fontSize = `${fontSize}px`;
  }

  function setFlexButtonSize(el: HTMLButtonElement, flexGrow: number, fontSize: number) {
    el.style.flex = `${flexGrow} 1 0`;
    el.style.width = '100%';
    el.style.height = 'auto';
    el.style.fontSize = `${fontSize}px`;
  }

  applyButtonLayoutForMode('touch', autoThrottle);

  const recalibrateBtn = document.createElement('button');
  recalibrateBtn.textContent = '⟳';
  recalibrateBtn.style.cssText =
    'display:none; position:absolute; top:52px; right:16px; width:40px; height:40px; border-radius:50%; ' +
    'border:none; background:rgba(255,255,255,0.15); color:#fff; font-size:18px; z-index:5;';
  root.appendChild(recalibrateBtn);

  const toast = document.createElement('div');
  toast.style.cssText =
    'position:fixed; top:52px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.85); ' +
    'color:#fff; padding:8px 16px; border-radius:8px; font-size:13px; display:none; z-index:30; ' +
    'text-align:center; max-width:80%; white-space:nowrap;';
  root.appendChild(toast);
  let toastTimer: number | null = null;

  // §v3 polish: the optional "⚙ retry" chip is gone along with its sticky
  // (never auto-hiding) toast variant. Its only user was the tilt-permission
  // failure path, which now gets the full-screen tiltGate instead — a retry
  // affordance you could actually see. Every remaining toast is transient.
  function showToast(message: string) {
    toast.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);
    toast.style.display = 'block';
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.style.display = 'none'), 3500);
  }

  function hideToast() {
    if (toastTimer !== null) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    toast.style.display = 'none';
  }

  const calibrationPanel = document.createElement('div');
  calibrationPanel.style.cssText =
    'position:fixed; inset:0; display:none; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:24px; background:#0b0b0b; z-index:25; padding:0 32px; text-align:center;';
  const calibrationText = document.createElement('div');
  calibrationText.style.cssText = 'font-size:18px; line-height:1.5;';
  calibrationText.innerHTML = 'Hold your phone like a steering wheel,<br>wheels straight → tap SET';
  calibrationPanel.appendChild(calibrationText);
  const levelBar = document.createElement('div');
  levelBar.style.cssText = 'width:260px; height:16px; border-radius:8px; background:rgba(255,255,255,0.15); position:relative;';
  calibrationPanel.appendChild(levelBar);
  const levelDot = document.createElement('div');
  levelDot.style.cssText =
    'position:absolute; top:-4px; left:50%; width:24px; height:24px; border-radius:50%; ' +
    'background:#2ecc71; transform:translateX(-50%);';
  levelBar.appendChild(levelDot);
  const setBtn = document.createElement('button');
  setBtn.textContent = 'SET';
  setBtn.style.cssText =
    'font-size:20px; font-weight:800; padding:14px 48px; border-radius:16px; border:none; ' +
    'background:#27ae60; color:#fff;';
  calibrationPanel.appendChild(setBtn);
  root.appendChild(calibrationPanel);

  // §v3 polish: the "one tap to grant tilt" gate (see primeTiltPermission).
  // z-index 18 sits above raceOverlay (10) so it is the first thing a
  // freshly-joined phone shows, but below portraitBlocker (20) — rotating the
  // phone is the more fundamental instruction — and below calibrationPanel
  // (25), which is what replaces it the moment permission is granted.
  const tiltGate = document.createElement('div');
  tiltGate.style.cssText =
    'position:fixed; inset:0; display:none; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:18px; background:#0b0b0b; z-index:18; text-align:center; padding:0 32px;';
  const tiltGateBody = document.createElement('div');
  tiltGateBody.innerHTML =
    '<div style="font-size:56px;">🎡</div>' +
    '<div style="font-size:24px; font-weight:700; margin-top:12px;">Tap to steer by tilting</div>' +
    '<div style="font-size:15px; opacity:0.7; margin-top:8px; line-height:1.5;">' +
    'iOS needs one tap before it will hand over the motion sensor.</div>';
  tiltGate.appendChild(tiltGateBody);
  const tiltGateTouchBtn = document.createElement('button');
  tiltGateTouchBtn.textContent = 'Use touch steering instead';
  tiltGateTouchBtn.style.cssText =
    'margin-top:8px; padding:12px 20px; font-size:15px; border:0; border-radius:10px; ' +
    'background:#34495e; color:#fff;';
  tiltGate.appendChild(tiltGateTouchBtn);
  root.appendChild(tiltGate);

  function showTiltGate() {
    tiltGate.style.display = 'flex';
  }

  function hideTiltGate() {
    tiltGate.style.display = 'none';
  }

  // The whole panel is the button — a tap anywhere on it is the gesture iOS
  // wants. A failure at this point is a real denial (the user said no in the
  // system prompt), so it falls back to touch rather than re-gating.
  tiltGate.addEventListener('click', () => {
    void enableTilt().then((ok) => {
      if (!ok) {
        hideTiltGate();
        showToast('Tilt unavailable — using touch.');
      }
    });
  });
  tiltGateTouchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideTiltGate();
  });

  // Auto-throttle toggle: default OFF in touch / ON in tilt, but that default
  // only applies until the user explicitly touches the toggle themselves —
  // after that their choice sticks (and persists) across mode switches.
  function renderAutoThrottleToggle() {
    autoThrottleToggle.textContent = autoThrottle ? '🚀 AUTO' : '🖐 MANUAL';
    autoThrottleToggle.style.background = autoThrottle ? '#27ae60' : '#34495e';
  }

  function setAutoThrottle(value: boolean, userInitiated: boolean) {
    autoThrottle = value;
    if (userInitiated) {
      autoThrottleUserSet = true;
      localStorage.setItem(AUTO_THROTTLE_STORAGE_KEY, value ? '1' : '0');
    }
    renderAutoThrottleToggle();
    applyButtonLayoutForMode(steerMode, autoThrottle);
  }

  autoThrottleToggle.addEventListener('click', () => setAutoThrottle(!autoThrottle, true));
  renderAutoThrottleToggle();

  function switchToTouch() {
    steerMode = 'touch';
    tiltSteering.detach();
    sliderContainer.style.display = 'block';
    wheelContainer.style.display = 'none';
    recalibrateBtn.style.display = 'none';
    modeToggle.textContent = '🎮 TOUCH';
    if (!autoThrottleUserSet) setAutoThrottle(false, false);
    else applyButtonLayoutForMode('touch', autoThrottle);
  }

  function switchToTilt() {
    steerMode = 'tilt';
    sliderContainer.style.display = 'none';
    wheelContainer.style.display = 'flex';
    recalibrateBtn.style.display = 'block';
    modeToggle.textContent = '🎡 TILT';
    if (!autoThrottleUserSet) setAutoThrottle(true, false);
    else applyButtonLayoutForMode('tilt', autoThrottle);
  }

  function openCalibration() {
    calibrationPanel.style.display = 'flex';
  }

  setBtn.addEventListener('click', () => {
    tiltSteering.calibrate();
    calibrationPanel.style.display = 'none';
    switchToTilt();
  });

  // §v3 polish: iOS gates DeviceOrientation behind
  // DeviceOrientationEvent.requestPermission(), which only ever resolves from
  // inside a real user gesture. Joining by scanning the QR code involves no
  // tap at all — the page opens with ?room=XXXX and auto-joins — so the
  // attempt fired from onJoined was rejected every time on iOS, and the only
  // way to actually grant tilt was the tiny "⚙ retry" chip inside a toast.
  // Two changes fix that: the prompt is fired from the JOIN tap whenever
  // there is one, and when there isn't, a full-screen gate asks for the one
  // tap the platform requires the moment we join.
  let tiltPermission: boolean | null = null; // null = not granted yet, still retryable

  // Safe to call from anywhere; the platform prompt only actually appears when
  // this runs synchronously inside a user gesture (everything before the first
  // `await` here does, so calling it straight from a click handler works).
  async function primeTiltPermission(): Promise<boolean> {
    if (checkTiltAvailability() !== 'available') return false;
    if (tiltPermission) return true;
    const granted = await requestTiltPermission();
    // A rejection outside a gesture is indistinguishable from a real "no", so
    // only a grant is cached — the gate below gets to ask again from a tap.
    if (granted) tiltPermission = true;
    return granted;
  }

  // §3.7 availability gate: secure context -> API exists -> (iOS) permission.
  // Returns whether tilt is now live, so the caller can decide between the
  // gate (we just need a tap) and plain touch fallback (tilt is impossible).
  async function enableTilt(): Promise<boolean> {
    if (checkTiltAvailability() !== 'available') {
      showToast('Tilt unavailable — using touch.');
      return false;
    }
    if (!(await primeTiltPermission())) return false;
    hideToast();
    hideTiltGate();
    tiltSteering.attach();
    openCalibration();
    return true;
  }

  modeToggle.addEventListener('click', () => {
    if (steerMode !== 'touch') {
      switchToTouch();
      return;
    }
    // This IS a gesture, so a failure here is a genuine denial rather than a
    // missing tap — no point showing the gate, which only asks for a tap.
    void enableTilt().then((ok) => {
      if (!ok) showToast('Tilt unavailable — using touch.');
    });
  });
  recalibrateBtn.addEventListener('click', openCalibration);

  function tickVisuals() {
    requestAnimationFrame(tickVisuals);
    if (calibrationPanel.style.display === 'flex') {
      const maxRad = (TUNING.tiltMaxAngleDeg * Math.PI) / 180;
      const frac = Math.max(-1, Math.min(1, tiltSteering.filteredAngle / maxRad));
      levelDot.style.left = `calc(50% + ${frac * 110}px)`;
    }
    if (steerMode === 'tilt') {
      // CSS rotate(+deg) turns clockwise, and tiltSteering.steer is +1 for
      // tilt-right (same human convention as the touch slider) — so this
      // spoke turns clockwise for a right tilt, matching the physical wheel.
      wheelSpoke.style.transform = `translateX(-50%) rotate(${tiltSteering.steer * 90}deg)`;
    }
  }
  requestAnimationFrame(tickVisuals);

  // §stage2: character select is gone entirely — P1 is always Mario, P2 always
  // Luigi (registry.ts), so there is nothing to pick. The phone joins straight
  // into this one overlay: a status line plus whichever of START/RESTART
  // applies, layered over the (already-live) play panel underneath.
  const raceOverlay = document.createElement('div');
  raceOverlay.style.cssText =
    'position:fixed; inset:0; display:none; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:20px; background:rgba(0,0,0,0.6); z-index:10;';
  root.appendChild(raceOverlay);

  const raceStatusText = document.createElement('div');
  raceStatusText.style.cssText = 'font-size:22px; text-align:center; padding:0 24px;';
  raceOverlay.appendChild(raceStatusText);

  const startBtn = document.createElement('button');
  startBtn.textContent = 'START RACE';
  startBtn.style.cssText =
    'font-size:20px; font-weight:800; padding:18px 36px; border-radius:16px; border:none; ' +
    'background:#27ae60; color:#fff;';
  raceOverlay.appendChild(startBtn);

  const restartBtn = document.createElement('button');
  restartBtn.textContent = 'RESTART';
  restartBtn.style.cssText =
    'font-size:20px; font-weight:800; padding:18px 36px; border-radius:16px; border:none; ' +
    'background:#2980b9; color:#fff;';
  raceOverlay.appendChild(restartBtn);

  // Portrait blocker: touch controls are landscape-only (§3.7).
  const portraitBlocker = document.createElement('div');
  portraitBlocker.style.cssText =
    'position:fixed; inset:0; display:none; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:16px; background:#0b0b0b; z-index:20; text-align:center; padding:0 32px;';
  portraitBlocker.innerHTML =
    '<div style="font-size:48px;">📱↻</div><div style="font-size:18px;">Rotate your phone to landscape</div>';
  root.appendChild(portraitBlocker);

  function updateOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    portraitBlocker.style.display = portrait ? 'flex' : 'none';
  }
  window.addEventListener('resize', updateOrientation);
  window.addEventListener('orientationchange', updateOrientation);
  updateOrientation();
  const orientationLock = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  orientationLock.lock?.('landscape').catch(() => {
    /* not supported outside fullscreen/installed contexts — the CSS blocker is the real fallback */
  });

  const wakeLock = new WakeLock();

  let activeSocket: ControllerSocket | null = null;
  startBtn.addEventListener('click', () => activeSocket?.sendEvent('start'));
  restartBtn.addEventListener('click', () => activeSocket?.sendEvent('restart'));

  function showRaceOverlay(text: string, buttons: { start?: boolean; restart?: boolean }) {
    raceOverlay.style.display = 'flex';
    raceStatusText.style.display = text ? 'block' : 'none';
    raceStatusText.textContent = text;
    startBtn.style.display = buttons.start ? 'block' : 'none';
    restartBtn.style.display = buttons.restart ? 'block' : 'none';
  }

  function hideRaceOverlay() {
    raceOverlay.style.display = 'none';
  }

  // Android-only (§Phase 11d); iOS Safari has no Vibration API, so this is a no-op there.
  function vibrate(ms: number) {
    navigator.vibrate?.(ms);
  }

  // §stage2: character select is gone, so this overlay is the ENTIRE
  // post-join screen — lobby included (a START button rather than its own
  // full-screen grid).
  function handleRaceEvent(name: EventName) {
    switch (name) {
      case 'lobby':
        showRaceOverlay("You're P2 — ready when you are", { start: true });
        break;
      case 'countdown':
        showRaceOverlay('Get ready…', {});
        // One tick per second for the 3-2-1 countdown, approximated locally
        // (the game doesn't send a message per tick, only the countdown start).
        vibrate(30);
        window.setTimeout(() => vibrate(30), 1000);
        window.setTimeout(() => vibrate(30), 2000);
        break;
      case 'go':
        hideRaceOverlay();
        break;
      case 'finished':
        showRaceOverlay('🏁 Finished!', { restart: true });
        break;
      case 'restart':
        break; // a 'lobby' event immediately follows and resets the overlay
      case 'boost':
      case 'collision':
        vibrate(30);
        break;
    }
  }

  function showCodeEntry(message: string) {
    codeEntryPanel.style.display = 'flex';
    playPanel.style.display = 'none';
    codeEntryMsg.textContent = message;
  }

  function showPlay() {
    codeEntryPanel.style.display = 'none';
    playPanel.style.display = 'flex';
  }

  function join(code: string) {
    activeSocket = new ControllerSocket(
      code,
      () => ({
        steer: steerMode === 'tilt' ? tiltSteering.steer : steering.steer,
        throttle: autoThrottle ? (brakeBtn.active ? 0 : 1) : throttleBtn.active,
        brake: brakeBtn.active,
        drift: driftBtn.active,
        boost: boostBtn.active,
        steerMode,
      }),
      {
        onStatus: (status) => {
          const [text, color] = STATUS_STYLE[status];
          pill.textContent = text;
          pill.style.background = color;
        },
        onJoined: (slot) => {
          slotBadge.textContent = slot === 0 ? 'P1' : 'P2';
          slotBadge.style.display = 'block';
          showPlay();
          // Default to the lobby look until an event says otherwise. If we're
          // (re)joining mid-race, the game immediately follows up with a
          // slot-targeted event carrying its current RaceDirector state
          // (main.ts's onPeer) — handleRaceEvent's switch above then corrects
          // it (e.g. 'countdown'/'go' replace this). A genuine lobby join
          // gets no such event, so this default stands.
          handleRaceEvent('lobby');
          wakeLock.start();
          // Tilt is the default steering mode; attempt it once per session.
          // §v3 polish: if the attempt fails only because the platform wants a
          // gesture (i.e. tilt is otherwise available), show the full-screen
          // gate immediately instead of the old easy-to-miss retry toast.
          if (!tiltAutoAttempted) {
            tiltAutoAttempted = true;
            void enableTilt().then((ok) => {
              if (!ok && checkTiltAvailability() === 'available') showTiltGate();
            });
          }
        },
        onJoinError: (reason) => {
          showCodeEntry(
            reason === 'room-full'
              ? "This game's phone slot is already connected — close it there first, or try again."
              : 'Room not found — check the code and try again.',
          );
        },
        onGameLeft: () => showCodeEntry('Game closed. Enter a new code to reconnect.'),
        onEvent: handleRaceEvent,
        onRtt: (rttMs) => {
          rttText.textContent = `${Math.round(rttMs)}ms`;
        },
      },
    );
  }

  joinButton.addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 4) return;
    // §v3 polish: fire the iOS motion-permission prompt from inside this tap,
    // the one gesture a manual join is guaranteed to have. By the time
    // onJoined runs the answer is already cached, so tilt comes up without
    // the gate. (The QR auto-join path below has no gesture to borrow — that
    // is what the gate is for.)
    void primeTiltPermission();
    join(code);
  });

  const params = new URLSearchParams(location.search);
  const urlCode = params.get('room')?.toUpperCase() ?? null;
  const initialCode = urlCode ?? getStoredRoomCode();

  if (initialCode) {
    join(initialCode);
  } else {
    showCodeEntry('Scan the QR code on the desktop screen, or enter the code manually.');
  }
}
