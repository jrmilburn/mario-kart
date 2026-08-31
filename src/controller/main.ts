const app = document.getElementById('app')!;

app.innerHTML = `
  <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:16px;">
    <h1 style="font-size:32px; letter-spacing:2px;">CONTROLLER</h1>
    <div id="status-pill" style="padding:6px 16px; border-radius:999px; background:#c0392b; font-size:14px;">
      connecting…
    </div>
  </div>
`;

const pill = document.getElementById('status-pill')!;

const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${proto}://${location.host}/ws`);

socket.addEventListener('open', () => {
  pill.textContent = 'connected';
  pill.style.background = '#27ae60';
  socket.send(JSON.stringify({ type: 'hello' }));
});

socket.addEventListener('close', () => {
  pill.textContent = 'disconnected';
  pill.style.background = '#c0392b';
});

socket.addEventListener('error', () => {
  pill.textContent = 'error';
  pill.style.background = '#c0392b';
});
