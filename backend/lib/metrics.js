// Token usage history + cost estimation
// Stores rolling 24h of token snapshots for sparkline charts

const fs = require('fs');
const path = require('path');

const METRICS_DIR = path.join(process.env.HOME, '.klaw-control', 'metrics');
const HISTORY_FILE = path.join(METRICS_DIR, 'token-history.json');
const MAX_POINTS = 288; // 24h at 5-min intervals

// Cost per 1M tokens (rough estimates, input+output blended)
const MODEL_COSTS = {
  'claude-opus-4': 30.0,
  'claude-sonnet-4': 6.0,
  'claude-haiku': 1.0,
  'gpt-4o': 10.0,
  'gpt-4o-mini': 0.3,
  'o3': 20.0,
  'codex': 3.0,
  default: 5.0,
};

function ensureDir() {
  if (!fs.existsSync(METRICS_DIR)) {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
  }
}

function loadHistory() {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { snapshots: [], dailyCost: [] };
  }
}

function saveHistory(data) {
  ensureDir();
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record a token snapshot from current sessions
 */
function recordSnapshot(sessions) {
  const history = loadHistory();
  const now = Date.now();

  const totalTokens = sessions.reduce((sum, s) => sum + (s.tokensUsed || 0), 0);
  const bySession = {};
  for (const s of sessions) {
    if (s.tokensUsed > 0) {
      bySession[s.label || s.id] = s.tokensUsed;
    }
  }

  history.snapshots.push({
    t: now,
    total: totalTokens,
    sessions: bySession,
  });

  // Trim to MAX_POINTS
  if (history.snapshots.length > MAX_POINTS) {
    history.snapshots = history.snapshots.slice(-MAX_POINTS);
  }

  saveHistory(history);
  return { total: totalTokens, pointCount: history.snapshots.length };
}

/**
 * Get token history for sparkline chart
 */
function getTokenHistory(hours = 24) {
  const history = loadHistory();
  const cutoff = Date.now() - hours * 3600000;
  const points = history.snapshots
    .filter(s => s.t > cutoff)
    .map(s => ({ t: s.t, total: s.total }));
  return points;
}

/**
 * Get token deltas (rate of burn) for sparkline
 */
function getTokenBurnRate(hours = 24) {
  const history = loadHistory();
  const cutoff = Date.now() - hours * 3600000;
  const snapshots = history.snapshots.filter(s => s.t > cutoff);

  if (snapshots.length < 2) return [];

  const deltas = [];
  for (let i = 1; i < snapshots.length; i++) {
    const dt = (snapshots[i].t - snapshots[i - 1].t) / 60000; // minutes
    const dTokens = snapshots[i].total - snapshots[i - 1].total;
    deltas.push({
      t: snapshots[i].t,
      rate: dt > 0 ? Math.round(dTokens / dt) : 0, // tokens/min
      delta: Math.max(0, dTokens),
    });
  }
  return deltas;
}

/**
 * Estimate cost from token usage
 */
function estimateCost(sessions) {
  let totalCost = 0;
  for (const s of sessions) {
    const tokens = s.tokensUsed || 0;
    if (tokens === 0) continue;

    const model = (s.model || '').toLowerCase();
    let costPer1M = MODEL_COSTS.default;
    for (const [key, cost] of Object.entries(MODEL_COSTS)) {
      if (key !== 'default' && model.includes(key)) {
        costPer1M = cost;
        break;
      }
    }
    totalCost += (tokens / 1_000_000) * costPer1M;
  }
  return Math.round(totalCost * 100) / 100;
}

module.exports = {
  recordSnapshot,
  getTokenHistory,
  getTokenBurnRate,
  estimateCost,
};
