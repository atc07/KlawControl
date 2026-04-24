// PTY session manager — uses python3 pty.fork() for real TTY support
// (node-pty broken on Node 25, script command needs TTY on stdin)

const { spawn: cpSpawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const PTY_HELPER = path.join(__dirname, 'pty-helper.py');
const sessions = new Map();

function genId() {
  return crypto.randomUUID();
}

function spawn(name = null) {
  const sid = genId();

  const proc = cpSpawn('python3', [PTY_HELPER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '160', LINES: '52' },
    cwd: process.env.HOME,
  });

  const session = {
    sid,
    name: name || `Session ${sessions.size + 1}`,
    pid: proc.pid,
    proc,
    startedAt: new Date().toISOString(),
    buffer: '',
    listeners: new Set(),
    alive: true,
  };

  // Stream error handlers — without these, a stream error crashes the process.
  proc.on('error', (err) => {
    console.error(`[terminals] proc error (${sid.slice(0, 8)}...):`, err.message);
    session.alive = false;
  });
  proc.stdout.on('error', (err) => {
    console.error(`[terminals] stdout error (${sid.slice(0, 8)}...):`, err.message);
  });
  proc.stderr.on('error', (err) => {
    console.error(`[terminals] stderr error (${sid.slice(0, 8)}...):`, err.message);
  });
  proc.stdin.on('error', (err) => {
    console.error(`[terminals] stdin error (${sid.slice(0, 8)}...):`, err.message);
  });

  proc.stdout.on('data', (data) => {
    const str = data.toString();
    console.log(`[terminals] stdout (${sid.slice(0, 8)}...): ${str.slice(0, 50).replace(/\n/g, '\\n')}`);
    session.buffer += str;
    if (session.buffer.length > 50000) {
      session.buffer = session.buffer.slice(-40000);
    }
    for (const ws of session.listeners) {
      try { 
        ws.send(str);
      } catch (err) {
        console.error(`[terminals] Failed to send to listener:`, err.message);
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const str = data.toString();
    console.log(`[terminals] stderr (${sid.slice(0, 8)}...): ${str.slice(0, 50).replace(/\n/g, '\\n')}`);
    session.buffer += str;
    if (session.buffer.length > 50000) {
      session.buffer = session.buffer.slice(-40000);
    }
    for (const ws of session.listeners) {
      try {
        ws.send(str);
      } catch (err) {
        console.error(`[terminals] Failed to send to listener:`, err.message);
      }
    }
  });

  proc.on('exit', (code) => {
    session.alive = false;
    session.exitCode = code;
    session.exitedAt = new Date().toISOString();
    for (const ws of session.listeners) {
      try {
        ws.send(`\r\n[Process exited with code ${code}]\r\n`);
        ws.close();
      } catch {}
    }
    session.listeners.clear();
  });

  sessions.set(sid, session);
  return { sid, name: session.name, pid: proc.pid, startedAt: session.startedAt };
}

function list() {
  return Array.from(sessions.values()).map(s => ({
    sid: s.sid,
    name: s.name,
    pid: s.pid,
    startedAt: s.startedAt,
    alive: s.alive,
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
  try { s.proc.kill('SIGTERM'); } catch {}
  sessions.delete(sid);
  return true;
}

function write(sid, data) {
  const s = sessions.get(sid);
  if (!s || !s.alive) return false;
  if (!s.proc.stdin.writable) {
    console.warn(`[terminals] stdin not writable for ${sid.slice(0, 8)}..., dropping write`);
    return false;
  }
  s.proc.stdin.write(data);
  return true;
}

function attach(sid, ws) {
  const s = sessions.get(sid);
  if (!s) return false;

  // Prune any listeners that are no longer open before adding.
  for (const existing of s.listeners) {
    if (existing.readyState !== 1) s.listeners.delete(existing);
  }

  s.listeners.add(ws);
  console.log(`[terminals] WebSocket attached to session ${sid.slice(0, 8)}... (${s.listeners.size} listeners)`);

  // Send buffered output
  if (s.buffer) {
    console.log(`[terminals] Sending buffered output (${s.buffer.length} bytes) to new listener`);
    try {
      ws.send(s.buffer);
    } catch (err) {
      console.error(`[terminals] Failed to send buffer to new listener:`, err.message);
    }
  }

  ws.on('message', (msg) => {
    const str = msg.toString();
    console.log(`[terminals] Received message (${str.length} bytes): ${str.slice(0, 50).replace(/\n/g, '\\n')}...`);
    
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize') {
        if (Number.isFinite(parsed.rows) && Number.isFinite(parsed.cols)) {
          const rows = Math.max(10, Math.min(200, Math.floor(parsed.rows)));
          const cols = Math.max(20, Math.min(400, Math.floor(parsed.cols)));
          const resizeMessage = `\x1b[8;${rows};${cols}t`;
          console.log(`[terminals] Resize message: ${cols}x${rows}`);
          if (s.proc.stdin.writable) s.proc.stdin.write(resizeMessage);
        }
        return;
      }
    } catch {}

    if (!s.alive) {
      console.log(`[terminals] ⚠️  Session not alive, ignoring message`);
      return;
    }
    if (!s.proc.stdin.writable) {
      console.warn(`[terminals] stdin not writable for ${sid.slice(0, 8)}..., dropping input`);
      return;
    }
    console.log(`[terminals] Writing to stdin: ${str.slice(0, 50).replace(/\n/g, '\\n')}`);
    s.proc.stdin.write(str);
  });

  ws.on('close', () => {
    s.listeners.delete(ws);
    console.log(`[terminals] WebSocket closed for ${sid.slice(0, 8)}... (${s.listeners.size} remaining listeners)`);
  });

  ws.on('error', (err) => {
    console.error(`[terminals] WebSocket error:`, err.message);
    s.listeners.delete(ws);
  });

  return true;
}

module.exports = { spawn, list, get, rename, kill, write, attach };
