/* GloryWave - Simple Node.js backend (server.js)

Purpose:

Provides REST endpoints to create/manage live streams and generate shareable links.

Provides WebSocket endpoints for broadcaster -> server -> listeners audio relay.

Keeps architecture simple and robust; the server relays binary audio frames from a single broadcaster to up to 200 listeners per stream.


Notes & Architecture Decisions:

This implementation relays raw binary audio frames (ArrayBuffer) without decoding/encoding on the server. That keeps the server simple, low-CPU and avoids codec licensing/complexity.

Audio processing (gain/normalizer/limiter/level meter) is best done in the broadcaster's browser using the Web Audio API where we can use built-in AnalyserNode, GainNode and DynamicsCompressorNode to implement the requested features. The client should send processed audio frames (e.g. encoded Opus or raw PCM frames) to the server.

Server supports basic auth-free streams created via REST (UUID). A production build should add auth and HTTPS.

WebSocket endpoints:

/ws/broadcast/:streamId  -> broadcaster connects here and sends binary frames; only one broadcaster allowed per stream.

/ws/listen/:streamId     -> listeners connect here and receive frames as binary messages.



How it works:

Broadcaster connects and sends a JSON 'meta' control msg first: { type: 'meta', codec: 'opus' }

Then broadcaster sends binary messages (Audio frames). Server forwards binary frames to connected listeners.

Control messages are JSON text messages. Audio transport should be binary frames.


To run:

1. npm init -y


2. npm i express ws helmet cors express-rate-limit body-parser


3. node server.js



This file contains: REST endpoints, WebSocket server, stream management, limit enforcement. */

const express = require('express'); const http = require('http'); const WebSocket = require('ws'); const crypto = require('crypto'); const helmet = require('helmet'); const cors = require('cors'); const rateLimit = require('express-rate-limit'); const bodyParser = require('body-parser');

const app = express(); app.use(helmet()); app.use(cors()); app.use(bodyParser.json({ limit: '100kb' }));

// Basic rate-limiter for REST API const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, // 15 minutes max: 300, // limit each IP }); app.use('/api/', apiLimiter);

// In-memory stream registry. For production use a persistent store. // streamId -> { id, createdAt, broadcasterSocket (ws), listeners: Set(ws), meta } const streams = new Map(); const MAX_LISTENERS_PER_STREAM = 200;

function genId() { return crypto.randomBytes(12).toString('hex'); }

// Helper to create a new stream app.post('/api/streams', (req, res) => { const id = genId(); const stream = { id, createdAt: Date.now(), broadcasterSocket: null, listeners: new Set(), meta: { title: req.body.title || 'GloryWave Live', codec: req.body.codec || 'opus', }, }; streams.set(id, stream); const shareable = /listen/${id}; res.json({ ok: true, id, shareable }); });

// Get info about stream app.get('/api/streams/:id', (req, res) => { const id = req.params.id; const s = streams.get(id); if (!s) return res.status(404).json({ ok: false, error: 'Stream not found' }); res.json({ ok: true, id: s.id, createdAt: s.createdAt, listeners: s.listeners.size, meta: s.meta, hasBroadcaster: !!s.broadcasterSocket }); });

// Close stream (terminate) app.post('/api/streams/:id/close', (req, res) => { const id = req.params.id; const s = streams.get(id); if (!s) return res.status(404).json({ ok: false, error: 'Stream not found' }); // Close sockets try { if (s.broadcasterSocket) s.broadcasterSocket.close(1000, 'Stream closed'); for (const ws of s.listeners) ws.close(1000, 'Stream closed'); } catch (e) {} streams.delete(id); res.json({ ok: true }); });

// Simple health app.get('/api/health', (req, res) => res.json({ ok: true, serverTime: Date.now() }));

// Serve a tiny landing / listener page (placeholder) - in production replace with static build app.get('/listen/:id', (req, res) => { const id = req.params.id; if (!streams.has(id)) return res.status(404).send('No such stream'); // Minimal HTML that the frontend will replace — this is just a placeholder. res.send(<html><body><h1>GloryWave</h1><p>Open the player app and connect to stream ${id}</p></body></html>); });

// Create HTTP server and attach WebSocket server const server = http.createServer(app); const wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 * 5 }); // 5MB payload cap

// Routine: forward binary frames from broadcaster to listeners function forwardToListeners(streamId, data) { const s = streams.get(streamId); if (!s) return; for (const ws of s.listeners) { if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch (e) { // if send fails, close that listener socket and remove try { ws.terminate(); } catch (ex) {} s.listeners.delete(ws); } } else { s.listeners.delete(ws); } } }

// Handle upgrade requests to route WebSocket paths server.on('upgrade', (request, socket, head) => { // Basic routing by pathname const url = new URL(request.url, http://${request.headers.host}); const pathname = url.pathname;

if (pathname.startsWith('/ws/broadcast/')) { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request, { role: 'broadcaster' }); }); } else if (pathname.startsWith('/ws/listen/')) { wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request, { role: 'listener' }); }); } else { socket.destroy(); } });

// Connection handler wss.on('connection', (ws, request, meta) => { // parse stream id from path const url = new URL(request.url, http://${request.headers.host}); const pathname = url.pathname; let parts = pathname.split('/').filter(Boolean); // e.g. ['ws','broadcast','<id>'] const role = meta.role || (parts[1] === 'broadcast' ? 'broadcaster' : 'listener'); const streamId = parts[2] || parts[1];

if (!streamId || !streams.has(streamId)) { ws.send(JSON.stringify({ type: 'error', message: 'Stream not found' })); ws.close(1008, 'Stream not found'); return; }

const stream = streams.get(streamId);

if (role === 'broadcaster') { if (stream.broadcasterSocket) { ws.send(JSON.stringify({ type: 'error', message: 'A broadcaster is already connected' })); ws.close(1013, 'Broadcaster exists'); return; }

stream.broadcasterSocket = ws;
ws.isBroadcaster = true;
console.log(`Broadcaster connected to stream ${streamId}`);

// Inform listeners that broadcaster is live
for (const l of stream.listeners) {
  if (l.readyState === WebSocket.OPEN) {
    l.send(JSON.stringify({ type: 'info', message: 'broadcaster_connected' }));
  }
}

ws.on('message', (message) => {
  // If message is text -> control message, otherwise binary -> audio frames
  if (typeof message === 'string') {
    let obj = null;
    try { obj = JSON.parse(message); } catch(e) { /* ignore */ }
    if (obj && obj.type === 'meta') {
      stream.meta = Object.assign(stream.meta || {}, obj.meta || {});
    }
    // Could implement more controls like 'markers', 'levels', etc.
    return;
  }

  // Binary audio: forward
  forwardToListeners(streamId, message);
});

ws.on('close', () => {
  console.log(`Broadcaster disconnected from ${streamId}`);
  stream.broadcasterSocket = null;
  // Notify listeners
  for (const l of stream.listeners) {
    if (l.readyState === WebSocket.OPEN) {
      l.send(JSON.stringify({ type: 'info', message: 'broadcaster_disconnected' }));
    }
  }
});

ws.on('error', (err) => {
  console.error('Broadcaster ws error', err);
  ws.terminate();
  stream.broadcasterSocket = null;
});

} else { // listener // Enforce max listeners if (stream.listeners.size >= MAX_LISTENERS_PER_STREAM) { ws.send(JSON.stringify({ type: 'error', message: 'Stream at capacity' })); ws.close(1013, 'Stream at capacity'); return; }

stream.listeners.add(ws);

// Send initial state
ws.send(JSON.stringify({ type: 'info', message: 'connected', hasBroadcaster: !!stream.broadcasterSocket }));

ws.on('message', (message) => {
  // listeners can send pings or control messages (e.g., request metadata)
  if (typeof message === 'string') {
    let obj = null;
    try { obj = JSON.parse(message); } catch (e) { }
    if (obj && obj.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  }
});

ws.on('close', () => {
  stream.listeners.delete(ws);
});

ws.on('error', (err) => {
  stream.listeners.delete(ws);
});

} });

// Periodic cleanup for old unused streams (optional) setInterval(() => { const now = Date.now(); for (const [id, s] of streams.entries()) { // if no broadcaster and no listeners for > 24 hours, drop if (!s.broadcasterSocket && s.listeners.size === 0 && now - s.createdAt > 24 * 3600 * 1000) { streams.delete(id); console.log('Pruned stream', id); } } }, 60 * 60 * 1000);

// Start server const PORT = process.env.PORT || 8080; server.listen(PORT, () => { console.log(GloryWave server listening on port ${PORT}); console.log(REST: http://localhost:${PORT}/api/streams  -> create streams); });

/* TODO / Next steps for the frontend (recommended):

Broadcaster page (browser):

Use Web Audio API to capture microphone, apply GainNode (200% boost option), DynamicsCompressorNode for limiter/normalizer, and AnalyserNode for real-time level meter.

Encode audio to Opus via MediaRecorder (mimeType: 'audio/webm;codecs=opus') or send raw PCM frames via AudioWorklet to server.

Send binary frames via WebSocket to /ws/broadcast/:streamId. Send an initial JSON meta message describing codec and sampleRate.


Listener page (browser):

Connect to /ws/listen/:streamId. Receive binary frames and decode/play them.

If audio is sent as Opus/WebM chunks from MediaRecorder, use a Media Source Extensions approach or Web Audio decodeAudioData to play.

Implement auto-reconnect strategy with exponential backoff.



Security & Production notes:

Use HTTPS/TLS. Use proper authentication for stream creation and broadcaster access.

Consider using an SFU or media server (mediasoup, Janus or Jitsi) for better WebRTC support and lower latency.

For very low-latency and good scaling, implement broadcaster -> media server (SFU) -> CDN or HLS fallback for large audiences. */


