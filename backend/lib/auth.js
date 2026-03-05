// Auth middleware — Bearer token from KLAW_AUTH_TOKEN env var

const TOKEN = process.env.KLAW_AUTH_TOKEN;

function authMiddleware(req, res, next) {
  if (!TOKEN) return next(); // no token configured = open access (local dev)

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

module.exports = { authMiddleware, authWebSocket };
