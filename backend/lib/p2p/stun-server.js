#!/usr/bin/env node
// Minimal STUN server — RFC 5389 Binding Request/Response only
// Tells clients their public IP:port. Stores nothing, logs nothing.
// Deploy anywhere: `node stun-server.js` (default port 3478)

const dgram = require('dgram');

const PORT = parseInt(process.env.STUN_PORT || '3478', 10);
const MAGIC_COOKIE = 0x2112A442;
const BINDING_REQUEST = 0x0001;
const BINDING_RESPONSE = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

const server = dgram.createSocket('udp4');

server.on('message', (msg, rinfo) => {
  if (msg.length < 20) return;

  const msgType = msg.readUInt16BE(0);
  if (msgType !== BINDING_REQUEST) return;

  const cookie = msg.readUInt32BE(4);
  if (cookie !== MAGIC_COOKIE) return;

  const txId = msg.slice(4, 20); // magic cookie + transaction ID (16 bytes)

  // Build XOR-MAPPED-ADDRESS attribute
  const xorPort = rinfo.port ^ (MAGIC_COOKIE >>> 16);
  const ipParts = rinfo.address.split('.').map(Number);
  const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const xorIP = ipInt ^ MAGIC_COOKIE;

  const attr = Buffer.alloc(12);
  attr.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(8, 2); // attribute length
  attr.writeUInt8(0, 4);    // reserved
  attr.writeUInt8(0x01, 5); // IPv4
  attr.writeUInt16BE(xorPort, 6);
  attr.writeUInt32BE(xorIP >>> 0, 8);

  // Build response
  const response = Buffer.alloc(20 + attr.length);
  response.writeUInt16BE(BINDING_RESPONSE, 0);
  response.writeUInt16BE(attr.length, 2);
  txId.copy(response, 4);
  attr.copy(response, 20);

  server.send(response, rinfo.port, rinfo.address);
});

server.bind(PORT, '0.0.0.0', () => {
  console.log(`STUN server listening on UDP port ${PORT}`);
});
