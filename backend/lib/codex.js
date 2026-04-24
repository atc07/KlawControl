// Codex Control Backend
// Manages Codex sessions, spawning, output streaming, and WebSocket connections

const { spawn } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./codex-config');

// ──────────────────────────────────────────────────────────────────────────
// Codex Session Manager
// ──────────────────────────────────────────────────────────────────────────

class CodexSessionManager {
  constructor() {
    this.sessions = new Map(); // id → session
    this.projectStatusCache = new Map();
    this.statusCacheTime = 0;
    this.registeredProjects = new Set(); // absolute paths registered at runtime
  }

  // ─ Binary / Health ─

  // Returns the absolute path to the `codex` binary, or null if not found.
  resolveBinary() {
    // Try PATH first.
    try {
      const resolved = execSync('which codex', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      if (resolved) return resolved;
    } catch {
      // fall through
    }

    const fallbacks = [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ];
    for (const candidate of fallbacks) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }

    // Honor an explicit non-bare config value if someone overrode it.
    if (config.codexBin && config.codexBin !== 'codex' && fs.existsSync(config.codexBin)) {
      return config.codexBin;
    }

    return null;
  }

  // { installed, binary, version, error }
  async getHealth() {
    const binary = this.resolveBinary();
    if (!binary) {
      return { installed: false, binary: null, version: null, error: 'codex binary not found in PATH or common install locations' };
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
      status: 'idle', // idle, running, waiting, done, error
      createdAt: new Date(),
      codexThreadId: null,
      processId: null,
      processHandle: null,
      messages: [],
      pendingActions: [],
      output: '',
      currentPrompt: null,
      subscribers: [], // WebSocket connections
    };

    this.sessions.set(id, session);
    console.log(`[codex] Created session ${id} for project ${session.projectName}`);
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
      codexThreadId: s.codexThreadId,
      messageCount: s.messages.length,
      pendingActionsCount: s.pendingActions.length,
    }));
  }

  killSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.processHandle) {
      session.processHandle.kill();
      session.processHandle = null;
      session.processId = null;
    }

    session.status = 'done';
    console.log(`[codex] Killed session ${id}`);
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

    // Broadcast status
    this.broadcastToSession(sessionId, {
      type: 'status',
      status: 'running',
      message: 'Executing prompt...',
    });

    try {
      const args = session.codexThreadId
        ? ['exec', 'resume', ...config.execArgs, session.codexThreadId, prompt, '--json']
        : ['exec', ...config.execArgs, prompt, '--json'];

      return await this.spawnCodex(sessionId, args, timeout);
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

  async spawnCodex(sessionId, args, timeout) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.processHandle) {
          session.processHandle.kill();
          session.processHandle = null;
        }
        session.status = 'error';
        reject(new Error(`Codex execution timeout after ${timeout}ms`));
      }, timeout);

      let stdout = '';
      let stderr = '';
      let streamedText = '';
      let bufferedStdout = '';

      const proc = spawn(config.codexBin, args, {
        cwd: session.projectPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });

      session.processHandle = proc;
      session.processId = proc.pid;

      // Attach stream error handlers — otherwise a stream error crashes the server.
      proc.stdout.on('error', (err) => {
        console.error(`[codex] stdout error (${sessionId}):`, err.message);
      });
      proc.stderr.on('error', (err) => {
        console.error(`[codex] stderr error (${sessionId}):`, err.message);
      });

      proc.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        bufferedStdout += text;
        const parsed = this.consumeCodexJsonLines(sessionId, bufferedStdout);
        bufferedStdout = parsed.remainder;

        if (parsed.text) {
          streamedText += parsed.text;
          session.output += parsed.text;

          this.broadcastToSession(sessionId, {
            type: 'output',
            text: parsed.text,
          });

          this.parseActions(sessionId, parsed.text);
        }
      });

      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        session.status = 'error';
        session.processHandle = null;
        reject(err);
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        session.processHandle = null;
        session.processId = null;

        if (bufferedStdout.trim()) {
          streamedText += bufferedStdout;
          session.output += bufferedStdout;
          this.broadcastToSession(sessionId, {
            type: 'output',
            text: bufferedStdout,
          });
          this.parseActions(sessionId, bufferedStdout);
        }

        if (code === 0) {
          session.status = 'waiting'; // Waiting for next prompt or approval
          const assistantText = streamedText.trim() || stdout.trim();
          const assistantMessage = this.addMessage(sessionId, 'assistant', assistantText);

          if (assistantMessage) {
            this.broadcastToSession(sessionId, {
              type: 'message',
              message: assistantMessage,
            });
          }

          this.broadcastToSession(sessionId, {
            type: 'status',
            status: 'waiting',
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

  consumeCodexJsonLines(sessionId, buffer) {
    const lines = buffer.split(/\r?\n/);
    const remainder = lines.pop() ?? '';
    let text = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed);
        const extracted = this.handleCodexEvent(sessionId, event);
        if (extracted) {
          text += extracted;
        }
      } catch {
        text += line + '\n';
      }
    }

    return { text, remainder };
  }

  handleCodexEvent(sessionId, event) {
    const session = this.getSession(sessionId);
    if (!session || !event || typeof event !== 'object') return '';

    switch (event.type) {
      case 'thread.started':
        if (event.thread_id) {
          session.codexThreadId = event.thread_id;
        }
        return '';

      case 'item.completed':
        if (event.item?.type === 'agent_message' && event.item?.text) {
          return `${event.item.text}\n`;
        }
        return '';

      case 'turn.completed':
      case 'turn.started':
        return '';

      case 'error':
        return event.message ? `Error: ${event.message}\n` : '';

      default:
        return '';
    }
  }

  // ─ Action Parsing ─

  parseActions(sessionId, text) {
    const session = this.getSession(sessionId);
    if (!session) return;

    // Simple pattern-based parsing for MVP
    // TODO: Switch to structured JSON output from Codex in production
    
    // Look for file operation mentions
    const createMatches = [...text.matchAll(config.actionPatterns.create)];
    const modifyMatches = [...text.matchAll(config.actionPatterns.modify)];
    const deleteMatches = [...text.matchAll(config.actionPatterns.delete)];

    createMatches.forEach((match) => {
      const filePath = match[1].trim();
      this.addAction(sessionId, 'create', filePath, { reason: 'detected from output' });
    });

    modifyMatches.forEach((match) => {
      const filePath = match[1].trim();
      this.addAction(sessionId, 'modify', filePath, { reason: 'detected from output' });
    });

    deleteMatches.forEach((match) => {
      const filePath = match[1].trim();
      this.addAction(sessionId, 'delete', filePath, { reason: 'detected from output' });
    });
  }

  addAction(sessionId, type, filePath, details = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    // Avoid duplicate actions
    const existing = session.pendingActions.find(a => a.filePath === filePath && a.type === type);
    if (existing) return existing;

    const action = {
      id: `act-${crypto.randomUUID()}`,
      type, // create, modify, delete
      filePath,
      status: 'pending', // pending, approved, rejected
      details,
      timestamp: new Date(),
    };

    session.pendingActions.push(action);

    // Broadcast action card
    this.broadcastToSession(sessionId, {
      type: 'action',
      id: action.id,
      title: `${this.capitalCase(type)} file`,
      description: filePath,
      details: {
        filePath,
        type,
      },
    });

    console.log(`[codex] Added action: ${type} ${filePath} (${action.id})`);
    return action;
  }

  approveAction(sessionId, actionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const action = session.pendingActions.find(a => a.id === actionId);
    if (!action) return null;

    action.status = 'approved';

    this.broadcastToSession(sessionId, {
      type: 'actionApproved',
      id: actionId,
    });

    console.log(`[codex] Approved action ${actionId}`);
    return action;
  }

  rejectAction(sessionId, actionId, reason) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const action = session.pendingActions.find(a => a.id === actionId);
    if (!action) return null;

    action.status = 'rejected';
    action.rejectReason = reason;

    this.broadcastToSession(sessionId, {
      type: 'actionRejected',
      id: actionId,
      reason,
    });

    console.log(`[codex] Rejected action ${actionId}: ${reason}`);
    return action;
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
        const status = line.substring(0, 2);
        const file = line.substring(3);

        if (status === '??') {
          untracked.push(file);
        } else if (status[0] === 'M' || status[0] === 'A') {
          staged.push(file);
        } else if (status[1] === 'M' || status[1] === 'D') {
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
    console.log(`[codex] WebSocket subscribed to session ${sessionId} (${session.subscribers.length} subscribers)`);

    // Send current state
    try {
      ws.send(JSON.stringify({
        type: 'state',
        session: {
          id: session.id,
          projectName: session.projectName,
          branch: session.branch,
          status: session.status,
        },
        messages: session.messages.slice(-50), // Last 50 messages
      }));
    } catch (err) {
      console.error(`[codex] Failed to send initial state:`, err.message);
    }
  }

  unsubscribe(sessionId, ws) {
    const session = this.getSession(sessionId);
    if (!session) return;

    session.subscribers = session.subscribers.filter(s => s !== ws);
    console.log(`[codex] WebSocket unsubscribed from session ${sessionId} (${session.subscribers.length} remaining)`);
  }

  broadcastToSession(sessionId, message) {
    const session = this.getSession(sessionId);
    if (!session) return;

    const json = JSON.stringify(message);
    // Build a new subscriber list while broadcasting so dead sockets are dropped.
    const stillAlive = [];
    for (const ws of session.subscribers) {
      if (ws.readyState !== 1) continue;
      try {
        ws.send(json);
        stillAlive.push(ws);
      } catch (err) {
        console.error(`[codex] broadcast send failed, dropping subscriber:`, err.message);
      }
    }
    session.subscribers = stillAlive;
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

          // Check if it's a git repo
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

  // ─ Utilities ─

  capitalCase(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ──────────────────────────────────────────────────────────────────────────

const manager = new CodexSessionManager();

module.exports = {
  manager,
  config,
};
