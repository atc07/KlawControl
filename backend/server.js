#!/usr/bin/env node
// Klaw Control — Backend Server
// Exposes OpenClaw state + PTY terminal sessions via HTTP + WebSocket

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { authMiddleware, authWebSocket, TOKEN } = require('./lib/auth');
const openclaw = require('./lib/openclaw');
const terminals = require('./lib/terminals');
const metrics = require('./lib/metrics');
const voiceRealtime = require('./lib/voice-realtime');
const { CHANNEL_NAMES, CHANNEL_KEYWORDS, resolveTargetSession } = require('./lib/voice-routing');

const PORT = process.env.KLAW_PORT || 7749;
const SESSIONS_CACHE_TTL_MS = parseInt(process.env.KLAW_SESSIONS_CACHE_TTL_MS || '5000', 10);

// Keep the process alive on unexpected async errors instead of crashing mid-session.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
});

let sessionsCache = { ts: 0, data: { sessions: [] } };
let metricsInterval = null;

function getCachedSessions() {
  const now = Date.now();
  if (now - sessionsCache.ts <= SESSIONS_CACHE_TTL_MS) {
    return sessionsCache.data;
  }

  const fresh = openclaw.getSessions();
  sessionsCache = { ts: now, data: fresh };
  return fresh;
}

const app = express();
const server = http.createServer(app);

// WebSocket servers
const terminalWss = new WebSocketServer({ noServer: true });
const voiceWss = new WebSocketServer({ noServer: true });
const codexWss = new WebSocketServer({ noServer: true });
const claudeWss = new WebSocketServer({ noServer: true });
const p2pRuntime = {
  completePairing: null,
  tunnel: null,
};

// Fix #8: Add CORS middleware to backend with explicit audio file headers
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms [${req.ip}]`);
  });
  next();
});

app.use(authMiddleware);

// ── Pairing ───────────────────────────────────────────────────

app.post('/api/p2p/pair', async (req, res) => {
  const peerPublicKey = req.body?.peerPublicKey;
  if (!peerPublicKey || typeof peerPublicKey !== 'string') {
    return res.status(400).json({ error: 'peerPublicKey required' });
  }
  if (!p2pRuntime.completePairing) {
    return res.status(503).json({ error: 'P2P runtime not ready' });
  }

  try {
    const result = await p2pRuntime.completePairing({ peerPublicKey });
    if (result?.tunnel) {
      p2pRuntime.tunnel = result.tunnel;
    }
    res.json({
      status: 'ok',
      pairedNow: !!result?.pairedNow,
      tunnelReady: !!result?.tunnel,
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Pairing failed' });
  }
});

// ── Health & Status ──────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const status = openclaw.getGatewayStatus();
  res.json(status);
});

// Fast health check - doesn't call external commands (those are slow!)
app.get('/api/health', (req, res) => {
  // Quick check: server is running and responding
  // Don't call openclaw status/channels - those take 3+ seconds and cause iOS timeouts
  res.json({
    status: 'ok',
    server: 'klaw-control',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Detailed health check - called less frequently by iOS
app.get('/api/health/detailed', (req, res) => {
  const gatewayStatus = openclaw.getGatewayStatus();
  const channelStatus = openclaw.getChannelsStatus();
  const allHealthy = gatewayStatus.isOk !== false &&
    channelStatus.every(ch => ch.state !== 'error');

  res.json({
    status: allHealthy ? 'ok' : 'degraded',
    server: 'klaw-control',
    uptime: process.uptime(),
    gateway: gatewayStatus.isOk ? 'ok' : 'down',
    channels: channelStatus.map(ch => ({
      id: ch.id,
      state: ch.state || 'unknown',
    })),
    alerts: channelStatus
      .filter(ch => ch.state === 'error' || ch.state === 'disconnected')
      .map(ch => `${ch.id} is ${ch.state}`),
  });
});

// ── Channels ─────────────────────────────────────────────────

app.get('/api/channels', (req, res) => {
  const channels = openclaw.getChannelsStatus();
  res.json({ channels });
});

// ── Agents / Sessions ────────────────────────────────────────

app.get('/api/agents', (req, res) => {
  const data = getCachedSessions();
  res.json(data);
});

app.get('/api/agents/:id', (req, res) => {
  const data = getCachedSessions();
  const sessions = data.sessions || [];
  const agent = sessions.find(s => s.id === req.params.id || s.sessionKey === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

// Session message history
app.get('/api/sessions/:key/messages', (req, res) => {
  const sessionKey = decodeURIComponent(req.params.key);
  const limit = parseInt(req.query.limit) || 20;
  const messages = openclaw.getSessionMessages(sessionKey, limit);
  res.json({ messages });
});

// ── Metrics ──────────────────────────────────────────────────

app.get('/api/metrics/tokens', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const history = metrics.getTokenHistory(hours);
  const burnRate = metrics.getTokenBurnRate(hours);
  res.json({ history, burnRate });
});

app.get('/api/metrics/cost', (req, res) => {
  const data = getCachedSessions();
  const sessions = data.sessions || [];
  const estimatedCost = metrics.estimateCost(sessions);
  const totalTokens = sessions.reduce((sum, s) => sum + (s.tokensUsed || 0), 0);
  res.json({
    estimatedCostUSD: estimatedCost,
    totalTokens,
    sessionCount: sessions.length,
    activeSessions: sessions.filter(s => s.status === 'active').length,
  });
});

// ── Sub-agents ───────────────────────────────────────────────

app.get('/api/subagents', (req, res) => {
  const data = openclaw.getSubAgents();
  res.json(data);
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

// ── Voice Clone ──────────────────────────────────────────────

const voiceClone = require('./lib/voice-clone');

// Download audio + get waveform
app.post('/api/voice/clone/download', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const result = await voiceClone.downloadAudio(url);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trim and save reference clip
app.post('/api/voice/clone/trim', async (req, res) => {
  const { startSec, endSec } = req.body;
  if (startSec === undefined || endSec === undefined) {
    return res.status(400).json({ error: 'startSec and endSec required' });
  }
  try {
    const result = await voiceClone.trimAndSave(startSec, endSec);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trim, analyze, and return readiness diagnostics for activation gating.
app.post('/api/voice/clone/analyze', async (req, res) => {
  const { startSec, endSec } = req.body;
  if (startSec === undefined || endSec === undefined) {
    return res.status(400).json({ error: 'startSec and endSec required' });
  }

  const startedAt = Date.now();
  try {
    const trim = await voiceClone.trimAndSave(startSec, endSec);
    const analysis = voiceClone.analyzeReference();
    const durationMs = Date.now() - startedAt;
    const failReasons = (analysis.recommendations || []).slice(0, 2).join(' | ') || 'none';
    console.log(`[voice-clone] analyze ready=${analysis.ready} latency_ms=${durationMs} fail_reason=${failReasons}`);
    res.json({
      status: 'ok',
      ...analysis,
      trim,
      metricsMeta: {
        voice_clone_analyze_ms: durationMs,
        voice_clone_ready: analysis.ready,
        voice_clone_fail_reason: failReasons,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Preview TTS with cloned voice
app.post('/api/voice/clone/preview', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const result = await voiceClone.previewTTS(text);
    // Send the audio file directly
    res.sendFile(result.filePath);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download the trimmed reference clip for on-device clone preview/runtime.
app.get('/api/voice/clone/reference', (req, res) => {
  const referencePath = voiceClone.getReferenceAudioPath();
  if (!referencePath) {
    return res.status(404).json({ error: 'No voice reference. Trim a clip first.' });
  }
  res.sendFile(referencePath);
});

// Voicebox reachability + model readiness check used by the iOS app before starting a clone session.
app.get('/api/voice/clone/readiness', async (req, res) => {
  const voiceboxUrl = process.env.VOICEBOX_URL || 'http://127.0.0.1:17493';
  const startedAt = Date.now();

  let health = null;
  let reachable = false;
  try {
    const raw = await new Promise((resolve, reject) => {
      const mod = voiceboxUrl.startsWith('https') ? require('https') : require('http');
      const req = mod.get(`${voiceboxUrl}/health`, { timeout: 3000 }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    health = JSON.parse(raw);
    reachable = true;
  } catch (_) {}

  const latencyMs = Date.now() - startedAt;
  const healthy = reachable && health?.status === 'healthy';
  const modelLoaded = reachable && health?.model_loaded === true;
  const modelSize = health?.model_size ?? null;

  res.json({
    ready: healthy && modelLoaded,
    checks: {
      voicebox: {
        reachable,
        healthy,
        model_loaded: modelLoaded,
        model_size: modelSize,
        latency_ms: latencyMs,
        url: voiceboxUrl,
      },
    },
  });
});

// Legacy one-shot clone
app.post('/api/voice/clone', async (req, res) => {
  const { url, startSec, durationSec } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await voiceClone.cloneFromURL(url, {
      startSec: startSec || null,
      durationSec: durationSec || 10,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/voice/clone/status', (req, res) => {
  res.json(voiceClone.getStatus());
});

app.delete('/api/voice/clone', (req, res) => {
  voiceClone.clearClone();
  res.json({ status: 'cleared' });
});

// ── Voice ────────────────────────────────────────────────────

// Voice message — routes to correct channel, returns spoken + text response
app.post('/api/voice/message', async (req, res) => {
  const { text, sessionKey: explicitSession } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const route = resolveTargetSession(text, explicitSession);
  const targetSession = route.sessionKey;
  const channelName = route.channelName;

  try {
    // Send to the target session through the supported OpenClaw CLI entry point.
    const { execFileSync } = require('child_process');
    const args = openclaw.buildAgentSendArgs(targetSession, text, {
      timeoutSeconds: 30,
      json: true,
    });
    const result = execFileSync('openclaw', args, {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let response;
    try {
      response = JSON.parse(result);
    } catch {
      response = result.trim();
    }

    const reply = openclaw.extractReplyText(response) || result.trim();

    // Generate short spoken summary (first 200 chars or first sentence)
    const spokenReply = reply.length > 200
      ? reply.split(/[.!?]\s/)[0] + '.'
      : reply;

    res.json({
      spokenReply,
      fullReply: reply,
      channel: channelName,
      sessionKey: targetSession,
      routed: route.routed,
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
      channel: channelName,
    });
  }
});

// List available channels for voice routing
app.get('/api/voice/channels', (req, res) => {
  const channels = Object.entries(CHANNEL_NAMES).map(([key, name]) => ({
    sessionKey: key,
    name,
    keywords: Object.entries(CHANNEL_KEYWORDS)
      .filter(([, v]) => v === key)
      .map(([k]) => k),
  }));
  res.json({ channels });
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

// ── Codex Control ────────────────────────────────────────────

const { manager: codexManager } = require('./lib/codex');

// Cached health info — refreshed at startup.
let codexHealthCache = { installed: false, binary: null, version: null, error: 'not checked yet' };

// GET /api/codex/health — on-demand detection.
app.get('/api/codex/health', async (req, res) => {
  try {
    const health = await codexManager.getHealth();
    codexHealthCache = health;
    res.json(health);
  } catch (err) {
    res.status(500).json({ installed: false, binary: null, version: null, error: err.message || 'health check failed' });
  }
});

// List available projects (git repos)
app.get('/api/codex/projects', (req, res) => {
  const projects = codexManager.discoverProjects();
  res.json({ projects });
});

// Create a new Codex session for a project
app.post('/api/codex/projects/:projectId/session', (req, res) => {
  const projects = codexManager.discoverProjects();
  const project = projects.find(p => p.id === req.params.projectId || p.path === req.params.projectId);
  
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const session = codexManager.createSession(project.path);
  res.status(201).json({
    id: session.id,
    projectName: session.projectName,
    projectPath: session.projectPath,
    branch: session.branch,
    status: session.status,
    createdAt: session.createdAt,
  });
});

// Get git status for a project
app.get('/api/codex/projects/:projectId/status', (req, res) => {
  const projects = codexManager.discoverProjects();
  const project = projects.find(p => p.id === req.params.projectId || p.path === req.params.projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const gitStatus = codexManager.getGitStatus(project.path);
  res.json({
    projectId: project.id,
    projectName: project.name,
    branch: codexManager.getGitBranch(project.path) || 'main',
    ...gitStatus,
  });
});

// List active Codex sessions
app.get('/api/codex/sessions', (req, res) => {
  const sessions = codexManager.listSessions();
  res.json({ sessions });
});

// Get single session status
app.get('/api/codex/sessions/:id/status', (req, res) => {
  const session = codexManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    id: session.id,
    projectName: session.projectName,
    projectPath: session.projectPath,
    branch: session.branch,
    status: session.status,
    createdAt: session.createdAt,
    messageCount: session.messages.length,
    pendingActionsCount: session.pendingActions.length,
  });
});

// Get session history
app.get('/api/codex/sessions/:id/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const history = codexManager.getHistory(req.params.id, limit);
  res.json({ history });
});

// Get git diff for session
app.get('/api/codex/sessions/:id/diff', (req, res) => {
  const session = codexManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const diff = codexManager.getGitDiff(session.projectPath, req.query.filePath);
  res.json({ diff, sessionId: req.params.id });
});

// Send prompt to Codex (HTTP endpoint for simple prompts)
app.post('/api/codex/sessions/:id/send', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const session = codexManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // For HTTP, just return immediately (real execution happens over WebSocket)
  // The client should use WebSocket for streaming output
  try {
    // Just validate and add to queue
    codexManager.addMessage(req.params.id, 'user', prompt);
    res.json({
      sessionId: req.params.id,
      status: 'queued',
      message: 'Connect via WebSocket to stream results',
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Approve action
app.post('/api/codex/sessions/:id/approve', (req, res) => {
  const { actionId } = req.body;
  if (!actionId) {
    return res.status(400).json({ error: 'actionId required' });
  }

  const action = codexManager.approveAction(req.params.id, actionId);
  if (!action) {
    return res.status(404).json({ error: 'Action not found' });
  }

  res.json({ status: 'approved', action });
});

// Reject action
app.post('/api/codex/sessions/:id/reject', (req, res) => {
  const { actionId, reason } = req.body;
  if (!actionId) {
    return res.status(400).json({ error: 'actionId required' });
  }

  const action = codexManager.rejectAction(req.params.id, actionId, reason || 'User rejected');
  if (!action) {
    return res.status(404).json({ error: 'Action not found' });
  }

  res.json({ status: 'rejected', action });
});

// Kill session
app.delete('/api/codex/sessions/:id', (req, res) => {
  const ok = codexManager.killSession(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ status: 'killed' });
});

// Register an arbitrary absolute path as a Codex project.
app.post('/api/codex/projects/open', (req, res) => {
  const { path: projectPath } = req.body || {};
  if (!projectPath || typeof projectPath !== 'string') {
    return res.status(400).json({ error: 'path required' });
  }
  try {
    const project = codexManager.registerProject(projectPath);
    // Register with claude manager too so it shows up there.
    try {
      claudeManager.registerProject(projectPath);
    } catch (err) {
      console.error('[claude] registerProject mirror failed:', err.message);
    }
    res.status(201).json(project);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Claude Code Control ──────────────────────────────────────

const { spawn: childSpawn } = require('child_process');
const { manager: claudeManager } = require('./lib/claude-code');

// Cached health info — refreshed at startup and after a successful install.
let claudeHealthCache = { installed: false, binary: null, version: null, error: 'not checked yet' };

// In-memory state for the most recent `npm install -g` run. We keep only the
// last run so the iOS client can poll /status after starting an install.
const INSTALL_LOG_CAP = 10 * 1024; // 10KB per stream
const claudeInstallState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  stdout: '',
  stderr: '',
};

function appendCapped(existing, chunk) {
  const next = existing + chunk;
  if (next.length <= INSTALL_LOG_CAP) return next;
  return next.slice(next.length - INSTALL_LOG_CAP);
}

function npmAvailable() {
  try {
    require('child_process').execSync('which npm', { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

// GET /api/claude/health — on-demand detection for the iOS client.
app.get('/api/claude/health', async (req, res) => {
  try {
    const health = await claudeManager.getHealth();
    claudeHealthCache = health;
    res.json(health);
  } catch (err) {
    res.status(500).json({ installed: false, binary: null, version: null, error: err.message || 'health check failed' });
  }
});

// POST /api/claude/install — kicks off `npm install -g @anthropic-ai/claude-code`
// as a background child process. Returns 202 immediately; progress is polled via
// GET /api/claude/install/status.
app.post('/api/claude/install', (req, res) => {
  if (claudeInstallState.running) {
    return res.status(409).json({ error: 'install already running', state: publicInstallState() });
  }
  if (!npmAvailable()) {
    return res.status(500).json({ error: 'npm not found' });
  }

  claudeInstallState.running = true;
  claudeInstallState.startedAt = new Date().toISOString();
  claudeInstallState.finishedAt = null;
  claudeInstallState.exitCode = null;
  claudeInstallState.stdout = '';
  claudeInstallState.stderr = '';

  console.log('[claude-install] starting: npm install -g @anthropic-ai/claude-code');

  let proc;
  try {
    proc = childSpawn('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    claudeInstallState.running = false;
    claudeInstallState.finishedAt = new Date().toISOString();
    claudeInstallState.exitCode = -1;
    claudeInstallState.stderr = err.message || 'spawn failed';
    console.error('[claude-install] spawn failed:', err.message);
    return res.status(500).json({ error: 'failed to spawn npm', details: err.message });
  }

  proc.on('error', (err) => {
    console.error('[claude-install] process error:', err.message);
    claudeInstallState.stderr = appendCapped(claudeInstallState.stderr, `\n${err.message}`);
  });
  proc.stdout.on('data', (chunk) => {
    claudeInstallState.stdout = appendCapped(claudeInstallState.stdout, chunk.toString());
  });
  proc.stderr.on('data', (chunk) => {
    claudeInstallState.stderr = appendCapped(claudeInstallState.stderr, chunk.toString());
  });
  proc.on('close', async (code) => {
    claudeInstallState.running = false;
    claudeInstallState.finishedAt = new Date().toISOString();
    claudeInstallState.exitCode = code;
    console.log(`[claude-install] finished with exit code ${code}`);

    // Refresh cached health so subsequent /health calls (and the iOS UI) see
    // the new binary path immediately.
    try {
      claudeHealthCache = await claudeManager.getHealth();
      if (claudeHealthCache.installed) {
        console.log(`[claude-install] claude now detected at ${claudeHealthCache.binary} (${claudeHealthCache.version || 'unknown version'})`);
      } else {
        console.log(`[claude-install] claude still not detected after install: ${claudeHealthCache.error}`);
      }
    } catch (err) {
      console.error('[claude-install] post-install health refresh failed:', err.message);
    }
  });

  res.status(202).json({ status: 'started', startedAt: claudeInstallState.startedAt });
});

function publicInstallState() {
  return {
    running: claudeInstallState.running,
    startedAt: claudeInstallState.startedAt,
    finishedAt: claudeInstallState.finishedAt,
    exitCode: claudeInstallState.exitCode,
    stdout: claudeInstallState.stdout,
    stderr: claudeInstallState.stderr,
  };
}

// GET /api/claude/install/status — poll endpoint for the active / most recent install.
app.get('/api/claude/install/status', (req, res) => {
  res.json(publicInstallState());
});

// List available projects for Claude Code (same filesystem scan as Codex).
app.get('/api/claude/projects', (req, res) => {
  const projects = claudeManager.discoverProjects();
  res.json({ projects });
});

// Create a new Claude Code session for a project.
app.post('/api/claude/projects/:projectId/session', (req, res) => {
  const projects = claudeManager.discoverProjects();
  const project = projects.find(p => p.id === req.params.projectId || p.path === req.params.projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const session = claudeManager.createSession(project.path);
  res.status(201).json({
    id: session.id,
    projectName: session.projectName,
    projectPath: session.projectPath,
    branch: session.branch,
    status: session.status,
    createdAt: session.createdAt,
  });
});

// List active Claude Code sessions.
app.get('/api/claude/sessions', (req, res) => {
  const sessions = claudeManager.listSessions();
  res.json({ sessions });
});

// Get single session status.
app.get('/api/claude/sessions/:id/status', (req, res) => {
  const session = claudeManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    id: session.id,
    projectName: session.projectName,
    projectPath: session.projectPath,
    branch: session.branch,
    status: session.status,
    createdAt: session.createdAt,
    messageCount: session.messages.length,
    pendingActionsCount: session.pendingActions.length,
  });
});

// Get session history.
app.get('/api/claude/sessions/:id/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const history = claudeManager.getHistory(req.params.id, limit);
  res.json({ history });
});

// Send prompt (HTTP queue; streaming happens over WebSocket).
app.post('/api/claude/sessions/:id/send', (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const session = claudeManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    claudeManager.addMessage(req.params.id, 'user', prompt);
    res.json({
      sessionId: req.params.id,
      status: 'queued',
      message: 'Connect via WebSocket to stream results',
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Kill session.
app.delete('/api/claude/sessions/:id', (req, res) => {
  const ok = claudeManager.killSession(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ status: 'killed' });
});

// ── Filesystem Browse ────────────────────────────────────────

const fsMod = require('fs');
const pathMod = require('path');
const osMod = require('os');
const codexConfig = require('./lib/codex-config');

app.get('/api/fs/browse', (req, res) => {
  const home = osMod.homedir();
  const requested = typeof req.query.path === 'string' && req.query.path.length > 0
    ? req.query.path
    : home;
  const showHidden = req.query.showHidden === 'true' || req.query.showHidden === '1';

  let resolved;
  try {
    resolved = pathMod.resolve(requested);
  } catch (err) {
    return res.status(400).json({ error: 'invalid path' });
  }

  const allowedRoots = [home, ...(codexConfig.projectPaths || [])].map(p => pathMod.resolve(p));
  const withinAllowed = allowedRoots.some((root) => {
    return resolved === root || resolved.startsWith(root + pathMod.sep);
  });
  if (!withinAllowed) {
    return res.status(404).json({ error: 'path not allowed' });
  }

  let entries;
  try {
    const stat = fsMod.statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(404).json({ error: 'not a directory' });
    }
    entries = fsMod.readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }

  const items = [];
  for (const entry of entries) {
    const hidden = entry.name.startsWith('.');
    if (hidden && !showHidden) continue;

    const isDirectory = entry.isDirectory();
    let isGitRepo = false;
    if (isDirectory) {
      try {
        isGitRepo = fsMod.existsSync(pathMod.join(resolved, entry.name, '.git'));
      } catch {
        isGitRepo = false;
      }
    }

    items.push({
      name: entry.name,
      isDirectory,
      isGitRepo,
      hidden,
    });
  }

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const parent = pathMod.dirname(resolved);

  res.json({
    path: resolved,
    parent: parent === resolved ? null : parent,
    entries: items,
  });
});

// ── Codex WebSocket Handler ───────────────────────────────────

function handleCodexWebSocket(sessionId, ws) {
  const session = codexManager.getSession(sessionId);
  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  console.log(`[codex-ws] Client connected to session ${sessionId}`);

  // Subscribe to session
  codexManager.subscribe(sessionId, ws);

  // Handle incoming messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'prompt': {
          if (!message.text) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'prompt text required',
            }));
            break;
          }

          // Execute prompt asynchronously
          try {
            await codexManager.executePrompt(sessionId, message.text);
          } catch (error) {
            console.error(`[codex-ws] Prompt execution failed:`, error.message);
            // Error is already broadcast to subscribers by executePrompt
          }
          break;
        }

        case 'approve': {
          if (!message.actionId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'actionId required',
            }));
            break;
          }

          const action = codexManager.approveAction(sessionId, message.actionId);
          if (!action) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Action not found',
            }));
          }
          break;
        }

        case 'reject': {
          if (!message.actionId) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'actionId required',
            }));
            break;
          }

          const action = codexManager.rejectAction(sessionId, message.actionId, message.reason || '');
          if (!action) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Action not found',
            }));
          }
          break;
        }

        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${message.type}`,
          }));
      }
    } catch (error) {
      console.error(`[codex-ws] Message parsing error:`, error.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to parse message',
      }));
    }
  });

  ws.on('close', () => {
    console.log(`[codex-ws] Client disconnected from session ${sessionId}`);
    codexManager.unsubscribe(sessionId, ws);
  });

  ws.on('error', (error) => {
    console.error(`[codex-ws] WebSocket error:`, error.message);
  });
}

// ── Claude Code WebSocket Handler ─────────────────────────────

function handleClaudeWebSocket(sessionId, ws) {
  const session = claudeManager.getSession(sessionId);
  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  console.log(`[claude-ws] Client connected to session ${sessionId}`);

  claudeManager.subscribe(sessionId, ws);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'prompt': {
          if (!message.text) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'prompt text required',
            }));
            break;
          }

          try {
            await claudeManager.executePrompt(sessionId, message.text);
          } catch (error) {
            console.error(`[claude-ws] Prompt execution failed:`, error.message);
            // Error is already broadcast to subscribers by executePrompt.
          }
          break;
        }

        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${message.type}`,
          }));
      }
    } catch (error) {
      console.error(`[claude-ws] Message parsing error:`, error.message);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to parse message',
      }));
    }
  });

  ws.on('close', () => {
    console.log(`[claude-ws] Client disconnected from session ${sessionId}`);
    claudeManager.unsubscribe(sessionId, ws);
  });

  ws.on('error', (error) => {
    console.error(`[claude-ws] WebSocket error:`, error.message);
  });
}

// ── WebSocket Upgrade ─────────────────────────────────────────

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  console.log(`[upgrade] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  
  if (!authWebSocket(req)) {
    console.log(`[upgrade] 401 Unauthorized: missing or invalid token for ${url.pathname}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const terminalMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)\/ws$/);
  if (terminalMatch) {
    const sid = terminalMatch[1];
    console.log(`[upgrade] Terminal WebSocket requested for SID: ${sid.slice(0, 8)}...`);
    const session = terminals.get(sid);
    if (!session) {
      console.log(`[upgrade] 404 Terminal not found: ${sid}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`[upgrade] ✅ Terminal upgrade OK for ${sid.slice(0, 8)}...`);
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[terminal-ws] Connected: ${sid.slice(0, 8)}...`);
      terminals.attach(sid, ws);
    });
    return;
  }

  if (url.pathname === '/api/voice/realtime') {
    console.log(`[upgrade] Voice realtime WebSocket requested`);
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[voice-ws] Connected`);
      voiceRealtime.handleConnection(ws);
    });
    return;
  }

  const codexMatch = url.pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/stream$/);
  if (codexMatch) {
    const sessionId = codexMatch[1];
    console.log(`[upgrade] Codex WebSocket requested for session: ${sessionId.slice(0, 8)}...`);
    const session = codexManager.getSession(sessionId);
    if (!session) {
      console.log(`[upgrade] 404 Codex session not found: ${sessionId}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`[upgrade] ✅ Codex upgrade OK for ${sessionId.slice(0, 8)}...`);
    codexWss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[codex-ws] Connected: ${sessionId.slice(0, 8)}...`);
      handleCodexWebSocket(sessionId, ws);
    });
    return;
  }

  const claudeMatch = url.pathname.match(/^\/api\/claude\/sessions\/([^/]+)\/stream$/);
  if (claudeMatch) {
    const sessionId = claudeMatch[1];
    console.log(`[upgrade] Claude WebSocket requested for session: ${sessionId.slice(0, 8)}...`);
    const session = claudeManager.getSession(sessionId);
    if (!session) {
      console.log(`[upgrade] 404 Claude session not found: ${sessionId}`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`[upgrade] ✅ Claude upgrade OK for ${sessionId.slice(0, 8)}...`);
    claudeWss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[claude-ws] Connected: ${sessionId.slice(0, 8)}...`);
      handleClaudeWebSocket(sessionId, ws);
    });
    return;
  }

  console.log(`[upgrade] ⚠️  No handler for: ${url.pathname}`);
  socket.destroy();
});

// ── Start ────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', async () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const localIP = Object.values(nets).flat().find(n => n.family === 'IPv4' && !n.internal)?.address || 'unknown';

  // Record metrics every 5 minutes
  metricsInterval = setInterval(() => {
    try {
      const data = openclaw.getSessions();
      metrics.recordSnapshot(data.sessions || []);
    } catch {}
  }, 5 * 60 * 1000);

  // Initial snapshot
  try {
    const data = openclaw.getSessions();
    metrics.recordSnapshot(data.sessions || []);
  } catch {}

  console.log(`⚡ Klaw Control backend running on http://0.0.0.0:${PORT}`);
  console.log(`   Local URL: http://${localIP}:${PORT}`);
  console.log(`   Auth token: ${TOKEN}`);
  console.log('');
  console.log('   Enter these in the Klaw Control iOS app → Settings to connect.');

  // ── CLI health checks (non-blocking) ──
  // These must not prevent startup even if they throw.
  claudeManager.getHealth().then((health) => {
    claudeHealthCache = health;
    if (health.installed) {
      console.log(`[startup] claude CLI detected: ${health.binary} (${health.version || 'unknown version'})`);
    } else {
      console.log('[startup] claude CLI NOT FOUND. Claude Code sessions will fail. To install: npm install -g @anthropic-ai/claude-code');
    }
  }).catch((err) => {
    console.error('[startup] claude health check failed:', err.message || err);
  });

  codexManager.getHealth().then((health) => {
    codexHealthCache = health;
    if (health.installed) {
      console.log(`[startup] codex CLI detected: ${health.binary} (${health.version || 'unknown version'})`);
    } else {
      console.log('[startup] codex CLI NOT FOUND. Codex sessions will fail. To install: npm install -g @openai/codex  (or: brew install codex)');
    }
  }).catch((err) => {
    console.error('[startup] codex health check failed:', err.message || err);
  });

  // ── Bonjour/mDNS advertisement ──
  // Advertise on local network so the iOS app auto-discovers us
  try {
    const mdns = require('multicast-dns')();
    const os = require('os');
    const hostname = os.hostname().replace(/\.local$/, '');
    const serviceName = `Klaw Control on ${hostname}`;

    // Respond to _klaw-control._tcp queries
    mdns.on('query', (query) => {
      const dominated = query.questions.some(
        (q) => q.name === '_klaw-control._tcp.local' && (q.type === 'PTR' || q.type === 'ANY')
      );
      if (dominated) {
        mdns.respond({
          answers: [
            { name: '_klaw-control._tcp.local', type: 'PTR', data: `${serviceName}._klaw-control._tcp.local` },
            { name: `${serviceName}._klaw-control._tcp.local`, type: 'SRV', data: { port: PORT, target: `${hostname}.local` } },
            { name: `${serviceName}._klaw-control._tcp.local`, type: 'TXT', data: [`version=1`, `auth=${process.env.KLAW_AUTH_TOKEN ? 'yes' : 'no'}`] },
          ],
        });
      }
    });

    console.log(`   Bonjour: advertising as "${serviceName}" on _klaw-control._tcp`);
  } catch {
    console.log(`   Bonjour: multicast-dns not installed (npm install multicast-dns for auto-discovery)`);
  }

  // ── P2P Tunnel ──
  try {
    const { initP2P } = require('./lib/p2p');
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const localIP = Object.values(interfaces).flat()
      .find((i) => i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';

    const { tunnel, qrPayload, completePairing } = await initP2P({
      localIP,
      httpPort: PORT,
      httpHandler: async (req) => {
        const forwardedHeaders = { ...req.headers };
        if (!forwardedHeaders.Authorization && !forwardedHeaders.authorization && TOKEN) {
          forwardedHeaders.Authorization = `Bearer ${TOKEN}`;
        }

        // Proxy HTTP requests from P2P tunnel to the local express app
        const response = await fetch(`http://127.0.0.1:${PORT}${req.path}`, {
          method: req.method,
          headers: forwardedHeaders,
          body: req.method !== 'GET' ? req.body : undefined,
        });
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        };
      },
    });
    p2pRuntime.completePairing = completePairing;
    p2pRuntime.tunnel = tunnel || null;

    if (qrPayload) {
      console.log(`\n   📱 Scan this to pair: ${qrPayload}\n`);
    } else if (tunnel) {
      console.log(`   P2P: tunnel listening, endpoint published`);
    }
  } catch (err) {
    console.log(`   P2P: ${err.message}`);
  }
});

// ── Graceful shutdown ────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received, closing server...`);
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
  // Give the HTTP server a chance to drain, but don't wait forever.
  const forceExit = setTimeout(() => {
    console.error('[shutdown] graceful close timed out, forcing exit');
    process.exit(1);
  }, 5000);
  forceExit.unref();
  server.close(() => {
    console.log('[shutdown] server closed cleanly');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
