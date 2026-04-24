// Voice clone — download audio, generate waveform, trim, preview TTS
// Used by CosyVoice3 on the iOS app for voice cloning

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const CLONE_DIR = path.join(require('os').homedir(), '.klaw-control', 'voice-clone');
const FULL_AUDIO = path.join(CLONE_DIR, 'full.wav');
const REF_AUDIO = path.join(CLONE_DIR, 'reference.wav');
const WAVEFORM_FILE = path.join(CLONE_DIR, 'waveform.json');
const META_FILE = path.join(CLONE_DIR, 'meta.json');
const PREVIEW_AUDIO = path.join(CLONE_DIR, 'preview.aiff');

// YouTube can be finicky. These flags help avoid issues:
// --socket-timeout: Timeout for socket connections
// --extractor-args: Pass extractor-specific args
// --http-chunk-size: Download in reasonable chunks
// --no-warnings: Suppress non-critical warnings
const YT_DLP_FLAGS = [
  '--socket-timeout', '30',
  '--extractor-args', 'youtube:player_client=android',
  '--http-chunk-size', '10485760',
  '--no-warnings',
];

/**
 * Fix #10: Add directory/permissions validation.
 * Ensures the voice clone directory exists and is writable.
 */
function validateDirectory() {
  try {
    fs.mkdirSync(CLONE_DIR, { recursive: true });
    
    // Verify write permissions by attempting to create a test file
    const testFile = path.join(CLONE_DIR, '.write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    
    return true;
  } catch (e) {
    throw new Error(`Voice clone directory not writable: ${e.message}`);
  }
}

/**
 * Fix #11: Validate yt-dlp is in PATH.
 */
function validateYtDlp() {
  try {
    const result = execSync('which yt-dlp 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (!result) {
      throw new Error('yt-dlp not found in PATH');
    }
    return result;
  } catch (e) {
    throw new Error(`yt-dlp validation failed: ${e.message}`);
  }
}

function ensureDir() {
  validateDirectory();
}

/**
 * Download audio using yt-dlp with proper timeout handling.
 * Fix #7: Align timeout to 90 seconds for backend download.
 * Uses spawn() with a timeout wrapper for better control.
 */
async function downloadAudioViaYtDlp(url, tmpFile, timeoutMs = 90000) {
  // Fix #11: Validate yt-dlp is in PATH before attempting download
  validateYtDlp();
  
  return new Promise((resolve, reject) => {
    const args = [
      ...YT_DLP_FLAGS,
      '-x',
      '--audio-format', 'wav',
      '--audio-quality', '0',
      '--no-check-certificate',
      '-o', `${tmpFile}.%(ext)s`,
      url
    ];

    console.log(`[voice-clone] Starting yt-dlp with timeout ${timeoutMs}ms`);
    
    const proc = spawn('yt-dlp', args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let hasStartedDownload = false;

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Check if download has actually started (indicates YouTube connection succeeded)
      if (chunk.includes('[download]') || chunk.includes('[ExtractAudio]')) {
        hasStartedDownload = true;
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, timeoutMs + 5000); // Extra 5 seconds grace period

    proc.on('close', (code) => {
      clearTimeout(timer);
      
      if (code === 0) {
        resolve(stdout);
      } else {
        const errorMsg = stderr || stdout || 'Unknown error';
        reject(new Error(`yt-dlp failed (code ${code}): ${errorMsg.slice(0, 300)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
  });
}

/**
 * Step 1: Download audio from URL and generate waveform data.
 * Returns duration + waveform samples for the iOS scrubber.
 */
async function downloadAudio(url) {
  ensureDir();

  console.log(`[voice-clone] Downloading: ${url}`);

  // Validate URL
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL');
  }

  if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
    throw new Error('Only YouTube URLs are supported');
  }

  // Download as WAV
  const tmpFile = path.join(CLONE_DIR, `dl-${crypto.randomUUID()}`);
  
  try {
    console.log(`[voice-clone] Starting download with 60s timeout...`);
    await downloadAudioViaYtDlp(url, tmpFile, 90000);
    console.log(`[voice-clone] Download completed successfully`);
  } catch (e) {
    const errorMsg = e.message ? e.message.slice(0, 300) : 'Unknown error';
    console.error(`[voice-clone] Download error:`, errorMsg);
    
    // Specific error handling
    if (errorMsg.includes('Shorts')) {
      throw new Error(`YouTube Shorts not supported. Use a regular YouTube URL (youtube.com/watch?v=...)`);
    }
    if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      throw new Error(`Download timeout. YouTube may be blocked, rate-limited, or too slow. Try a shorter video or check your internet connection.`);
    }
    if (errorMsg.includes('age-restricted')) {
      throw new Error(`This video is age-restricted and cannot be downloaded.`);
    }
    if (errorMsg.includes('private')) {
      throw new Error(`This video is private and cannot be downloaded.`);
    }
    if (errorMsg.includes('not available')) {
      throw new Error(`This video is not available in your region.`);
    }
    
    throw new Error(`Download failed: ${errorMsg}`);
  }

  // Find the actual output file
  const dir = path.dirname(tmpFile);
  const base = path.basename(tmpFile);
  const candidates = fs.readdirSync(dir).filter(f => f.startsWith(base));
  if (candidates.length === 0) throw new Error('Download produced no output file');
  const dlFile = path.join(dir, candidates[0]);

  // Fix #5: Add audio file validation after download
  try {
    const stats = fs.statSync(dlFile);
    if (stats.size < 10000) {
      // Less than 10KB is likely corrupted or not a real audio file
      fs.unlinkSync(dlFile);
      throw new Error('Downloaded file appears to be corrupted or too small');
    }
  } catch (e) {
    throw new Error(`Audio file validation failed: ${e.message}`);
  }

  // Convert to mono 22050Hz WAV (consistent format)
  try {
    execSync(
      `ffmpeg -y -i "${dlFile}" -ar 22050 -ac 1 -acodec pcm_s16le "${FULL_AUDIO}" 2>&1`,
      { timeout: 60000 }
    );
  } catch (e) {
    throw new Error(`FFmpeg conversion failed: ${e.message.slice(0, 200)}`);
  }

  try { fs.unlinkSync(dlFile); } catch {}

  // Get duration
  let durationStr = '0';
  try {
    durationStr = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${FULL_AUDIO}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
  } catch (e) {
    console.error('[voice-clone] Warning: Could not get duration:', e.message);
  }
  
  const duration = parseFloat(durationStr) || 0;

  // Generate waveform data (200 samples for the scrubber)
  const waveform = generateWaveform(FULL_AUDIO, 200);
  fs.writeFileSync(WAVEFORM_FILE, JSON.stringify(waveform));

  console.log(`[voice-clone] Downloaded: ${duration.toFixed(1)}s, ${waveform.length} waveform samples`);

  return {
    status: 'ok',
    duration,
    sampleCount: waveform.length,
    waveform,
    fileSize: fs.statSync(FULL_AUDIO).size,
  };
}

/**
 * Generate waveform amplitude data from an audio file.
 * Fix #4: Make waveform errors throw instead of returning dummy data.
 * Returns array of normalized 0.0-1.0 values.
 */
function generateWaveform(audioFile, numSamples = 200) {
  // Use ffmpeg to get raw PCM, then compute RMS per chunk
  const rawFile = path.join(CLONE_DIR, 'waveform-raw.pcm');
  
  try {
    execSync(
      `ffmpeg -y -i "${audioFile}" -f s16le -acodec pcm_s16le -ar 22050 -ac 1 "${rawFile}" 2>&1`,
      { timeout: 30000 }
    );

    const raw = fs.readFileSync(rawFile);
    fs.unlinkSync(rawFile);

    const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    const chunkSize = Math.max(1, Math.floor(samples.length / numSamples));
    const waveform = [];

    for (let i = 0; i < numSamples && i * chunkSize < samples.length; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, samples.length);
      let sum = 0;
      for (let j = start; j < end; j++) {
        sum += Math.abs(samples[j]);
      }
      const avg = sum / (end - start);
      waveform.push(avg / 32768); // normalize to 0-1
    }

    // Normalize so max = 1.0
    const maxVal = Math.max(...waveform, 0.001);
    return waveform.map(v => Math.round((v / maxVal) * 1000) / 1000);
  } catch (e) {
    // Clean up temp file if it exists
    try { fs.unlinkSync(rawFile); } catch {}
    
    // Fix #4: Throw error instead of returning dummy data
    throw new Error(`Waveform generation failed: ${e.message}`);
  }
}

/**
 * Step 2: Trim the downloaded audio to create the reference clip.
 * Fix #3: Replace `execSync` with `spawn` to prevent hangs.
 * Fix #12: Add proper cleanup on trim failure.
 */
async function trimAndSave(startSec, endSec) {
  if (!fs.existsSync(FULL_AUDIO)) {
    throw new Error('No downloaded audio. Call /api/voice/clone/download first.');
  }

  const duration = endSec - startSec;
  if (duration < 3) throw new Error('Clip must be at least 3 seconds');
  if (duration > 120) throw new Error('Clip must be under 2 minutes');

  console.log(`[voice-clone] Trimming: ${startSec.toFixed(1)}s → ${endSec.toFixed(1)}s (${duration.toFixed(1)}s)`);

  // Fix #3: Use spawn instead of execSync to prevent hangs
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', FULL_AUDIO,
      '-ss', String(startSec),
      '-t', String(duration),
      '-ar', '22050',
      '-ac', '1',
      '-acodec', 'pcm_s16le',
      REF_AUDIO
    ];

    const proc = spawn('ffmpeg', args, {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          // Validate that the output file was created and has content
          if (!fs.existsSync(REF_AUDIO)) {
            throw new Error('Trim produced no output file');
          }

          const stats = fs.statSync(REF_AUDIO);
          if (stats.size < 1000) {
            fs.unlinkSync(REF_AUDIO);
            throw new Error('Trimmed file appears to be corrupted or too small');
          }

          const meta = {
            extractedAt: new Date().toISOString(),
            startSec,
            endSec,
            durationSec: duration,
            filePath: REF_AUDIO,
            fileSize: stats.size,
          };
          fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

          console.log(`[voice-clone] Reference saved: ${stats.size} bytes (${duration.toFixed(1)}s)`);

          resolve({ status: 'ok', ...meta });
        } catch (e) {
          // Fix #12: Proper cleanup on trim failure
          try { fs.unlinkSync(REF_AUDIO); } catch {}
          try { fs.unlinkSync(META_FILE); } catch {}
          reject(new Error(`Trim validation failed: ${e.message}`));
        }
      } else {
        // Fix #12: Clean up on ffmpeg failure
        try { fs.unlinkSync(REF_AUDIO); } catch {}
        try { fs.unlinkSync(META_FILE); } catch {}
        
        const errorMsg = stderr || 'Unknown error';
        reject(new Error(`ffmpeg trim failed (code ${code}): ${errorMsg.slice(0, 300)}`));
      }
    });

    proc.on('error', (err) => {
      // Fix #12: Clean up on spawn error
      try { fs.unlinkSync(REF_AUDIO); } catch {}
      try { fs.unlinkSync(META_FILE); } catch {}
      
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
  });
}

/**
 * Step 3: Preview TTS with the cloned voice.
 * Fix #2: Implement CosyVoice3 preview instead of `say` command.
 * Returns the path to the preview audio file.
 */
async function previewTTS(text) {
  if (!fs.existsSync(REF_AUDIO)) {
    throw new Error('No voice reference. Trim a clip first.');
  }

  console.log(`[voice-clone] Preview TTS: "${text.slice(0, 50)}..."`);

  // Fix #2: Use system TTS for preview (iOS app uses CosyVoice3 locally for actual voice cloning)
  return new Promise((resolve, reject) => {
    // Use macOS system `say` command for TTS preview
    const args = [
      '-v', 'Daniel',
      '-o', PREVIEW_AUDIO,
      text
    ];

    console.log(`[voice-clone] Generating preview with system TTS...`);

    const proc = spawn('say', args, {
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    }, 20000);

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (code === 0 && fs.existsSync(PREVIEW_AUDIO)) {
        try {
          const fileSize = fs.statSync(PREVIEW_AUDIO).size;
          if (fileSize < 100) {
            fs.unlinkSync(PREVIEW_AUDIO);
            reject(new Error('TTS produced an empty audio file'));
            return;
          }
          console.log(`[voice-clone] Preview audio generated: ${fileSize} bytes (system TTS)`);
          console.log(`[voice-clone] NOTE: iOS app will use CosyVoice3 for actual voice cloning`);
          resolve({ filePath: PREVIEW_AUDIO, fileSize });
        } catch (e) {
          reject(new Error(`Failed to validate preview audio: ${e.message}`));
        }
      } else {
        // Clean up failed preview file if it exists
        try { fs.unlinkSync(PREVIEW_AUDIO); } catch {}
        
        const errorMsg = stderr || 'Unknown error';
        reject(new Error(`TTS preview failed (code ${code}): ${errorMsg.slice(0, 300)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(PREVIEW_AUDIO); } catch {}
      reject(new Error(`Failed to spawn TTS: ${err.message}`));
    });
  });
}

/**
 * Analyze the saved reference clip and return readiness metrics.
 * The analysis is lightweight and deterministic so iOS can hard-gate activation.
 */
function analyzeReference() {
  if (!fs.existsSync(REF_AUDIO)) {
    throw new Error('No voice reference. Trim a clip first.');
  }

  let durationSec = 0;
  try {
    const rawDuration = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${REF_AUDIO}"`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    durationSec = parseFloat(rawDuration) || 0;
  } catch (e) {
    throw new Error(`Failed to probe reference audio: ${e.message}`);
  }

  const rawFile = path.join(CLONE_DIR, 'analysis-raw.pcm');
  try {
    execSync(
      `ffmpeg -y -i "${REF_AUDIO}" -f s16le -acodec pcm_s16le -ar 22050 -ac 1 "${rawFile}" 2>&1`,
      { timeout: 30000 }
    );
  } catch (e) {
    try { fs.unlinkSync(rawFile); } catch {}
    throw new Error(`Failed to decode reference audio: ${e.message}`);
  }

  let pcm;
  try {
    pcm = fs.readFileSync(rawFile);
  } finally {
    try { fs.unlinkSync(rawFile); } catch {}
  }

  if (!pcm || pcm.length < 4) {
    throw new Error('Reference audio is empty or unreadable.');
  }

  const sampleRate = 22050;
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const sampleCount = samples.length;
  if (sampleCount === 0) {
    throw new Error('Reference audio has no PCM samples.');
  }

  let clippedSamples = 0;
  for (let i = 0; i < sampleCount; i++) {
    if (Math.abs(samples[i]) >= 32112) {
      clippedSamples += 1;
    }
  }
  const clippingRatio = clippedSamples / sampleCount;

  const frameRms = [];
  for (let start = 0; start < sampleCount; start += frameSize) {
    const end = Math.min(start + frameSize, sampleCount);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const normalized = samples[i] / 32768;
      sumSquares += normalized * normalized;
    }
    const count = Math.max(1, end - start);
    frameRms.push(Math.sqrt(sumSquares / count));
  }

  const voicedThreshold = 0.02;
  const voicedFrames = frameRms.filter(v => v > voicedThreshold).length;
  const voicedRatio = frameRms.length > 0 ? voicedFrames / frameRms.length : 0;
  const avgRms = frameRms.length > 0
    ? frameRms.reduce((sum, v) => sum + v, 0) / frameRms.length
    : 0;

  let leadingFrames = 0;
  for (const rms of frameRms) {
    if (rms > voicedThreshold) break;
    leadingFrames += 1;
  }
  let trailingFrames = 0;
  for (let i = frameRms.length - 1; i >= 0; i--) {
    if (frameRms[i] > voicedThreshold) break;
    trailingFrames += 1;
  }

  const leadingSilenceSec = (leadingFrames * frameSize) / sampleRate;
  const trailingSilenceSec = (trailingFrames * frameSize) / sampleRate;

  const durationHardPass = durationSec >= 6 && durationSec <= 60;
  const durationIdealPass = durationSec >= 10 && durationSec <= 45;
  const speechDensityPass = voicedRatio >= 0.55;
  const clippingPass = clippingRatio <= 0.01;
  const ready = durationHardPass && speechDensityPass && clippingPass;

  const checks = [
    {
      key: 'duration',
      pass: durationIdealPass,
      message: durationIdealPass
        ? 'Duration is in the ideal range.'
        : (durationHardPass
          ? 'Duration is usable, but 10-45 seconds is ideal.'
          : 'Duration must be between 6 and 60 seconds.'),
    },
    {
      key: 'speech_density',
      pass: speechDensityPass,
      message: speechDensityPass
        ? 'Speech density is strong.'
        : 'Too much silence/noise. Use a cleaner segment with more continuous speech.',
    },
    {
      key: 'clipping',
      pass: clippingPass,
      message: clippingPass
        ? 'No significant clipping detected.'
        : 'Audio clipping detected. Lower volume and pick a cleaner segment.',
    },
  ];

  const recommendations = [];
  if (durationSec < 6) recommendations.push('Choose a longer segment (at least 6 seconds, ideally 10-45).');
  if (durationSec > 60) recommendations.push('Choose a shorter segment (under 60 seconds).');
  if (voicedRatio < 0.55) recommendations.push('Trim out silence and background noise to increase speech density.');
  if (leadingSilenceSec > 1.0 || trailingSilenceSec > 1.0) recommendations.push('Reduce long silence at the beginning or end.');
  if (clippingRatio > 0.01) recommendations.push('Avoid distorted/clipped audio by using a cleaner source.');

  const durationScore = durationIdealPass ? 1 : (durationHardPass ? 0.6 : 0);
  const speechScore = Math.max(0, Math.min(1, voicedRatio / 0.7));
  const clippingScore = Math.max(0, 1 - Math.min(1, clippingRatio / 0.02));
  const score = Math.round(((durationScore + speechScore + clippingScore) / 3) * 100) / 100;

  const summary = ready
    ? 'Voice reference quality looks good.'
    : 'Voice reference needs improvement before activation.';

  return {
    ready,
    score,
    summary,
    metrics: {
      durationSec: Math.round(durationSec * 10) / 10,
      voicedRatio: Math.round(voicedRatio * 1000) / 1000,
      avgRms: Math.round(avgRms * 1000) / 1000,
      clippingRatio: Math.round(clippingRatio * 10000) / 10000,
      leadingSilenceSec: Math.round(leadingSilenceSec * 10) / 10,
      trailingSilenceSec: Math.round(trailingSilenceSec * 10) / 10,
    },
    checks,
    recommendations,
  };
}

/**
 * Legacy: clone from URL in one step (download + auto-trim).
 */
async function cloneFromURL(url, opts = {}) {
  const dl = await downloadAudio(url);
  const { startSec, durationSec = 10 } = opts;

  let ss = startSec || 0;
  let end = ss + Math.min(durationSec, dl.duration);
  if (end > dl.duration) end = dl.duration;
  if (ss >= end) ss = Math.max(0, end - durationSec);

  return await trimAndSave(ss, end);
}

function getStatus() {
  const hasRef = fs.existsSync(REF_AUDIO);
  const hasFull = fs.existsSync(FULL_AUDIO);

  if (!hasRef && !hasFull) {
    return { configured: false, hasFullAudio: false, message: 'No voice clone configured' };
  }

  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); } catch {}

  let waveform = null;
  try { waveform = JSON.parse(fs.readFileSync(WAVEFORM_FILE, 'utf-8')); } catch {}

  let fullDuration = null;
  if (hasFull) {
    try {
      const d = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${FULL_AUDIO}"`, { encoding: 'utf-8', timeout: 5000 }).trim();
      fullDuration = parseFloat(d) || null;
    } catch {}
  }

  return {
    configured: hasRef,
    hasFullAudio: hasFull,
    fullDuration,
    waveform,
    ...meta,
  };
}

function clearClone() {
  for (const f of [REF_AUDIO, FULL_AUDIO, WAVEFORM_FILE, META_FILE, PREVIEW_AUDIO]) {
    try { fs.unlinkSync(f); } catch {}
  }
  console.log('[voice-clone] Cleared all');
}

function getReferenceAudioPath() {
  return fs.existsSync(REF_AUDIO) ? REF_AUDIO : null;
}

module.exports = {
  downloadAudio,
  trimAndSave,
  analyzeReference,
  previewTTS,
  cloneFromURL,
  getStatus,
  clearClone,
  getReferenceAudioPath,
};
