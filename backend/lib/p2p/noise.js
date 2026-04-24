// Noise Protocol — Noise_IK handshake + ChaCha20-Poly1305 transport
// Same crypto primitives as WireGuard
// Uses Node.js built-in crypto module (no dependencies)

const crypto = require('crypto');

const NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';

/**
 * Generate a Curve25519 keypair for Noise protocol.
 * @returns {{publicKey: Buffer, privateKey: Buffer}}
 */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  // Extract raw 32-byte keys from DER encoding
  return {
    publicKey: publicKey.slice(-32),
    privateKey: privateKey.slice(-32),
  };
}

/**
 * Perform X25519 Diffie-Hellman key exchange.
 */
function dh(privateKeyRaw, publicKeyRaw) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'),
      privateKeyRaw,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'),
      publicKeyRaw,
    ]),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey: privKey, publicKey: pubKey });
}

/**
 * HKDF using SHA-256.
 */
function hkdf(chainingKey, inputKeyMaterial, numOutputs = 2) {
  const tempKey = crypto.createHmac('sha256', chainingKey)
    .update(inputKeyMaterial)
    .digest();

  const out1 = crypto.createHmac('sha256', tempKey)
    .update(Buffer.from([1]))
    .digest();

  if (numOutputs === 1) return [out1];

  const out2 = crypto.createHmac('sha256', tempKey)
    .update(Buffer.concat([out1, Buffer.from([2])]))
    .digest();

  if (numOutputs === 2) return [out1, out2];

  const out3 = crypto.createHmac('sha256', tempKey)
    .update(Buffer.concat([out2, Buffer.from([3])]))
    .digest();

  return [out1, out2, out3];
}

// ── Noise Session ────────────────────────────────────────────

class NoiseSession {
  constructor() {
    this.sendKey = null;
    this.recvKey = null;
    this.sendNonce = 0n;
    this.recvNonce = 0n;
  }

  /**
   * Encrypt a plaintext message.
   * @param {Buffer} plaintext
   * @returns {Buffer} — nonce (8 bytes) + ciphertext + tag (16 bytes)
   */
  encrypt(plaintext) {
    if (!this.sendKey) throw new Error('Session not established');

    const nonceBuf = Buffer.alloc(12);
    nonceBuf.writeBigUInt64LE(this.sendNonce, 4);
    this.sendNonce++;

    const cipher = crypto.createCipheriv('chacha20-poly1305', this.sendKey, nonceBuf, {
      authTagLength: 16,
    });

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Return: 8-byte nonce counter + ciphertext + 16-byte tag
    const nonceCounter = Buffer.alloc(8);
    nonceCounter.writeBigUInt64LE(this.sendNonce - 1n);
    return Buffer.concat([nonceCounter, encrypted, tag]);
  }

  /**
   * Decrypt a received message.
   * @param {Buffer} packet — nonce (8 bytes) + ciphertext + tag (16 bytes)
   * @returns {Buffer} plaintext
   */
  decrypt(packet) {
    if (!this.recvKey) throw new Error('Session not established');
    if (packet.length < 24) throw new Error('Packet too short');

    const nonceCounter = packet.readBigUInt64LE(0);
    const ciphertext = packet.slice(8, -16);
    const tag = packet.slice(-16);

    const nonceBuf = Buffer.alloc(12);
    nonceBuf.writeBigUInt64LE(nonceCounter, 4);

    const decipher = crypto.createDecipheriv('chacha20-poly1305', this.recvKey, nonceBuf, {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    this.recvNonce = nonceCounter + 1n;
    return decrypted;
  }
}

// ── Noise_IK Handshake ───────────────────────────────────────

/**
 * Perform Noise_IK handshake as the RESPONDER (Mac/server side).
 * The initiator (phone) sends first.
 *
 * @param {Buffer} staticPrivateKey — our static private key
 * @param {Buffer} staticPublicKey — our static public key  
 * @param {Buffer} peerStaticPublicKey — phone's static public key (from pairing)
 * @param {Buffer} initiatorMessage — first handshake message from phone
 * @returns {{session: NoiseSession, response: Buffer}}
 */
function respondHandshake(staticPrivateKey, staticPublicKey, peerStaticPublicKey, initiatorMessage) {
  // Initialize symmetric state
  const protocolName = Buffer.from(NOISE_PROTOCOL_NAME, 'ascii');
  let h = crypto.createHash('sha256').update(protocolName).digest();
  let ck = Buffer.from(h);

  // MixHash(prologue) — empty prologue
  h = mixHash(h, Buffer.alloc(0));

  // MixHash(s) — responder's static public key
  h = mixHash(h, staticPublicKey);

  // ── Process initiator's message ──
  // e (ephemeral public key, 32 bytes) + encrypted_s (48 bytes) + encrypted_payload
  if (initiatorMessage.length < 80) {
    throw new Error('Initiator message too short');
  }

  const peerEphemeral = initiatorMessage.slice(0, 32);
  h = mixHash(h, peerEphemeral);

  // DH(s, re) — responder static + initiator ephemeral
  let dhResult = dh(staticPrivateKey, peerEphemeral);
  const [ck1, k1] = hkdf(ck, dhResult);
  ck = ck1;

  // Decrypt initiator's static key
  const encryptedStatic = initiatorMessage.slice(32, 80);
  const decryptedStatic = decryptWithKey(k1, 0n, h, encryptedStatic);
  h = mixHash(h, encryptedStatic);

  // Verify it matches the expected peer key
  if (!decryptedStatic.equals(peerStaticPublicKey)) {
    throw new Error('Peer static key mismatch — unauthorized device');
  }

  // DH(s, rs) — responder static + initiator static
  dhResult = dh(staticPrivateKey, decryptedStatic);
  const [ck2, k2] = hkdf(ck, dhResult);
  ck = ck2;

  // Decrypt payload
  const encryptedPayload = initiatorMessage.slice(80);
  const payload = decryptWithKey(k2, 0n, h, encryptedPayload);
  h = mixHash(h, encryptedPayload);

  // ── Build response message ──
  const ephemeral = generateKeypair();
  let response = Buffer.from(ephemeral.publicKey);
  h = mixHash(h, ephemeral.publicKey);

  // DH(e, re) — responder ephemeral + initiator ephemeral
  dhResult = dh(ephemeral.privateKey, peerEphemeral);
  const [ck3, k3] = hkdf(ck, dhResult);
  ck = ck3;

  // DH(e, rs) — responder ephemeral + initiator static
  dhResult = dh(ephemeral.privateKey, decryptedStatic);
  const [ck4, k4] = hkdf(ck, dhResult);
  ck = ck4;

  // Encrypt empty payload
  const encryptedResp = encryptWithKey(k4, 0n, h, Buffer.alloc(0));
  h = mixHash(h, encryptedResp);
  response = Buffer.concat([response, encryptedResp]);

  // Split — derive transport keys
  const [sendKey, recvKey] = hkdf(ck, Buffer.alloc(0));

  const session = new NoiseSession();
  // Responder: send with key2, receive with key1
  session.sendKey = sendKey;
  session.recvKey = recvKey;

  return { session, response, payload };
}

// ── Helpers ──────────────────────────────────────────────────

function mixHash(h, data) {
  return crypto.createHash('sha256').update(h).update(data).digest();
}

function encryptWithKey(key, nonce, ad, plaintext) {
  const nonceBuf = Buffer.alloc(12);
  nonceBuf.writeBigUInt64LE(nonce, 4);

  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonceBuf, {
    authTagLength: 16,
  });
  cipher.setAAD(ad);

  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]);
}

function decryptWithKey(key, nonce, ad, ciphertext) {
  if (ciphertext.length < 16) throw new Error('Ciphertext too short');

  const nonceBuf = Buffer.alloc(12);
  nonceBuf.writeBigUInt64LE(nonce, 4);

  const tag = ciphertext.slice(-16);
  const data = ciphertext.slice(0, -16);

  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonceBuf, {
    authTagLength: 16,
  });
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]);
}

module.exports = {
  generateKeypair,
  NoiseSession,
  respondHandshake,
  NOISE_PROTOCOL_NAME,
};
