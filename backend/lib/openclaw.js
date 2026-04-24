// OpenClaw CLI wrappers — parse live state from the CLI

const { execSync } = require('child_process');
const PROGRESS_CACHE_TTL_MS = parseInt(process.env.KLAW_PROGRESS_CACHE_TTL_MS || '15000', 10);
const SESSION_HISTORY_LIMIT = parseInt(process.env.KLAW_PROGRESS_HISTORY_LIMIT || '120', 10);
const progressCache = new Map();

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
  } catch (e) {
    return e.stdout ? e.stdout.trim() : '';
  }
}

function parseJSON(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function textFromPayloadArray(payloads) {
  if (!Array.isArray(payloads)) return '';
  const texts = payloads
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      return firstNonEmptyString([
        item.text,
        item.message,
        item.content,
        item.value,
        item.output,
        item.reply,
      ]);
    })
    .filter(Boolean);
  return texts.join('\n').trim();
}

function extractReplyText(value) {
  const parsed = parseJSON(value) || value;
  if (!parsed) return '';

  if (typeof parsed === 'string') return parsed.trim();
  if (Array.isArray(parsed)) return textFromPayloadArray(parsed);
  if (typeof parsed !== 'object') return '';

  const topLevel = firstNonEmptyString([
    parsed.reply,
    parsed.message,
    parsed.text,
    parsed.output,
    parsed.fullReply,
    parsed.spokenReply,
  ]);
  if (topLevel) return topLevel;

  const result = parsed.result;
  if (result && typeof result === 'object') {
    const nested = firstNonEmptyString([
      result.reply,
      result.message,
      result.text,
      result.output,
      result.summary,
    ]);
    if (nested) return nested;

    const payloadText = textFromPayloadArray(result.payloads);
    if (payloadText) return payloadText;
  }

  const contentText = textFromPayloadArray(parsed.content);
  if (contentText) return contentText;

  return '';
}

function normalizeStepStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'done' || normalized === 'complete') return 'completed';
  if (normalized === 'in-progress') return 'in_progress';
  if (normalized === 'not_started') return 'pending';
  if (normalized === 'completed' || normalized === 'in_progress' || normalized === 'pending') {
    return normalized;
  }
  return 'pending';
}

function stepWeight(step) {
  const candidates = [step?.weight, step?.effort, step?.points, step?.estimate];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1;
}

function extractToolCalls(message) {
  const calls = [];
  if (Array.isArray(message?.tool_calls)) calls.push(...message.tool_calls);
  if (Array.isArray(message?.toolCalls)) calls.push(...message.toolCalls);
  if (Array.isArray(message?.toolInvocations)) calls.push(...message.toolInvocations);
  if (message?.tool_call && typeof message.tool_call === 'object') calls.push(message.tool_call);
  return calls;
}

function extractPlanFromToolCall(call) {
  const name = call?.name || call?.tool_name || call?.function?.name || call?.functionName;
  if (String(name || '').trim().toLowerCase() !== 'update_plan') return null;
  const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? call?.parameters;
  const parsedArgs = parseJSON(rawArgs) || (typeof rawArgs === 'object' ? rawArgs : null);
  if (!parsedArgs || !Array.isArray(parsedArgs.plan)) return null;
  return parsedArgs.plan;
}

function buildPlanProgress(plan) {
  const planSteps = [];
  let doneWeight = 0;
  let totalWeight = 0;
  let doneSteps = 0;

  for (const step of plan) {
    const labelRaw = step?.step ?? step?.title ?? step?.name;
    const label = typeof labelRaw === 'string' ? labelRaw.trim() : '';
    if (!label) continue;

    const status = normalizeStepStatus(step?.status);
    const weight = stepWeight(step);
    totalWeight += weight;
    if (status === 'completed') {
      doneSteps += 1;
      doneWeight += weight;
    }
    planSteps.push({ step: label, status, weight });
  }

  if (planSteps.length === 0 || totalWeight <= 0) return null;

  const progressPercent = Math.max(0, Math.min(100, Math.round((doneWeight / totalWeight) * 100)));
  return {
    progressPercent,
    progressSource: 'steps_weighted',
    planSteps,
    planDoneSteps: doneSteps,
    planTotalSteps: planSteps.length,
    planDoneWeight: doneWeight,
    planTotalWeight: totalWeight,
    planUpdatedAt: new Date().toISOString(),
  };
}

function tokenFallbackProgress(session) {
  if (session.status === 'completed') return 100;
  const used = Number(session.tokensUsed || 0);
  const limit = Number(session.tokensLimit || 0);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function getPlanProgressFromHistory(session) {
  if (!session.sessionKey) return null;
  const now = Date.now();
  const cached = progressCache.get(session.sessionKey);
  if (cached && (now - cached.ts) <= PROGRESS_CACHE_TTL_MS) {
    return cached.value;
  }

  const raw = run(`openclaw sessions history "${session.sessionKey}" --limit ${SESSION_HISTORY_LIMIT} --json 2>&1`);
  const parsed = parseJSON(raw);
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : (Array.isArray(parsed) ? parsed : []);
  let latestPlan = null;

  for (const message of messages) {
    const toolCalls = extractToolCalls(message);
    for (const call of toolCalls) {
      const maybePlan = extractPlanFromToolCall(call);
      if (Array.isArray(maybePlan)) latestPlan = maybePlan;
    }
  }

  const value = latestPlan ? buildPlanProgress(latestPlan) : null;
  progressCache.set(session.sessionKey, { ts: now, value });
  return value;
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

  // Parse the rich output — look for channel names and states
  // Format: "- Telegram default: enabled, configured, running, mode:polling..."
  // Format: "- Discord default: enabled, configured, running, disconnected, in:just now..."
  const lines = raw.split('\n');
  for (const line of lines) {
    const match = line.match(/^-\s+(\w+)\s+\w+:\s+(.+)$/);
    if (match) {
      const id = match[1].toLowerCase();
      const detail = match[2];
      const connected = detail.includes('running') && !detail.includes('disconnected');

      const inMatch = detail.match(/in:([^,]+)/);
      const lastIn = inMatch ? inMatch[1].trim() : null;

      channels.push({
        id,
        name: match[1],
        connected,
        status: connected ? 'connected' : detail.includes('disconnected') ? 'reconnecting' : 'offline',
        lastMessageIn: lastIn,
        raw: detail.trim(),
      });
    }
  }

  // If parsing got nothing, return raw
  if (channels.length === 0 && raw) {
    channels.push({ id: 'raw', connected: false, raw });
  }

  return channels;
}

function getGatewayStatus() {
  const raw = run('openclaw status 2>&1');

  // Parse key data from the table
  let version = null;
  let uptime = null;
  let sessionCount = null;
  let agentCount = null;
  let model = null;

  const versionMatch = raw.match(/app\s+([\d.]+)/);
  if (versionMatch) version = versionMatch[1];

  const sessionMatch = raw.match(/Sessions\s*│\s*(\d+)\s*active/);
  if (sessionMatch) sessionCount = parseInt(sessionMatch[1]);

  const agentMatch = raw.match(/Agents\s*│\s*(\d+)/);
  if (agentMatch) agentCount = parseInt(agentMatch[1]);

  const modelMatch = raw.match(/default\s+([\w-]+)\s*\(/);
  if (modelMatch) model = modelMatch[1];

  return {
    status: raw.includes('running') ? 'ok' : 'degraded',
    raw,
    version,
    uptime,
    sessionCount,
    agentCount,
    model,
    checkedAt: new Date().toISOString(),
  };
}

function listSessionRows(activeMinutes = 1440) {
  const raw = run(`openclaw sessions --json --active ${activeMinutes} 2>&1`);
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data?.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

function parseAgentId(sessionKey) {
  const match = String(sessionKey || '').match(/^agent:([^:]+):/);
  return match ? match[1] : null;
}

function resolveSessionId(sessionKey) {
  if (!sessionKey) return null;
  const rows = listSessionRows(10080);
  const match = rows.find((row) => row?.key === sessionKey || row?.sessionKey === sessionKey);
  return match?.sessionId || null;
}

function buildAgentSendArgs(sessionKey, message, options = {}) {
  const timeoutSeconds = Math.max(1, Math.ceil(Number(options.timeoutSeconds || 30)));
  const sessionId = resolveSessionId(sessionKey);
  const args = ['agent'];

  if (sessionId) {
    args.push('--session-id', sessionId);
  } else {
    const agentId = parseAgentId(sessionKey);
    const isMainSession = /^agent:[^:]+:main$/.test(String(sessionKey || ''));
    if (agentId && isMainSession) {
      args.push('--agent', agentId);
    } else {
      throw new Error(`Unable to resolve session id for ${sessionKey}`);
    }
  }

  args.push('--message', String(message || ''));
  args.push('--timeout', String(timeoutSeconds));

  if (options.json !== false) {
    args.push('--json');
  }

  return args;
}

function getSessions() {
  const raw = run('openclaw sessions --json --active 1440 2>&1');
  try {
    const data = JSON.parse(raw);
    const sessions = (data.sessions || []).map(s => {
      const key = s.key || '';
      const project = extractProject(key);
      const label = extractLabel(key);
      const ageMs = s.ageMs || 0;
      const isRecent = ageMs < 600000; // <10min

      // Accurate categorization
      let kind, task;
      if (key === 'agent:main:main') {
        kind = 'main';
        task = 'Main agent session';
      } else if (key.includes(':discord:') || key.includes(':telegram:')) {
        kind = 'channel';
        task = null; // Channels don't have tasks
      } else if (key.includes(':cron:')) {
        kind = 'cron';
        // Extract cron job name from key: "agent:main:cron:heartbeat" → "Heartbeat"
        const parts = key.split(':');
        const cronIndex = parts.indexOf('cron');
        const cronName = cronIndex >= 0 && parts[cronIndex + 1] ? parts[cronIndex + 1] : 'task';
        task = formatCronJobName(cronName);
      } else if (key.includes(':subagent:') || key.includes(':run:') || key.includes(':acp:')) {
        kind = 'sub-agent';
        // Try to extract task from session label
        const parts = key.split(':');
        const taskLabel = parts[parts.length - 1];
        task = taskLabel && taskLabel.length > 5 ? taskLabel : 'Agent task';
      } else {
        kind = 'other';
        task = null;
      }

      // Status: active only if recent activity
      let status;
      if (!isRecent) {
        status = 'idle';
      } else if (kind === 'channel') {
        status = 'active';
      } else {
        status = 'active';
      }

      // Add cron schedule info if it's a cron job
      let schedule = null;
      if (kind === 'cron') {
        const cronName = task ? task.toLowerCase().replace(/\s+/g, '_') : 'unknown';
        schedule = getCronScheduleInfo(cronName);
      }

      const tokensUsed = s.totalTokens || 0;
      const tokensLimit = s.contextTokens || 200000;
      const sessionBase = {
        sessionKey: key,
        kind,
        status,
        tokensUsed,
        tokensLimit,
      };

      let progressData = null;
      if (kind === 'sub-agent' && status === 'active' && key) {
        progressData = getPlanProgressFromHistory(sessionBase);
      }

      const fallbackPercent = tokenFallbackProgress(sessionBase);
      const progressPercent = progressData?.progressPercent ?? fallbackPercent;
      const progressSource = progressData?.progressSource || (progressPercent !== null ? 'tokens_fallback' : 'none');

      return {
        id: s.sessionId || key,
        label: project || label,
        kind,
        status,
        task: status === 'idle' ? null : task, // Clear task when idle
        model: s.model || null,
        sessionKey: key,
        startedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
        lastActivity: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
        elapsedSeconds: s.ageMs ? s.ageMs / 1000 : null,
        project,
        tokensUsed,
        tokensLimit,
        progressPercent,
        progressSource,
        planSteps: progressData?.planSteps || null,
        planDoneSteps: progressData?.planDoneSteps ?? null,
        planTotalSteps: progressData?.planTotalSteps ?? null,
        planDoneWeight: progressData?.planDoneWeight ?? null,
        planTotalWeight: progressData?.planTotalWeight ?? null,
        planUpdatedAt: progressData?.planUpdatedAt ?? null,
        schedule,  // For cron jobs
      };
    });

    return { sessions };
  } catch {
    return { raw, sessions: [] };
  }
}

function formatCronJobName(cronName) {
  // Convert "heartbeat" → "Heartbeat"
  // "daily_cleanup" → "Daily Cleanup"
  return cronName
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getCronScheduleInfo(cronName) {
  // Map known cron jobs to human-readable schedules
  const schedules = {
    'heartbeat': { description: 'Health check', schedule: 'Every 30 minutes' },
    'daily_cleanup': { description: 'Clean up old sessions', schedule: 'Daily at midnight' },
    'token_sync': { description: 'Sync token metrics', schedule: 'Every 5 minutes' },
    'email_digest': { description: 'Send email digest', schedule: 'Daily at 9 AM' },
    'backup': { description: 'Database backup', schedule: 'Every 6 hours' },
    'metrics': { description: 'Collect metrics', schedule: 'Every 5 minutes' },
    'alerts': { description: 'Check alerts', schedule: 'Every 1 minute' },
  };
  return schedules[cronName] || { description: 'Scheduled task', schedule: 'Custom schedule' };
}

function extractLabel(key) {
  // "agent:main:discord:channel:1479104379402322130" → "discord"
  // "agent:main:cron:5a0d4a52..." → "cron"
  if (!key) return 'unknown';
  const parts = key.split(':');
  if (parts.includes('discord')) return 'discord';
  if (parts.includes('telegram')) return 'telegram';
  if (parts.includes('cron')) return 'cron';
  return parts[2] || parts[0] || 'session';
}

function extractProject(key) {
  // Try to map channel IDs to project names
  // This could be made configurable
  if (!key) return null;
  if (key.includes('1479104379402322130')) return '#klaw-control';
  if (key.includes('1471523072946475185')) return '#sousiq';
  if (key.includes('1471683763007262793')) return '#underwriting';
  if (key.includes('1473800794892406924')) return '#ct-alerts';
  if (key.includes('1471523073856503993')) return '#cleanmybox';
  if (key.includes('1472822763151556761')) return '#collective-theory';
  if (key.includes('1471507451256901634')) return '#general';
  if (key.includes('cron:')) return 'cron job';
  return null;
}

function getSubAgents() {
  // Get active sessions that look like sub-agents (spawned sessions, not channels/cron)
  const raw = run('openclaw sessions --json --active 120 2>&1');
  try {
    const data = JSON.parse(raw);
    const sessions = (data.sessions || []);
    
    // Categorize sessions
    const subAgents = [];
    const mainSessions = [];
    
    for (const s of sessions) {
      const key = s.key || '';
      const session = {
        id: s.sessionId || key,
        sessionKey: key,
        model: s.model || null,
        tokensUsed: s.totalTokens || 0,
        tokensLimit: s.contextTokens || 200000,
        lastActivity: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
        ageMs: s.ageMs || 0,
        agentId: s.agentId || 'main',
        kind: s.kind || 'unknown',
      };
      
      if (key.includes(':discord:') || key.includes(':telegram:')) {
        session.type = 'channel';
        session.label = extractLabel(key);
        session.project = extractProject(key);
        mainSessions.push(session);
      } else if (key.includes(':cron:')) {
        session.type = 'cron';
        session.label = 'Cron Job';
        mainSessions.push(session);
      } else if (key.includes(':subagent:') || key.includes(':run:') || key.includes(':acp:')) {
        session.type = 'subagent';
        session.label = key.split(':').pop() || 'sub-agent';
        // Try to extract task from session label
        const labelMatch = key.match(/:([^:]+)$/);
        session.taskSummary = labelMatch ? labelMatch[1] : null;
        subAgents.push(session);
      } else {
        session.type = 'other';
        session.label = key.split(':').pop() || 'session';
        mainSessions.push(session);
      }
    }
    
    return { subAgents, mainSessions, total: sessions.length };
  } catch {
    return { raw, subAgents: [], mainSessions: [], total: 0 };
  }
}

function getSessionMessages(sessionKey, limit = 20) {
  // Use openclaw sessions history command
  const raw = run(`openclaw sessions history "${sessionKey}" --limit ${limit} --json 2>&1`);
  try {
    const data = JSON.parse(raw);
    return (data.messages || data || []).map(m => ({
      role: m.role || 'unknown',
      content: typeof m.content === 'string' ? m.content.slice(0, 2000) : JSON.stringify(m.content).slice(0, 2000),
      timestamp: m.timestamp || null,
      toolCalls: m.tool_calls ? m.tool_calls.length : 0,
    }));
  } catch {
    // Fallback: try non-JSON output
    return [{ role: 'system', content: raw.slice(0, 2000), timestamp: null, toolCalls: 0 }];
  }
}

module.exports = {
  extractReplyText,
  buildAgentSendArgs,
  getHealth,
  getChannelsStatus,
  getGatewayStatus,
  getSessions,
  getSubAgents,
  getSessionMessages,
  resolveSessionId,
};
