// Codex Configuration
// Controls project discovery, timeouts, and Codex CLI templates

const path = require('path');
const os = require('os');

module.exports = {
  // Project discovery paths
  projectPaths: [
    path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/Arya Shared Folder'),
    path.join(os.homedir(), '.openclaw/workspace/projects'),
    path.join(os.homedir(), '.openclaw/workspace'),
  ],

  // Codex binary location
  codexBin: 'codex',

  // Execution flags for remote Codex runs. This backend is the trusted execution host,
  // so Codex needs real write access instead of the default read-only exec sandbox.
  execArgs: [
    '--dangerously-bypass-approvals-and-sandbox',
  ],

  // Timeouts (milliseconds)
  timeouts: {
    defaultPrompt: 30 * 1000,      // 30s for typical prompts
    longRunning: 120 * 1000,        // 120s for complex operations
    session: 300 * 1000,            // 5min for full session
  },

  // Output buffering
  outputBuffer: {
    maxSize: 1_000_000,             // 1MB max
    trimToSize: 700_000,            // Trim to 700KB when exceeded
  },

  // Action parsing patterns
  actionPatterns: {
    // Match "Creating file: src/App.tsx"
    create: /Creating file[:\s]+([^\n]+)/gi,
    modify: /Modifying file[:\s]+([^\n]+)/gi,
    delete: /Deleting file[:\s]+([^\n]+)/gi,
    // Match "Creating directory: src/components"
    mkdir: /Creating directory[:\s]+([^\n]+)/gi,
  },

  // Git integration
  git: {
    // How often to refresh status (ms)
    statusCacheTTL: 5000,
  },

  // Retry policy for Codex spawning
  spawn: {
    maxRetries: 2,
    retryDelay: 1000,
  },
};
