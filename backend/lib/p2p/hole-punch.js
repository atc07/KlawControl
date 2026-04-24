// UDP Hole-Punching — establishes direct P2P connection through NAT
// Both sides simultaneously send UDP packets to each other's STUN-discovered endpoint.
// NAT routers see outbound traffic and open a "hole" for replies.

const dgram = require('dgram');
const { discover } = require('./stun');

const PUNCH_INTERVAL_MS = 100;   // Send punch packets every 100ms
const PUNCH_TIMEOUT_MS = 5000;   // Give up after 5 seconds
const KEEPALIVE_INTERVAL_MS = 25000; // Keep NAT hole open
const PUNCH_MAGIC = Buffer.from('KLAW_PUNCH');
const KEEPALIVE_MAGIC = Buffer.from('KLAW_ALIVE');

/**
 * Create a UDP socket bound to a random port and discover its public endpoint.
 * @returns {Promise<{socket: dgram.Socket, localPort: number, publicEndpoint: {ip: string, port: number}}>}
 */
async function createPunchedSocket() {
  const socket = dgram.createSocket('udp4');

  await new Promise((resolve, reject) => {
    socket.bind(0, '0.0.0.0', (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const localPort = socket.address().port;

  // Discover public endpoint using THIS socket so the NAT mapping is for this port
  const publicEndpoint = await discover(socket);

  return { socket, localPort, publicEndpoint };
}

/**
 * Attempt to punch through NAT to reach a peer.
 *
 * @param {dgram.Socket} socket — our bound UDP socket
 * @param {{ip: string, port: number}} peerEndpoint — peer's STUN-discovered public endpoint
 * @returns {Promise<{peerAddress: string, peerPort: number}>} — confirmed reachable endpoint
 */
function punchThrough(socket, peerEndpoint) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let punchInterval;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearInterval(punchInterval);
        socket.removeListener('message', onMessage);
        reject(new Error('Hole-punch timeout — peer unreachable'));
      }
    }, PUNCH_TIMEOUT_MS);

    function onMessage(msg, rinfo) {
      // Accept punch response from peer
      if (msg.length >= PUNCH_MAGIC.length && msg.slice(0, PUNCH_MAGIC.length).equals(PUNCH_MAGIC)) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          clearInterval(punchInterval);
          socket.removeListener('message', onMessage);

          // Send one more punch to confirm (so peer also resolves)
          socket.send(PUNCH_MAGIC, rinfo.port, rinfo.address, () => {});

          resolve({ peerAddress: rinfo.address, peerPort: rinfo.port });
        }
      }
    }

    socket.on('message', onMessage);

    // Send punch packets at regular intervals
    punchInterval = setInterval(() => {
      if (settled) return;
      socket.send(PUNCH_MAGIC, peerEndpoint.port, peerEndpoint.ip, () => {});
    }, PUNCH_INTERVAL_MS);

    // Send first one immediately
    socket.send(PUNCH_MAGIC, peerEndpoint.port, peerEndpoint.ip, () => {});
  });
}

/**
 * Start keepalive packets to maintain the NAT hole.
 * @param {dgram.Socket} socket
 * @param {string} peerAddress
 * @param {number} peerPort
 * @returns {NodeJS.Timeout} — interval handle (clear to stop)
 */
function startKeepalive(socket, peerAddress, peerPort) {
  return setInterval(() => {
    socket.send(KEEPALIVE_MAGIC, peerPort, peerAddress, () => {});
  }, KEEPALIVE_INTERVAL_MS);
}

/**
 * Check if a message is a keepalive (should be ignored by application layer).
 */
function isKeepalive(msg) {
  return msg.length === KEEPALIVE_MAGIC.length && msg.equals(KEEPALIVE_MAGIC);
}

/**
 * Check if a message is a punch packet (should be ignored after connection established).
 */
function isPunch(msg) {
  return msg.length >= PUNCH_MAGIC.length && msg.slice(0, PUNCH_MAGIC.length).equals(PUNCH_MAGIC);
}

module.exports = {
  createPunchedSocket,
  punchThrough,
  startKeepalive,
  isKeepalive,
  isPunch,
  KEEPALIVE_INTERVAL_MS,
};
