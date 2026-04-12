// PTY session manager — spawn, list, rename, kill terminal sessions

const { spawn: spawnChild } = require('child_process');
const pty = require('node-pty');
const crypto = require('crypto');

const sessions = new Map();

function genId() {
  return crypto.randomUUID();
}

function appendOutput(session, data) {
  session.buffer += data;
  if (session.buffer.length > 50000) {
    session.buffer = session.buffer.slice(-40000);
  }

  for (const ws of session.listeners) {
    try {
      ws.send(data);
    } catch {}
  }
}

function markExited(session, exitCode) {
  session.exitCode = exitCode;
  session.exitedAt = new Date().toISOString();

  for (const ws of session.listeners) {
    try {
      ws.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
      ws.close();
    } catch {}
  }

  session.listeners.clear();
}

function createPtyTransport(shell, cwd, env) {
  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env,
  });

  return {
    pid: term.pid,
    write(data) {
      term.write(data);
    },
    resize(cols, rows) {
      term.resize(cols, rows);
      return true;
    },
    kill() {
      term.kill();
    },
    onData(handler) {
      term.onData(handler);
    },
    onExit(handler) {
      term.onExit(({ exitCode }) => handler(exitCode));
    },
  };
}

function createPipeTransport(shell, cwd, env) {
  const child = spawnChild(shell, [], {
    cwd,
    env,
    stdio: 'pipe',
  });

  return {
    pid: child.pid,
    write(data) {
      child.stdin.write(data);
    },
    resize() {
      return false;
    },
    kill() {
      child.kill();
    },
    onData(handler) {
      child.stdout.on('data', (chunk) => handler(chunk.toString()));
      child.stderr.on('data', (chunk) => handler(chunk.toString()));
    },
    onExit(handler) {
      child.on('exit', (exitCode) => handler(exitCode ?? 0));
      child.on('error', () => handler(1));
    },
  };
}

function createTransport(shell, cwd, env) {
  try {
    return createPtyTransport(shell, cwd, env);
  } catch {
    return createPipeTransport('/bin/sh', cwd, env);
  }
}

function spawn(name = null) {
  const sid = genId();
  const shell = process.env.SHELL || '/bin/zsh';
  const cwd = process.env.HOME || process.cwd();
  const env = { ...process.env, TERM: 'xterm-256color' };
  const transport = createTransport(shell, cwd, env);

  const session = {
    sid,
    name: name || `Session ${sessions.size + 1}`,
    pid: transport.pid,
    transport,
    startedAt: new Date().toISOString(),
    buffer: '',
    listeners: new Set(),
  };

  transport.onData((data) => {
    appendOutput(session, data);
  });

  transport.onExit((exitCode) => {
    markExited(session, exitCode);
  });

  sessions.set(sid, session);
  return { sid, name: session.name, pid: transport.pid, startedAt: session.startedAt };
}

function list() {
  return Array.from(sessions.values()).map((s) => ({
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
  try {
    s.transport.kill();
  } catch {}
  sessions.delete(sid);
  return true;
}

function resize(sid, cols, rows) {
  const s = sessions.get(sid);
  if (!s) return false;
  try {
    return s.transport.resize(cols, rows);
  } catch {
    return false;
  }
}

function write(sid, data) {
  const s = sessions.get(sid);
  if (!s) return false;
  s.transport.write(data);
  return true;
}

function attach(sid, ws) {
  const s = sessions.get(sid);
  if (!s) return false;

  s.listeners.add(ws);

  if (s.buffer) {
    ws.send(s.buffer);
  }

  ws.on('message', (msg) => {
    const str = msg.toString();

    try {
      const parsed = JSON.parse(str);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        resize(sid, parsed.cols, parsed.rows);
        return;
      }
    } catch {}

    write(sid, str);
  });

  ws.on('close', () => {
    s.listeners.delete(ws);
  });

  return true;
}

module.exports = { spawn, list, get, rename, kill, resize, write, attach };
