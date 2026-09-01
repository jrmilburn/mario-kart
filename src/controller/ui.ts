import type { EventName, PlayerSlot, RosterPick } from '../shared/protocol';
import { TUNING } from '../game/tuning';
import { CHARACTERS } from '../game/characters/registry';
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

function makeHoldButton(label: string, color: string, extraStyle = '') {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText =
    `border-radius:16px; border:none; font-size:16px; font-weight:700; ` +
    `color:#fff; background:${color}; touch-action:none; ${extraStyle}`;
  let active = false;
  const setActive = (v: boolean) => {
    active = v;
    btn.style.opacity = v ? '0.6' : '1';
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

  const itemBtn = makeHoldButton('ITEM', '#f39c12');
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
  // underneath GO, mirrored by ITEM under DRIFT. With auto-throttle ON, GO is
  // dropped (throttle is computed automatically) leaving three huge buttons:
  // DRIFT alone on the left, ITEM+REVERSE stacked on the right. These use
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
      leftCluster.append(itemBtn.el, brakeBtn.el);
      brakeBtn.el.textContent = 'BRAKE';
      setFixedButtonSize(itemBtn.el, 120, 64, 16);
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
        rightCluster.append(itemBtn.el, brakeBtn.el);
        setFlexButtonSize(driftBtn.el, 4, 30);
        setFlexButtonSize(itemBtn.el, 3, 28);
        setFlexButtonSize(brakeBtn.el, 1, 16);
      } else {
        leftCluster.append(driftBtn.el, itemBtn.el);
        rightCluster.append(throttleBtn.el, brakeBtn.el);
        setFlexButtonSize(driftBtn.el, 5, 28); // bumped 26->28 to meet the grow>=3 => >=28px rule
        setFlexButtonSize(itemBtn.el, 2, 16);
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

  function showToast(message: string, retry?: () => void) {
    toast.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);
    if (retry) {
      const retryBtn = document.createElement('button');
      retryBtn.textContent = '⚙ retry';
      retryBtn.style.cssText =
        'margin-left:10px; background:none; border:1px solid #fff; color:#fff; border-radius:6px; ' +
        'padding:2px 8px; font-size:12px;';
      retryBtn.addEventListener('click', retry);
      toast.appendChild(retryBtn);
    }
    toast.style.display = 'block';
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    if (!retry) toastTimer = window.setTimeout(() => (toast.style.display = 'none'), 3500);
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

  // §3.7 availability gate: secure context -> API exists -> (iOS) permission
  // granted from this tap handler. Any failure falls back to touch with a toast.
  async function enableTilt() {
    const availability = checkTiltAvailability();
    if (availability !== 'available') {
      showToast('Tilt unavailable — using touch.');
      return;
    }
    const granted = await requestTiltPermission();
    if (!granted) {
      showToast('Tilt unavailable — using touch.', enableTilt);
      return;
    }
    hideToast();
    tiltSteering.attach();
    openCalibration();
  }

  modeToggle.addEventListener('click', () => {
    if (steerMode === 'touch') enableTilt();
    else switchToTouch();
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
      wheelSpoke.style.transform = `translateX(-50%) rotate(${tiltSteering.steer * 90}deg)`;
    }
  }
  requestAnimationFrame(tickVisuals);

  const raceOverlay = document.createElement('div');
  raceOverlay.style.cssText =
    'position:fixed; inset:0; display:none; flex-direction:column; align-items:center; ' +
    'justify-content:center; gap:20px; background:rgba(0,0,0,0.6); z-index:10;';
  root.appendChild(raceOverlay);

  const raceStatusText = document.createElement('div');
  raceStatusText.style.cssText = 'font-size:22px; text-align:center; padding:0 24px;';
  raceOverlay.appendChild(raceStatusText);

  const restartBtn = document.createElement('button');
  restartBtn.textContent = 'RESTART';
  restartBtn.style.cssText =
    'font-size:20px; font-weight:800; padding:18px 36px; border-radius:16px; border:none; ' +
    'background:#2980b9; color:#fff;';
  raceOverlay.appendChild(restartBtn);

  // §Track D: character select used to be a grid squeezed inside raceOverlay
  // alongside the status text/START button, layered over the translucent
  // play panel — the user's "overlaps with other parts of the controller"
  // complaint. It is now its own dedicated, fully OPAQUE full-screen
  // controller screen so nothing behind it (play panel, raceOverlay) bleeds
  // through. Stacking: below the portrait blocker (z-index 20, §3.7) and the
  // toast (z-index 30) — both must still render over it — above everything
  // else (z-index 16). Layout target is a landscape phone (~700x340 CSS px):
  // header row / large 3x2 tile grid filling the height / footer row.
  const characterScreen = document.createElement('div');
  characterScreen.style.cssText =
    'position:fixed; inset:0; z-index:16; display:none; flex-direction:column; ' +
    'background:linear-gradient(180deg, #1a1f27 0%, #0f1216 100%); color:#fff;';
  root.appendChild(characterScreen);

  const csHeader = document.createElement('div');
  csHeader.style.cssText =
    'flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; ' +
    'padding:12px 20px; gap:12px;';
  characterScreen.appendChild(csHeader);

  const csTitle = document.createElement('div');
  csTitle.textContent = 'CHOOSE YOUR RACER';
  csTitle.style.cssText = 'font-size:16px; font-weight:800; letter-spacing:2px;';
  csHeader.appendChild(csTitle);

  const csBody = document.createElement('div');
  csBody.style.cssText =
    'flex:1; min-height:0; display:grid; grid-template-columns:repeat(3, 1fr); ' +
    'grid-template-rows:repeat(2, minmax(86px, 1fr)); gap:10px; padding:4px 20px;';
  characterScreen.appendChild(csBody);

  // 3x2 grid of thumb-sized tiles (min-height 86px per spec). Each tile is a
  // big colour disc (the kart colour) with the character's initial, the
  // name at >=16px, an absolute-positioned ✓ shown only when it's your own
  // pick, and a TAKEN label shown only when the other connected slot holds
  // it (mutually exclusive with ✓ — a tile is never both).
  interface CharacterTile {
    id: string;
    button: HTMLButtonElement;
    check: HTMLElement;
    takenLabel: HTMLElement;
  }
  const characterTiles: CharacterTile[] = CHARACTERS.map((c) => {
    const button = document.createElement('button');
    button.style.cssText =
      'position:relative; display:flex; flex-direction:column; align-items:center; ' +
      'justify-content:center; gap:6px; min-height:86px; border-radius:16px; ' +
      'border:3px solid transparent; background:rgba(255,255,255,0.08); color:#fff; ' +
      'touch-action:manipulation; padding:6px;';
    const hex = `#${c.kartColor.toString(16).padStart(6, '0')}`;
    const disc = document.createElement('div');
    disc.style.cssText =
      `width:46px; height:46px; border-radius:50%; background:${hex}; display:flex; ` +
      'align-items:center; justify-content:center; font-size:20px; font-weight:800; ' +
      'color:rgba(0,0,0,0.55); border:2px solid rgba(255,255,255,0.5); flex:0 0 auto;';
    disc.textContent = c.name.charAt(0).toUpperCase();
    const label = document.createElement('div');
    label.textContent = c.name;
    label.style.cssText = 'font-size:16px; font-weight:700;';
    const check = document.createElement('div');
    check.textContent = '✓';
    check.style.cssText =
      'position:absolute; top:6px; right:10px; font-size:16px; font-weight:900; ' +
      'color:#2ecc71; display:none;';
    const takenLabel = document.createElement('div');
    takenLabel.textContent = 'TAKEN';
    takenLabel.style.cssText =
      'font-size:10px; font-weight:800; letter-spacing:1px; color:#e74c3c; display:none;';
    button.append(check, disc, label, takenLabel);
    button.addEventListener('click', () => {
      if (button.disabled) return;
      activeSocket?.sendSelect(c.id);
    });
    csBody.appendChild(button);
    return { id: c.id, button, check, takenLabel };
  });

  let mySlot: PlayerSlot | null = null;
  let latestPicks: RosterPick[] = [];

  const csFooter = document.createElement('div');
  csFooter.style.cssText =
    'flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; ' +
    'padding:14px 20px 18px;';
  characterScreen.appendChild(csFooter);

  const csYouLabel = document.createElement('div');
  csYouLabel.style.cssText = 'font-size:14px; opacity:0.85;';
  csFooter.appendChild(csYouLabel);

  // Single START button, lives only here. Lobby is now the only state where
  // characterScreen shows and raceOverlay is hidden entirely (see
  // handleRaceEvent below), so there is no second START anywhere the user
  // could see both at once.
  const startBtn = document.createElement('button');
  startBtn.textContent = 'START RACE';
  startBtn.style.cssText =
    'font-size:18px; font-weight:800; padding:14px 32px; border-radius:14px; border:none; ' +
    'background:#27ae60; color:#fff;';
  csFooter.appendChild(startBtn);

  // Own pick highlighted (bright border + ✓); tiles the *other* connected
  // slot currently holds are dimmed, labelled TAKEN and non-tappable. AI
  // picks never appear here (those are resolved server-side only at
  // countdown), so there's nothing to grey out on their account.
  function renderCharacterTiles() {
    const otherSlot: PlayerSlot | null = mySlot === 0 ? 1 : mySlot === 1 ? 0 : null;
    const minePick = mySlot !== null ? latestPicks.find((p) => p.slot === mySlot)?.characterId ?? null : null;
    const otherPick = otherSlot !== null ? latestPicks.find((p) => p.slot === otherSlot)?.characterId ?? null : null;
    for (const tile of characterTiles) {
      const taken = otherPick === tile.id;
      const mine = minePick === tile.id;
      tile.button.disabled = taken;
      tile.button.style.opacity = taken ? '0.35' : '1';
      tile.button.style.cursor = taken ? 'default' : 'pointer';
      tile.button.style.borderColor = mine ? '#2ecc71' : 'transparent';
      tile.button.style.background = mine ? 'rgba(46,204,113,0.18)' : 'rgba(255,255,255,0.08)';
      tile.check.style.display = mine ? 'block' : 'none';
      tile.takenLabel.style.display = taken ? 'block' : 'none';
    }
    const mineName = minePick ? CHARACTERS.find((c) => c.id === minePick)?.name ?? null : null;
    csYouLabel.textContent = `You: ${mineName ?? '—'}`;
  }

  // The connection pill/RTT/slot badge (statusGroup, built near the top of
  // this function) are one set of DOM nodes reused between the top bar and
  // this screen's own header rather than duplicated ("reuse, don't
  // duplicate state" per spec) — characterScreen is opaque and covers the
  // top bar completely while shown, so the live status needs a visible home
  // here instead. Moving them back on hide restores header's original
  // (title, then statusGroup) child order, since header only ever holds
  // those two nodes.
  function showCharacterScreen() {
    header.style.display = 'none';
    csHeader.appendChild(statusGroup);
    characterScreen.style.display = 'flex';
  }

  function hideCharacterScreen() {
    characterScreen.style.display = 'none';
    header.appendChild(statusGroup);
    header.style.display = 'flex';
  }

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

  function showRaceOverlay(text: string, showRestart: boolean) {
    raceOverlay.style.display = 'flex';
    raceStatusText.style.display = text ? 'block' : 'none';
    raceStatusText.textContent = text;
    restartBtn.style.display = showRestart ? 'block' : 'none';
  }

  function hideRaceOverlay() {
    raceOverlay.style.display = 'none';
  }

  // Android-only (§Phase 11d); iOS Safari has no Vibration API, so this is a no-op there.
  function vibrate(ms: number) {
    navigator.vibrate?.(ms);
  }

  // §Track D: lobby shows characterScreen and hides raceOverlay entirely
  // (raceOverlay's old lobby state — status text + START — no longer
  // exists; START now lives only in characterScreen's footer). Every other
  // state shows raceOverlay and hides characterScreen, so the two full-
  // screen surfaces are always mutually exclusive — never both, never
  // neither once joined.
  function handleRaceEvent(name: EventName) {
    switch (name) {
      case 'lobby':
        hideRaceOverlay();
        showCharacterScreen();
        break;
      case 'countdown':
        hideCharacterScreen();
        showRaceOverlay('Get ready…', false);
        // One tick per second for the 3-2-1 countdown, approximated locally
        // (the game doesn't send a message per tick, only the countdown start).
        vibrate(30);
        window.setTimeout(() => vibrate(30), 1000);
        window.setTimeout(() => vibrate(30), 2000);
        break;
      case 'go':
        hideRaceOverlay();
        hideCharacterScreen();
        break;
      case 'paused':
        hideCharacterScreen();
        showRaceOverlay('Paused', false);
        break;
      case 'finished':
        hideCharacterScreen();
        showRaceOverlay('🏁 Finished!', true);
        break;
      case 'restart':
        break; // a 'lobby' event immediately follows and resets both screens
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
        item: itemBtn.active,
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
          mySlot = slot;
          renderCharacterTiles();
          showPlay();
          // Default to the lobby screen (characterScreen) until an event says
          // otherwise. If we're (re)joining mid-race, the game immediately
          // follows up with a slot-targeted event carrying its current
          // RaceDirector state (main.ts's onPeer) — handleRaceEvent's switch
          // above then corrects the screen (e.g. 'countdown'/'paused' hide
          // characterScreen and show raceOverlay instead). A genuine lobby
          // join gets no such event, so this default stands.
          hideRaceOverlay();
          showCharacterScreen();
          wakeLock.start();
          // Tilt is the default steering mode; attempt it once per session,
          // falling back to touch (with a one-tap retry toast) if unavailable.
          if (!tiltAutoAttempted) {
            tiltAutoAttempted = true;
            enableTilt();
          }
        },
        onJoinError: (reason) => {
          showCodeEntry(
            reason === 'room-full'
              ? 'Both player slots are taken.'
              : 'Room not found — check the code and try again.',
          );
        },
        onGameLeft: () => showCodeEntry('Game closed. Enter a new code to reconnect.'),
        onEvent: handleRaceEvent,
        onRoster: (picks) => {
          latestPicks = picks;
          renderCharacterTiles();
        },
        onRtt: (rttMs) => {
          rttText.textContent = `${Math.round(rttMs)}ms`;
        },
      },
    );
  }

  joinButton.addEventListener('click', () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length === 4) join(code);
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
