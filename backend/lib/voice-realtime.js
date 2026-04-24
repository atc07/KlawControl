const { spawn } = require('child_process');
const crypto = require('crypto');
const openclaw = require('./openclaw');
const { resolveTargetSession } = require('./voice-routing');

const DEFAULTS = {
  silenceDurationMs: 450,
  prefixPaddingMs: 250,
  threshold: 0.55,
  maxTurnMs: 30000,
  deltaChunkChars: 36,
  deltaCadenceMs: 35,
};

function nowMs() {
  return Date.now();
}

function makeTurnId() {
  return `turn_${crypto.randomBytes(6).toString('hex')}`;
}

function safeParseJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sentenceOrSnippet(text, maxChars = 220) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  const sentence = cleaned.split(/[.!?]\s/)[0];
  if (sentence && sentence.length >= 8 && sentence.length <= maxChars) {
    return sentence.endsWith('.') ? sentence : `${sentence}.`;
  }
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

function chunkText(text, chunkSize = DEFAULTS.deltaChunkChars) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return [];
  const chunks = [];
  let cursor = 0;
  while (cursor < cleaned.length) {
    const end = Math.min(cleaned.length, cursor + chunkSize);
    chunks.push(cleaned.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

function rmsNormFromPCM16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return 0;
  const samples = Math.floor(buffer.length / 2);
  if (samples <= 0) return 0;

  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = buffer.readInt16LE(i * 2);
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples);
}

function vadScoreFromRms(rms) {
  // RMS is typically very small for speech (0.01-0.08), so map it into a 0-1 score.
  return Math.max(0, Math.min(1, rms * 20));
}

function sendEvent(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function runOpenClawSend(sessionKey, text, timeoutMs = DEFAULTS.maxTurnMs) {
  const args = openclaw.buildAgentSendArgs(sessionKey, text, {
    timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
    json: true,
  });

  const child = spawn('openclaw', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const promise = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `openclaw exited with code ${code}`));
        return;
      }

      const parsed = safeParseJSON(stdout.trim());
      if (parsed) {
        resolve({
          reply: openclaw.extractReplyText(parsed) || stdout.trim(),
          raw: parsed,
        });
        return;
      }

      resolve({
        reply: stdout.trim() || stderr.trim(),
        raw: null,
      });
    });
  });

  return { child, promise };
}

class RealtimeVoiceSession {
  constructor(ws) {
    this.ws = ws;
    this.sessionId = null;
    this.channelHint = null;

    this.vad = {
      speech: false,
      lastSpeechAt: 0,
      speechStartedAt: 0,
      turnId: null,
    };

    this.latestTranscript = '';
    this.latestTranscriptStability = 0;
    this.turnInFlight = false;
    this.turnInterrupted = false;
    this.activeChild = null;
    this.streamTask = null;
    this.pendingTurnText = null;
    this.metrics = {};
  }

  handleRawMessage(raw) {
    const data = safeParseJSON(raw);
    if (!data || !data.type) return;

    switch (data.type) {
    case 'voice.session.start':
      this.handleSessionStart(data);
      break;
    case 'audio.chunk':
      this.handleAudioChunk(data);
      break;
    case 'audio.flush':
      this.handleAudioFlush(data);
      break;
    case 'transcript.partial':
      this.handleTranscriptPartial(data);
      break;
    case 'transcript.final':
      this.handleTranscriptFinal(data);
      break;
    case 'assistant.interrupt':
      this.handleAssistantInterrupt(data.reason || 'barge_in');
      break;
    case 'voice.session.stop':
      this.cleanup();
      break;
    default:
      sendEvent(this.ws, 'error', {
        code: 'unknown_event',
        message: `Unsupported event: ${data.type}`,
        recoverable: true,
      });
      break;
    }
  }

  handleSessionStart(data) {
    this.sessionId = data.sessionId || crypto.randomUUID();
    this.channelHint = data.channelHint || null;
    sendEvent(this.ws, 'voice.session.started', {
      sessionId: this.sessionId,
      vad: {
        silence_duration_ms: DEFAULTS.silenceDurationMs,
        prefix_padding_ms: DEFAULTS.prefixPaddingMs,
        threshold: DEFAULTS.threshold,
      },
    });
  }

  handleAudioChunk(data) {
    const chunk = Buffer.from(data.pcm16_b64 || '', 'base64');
    if (!chunk.length) return;
    const tNow = nowMs();
    const rms = rmsNormFromPCM16(chunk);
    const vadScore = vadScoreFromRms(rms);
    const isSpeech = vadScore >= DEFAULTS.threshold;

    if (isSpeech) {
      this.vad.lastSpeechAt = tNow;
      if (!this.vad.speech) {
        this.vad.speech = true;
        this.vad.speechStartedAt = tNow;
        this.vad.turnId = makeTurnId();
        this.metrics.firstSpeechFrameAt = this.metrics.firstSpeechFrameAt || tNow;
        sendEvent(this.ws, 'vad.speech_started', {
          tServerMs: tNow,
          turnId: this.vad.turnId,
          vadScore: Number(vadScore.toFixed(4)),
          rms: Number(rms.toFixed(4)),
        });
      }
      return;
    }

    if (this.vad.speech && tNow - this.vad.lastSpeechAt >= DEFAULTS.silenceDurationMs) {
      this.vad.speech = false;
      this.metrics.speechStoppedAt = tNow;
      sendEvent(this.ws, 'vad.speech_stopped', {
        tServerMs: tNow,
        turnId: this.vad.turnId || makeTurnId(),
      });
    }
  }

  handleTranscriptPartial(data) {
    const text = String(data.text || '').trim();
    if (!text) return;
    this.latestTranscript = text;
    this.latestTranscriptStability = Number(data.stability || 0);
    sendEvent(this.ws, 'transcript.partial', {
      turnId: data.turnId || this.vad.turnId || makeTurnId(),
      text,
      stability: this.latestTranscriptStability,
    });
  }

  handleTranscriptFinal(data) {
    const text = String(data.text || '').trim();
    if (!text) return;
    this.latestTranscript = text;
    const turnId = data.turnId || this.vad.turnId || makeTurnId();
    this.metrics.transcriptFinalAt = nowMs();
    sendEvent(this.ws, 'transcript.final', { turnId, text });
    this.startTurn(turnId, text);
  }

  handleAudioFlush(data) {
    const explicit = String(data.transcript || '').trim();
    const text = explicit || this.latestTranscript;
    if (!text) return;
    const turnId = data.turnId || this.vad.turnId || makeTurnId();
    sendEvent(this.ws, 'transcript.final', { turnId, text });
    this.startTurn(turnId, text);
  }

  handleAssistantInterrupt(reason) {
    this.turnInterrupted = true;
    if (this.activeChild) {
      try { this.activeChild.kill('SIGTERM'); } catch {}
      this.activeChild = null;
    }
    if (this.streamTask) {
      clearInterval(this.streamTask);
      this.streamTask = null;
    }
    sendEvent(this.ws, 'assistant.interrupted', {
      reason,
      tServerMs: nowMs(),
    });
  }

  startTurn(turnId, transcript) {
    if (this.turnInFlight) {
      this.pendingTurnText = { turnId, transcript };
      return;
    }

    this.turnInFlight = true;
    this.turnInterrupted = false;
    this.metrics = {
      micOpenAt: this.metrics.micOpenAt || nowMs(),
      transcriptFinalAt: nowMs(),
      firstAssistantTokenAt: null,
      firstAssistantAudioAt: null,
    };

    this.processTurn(turnId, transcript)
      .catch((err) => {
        sendEvent(this.ws, 'error', {
          code: 'assistant_failed',
          message: err.message || 'Failed to process turn',
          recoverable: true,
        });
      })
      .finally(() => {
        this.turnInFlight = false;
        this.activeChild = null;
        if (this.pendingTurnText) {
          const pending = this.pendingTurnText;
          this.pendingTurnText = null;
          this.startTurn(pending.turnId, pending.transcript);
        }
      });
  }

  async processTurn(turnId, transcript) {
    const startedAt = nowMs();
    const { sessionKey, channelName, routed } = resolveTargetSession(transcript, this.channelHint);

    const sendTask = runOpenClawSend(sessionKey, transcript, DEFAULTS.maxTurnMs);
    this.activeChild = sendTask.child || null;

    let reply;
    try {
      const result = await sendTask.promise;
      reply = String(result.reply || '').trim();
    } catch (error) {
      if (this.turnInterrupted) {
        sendEvent(this.ws, 'turn.done', {
          turnId,
          interrupted: true,
          metrics: {
            elapsed_ms: nowMs() - startedAt,
          },
        });
        return;
      }
      throw error;
    }

    if (this.turnInterrupted) {
      sendEvent(this.ws, 'turn.done', {
        turnId,
        interrupted: true,
        metrics: {
          elapsed_ms: nowMs() - startedAt,
        },
      });
      return;
    }

    const spokenReply = sentenceOrSnippet(reply || "I couldn't produce a response.", 220);
    const deltas = chunkText(spokenReply, DEFAULTS.deltaChunkChars);

    await new Promise((resolve) => {
      if (deltas.length === 0) {
        resolve();
        return;
      }
      let index = 0;
      this.streamTask = setInterval(() => {
        if (this.turnInterrupted) {
          clearInterval(this.streamTask);
          this.streamTask = null;
          resolve();
          return;
        }
        if (index >= deltas.length) {
          clearInterval(this.streamTask);
          this.streamTask = null;
          resolve();
          return;
        }
        if (!this.metrics.firstAssistantTokenAt) {
          this.metrics.firstAssistantTokenAt = nowMs();
        }
        sendEvent(this.ws, 'assistant.text.delta', {
          turnId,
          textDelta: deltas[index],
          channel: channelName,
          routed,
        });
        index += 1;
      }, DEFAULTS.deltaCadenceMs);
    });

    if (this.turnInterrupted) {
      sendEvent(this.ws, 'turn.done', {
        turnId,
        interrupted: true,
        metrics: {
          elapsed_ms: nowMs() - startedAt,
        },
      });
      return;
    }

    this.metrics.firstAssistantAudioAt = this.metrics.firstAssistantAudioAt || nowMs();
    sendEvent(this.ws, 'assistant.text.final', {
      turnId,
      text: spokenReply,
      fullText: reply,
      channel: channelName,
      routed,
    });
    sendEvent(this.ws, 'assistant.audio.done', { turnId });
    const turnMetrics = {
      elapsed_ms: nowMs() - startedAt,
      speech_to_final_ms: this.metrics.transcriptFinalAt ? nowMs() - this.metrics.transcriptFinalAt : null,
      first_token_ms: this.metrics.firstAssistantTokenAt && this.metrics.transcriptFinalAt
        ? this.metrics.firstAssistantTokenAt - this.metrics.transcriptFinalAt
        : null,
      first_audio_ms: this.metrics.firstAssistantAudioAt && this.metrics.transcriptFinalAt
        ? this.metrics.firstAssistantAudioAt - this.metrics.transcriptFinalAt
        : null,
    };
    sendEvent(this.ws, 'turn.done', {
      turnId,
      metrics: turnMetrics,
    });

    // Structured log fields for rollout monitoring.
    console.log('[voice-realtime] turn.complete', JSON.stringify({
      turnId,
      sessionKey,
      channel: channelName,
      voice_turn_latency_ms: turnMetrics.elapsed_ms,
      first_token_ms: turnMetrics.first_token_ms,
      first_audio_ms: turnMetrics.first_audio_ms,
      routed,
    }));
  }

  cleanup() {
    this.turnInterrupted = true;
    if (this.activeChild) {
      try { this.activeChild.kill('SIGTERM'); } catch {}
      this.activeChild = null;
    }
    if (this.streamTask) {
      clearInterval(this.streamTask);
      this.streamTask = null;
    }
  }
}

function handleConnection(ws) {
  const session = new RealtimeVoiceSession(ws);
  ws.on('message', (raw) => session.handleRawMessage(raw.toString('utf8')));
  ws.on('close', () => session.cleanup());
  ws.on('error', () => session.cleanup());
}

module.exports = {
  handleConnection,
};
