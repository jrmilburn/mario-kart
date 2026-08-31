import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

const app = express();
const distDir = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distDir));
app.get('/healthz', (_req, res) => res.send('ok'));

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  socket.on('message', (data) => {
    // Phase 0: dumb echo to prove the link works end to end.
    socket.send(data.toString());
  });
});

function getLanIPv4(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIPv4();
  console.log(`[server] listening on 0.0.0.0:${PORT}`);
  console.log(`[server] LAN URL: http://${lanIp}:${PORT}`);
});
