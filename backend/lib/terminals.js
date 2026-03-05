// PTY session manager — spawn, list, rename, kill terminal sessions

const pty = require('node-pty');
const { v4: uuidv4 } = require('crypto');
const crypto = require('crypto');

const sessions = new Map();

function genId() {
  return crypto.randomUUID();
}

function spawn(name = null) {
  const sid = genId();
  const shell = process.env.SHELL || '/bin/zsh';

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const session = {
    sid,
    name: name || `Session ${sessions.size + 1}`,
    pid: term.pid,
    pty: term,
    startedAt: new Date().toISOString(),
    buffer: '', // rolling buffer of recent output
    listeners: new Set(), // WebSocket connections
  };

  // Capture output
  term.onData((data) => {
    session.buffer += data;
    // Keep last 50KB
    if (session.buffer.length > 50000) {
      session.buffer = session.buffer.slice(-40000);
    }
    // Relay to all connected WebSockets
    for (const ws of session.listeners) {
      try { ws.send(data); } catch {}
    }
  });

  term.onExit(({ exitCode }) => {
    session.exitCode = exitCode;
    session.exitedAt = new Date().toISOString();
    for (const ws of session.listeners) {
      try { ws.send(`\r\n[Process exited with code ${exitCode}]\r\n`); ws.close(); } catch {}
    }
    session.listeners.clear();
  });

  sessions.set(sid, session);
  return { sid, name: session.name, pid: term.pid, startedAt: session.startedAt };
}

function list() {
  return Array.from(sessions.values()).map(s => ({
    sid: s.sid,
    name: s.name,
    pid: s.pid,
    startedAt: s.startedAt,
    alive: !s.exitedAt,
    exitCode: s.exitCode ?? null,
    exitedAt: s.exitedAt ?? null,
  }));
}

function get(sid) {
  return sessions.get(sid) || null;
}

function rename(sid, name) {
  const s = sessions.get(sid);
  if (!s) return null;
  s.name = name;
  return { sid, name };
}

function kill(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  try { s.pty.kill(); } catch {}
  sessions.delete(sid);
  return true;
}

function resize(sid, cols, rows) {
  const s = sessions.get(sid);
  if (!s) return false;
  try { s.pty.resize(cols, rows); return true; } catch { return false; }
}

function write(sid, data) {
  const s = sessions.get(sid);
  if (!s) return false;
  s.pty.write(data);
  return true;
}

function attach(sid, ws) {
  const s = sessions.get(sid);
  if (!s) return false;

  s.listeners.add(ws);

  // Send buffered output
  if (s.buffer) ws.send(s.buffer);

  ws.on('message', (msg) => {
    const str = msg.toString();
    // Handle resize messages
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        resize(sid, parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    // Regular input
    s.pty.write(str);
  });

  ws.on('close', () => {
    s.listeners.delete(ws);
  });

  return true;
}

module.exports = { spawn, list, get, rename, kill, resize, write, attach };
