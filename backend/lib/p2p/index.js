// P2P module — main entry point
// Sets up the encrypted P2P tunnel alongside the HTTP server

const fs = require('fs');
const path = require('path');
const { generateKeypair } = require('./noise');
const { P2PTunnel } = require('./tunnel');
const { startEndpointSync } = require('./endpoint-sync');
const crypto = require('crypto');
const { TOKEN } = require('../auth');

const CONFIG_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.klaw-control'
);
const KEYS_PATH = path.join(CONFIG_DIR, 'keys.json');
const PAIRING_PATH = path.join(CONFIG_DIR, 'pairing.json');

/**
 * Load or generate static keypair.
 */
function loadOrCreateKeys() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  if (fs.existsSync(KEYS_PATH)) {
    const data = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    return {
      publicKey: Buffer.from(data.publicKey, 'base64'),
      privateKey: Buffer.from(data.privateKey, 'base64'),
    };
  }

  const keys = generateKeypair();
  fs.writeFileSync(KEYS_PATH, JSON.stringify({
    publicKey: keys.publicKey.toString('base64'),
    privateKey: keys.privateKey.toString('base64'),
  }), { mode: 0o600 });

  console.log('[p2p] Generated new static keypair');
  return keys;
}

/**
 * Save pairing info (peer's public key + shared secret).
 */
function savePairing(peerPublicKey, sharedSecret) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(PAIRING_PATH, JSON.stringify({
    peerPublicKey: peerPublicKey.toString('base64'),
    sharedSecret: sharedSecret.toString('base64'),
    pairedAt: new Date().toISOString(),
  }), { mode: 0o600 });
}

/**
 * Load pairing info.
 * @returns {{peerPublicKey: Buffer, sharedSecret: Buffer}|null}
 */
function loadPairing() {
  if (!fs.existsSync(PAIRING_PATH)) return null;

  const data = JSON.parse(fs.readFileSync(PAIRING_PATH, 'utf8'));
  return {
    peerPublicKey: Buffer.from(data.peerPublicKey, 'base64'),
    sharedSecret: Buffer.from(data.sharedSecret, 'base64'),
  };
}

function decodeBase64URL(value) {
  let base64 = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

/**
 * Generate a QR code pairing payload.
 * Contains everything the phone needs to connect.
 *
 * @param {Buffer} publicKey — our static public key
 * @param {string} localIP — local network IP
 * @param {number} httpPort — HTTP server port
 * @returns {{url: string, sharedSecret: Buffer, display: string}}
 */
function generatePairingPayload(publicKey, localIP, httpPort) {
  // Generate a shared secret for endpoint encryption
  const sharedSecret = crypto.randomBytes(32);

  const payload = {
    // Local connection info
    local: `${localIP}:${httpPort}`,
    // Our static public key for Noise protocol
    pk: publicKey.toString('base64url'),
    // Shared secret for endpoint encryption (iCloud KVS)
    ss: sharedSecret.toString('base64url'),
    // Auth token for HTTP API
    token: TOKEN,
  };

  const url = `klawcontrol://pair?${new URLSearchParams(payload).toString()}`;

  return {
    url,
    sharedSecret,
    display: url,
  };
}

async function startPairedTunnel({ keys, pairing, httpHandler }) {
  const tunnel = new P2PTunnel(keys, pairing.peerPublicKey);

  // Handle HTTP requests proxied through the tunnel
  tunnel.on('http-request', async (req) => {
    try {
      const response = await httpHandler(req);
      tunnel.send(
        Buffer.from(JSON.stringify({ id: req.id, ...response })),
        0x04 // PACKET_TYPE_HTTP_RES
      );
    } catch (err) {
      tunnel.send(
        Buffer.from(JSON.stringify({ id: req.id, status: 500, body: err.message })),
        0x04
      );
    }
  });

  const endpoint = await tunnel.listen();

  // Start endpoint sync (publish our public IP to iCloud KVS)
  startEndpointSync(
    () => tunnel.publicEndpoint,
    pairing.sharedSecret
  );

  return { tunnel, endpoint };
}

/**
 * Initialize P2P connectivity.
 * Call this after the HTTP server is running.
 *
 * @param {object} options
 * @param {string} options.localIP — local network IP
 * @param {number} options.httpPort — HTTP server port
 * @param {Function} options.httpHandler — function(req) → {status, headers, body} to handle proxied HTTP requests
 * @returns {Promise<{tunnel: P2PTunnel, qrPayload: string|null}>}
 */
async function initP2P({ localIP, httpPort, httpHandler }) {
  const keys = loadOrCreateKeys();
  let pairing = loadPairing();

  if (!pairing) {
    // Not paired yet — generate QR code and wait
    const { url, sharedSecret } = generatePairingPayload(keys.publicKey, localIP, httpPort);

    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║   Klaw Control — Scan QR code to pair        ║');
    console.log('╚══════════════════════════════════════════════╝\n');
    console.log(`  Pairing URL: ${url}\n`);

    let activeTunnel = null;

    return {
      tunnel: null,
      qrPayload: url,
      completePairing: async ({ peerPublicKey }) => {
        if (activeTunnel) {
          return { tunnel: activeTunnel, pairedNow: false };
        }
        if (!peerPublicKey) {
          throw new Error('peerPublicKey required');
        }

        const peerKey = decodeBase64URL(peerPublicKey);
        if (peerKey.length !== 32) {
          throw new Error('peerPublicKey must be 32-byte base64url');
        }

        savePairing(peerKey, sharedSecret);
        pairing = { peerPublicKey: peerKey, sharedSecret };
        console.log('[p2p] Pairing completed; starting tunnel...');

        const started = await startPairedTunnel({ keys, pairing, httpHandler });
        activeTunnel = started.tunnel;
        return { tunnel: activeTunnel, pairedNow: true };
      },
    };
  }

  // Already paired — start P2P tunnel
  try {
    const started = await startPairedTunnel({ keys, pairing, httpHandler });
    return {
      tunnel: started.tunnel,
      qrPayload: null,
      completePairing: async () => ({ tunnel: started.tunnel, pairedNow: false }),
    };
  } catch (err) {
    console.error('[p2p] Failed to start tunnel:', err.message);
    return {
      tunnel: null,
      qrPayload: null,
      completePairing: async () => {
        throw new Error('P2P tunnel unavailable');
      },
    };
  }
}

module.exports = {
  initP2P,
  loadOrCreateKeys,
  loadPairing,
  savePairing,
  generatePairingPayload,
  CONFIG_DIR,
};
