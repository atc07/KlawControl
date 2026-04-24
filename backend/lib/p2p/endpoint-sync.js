// Endpoint Sync — publishes our public endpoint so the phone can find us
// Uses iCloud KVS (NSUbiquitousKeyValueStore) via macOS osascript bridge
// The endpoint is encrypted with the shared pairing key before writing

const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ICLOUD_KVS_KEY = 'klaw_control_endpoint';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Encrypt endpoint data with the shared secret.
 * @param {{ip: string, port: number}} endpoint
 * @param {Buffer} sharedSecret — 32-byte key derived from pairing
 * @returns {string} base64-encoded encrypted blob
 */
function encryptEndpoint(endpoint, sharedSecret) {
  const plaintext = JSON.stringify(endpoint);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedSecret, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt endpoint data.
 * @param {string} blob — base64-encoded encrypted data
 * @param {Buffer} sharedSecret
 * @returns {{ip: string, port: number}}
 */
function decryptEndpoint(blob, sharedSecret) {
  const data = Buffer.from(blob, 'base64');
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const ciphertext = data.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedSecret, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

/**
 * Write endpoint to iCloud KVS via osascript (macOS only).
 * @param {{ip: string, port: number}} endpoint
 * @param {Buffer} sharedSecret
 */
function publishEndpoint(endpoint, sharedSecret) {
  const encrypted = encryptEndpoint(endpoint, sharedSecret);

  // Also write to a local file as fallback (for non-macOS or when iCloud is unavailable)
  const fallbackPath = path.join(getConfigDir(), 'endpoint.json');
  fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
  fs.writeFileSync(fallbackPath, JSON.stringify({
    encrypted,
    timestamp: Date.now(),
    endpoint, // plaintext for local access only
  }));

  // Try iCloud KVS via osascript
  if (process.platform === 'darwin') {
    try {
      const script = `
        use framework "Foundation"
        set kvs to current application's NSUbiquitousKeyValueStore's defaultStore()
        kvs's setString:"${encrypted}" forKey:"${ICLOUD_KVS_KEY}"
        kvs's synchronize()
      `;
      execSync(`osascript -l AppleScript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: 5000,
        stdio: 'pipe',
      });
      console.log('[p2p] Endpoint published to iCloud KVS');
    } catch (err) {
      console.log('[p2p] iCloud KVS unavailable, using local fallback only');
    }
  }

  console.log(`[p2p] Endpoint saved: ${endpoint.ip}:${endpoint.port}`);
}

/**
 * Start periodic endpoint publishing.
 * @param {Function} getEndpoint — returns current {ip, port} or null
 * @param {Buffer} sharedSecret
 * @returns {NodeJS.Timeout}
 */
function startEndpointSync(getEndpoint, sharedSecret) {
  const sync = () => {
    const endpoint = getEndpoint();
    if (endpoint) {
      publishEndpoint(endpoint, sharedSecret);
    }
  };

  // Sync immediately
  sync();

  // Then every 5 minutes
  return setInterval(sync, SYNC_INTERVAL_MS);
}

/**
 * Read the locally stored endpoint (for same-machine access).
 * @returns {{ip: string, port: number, timestamp: number}|null}
 */
function readLocalEndpoint() {
  const fallbackPath = path.join(getConfigDir(), 'endpoint.json');
  try {
    const data = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
    return data;
  } catch {
    return null;
  }
}

function getConfigDir() {
  return path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.klaw-control'
  );
}

module.exports = {
  encryptEndpoint,
  decryptEndpoint,
  publishEndpoint,
  startEndpointSync,
  readLocalEndpoint,
  ICLOUD_KVS_KEY,
};
