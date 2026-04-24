// Claude Code Control Backend
// Manages Claude Code sessions, spawning, output streaming, and WebSocket connections.
// Mirrors backend/lib/codex.js in structure.

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./codex-config');

// ──────────────────────────────────────────────────────────────────────────
// Binary resolution
// ──────────────────────────────────────────────────────────────────────────

// Returns an absolute path if we can find `claude` on disk, otherwise null.
// This is the canonical lookup used by the manager's resolveBinary() + getHealth().
function resolveClaudeBin() {
  try {
    const resolved = execSync('which claude', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (resolved) return resolved;
  } catch {
    // fall through to fallbacks
  }

  const fallbacks = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];

  for (const candidate of fallbacks) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }

  return null;
}

// For spawnClaude we still need *something* to hand to child_process.spawn even
// if the binary isn't on disk yet — fall back to the bare name so PATH can
// resolve it at spawn time. Sessions will simply fail with ENOENT if missing.
const CLAUDE_BIN = resolveClaudeBin() || 'claude';

// ──────────────────────────────────────────────────────────────────────────
// Claude Code Session Manager
// ──────────────────────────────────────────────────────────────────────────

class ClaudeCodeSessionManager {
  constructor() {
    this.sessions = new Map(); // id → session
    this.registeredProjects = new Set(); // absolute paths registered at runtime
  }

  // ─ Binary / Health ─

  // Returns the absolute path to the `claude` binary, or null if not found.
  // Resolved fresh each call so a post-install shows up without a restart.
  resolveBinary() {
    return resolveClaudeBin();
  }

  // Detects whether claude is installed and, if so, captures `--version`.
  // Shape: { installed, binary, version, error }
  async getHealth() {
    const binary = this.resolveBinary();
    if (!binary) {
      return { installed: false, binary: null, version: null, error: 'claude binary not found in PATH or common install locations' };
    }

    return new Promise((resolve) => {
      let finished = false;
      const done = (payload) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(payload);
      };

      let stdout = '';
      let stderr = '';
      let proc;
      try {
        proc = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        done({ installed: true, binary, version: null, error: err.message || 'spawn failed' });
        return;
      }

      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        done({ installed: true, binary, version: null, error: 'version check timed out after 5s' });
      }, 5000);

      proc.on('error', (err) => {
        done({ installed: true, binary, version: null, error: err.message || 'spawn error' });
      });
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('close', (code) => {
        const raw = (stdout || stderr || '').trim();
        if (code === 0 && raw) {
          done({ installed: true, binary, version: raw, error: null });
        } else if (code === 0) {
          done({ installed: true, binary, version: null, error: null });
        } else {
          done({ installed: true, binary, version: null, error: (stderr || stdout || `exit ${code}`).trim() });
        }
      });
    });
  }

  // ─ Session Lifecycle ─

  createSession(projectPath) {
    const id = crypto.randomUUID();
    const session = {
      id,
      projectPath,
      projectName: path.basename(projectPath),
      branch: this.getGitBranch(projectPath) || 'main',
      status: 'idle', // idle, running, done, error
      createdAt: new Date(),
      processId: null,
      processHandle: null,
      messages: [],
      pendingActions: [],
      output: '',
      currentPrompt: null,
      currentAssistantMessage: null,
      subscribers: [],
    };

    this.sessions.set(id, session);
    console.log(`[claude] Created session ${id} for project ${session.projectName}`);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      projectName: s.projectName,
      projectPath: s.projectPath,
      branch: s.branch,
      status: s.status,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
      pendingActionsCount: s.pendingActions.length,
    }));
  }

  killSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.processHandle) {
      try {
        session.processHandle.kill();
      } catch (err) {
        console.error(`[claude] kill failed for ${id}:`, err.message);
      }
      session.processHandle = null;
      session.processId = null;
    }

    session.status = 'done';
    console.log(`[claude] Killed session ${id}`);
    return true;
  }

  // ─ Messaging & Streaming ─

  addMessage(sessionId, role, text) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const message = {
      id: crypto.randomUUID(),
      role,
      text,
      timestamp: new Date(),
    };

    session.messages.push(message);
    return message;
  }

  getHistory(sessionId, limit = 20) {
    const session = this.getSession(sessionId);
    if (!session) return [];

    const messages = session.messages.slice(-limit);
    return messages.map(m => ({
      id: m.id,
      role: m.role,
      text: m.text,
      timestamp: m.timestamp,
    }));
  }

  // ─ Execution ─

  async executePrompt(sessionId, prompt, timeout = config.timeouts.defaultPrompt) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    if (session.status === 'running') {
      throw new Error('Session is already running');
    }

    // Record user message
    this.addMessage(sessionId, 'user', prompt);
    session.currentPrompt = prompt;
    session.status = 'running';
    session.output = '';
    session.currentAssistantMessage = null;

    this.broadcastToSession(sessionId, {
      type: 'status',
      status: 'running',
      message: 'Executing prompt...',
    });

    try {
      const args = [
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'bypassPermissions',
        prompt,
      ];

      return await this.spawnClaude(sessionId, args, timeout);
    } catch (error) {
      session.status = 'error';
      const errorMsg = error.message || 'Unknown error';
      this.broadcastToSession(sessionId, {
        type: 'error',
        message: errorMsg,
      });
      this.addMessage(sessionId, 'assistant', `Error: ${errorMsg}`);
      throw error;
    }
  }

  async spawnClaude(sessionId, args, timeout) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.processHandle) {
          try {
            session.processHandle.kill();
          } catch {}
          session.processHandle = null;
        }
        session.status = 'error';
        reject(new Error(`Claude Code execution timeout after ${timeout}ms`));
      }, timeout);

      let stdout = '';
      let stderr = '';
      let bufferedStdout = '';

      const proc = spawn(CLAUDE_BIN, args, {
        cwd: session.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });

      session.processHandle = proc;
      session.processId = proc.pid;

      // Attach stream error handlers — otherwise a stream error crashes the server.
      proc.on('error', (err) => {
        clearTimeout(timer);
        session.status = 'error';
        session.processHandle = null;
        console.error(`[claude] process error (${sessionId}):`, err.message);
        reject(err);
      });
      if (proc.stdin) {
        proc.stdin.on('error', (err) => {
          console.error(`[claude] stdin error (${sessionId}):`, err.message);
        });
        // Prompt passed as argument, so we close stdin immediately.
        try {
          proc.stdin.end();
        } catch {}
      }
      proc.stdout.on('error', (err) => {
        console.error(`[claude] stdout error (${sessionId}):`, err.message);
      });
      proc.stderr.on('error', (err) => {
        console.error(`[claude] stderr error (${sessionId}):`, err.message);
      });

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        bufferedStdout += text;

        const lines = bufferedStdout.split(/\r?\n/);
        bufferedStdout = lines.pop() ?? '';

        for (const line of lines) {
          this.handleStreamLine(sessionId, line);
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        session.processHandle = null;
        session.processId = null;

        // Flush any trailing buffered line.
        if (bufferedStdout.trim()) {
          this.handleStreamLine(sessionId, bufferedStdout);
          bufferedStdout = '';
        }

        // Finalize any accumulated assistant message.
        if (session.currentAssistantMessage && session.currentAssistantMessage.text) {
          session.messages.push(session.currentAssistantMessage);
          this.broadcastToSession(sessionId, {
            type: 'message',
            message: session.currentAssistantMessage,
          });
        }
        session.currentAssistantMessage = null;

        if (code === 0) {
          session.status = 'idle';
          this.broadcastToSession(sessionId, {
            type: 'status',
            status: 'idle',
            message: 'Ready for next prompt',
          });
          resolve({ stdout, stderr, code });
        } else {
          session.status = 'error';
          const error = stderr || stdout || `Process exited with code ${code}`;
          const assistantMessage = this.addMessage(sessionId, 'assistant', `Error: ${error}`);

          if (assistantMessage) {
            this.broadcastToSession(sessionId, {
              type: 'message',
              message: assistantMessage,
            });
          }

          this.broadcastToSession(sessionId, {
            type: 'error',
            message: error,
          });

          reject(new Error(error));
        }
      });
    });
  }

  handleStreamLine(sessionId, line) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const trimmed = line.trim();
    if (!trimmed) return;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Non-JSON line: log and forward raw.
      console.log(`[claude] non-json line (${sessionId}): ${trimmed.slice(0, 200)}`);
      this.broadcastToSession(sessionId, {
        type: 'raw',
        text: line,
      });
      session.output += line + '\n';
      return;
    }

    // Forward the parsed event to subscribers verbatim.
    this.broadcastToSession(sessionId, {
      type: 'claude-stream',
      event,
    });

    // Accumulate assistant text into a single message per turn.
    if (event && event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      let chunk = '';
      for (const part of event.message.content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          chunk += part.text;
        }
      }

      if (chunk) {
        if (!session.currentAssistantMessage) {
          session.currentAssistantMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: '',
            timestamp: new Date(),
          };
        }
        session.currentAssistantMessage.text += chunk;
        session.output += chunk;
      }
    }
  }

  // ─ Git Integration ─

  getGitBranch(projectPath) {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      return branch;
    } catch {
      return null;
    }
  }

  getGitStatus(projectPath) {
    try {
      const status = execSync('git status --porcelain', {
        cwd: projectPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const lines = status.trim().split('\n').filter(Boolean);
      const modified = [];
      const staged = [];
      const untracked = [];

      lines.forEach((line) => {
        const st = line.substring(0, 2);
        const file = line.substring(3);

        if (st === '??') {
          untracked.push(file);
        } else if (st[0] === 'M' || st[0] === 'A') {
          staged.push(file);
        } else if (st[1] === 'M' || st[1] === 'D') {
          modified.push(file);
        }
      });

      return { modified, staged, untracked };
    } catch {
      return { modified: [], staged: [], untracked: [] };
    }
  }

  getGitDiff(projectPath, filePath = null) {
    try {
      const args = ['diff'];
      if (filePath) args.push(filePath);

      const diff = execSync(`git ${args.join(' ')}`, {
        cwd: projectPath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return diff;
    } catch {
      return '';
    }
  }

  // ─ WebSocket Subscribers ─

  subscribe(sessionId, ws) {
    const session = this.getSession(sessionId);
    if (!session) return;

    // Prune stale subscribers before adding so the list doesn't grow unbounded.
    session.subscribers = session.subscribers.filter(s => s.readyState === 1);
    session.subscribers.push(ws);
    console.log(`[claude] WebSocket subscribed to session ${sessionId} (${session.subscribers.length} subscribers)`);

    try {
      ws.send(JSON.stringify({
        type: 'state',
        session: {
          id: session.id,
          projectName: session.projectName,
          branch: session.branch,
          status: session.status,
        },
        messages: session.messages.slice(-50),
      }));
    } catch (err) {
      console.error(`[claude] Failed to send initial state:`, err.message);
    }
  }

  unsubscribe(sessionId, ws) {
    const session = this.getSession(sessionId);
    if (!session) return;

    session.subscribers = session.subscribers.filter(s => s !== ws);
    console.log(`[claude] WebSocket unsubscribed from session ${sessionId} (${session.subscribers.length} remaining)`);
  }

  broadcastToSession(sessionId, message) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const json = JSON.stringify(message);
    const stillAlive = [];
    for (const ws of session.subscribers) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(json);
        stillAlive.push(ws);
      } catch (err) {
        console.error(`[claude] broadcast send failed, dropping subscriber:`, err.message);
      }
    }
    session.subscribers = stillAlive;
  }

  // ─ Registered Projects ─

  registerProject(absolutePath) {
    if (!absolutePath || typeof absolutePath !== 'string') {
      throw new Error('absolute path required');
    }
    const resolved = path.resolve(absolutePath);
    if (!fs.existsSync(resolved)) {
      throw new Error('path does not exist');
    }
    if (!fs.existsSync(path.join(resolved, '.git'))) {
      throw new Error('path is not a git repository');
    }

    this.registeredProjects.add(resolved);

    return {
      id: path.basename(resolved),
      name: path.basename(resolved),
      path: resolved,
      branch: this.getGitBranch(resolved) || 'main',
    };
  }

  // ─ Project Discovery ─

  discoverProjects() {
    const projects = new Map();

    config.projectPaths.forEach((basePath) => {
      if (!fs.existsSync(basePath)) return;

      try {
        const entries = fs.readdirSync(basePath, { withFileTypes: true });
        entries.forEach((entry) => {
          if (!entry.isDirectory()) return;

          const fullPath = path.join(basePath, entry.name);

          if (fs.existsSync(path.join(fullPath, '.git'))) {
            projects.set(entry.name, {
              id: entry.name,
              name: entry.name,
              path: fullPath,
              branch: this.getGitBranch(fullPath) || 'main',
            });
          }
        });
      } catch {
        // Skip on permission errors, etc.
      }
    });

    // Merge in runtime-registered paths.
    for (const registered of this.registeredProjects) {
      if (!fs.existsSync(registered)) continue;
      if (!fs.existsSync(path.join(registered, '.git'))) continue;
      const name = path.basename(registered);
      projects.set(name, {
        id: name,
        name,
        path: registered,
        branch: this.getGitBranch(registered) || 'main',
      });
    }

    return Array.from(projects.values());
  }

  // ─ Utilities ─

  capitalCase(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ──────────────────────────────────────────────────────────────────────────

const manager = new ClaudeCodeSessionManager();

module.exports = {
  manager,
  config,
  CLAUDE_BIN,
};
