// P2P Tunnel — manages the full lifecycle of a direct encrypted connection
// Orchestrates: STUN discovery → hole-punch → Noise handshake → encrypted transport

const dgram = require('dgram');
const EventEmitter = require('events');
const { discover } = require('./stun');
const { respondHandshake, NoiseSession } = require('./noise');
const { createPunchedSocket, punchThrough, startKeepalive, isKeepalive, isPunch } = require('./hole-punch');

const PACKET_TYPE_HANDSHAKE = 0x01;
const PACKET_TYPE_DATA = 0x02;
const PACKET_TYPE_HTTP_REQ = 0x03;
const PACKET_TYPE_HTTP_RES = 0x04;

class P2PTunnel extends EventEmitter {
  /**
   * @param {{publicKey: Buffer, privateKey: Buffer}} staticKeys — our static keypair
   * @param {Buffer} peerPublicKey — peer's static public key (from pairing)
   */
  constructor(staticKeys, peerPublicKey) {
    super();
    this.staticKeys = staticKeys;
    this.peerPublicKey = peerPublicKey;
    this.socket = null;
    this.session = null;
    this.peerAddress = null;
    this.peerPort = null;
    this.keepaliveHandle = null;
    this.publicEndpoint = null;
    this.state = 'disconnected'; // disconnected | discovering | punching | handshaking | connected
    this._pendingRequests = new Map();
    this._requestCounter = 0;
  }

  /**
   * Start listening for incoming P2P connections.
   * Discovers our public endpoint and waits for peer to punch through.
   * @returns {Promise<{ip: string, port: number}>} our public endpoint
   */
  async listen() {
    this.state = 'discovering';
    this.emit('state', this.state);

    const { socket, localPort, publicEndpoint } = await createPunchedSocket();
    this.socket = socket;
    this.publicEndpoint = publicEndpoint;

    console.log(`[p2p] Listening on port ${localPort}, public endpoint: ${publicEndpoint.ip}:${publicEndpoint.port}`);

    // Set up message handler
    this.socket.on('message', (msg, rinfo) => this._handleMessage(msg, rinfo));

    this.state = 'listening';
    this.emit('state', this.state);
    this.emit('endpoint', publicEndpoint);

    return publicEndpoint;
  }

  /**
   * Actively connect to a peer at a known endpoint.
   * @param {{ip: string, port: number}} peerEndpoint
   */
  async connect(peerEndpoint) {
    if (!this.socket) {
      await this.listen();
    }

    this.state = 'punching';
    this.emit('state', this.state);

    console.log(`[p2p] Hole-punching to ${peerEndpoint.ip}:${peerEndpoint.port}...`);

    try {
      const { peerAddress, peerPort } = await punchThrough(this.socket, peerEndpoint);
      this.peerAddress = peerAddress;
      this.peerPort = peerPort;

      console.log(`[p2p] Hole-punch succeeded! Peer at ${peerAddress}:${peerPort}`);

      // Start keepalive
      this.keepaliveHandle = startKeepalive(this.socket, peerAddress, peerPort);

      this.state = 'handshaking';
      this.emit('state', this.state);

      // Wait for handshake from initiator (phone)
      // The phone sends the first Noise_IK message

    } catch (err) {
      this.state = 'disconnected';
      this.emit('state', this.state);
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Send an encrypted message to the peer.
   * @param {Buffer} data
   * @param {number} [type=PACKET_TYPE_DATA]
   */
  send(data, type = PACKET_TYPE_DATA) {
    if (!this.session || !this.peerAddress) {
      throw new Error('Tunnel not connected');
    }

    const encrypted = this.session.encrypt(data);
    const packet = Buffer.alloc(5 + encrypted.length);
    packet.writeUInt8(type, 0);
    packet.writeUInt32BE(encrypted.length, 1);
    encrypted.copy(packet, 5);

    this.socket.send(packet, this.peerPort, this.peerAddress, (err) => {
      if (err) this.emit('error', err);
    });
  }

  /**
   * Proxy an HTTP request through the tunnel.
   * @param {string} method
   * @param {string} path
   * @param {object} [headers]
   * @param {Buffer|string} [body]
   * @returns {Promise<{status: number, headers: object, body: string}>}
   */
  async proxyHTTPRequest(method, path, headers = {}, body = '') {
    const reqId = ++this._requestCounter;
    const request = JSON.stringify({ id: reqId, method, path, headers, body: body.toString() });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(reqId);
        reject(new Error('HTTP proxy timeout'));
      }, 30000);

      this._pendingRequests.set(reqId, { resolve, reject, timeout });
      this.send(Buffer.from(request), PACKET_TYPE_HTTP_REQ);
    });
  }

  /**
   * Close the tunnel.
   */
  close() {
    if (this.keepaliveHandle) {
      clearInterval(this.keepaliveHandle);
      this.keepaliveHandle = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.session = null;
    this.state = 'disconnected';
    this.emit('state', this.state);
    this.emit('close');
  }

  // ── Internal ─────────────────────────────────────────────

  _handleMessage(msg, rinfo) {
    // Skip keepalive and punch packets
    if (isKeepalive(msg) || isPunch(msg)) {
      // If we get a punch from a new peer, update address
      if (isPunch(msg) && !this.peerAddress) {
        this.peerAddress = rinfo.address;
        this.peerPort = rinfo.port;
        this.keepaliveHandle = startKeepalive(this.socket, rinfo.address, rinfo.port);
      }
      return;
    }

    if (msg.length < 5) return;

    const type = msg.readUInt8(0);
    const length = msg.readUInt32BE(1);
    const payload = msg.slice(5, 5 + length);

    if (type === PACKET_TYPE_HANDSHAKE) {
      this._handleHandshake(payload, rinfo);
      return;
    }

    if (!this.session) return;

    try {
      const decrypted = this.session.decrypt(payload);

      if (type === PACKET_TYPE_HTTP_REQ) {
        this._handleHTTPRequest(decrypted);
      } else if (type === PACKET_TYPE_HTTP_RES) {
        this._handleHTTPResponse(decrypted);
      } else {
        this.emit('data', decrypted);
      }
    } catch (err) {
      this.emit('error', new Error(`Decryption failed: ${err.message}`));
    }
  }

  _handleHandshake(initiatorMessage, rinfo) {
    try {
      const { session, response } = respondHandshake(
        this.staticKeys.privateKey,
        this.staticKeys.publicKey,
        this.peerPublicKey,
        initiatorMessage
      );

      this.session = session;
      this.peerAddress = rinfo.address;
      this.peerPort = rinfo.port;

      // Send handshake response
      const packet = Buffer.alloc(5 + response.length);
      packet.writeUInt8(PACKET_TYPE_HANDSHAKE, 0);
      packet.writeUInt32BE(response.length, 1);
      response.copy(packet, 5);
      this.socket.send(packet, rinfo.port, rinfo.address);

      this.state = 'connected';
      this.emit('state', this.state);
      this.emit('connected', { address: rinfo.address, port: rinfo.port });

      console.log(`[p2p] Noise handshake complete — encrypted tunnel established`);
    } catch (err) {
      this.emit('error', new Error(`Handshake failed: ${err.message}`));
    }
  }

  _handleHTTPRequest(decrypted) {
    // Server-side: proxy HTTP requests to the local backend
    const req = JSON.parse(decrypted.toString());
    this.emit('http-request', req);
  }

  _handleHTTPResponse(decrypted) {
    // Client-side: resolve pending HTTP request promises
    const res = JSON.parse(decrypted.toString());
    const pending = this._pendingRequests.get(res.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this._pendingRequests.delete(res.id);
      pending.resolve(res);
    }
  }
}

module.exports = {
  P2PTunnel,
  PACKET_TYPE_HANDSHAKE,
  PACKET_TYPE_DATA,
  PACKET_TYPE_HTTP_REQ,
  PACKET_TYPE_HTTP_RES,
};
