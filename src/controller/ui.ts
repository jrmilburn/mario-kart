import type { EventName } from '../shared/protocol';
import { ControllerSocket, getStoredRoomCode, type ConnectionStatus } from './ControllerSocket';
import { TouchSteering } from './TouchSteering';

const STATUS_STYLE: Record<ConnectionStatus, [string, string]> = {
  connecting: ['connecting…', '#f39c12'],
  connected: ['connected', '#27ae60'],
  reconnecting: ['reconnecting…', '#c0392b'],
};

function makeHoldButton(label: string, color: string) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText =
    `flex:1; height:88px; border-radius:16px; border:none; font-size:16px; font-weight:700; ` +
    `color:#fff; background:${color}; touch-action:none;`;
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

  const pill = document.createElement('div');
  pill.style.cssText = 'padding:4px 12px; border-radius:999px; font-size:12px; background:#f39c12;';
  pill.textContent = 'connecting…';
  header.appendChild(pill);

  const codeEntryPanel = document.createElement('div');
  codeEntryPanel.style.cssText =
    'display:none; flex-direction:column; align-items:center; justify-content:center; flex:1; gap:12px;';
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

  const playPanel = document.createElement('div');
  playPanel.style.cssText = 'display:none; flex-direction:column; flex:1; gap:16px; justify-content:flex-end;';
  wrapper.appendChild(playPanel);

  const buttonsRow = document.createElement('div');
  buttonsRow.style.cssText = 'display:flex; gap:12px; justify-content:space-between;';
  playPanel.appendChild(buttonsRow);

  const brakeBtn = makeHoldButton('BRAKE', '#c0392b');
  const driftBtn = makeHoldButton('DRIFT', '#8e44ad');
  const throttleBtn = makeHoldButton('GO', '#27ae60');
  buttonsRow.append(brakeBtn.el, driftBtn.el, throttleBtn.el);

  const sliderContainer = document.createElement('div');
  playPanel.appendChild(sliderContainer);
  const steering = new TouchSteering(sliderContainer);

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

  let activeSocket: ControllerSocket | null = null;
  startBtn.addEventListener('click', () => activeSocket?.sendEvent('start'));
  restartBtn.addEventListener('click', () => activeSocket?.sendEvent('restart'));

  function showRaceOverlay(text: string, showStart: boolean, showRestart: boolean) {
    raceOverlay.style.display = 'flex';
    raceStatusText.style.display = text ? 'block' : 'none';
    raceStatusText.textContent = text;
    startBtn.style.display = showStart ? 'block' : 'none';
    restartBtn.style.display = showRestart ? 'block' : 'none';
  }

  function hideRaceOverlay() {
    raceOverlay.style.display = 'none';
  }

  function handleRaceEvent(name: EventName) {
    switch (name) {
      case 'lobby':
        showRaceOverlay('', true, false);
        break;
      case 'countdown':
        showRaceOverlay('Get ready…', false, false);
        break;
      case 'go':
        hideRaceOverlay();
        break;
      case 'paused':
        showRaceOverlay('Paused', false, false);
        break;
      case 'finished':
        showRaceOverlay('🏁 Finished!', false, true);
        break;
      case 'restart':
        break; // a 'lobby' event immediately follows and resets the overlay
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
        steer: steering.steer,
        throttle: throttleBtn.active,
        brake: brakeBtn.active,
        drift: driftBtn.active,
        steerMode: 'touch',
      }),
      {
        onStatus: (status) => {
          const [text, color] = STATUS_STYLE[status];
          pill.textContent = text;
          pill.style.background = color;
        },
        onJoined: () => {
          showPlay();
          showRaceOverlay('', true, false); // default to the lobby/START state until an event says otherwise
        },
        onJoinError: (reason) => {
          showCodeEntry(
            reason === 'room-full'
              ? 'That room already has a controller connected.'
              : 'Room not found — check the code and try again.',
          );
        },
        onGameLeft: () => showCodeEntry('Game closed. Enter a new code to reconnect.'),
        onEvent: handleRaceEvent,
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
