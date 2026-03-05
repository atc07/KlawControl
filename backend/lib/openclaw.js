// OpenClaw CLI wrappers — parse live state from the CLI

const { execSync } = require('child_process');

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : '';
  }
}

function getHealth() {
  const raw = run('openclaw health 2>&1');
  const ok = raw.includes('ok') || raw.includes('running');
  return {
    status: ok ? 'ok' : 'degraded',
    raw,
    checkedAt: new Date().toISOString(),
  };
}

function getChannelsStatus() {
  const raw = run('openclaw channels status 2>&1');
  const channels = [];

  // Parse lines like: discord    running  in: 2m ago  out: 1m ago
  const lines = raw.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const match = line.match(/^\s*(\S+)\s+(running|stopped|error|disconnected)/i);
    if (match) {
      const id = match[1];
      const connected = match[2].toLowerCase() === 'running';

      // Try to extract timing info
      const inMatch = line.match(/in:\s*(.+?)(\s+out:|$)/);
      const outMatch = line.match(/out:\s*(.+?)$/);

      channels.push({
        id,
        connected,
        lastMessageIn: inMatch ? inMatch[1].trim() : null,
        lastMessageOut: outMatch ? outMatch[1].trim() : null,
        raw: line.trim(),
      });
    }
  }

  // If parsing got nothing, return raw for debugging
  if (channels.length === 0 && raw) {
    channels.push({ id: 'raw', connected: false, raw });
  }

  return channels;
}

function getGatewayStatus() {
  const raw = run('openclaw status 2>&1');
  const health = getHealth();
  return {
    status: health.status,
    raw,
    uptime: null, // TODO: parse if available
    version: null,
    checkedAt: new Date().toISOString(),
  };
}

function getSessions() {
  // Try openclaw CLI for session listing
  const raw = run('openclaw sessions list --json 2>&1');
  try {
    return JSON.parse(raw);
  } catch {
    // Fallback: return raw
    return { raw, sessions: [] };
  }
}

module.exports = {
  getHealth,
  getChannelsStatus,
  getGatewayStatus,
  getSessions,
};
