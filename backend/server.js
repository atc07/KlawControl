#!/usr/bin/env node
// Klaw Control — Backend Server
// Exposes OpenClaw state + PTY terminal sessions via HTTP + WebSocket

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { authMiddleware, authWebSocket } = require('./lib/auth');
const openclaw = require('./lib/openclaw');
const terminals = require('./lib/terminals');

const PORT = process.env.KLAW_PORT || 7749;
const app = express();
const server = http.createServer(app);

// WebSocket server for terminal sessions
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(authMiddleware);

// ── Health & Status ──────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const status = openclaw.getGatewayStatus();
  res.json(status);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: 'klaw-control', uptime: process.uptime() });
});

// ── Channels ─────────────────────────────────────────────────

app.get('/api/channels', (req, res) => {
  const channels = openclaw.getChannelsStatus();
  res.json({ channels });
});

// ── Agents / Sessions ────────────────────────────────────────

app.get('/api/agents', (req, res) => {
  const data = openclaw.getSessions();
  res.json(data);
});

app.get('/api/agents/:id', (req, res) => {
  // TODO: get specific session detail + recent messages
  const data = openclaw.getSessions();
  const sessions = data.sessions || [];
  const agent = sessions.find(s => s.id === req.params.id || s.sessionKey === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

app.post('/api/agents/:id/steer', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  // TODO: integrate with openclaw sessions_send
  res.json({ status: 'sent', sessionId: req.params.id, message });
});

app.post('/api/agents/:id/kill', (req, res) => {
  // TODO: integrate with openclaw subagent kill
  res.json({ status: 'killed', sessionId: req.params.id });
});

// ── Terminals ────────────────────────────────────────────────

app.get('/api/terminals', (req, res) => {
  res.json({ terminals: terminals.list() });
});

app.post('/api/terminals', (req, res) => {
  const { name } = req.body || {};
  const session = terminals.spawn(name);
  res.status(201).json(session);
});

app.patch('/api/terminals/:sid', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const result = terminals.rename(req.params.sid, name);
  if (!result) return res.status(404).json({ error: 'Session not found' });
  res.json(result);
});

app.delete('/api/terminals/:sid', (req, res) => {
  const ok = terminals.kill(req.params.sid);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: 'killed' });
});

// ── WebSocket Upgrade (Terminal PTY) ─────────────────────────

server.on('upgrade', (req, socket, head) => {
  // Expect: /api/terminals/:sid/ws?token=xxx
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/terminals\/([^/]+)\/ws$/);

  if (!match) {
    socket.destroy();
    return;
  }

  if (!authWebSocket(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const sid = match[1];
  const session = terminals.get(sid);
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    terminals.attach(sid, ws);
  });
});

// ── Start ────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ Klaw Control backend running on http://0.0.0.0:${PORT}`);
  console.log(`   Auth: ${process.env.KLAW_AUTH_TOKEN ? 'enabled' : 'disabled (set KLAW_AUTH_TOKEN)'}`);
});
