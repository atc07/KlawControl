// Auth middleware — Bearer token from KLAW_AUTH_TOKEN env var or auto-generated

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(require('os').homedir(), '.klaw-control');
const TOKEN_FILE = path.join(CONFIG_DIR, 'auth-token');

function getOrCreateToken() {
  // 1. Env var takes priority
  if (process.env.KLAW_AUTH_TOKEN) return process.env.KLAW_AUTH_TOKEN;

  // 2. Check saved token file
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (saved) return saved;
  } catch {}

  // 3. Generate new token on first run
  const token = 'kc_' + crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  } catch (e) {
    console.error('Warning: Could not save auth token:', e.message);
  }
  return token;
}

const TOKEN = getOrCreateToken();

function authMiddleware(req, res, next) {
  if (!TOKEN) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = header.slice(7);
  if (token !== TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
}

function authWebSocket(req) {
  if (!TOKEN) return true;
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || '';
  return token === TOKEN;
}

module.exports = { authMiddleware, authWebSocket, TOKEN };
