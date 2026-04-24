// STUN client — discovers public IP:port via standard STUN servers
// RFC 5389 — only uses Binding Request/Response (simplest STUN operation)

const dgram = require('dgram');

// Self-hosted STUN server first, public fallbacks if unavailable
// Set KLAW_STUN_HOST to your own server, or leave empty for defaults
const STUN_SERVERS = [
  process.env.KLAW_STUN_HOST && { host: process.env.KLAW_STUN_HOST, port: parseInt(process.env.KLAW_STUN_PORT || '3478', 10) },
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
].filter(Boolean);

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE = 0x2112A442;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0001;

/**
 * Discover public IP and port via STUN.
 * @param {dgram.Socket} [existingSocket] — reuse an existing UDP socket to get the mapped port for THAT socket
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<{ip: string, port: number}>}
 */
async function discover(existingSocket, timeoutMs = 3000) {
  const errors = [];

  for (const server of STUN_SERVERS) {
    try {
      return await querySingleServer(server, existingSocket, timeoutMs);
    } catch (err) {
      errors.push(`${server.host}: ${err.message}`);
    }
  }

  throw new Error(`STUN discovery failed: ${errors.join('; ')}`);
}

function querySingleServer(server, existingSocket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ownSocket = !existingSocket;
    const socket = existingSocket || dgram.createSocket('udp4');
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (ownSocket) socket.close();
        reject(new Error('timeout'));
      }
    }, timeoutMs);

    // Build STUN Binding Request
    const txId = Buffer.alloc(12);
    require('crypto').randomFillSync(txId);

    const request = Buffer.alloc(20);
    request.writeUInt16BE(STUN_BINDING_REQUEST, 0); // Message Type
    request.writeUInt16BE(0, 2); // Message Length (no attributes)
    request.writeUInt32BE(STUN_MAGIC_COOKIE, 4); // Magic Cookie
    txId.copy(request, 8); // Transaction ID

    const onMessage = (msg) => {
      if (settled) return;
      const parsed = parseBindingResponse(msg, txId);
      if (parsed) {
        settled = true;
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        if (ownSocket) socket.close();
        resolve(parsed);
      }
    };

    socket.on('message', onMessage);

    socket.send(request, server.port, server.host, (err) => {
      if (err && !settled) {
        settled = true;
        clearTimeout(timer);
        if (ownSocket) socket.close();
        reject(err);
      }
    });
  });
}

function parseBindingResponse(msg, expectedTxId) {
  if (msg.length < 20) return null;

  const msgType = msg.readUInt16BE(0);
  if (msgType !== STUN_BINDING_RESPONSE) return null;

  const cookie = msg.readUInt32BE(4);
  if (cookie !== STUN_MAGIC_COOKIE) return null;

  // Verify transaction ID
  const txId = msg.slice(8, 20);
  if (!txId.equals(expectedTxId)) return null;

  const msgLength = msg.readUInt16BE(2);
  let offset = 20;
  const end = 20 + msgLength;

  while (offset + 4 <= end) {
    const attrType = msg.readUInt16BE(offset);
    const attrLength = msg.readUInt16BE(offset + 2);
    const attrData = msg.slice(offset + 4, offset + 4 + attrLength);

    if (attrType === ATTR_XOR_MAPPED_ADDRESS && attrLength >= 8) {
      const family = attrData.readUInt8(1);
      if (family === 0x01) { // IPv4
        const xorPort = attrData.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
        const xorIP = attrData.readUInt32BE(4) ^ STUN_MAGIC_COOKIE;
        const ip = [
          (xorIP >>> 24) & 0xFF,
          (xorIP >>> 16) & 0xFF,
          (xorIP >>> 8) & 0xFF,
          xorIP & 0xFF,
        ].join('.');
        return { ip, port: xorPort };
      }
    }

    if (attrType === ATTR_MAPPED_ADDRESS && attrLength >= 8) {
      const family = attrData.readUInt8(1);
      if (family === 0x01) { // IPv4
        const port = attrData.readUInt16BE(2);
        const ip = [
          attrData.readUInt8(4),
          attrData.readUInt8(5),
          attrData.readUInt8(6),
          attrData.readUInt8(7),
        ].join('.');
        return { ip, port };
      }
    }

    // Align to 4-byte boundary
    offset += 4 + Math.ceil(attrLength / 4) * 4;
  }

  return null;
}

module.exports = { discover, STUN_SERVERS };
