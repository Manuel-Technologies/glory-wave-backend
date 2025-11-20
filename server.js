// server.js - GloryWave Production Backend v2
// One-file, battle-tested, secure, observable

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const promBundle = require('express-prom-bundle');

const app = express();
const server = http.createServer(app);

// === Security & Performance Middleware ===
app.set('trust proxy', 1); // Important if behind reverse proxy (e.g. Nginx, Cloudflare)

app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || true,
  credentials: true
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));

// Logging
app.use(morgan('combined'));

// Prometheus metrics
const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  metricsPath: '/metrics',
  promClient: { collectDefaultMetrics: {} }
});
app.use(metricsMiddleware);

// Rate limiting - aggressive per IP
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,   // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(globalLimiter);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// === In-memory Stream Registry (with TTL & size limits) ===
const streams = new Map();
const MAX_LISTENERS_PER_STREAM = parseInt(process.env.MAX_LISTENERS) || 250;
const MAX_STREAM_IDLE_MINUTES = 30; // Auto-delete idle streams
const MAX_STREAM_AGE_HOURS = 48;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Every 5 mins

function generateStreamId() {
  return crypto.randomBytes(16).toString('hex');
}

function pruneStream(id) {
  const stream = streams.get(id);
  if (!stream) return;

  try {
    if (stream.broadcasterSocket?.readyState === WebSocket.OPEN) {
      stream.broadcasterSocket.close(1001, 'Stream pruned');
    }
    for (const listener of stream.listeners) {
      if (listener.readyState === WebSocket.OPEN) {
        listener.close(1001, 'Stream ended');
      }
    }
  } catch (err) {
    console.error(`Error closing stream ${id}:`, err);
  } finally {
    streams.delete(id);
    console.log(`Pruned stream ${id}`);
  }
}

// === REST API Routes ===
app.post('/api/streams', (req, res) => {
  const { title, codec } = req.body || {};
  if (title && typeof title !== 'string') return res.status(400).json({ ok: false, error: 'Invalid title' });

  const id = generateStreamId();
  const now = Date.now();

  streams.set(id, {
    id,
    createdAt: now,
    lastActive: now,
    broadcasterSocket: null,
    listeners: new Set(),
    meta: {
      title: (title || 'GloryWave Live').substring(0, 100),
      codec: codec === 'opus' || codec === 'aac' ? codec : 'opus'
    }
  });

  res.json({
    ok: true,
    id,
    shareable: `${process.env.BASE_URL || ''}/listen/${id}`
  });
});

app.get('/api/streams/:id', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'Stream not found' });

  stream.lastActive = Date.now(); // Keep alive on read

  res.json({
    ok: true,
    id: stream.id,
    listeners: stream.listeners.size,
    hasBroadcaster: !!stream.broadcasterSocket,
    meta: stream.meta,
    uptime: Math.floor((Date.now() - stream.createdAt) / 1000)
  });
});

app.post('/api/streams/:id/close', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ ok: false, error: 'Stream not found' });

  pruneStream(req.params.id);
  res.json({ ok: true, message: 'Stream closed' });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    activeStreams: streams.size,
    uptime: process.uptime()
  });
});

app.get('/listen/:id', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) {
    return res.status(404).send(`
      <h1>Stream Offline</h1>
      <p>This GloryWave stream does not exist or has ended.</p>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>${stream.meta.title} • GloryWave</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: system-ui, sans-serif; text-align: center; margin: 4rem; background: #0d0d0d; color: #fff; }
        h1 { font-size: 2.5rem; margin: 2rem 0; background: linear-gradient(90deg, #ff6ec4, #7873f5); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .id { font-family: monospace; background: #1a1a1a; padding: 1rem; border-radius: 8px; font-size: 1.5rem; display: inline-block; margin: 2rem; }
      </style>
    </head>
    <body>
      <h1>${stream.meta.title}</h1>
      <p>Listeners: <strong>${stream.listeners.size}</strong></p>
      <div class="id">${req.params.id}</div>
      <p>Open your GloryWave app and connect!</p>
    </body>
    </html>
  `);
});

// === WebSocket Server ===
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: 5 * 1024 * 1024, // 5MB max per message
  backlog: 100,
  skipUTF8Validation: false
});

function heartbeat() {
  this.isAlive = true;
}

function forwardToListeners(stream, data) {
  if (!stream || stream.listeners.size === 0) return;

  let dead = 0;
  for (const ws of stream.listeners) {
    if (ws.isAlive === false) {
      ws.terminate();
      stream.listeners.delete(ws);
      dead++;
      continue;
    }

    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data, { binary: true, compress: false });
      } catch (err) {
        ws.terminate();
        stream.listeners.delete(ws);
        dead++;
      }
    } else {
      stream.listeners.delete(ws);
      dead++;
    }
  }

  if (dead > 0) {
    stream.lastActive = Date.now();
  }
}

// Handle WebSocket upgrades
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (pathname.startsWith('/ws/broadcast/') || pathname.startsWith('/ws/listen/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const parts = pathname.split('/').filter(Boolean);
  const role = parts[1]; // 'broadcast' or 'listen'
  const streamId = parts[2];

  if (!streamId || !streams.has(streamId)) {
    ws.close(1008, 'Stream not found');
    return;
  }

  const stream = streams.get(streamId);
  stream.lastActive = Date.now();

  ws.isAlive = true;
  ws.on('pong', heartbeat);

  if (role === 'broadcast') {
    if (stream.broadcasterSocket) {
      ws.close(1013, 'Broadcaster already connected');
      return;
    }

    stream.broadcasterSocket = ws;
    console.log(`Broadcaster connected → ${streamId} (${stream.listeners.size} listeners)`);

    ws.send(JSON.stringify({ type: 'welcome', role: 'broadcaster' }));

    // Notify listeners
    for (const l of stream.listeners) {
      if (l.readyState === WebSocket.OPEN) {
        l.send(JSON.stringify({ type: 'info', event: 'broadcaster_connected' }));
      }
    }

    ws.on('message', (data) => {
      stream.lastActive = Date.now();

      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'meta' && msg.meta) {
            stream.meta = { ...stream.meta, ...msg.meta };
            for (const l of stream.listeners) {
              if (l.readyState === WebSocket.OPEN) {
                l.send(JSON.stringify({ type: 'meta', meta: stream.meta }));
              }
            }
          }
        } catch {}
        return;
      }

      forwardToListeners(stream, data);
    });

    ws.on('close', () => {
      if (stream.broadcasterSocket === ws) {
        stream.broadcasterSocket = null;
        for (const l of stream.listeners) {
          if (l.readyState === WebSocket.OPEN) {
            l.send(JSON.stringify({ type: 'info', event: 'broadcaster_disconnected' }));
          }
        }
      }
    });

  } else if (role === 'listen') {
    if (stream.listeners.size >= MAX_LISTENERS_PER_STREAM) {
      ws.close(1013, 'Stream full');
      return;
    }

    stream.listeners.add(ws);
    ws.send(JSON.stringify({
      type: 'connected',
      hasBroadcaster: !!stream.broadcasterSocket,
      meta: stream.meta
    }));

    ws.on('message', (msg) => {
      if (msg.toString() === 'ping') {
        ws.send('pong');
      }
    });

    ws.on('close', () => stream.listeners.delete(ws));
  }
});

// === Heartbeat & Cleanup ===
const interval = setInterval(() => {
  const now = Date.now();

  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });

  // Prune dead streams
  for (const [id, stream] of streams.entries()) {
    const idleMinutes = (now - stream.lastActive) / (1000 * 60);
    const ageHours = (now - stream.createdAt) / (1000 * 60 * 60);

    if (
      (!stream.broadcasterSocket && stream.listeners.size === 0) ||
      idleMinutes > MAX_STREAM_IDLE_MINUTES ||
      ageHours > MAX_STREAM_AGE_HOURS
    ) {
      pruneStream(id);
    }
  }
}, CLEANUP_INTERVAL_MS);

wss.on('close', () => clearInterval(interval));

// === Graceful Shutdown ===
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  console.log('Shutting down gracefully...');
  server.close(() => {
    wss.close();
    console.log('Server stopped.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forcing exit...');
    process.exit(1);
  }, 10000);
}

// === Start Server ===
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GloryWave Production Server Running`);
  console.log(`→ Port: ${PORT}`);
  console.log(`→ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`→ Max listeners per stream: ${MAX_LISTENERS_PER_STREAM}`);
});

module.exports = app;
