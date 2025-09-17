/* GloryWave - Simple Node.js backend (server.js) */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');

const app = express();
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '100kb' }));

// Rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300
});
app.use('/api/', apiLimiter);

// In-memory stream registry
const streams = new Map();
const MAX_LISTENERS_PER_STREAM = 200;

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

// Create stream
app.post('/api/streams', (req, res) => {
  const id = genId();
  const stream = {
    id,
    createdAt: Date.now(),
    broadcasterSocket: null,
    listeners: new Set(),
    meta: {
      title: req.body.title || 'GloryWave Live',
      codec: req.body.codec || 'opus'
    }
  };
  streams.set(id, stream);
  const shareable = `/listen/${id}`;
  res.json({ ok: true, id, shareable });
});

// Get stream info
app.get('/api/streams/:id', (req, res) => {
  const s = streams.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Stream not found' });
  res.json({
    ok: true,
    id: s.id,
    createdAt: s.createdAt,
    listeners: s.listeners.size,
    meta: s.meta,
    hasBroadcaster: !!s.broadcasterSocket
  });
});

// Close stream
app.post('/api/streams/:id/close', (req, res) => {
  const s = streams.get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Stream not found' });
  try {
    if (s.broadcasterSocket) s.broadcasterSocket.close(1000, 'Stream closed');
    for (const ws of s.listeners) ws.close(1000, 'Stream closed');
  } catch (e) {}
  streams.delete(req.params.id);
  res.json({ ok: true });
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

// Minimal listener page
app.get('/listen/:id', (req, res) => {
  if (!streams.has(req.params.id)) return res.status(404).send('No such stream');
  res.send(`
    <html>
      <body>
        <h1>GloryWave</h1>
        <p>Open the player app and connect to stream ${req.params.id}</p>
      </body>
    </html>
  `);
});

// HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 * 5 });

// Forward frames
function forwardToListeners(streamId, data) {
  const s = streams.get(streamId);
  if (!s) return;
  for (const ws of s.listeners) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        try { ws.terminate(); } catch {}
        s.listeners.delete(ws);
      }
    } else {
      s.listeners.delete(ws);
    }
  }
}

// Handle upgrades
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/ws/broadcast/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { role: 'broadcaster' });
    });
  } else if (pathname.startsWith('/ws/listen/')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, { role: 'listener' });
    });
  } else {
    socket.destroy();
  }
});

// Connection handling
wss.on('connection', (ws, request, meta) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const role = meta.role || (parts[1] === 'broadcast' ? 'broadcaster' : 'listener');
  const streamId = parts[2] || parts[1];

  if (!streamId || !streams.has(streamId)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stream not found' }));
    ws.close(1008, 'Stream not found');
    return;
  }

  const stream = streams.get(streamId);

  if (role === 'broadcaster') {
    if (stream.broadcasterSocket) {
      ws.send(JSON.stringify({ type: 'error', message: 'Broadcaster already exists' }));
      ws.close(1013, 'Broadcaster exists');
      return;
    }
    stream.broadcasterSocket = ws;
    console.log(`Broadcaster connected to stream ${streamId}`);

    // Notify listeners
    for (const l of stream.listeners) {
      if (l.readyState === WebSocket.OPEN) {
        l.send(JSON.stringify({ type: 'info', message: 'broadcaster_connected' }));
      }
    }

    ws.on('message', (message) => {
      if (typeof message === 'string') {
        let obj = null;
        try { obj = JSON.parse(message); } catch {}
        if (obj && obj.type === 'meta') {
          stream.meta = { ...stream.meta, ...obj.meta };
        }
        return;
      }
      forwardToListeners(streamId, message);
    });

    ws.on('close', () => {
      stream.broadcasterSocket = null;
      for (const l of stream.listeners) {
        if (l.readyState === WebSocket.OPEN) {
          l.send(JSON.stringify({ type: 'info', message: 'broadcaster_disconnected' }));
        }
      }
    });

    ws.on('error', () => {
      stream.broadcasterSocket = null;
    });

  } else {
    if (stream.listeners.size >= MAX_LISTENERS_PER_STREAM) {
      ws.send(JSON.stringify({ type: 'error', message: 'Stream at capacity' }));
      ws.close(1013, 'Stream at capacity');
      return;
    }
    stream.listeners.add(ws);
    ws.send(JSON.stringify({ type: 'info', message: 'connected', hasBroadcaster: !!stream.broadcasterSocket }));

    ws.on('message', (msg) => {
      if (typeof msg === 'string') {
        let obj = null;
        try { obj = JSON.parse(msg); } catch {}
        if (obj && obj.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      }
    });

    ws.on('close', () => stream.listeners.delete(ws));
    ws.on('error', () => stream.listeners.delete(ws));
  }
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of streams.entries()) {
    if (!s.broadcasterSocket && s.listeners.size === 0 && now - s.createdAt > 24 * 3600 * 1000) {
      streams.delete(id);
      console.log('Pruned stream', id);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`GloryWave backend running on port ${PORT}`);
});