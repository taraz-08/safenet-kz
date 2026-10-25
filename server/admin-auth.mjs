import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ADMIN_AUTH_LIMITS = Object.freeze({ ttlMs: 8 * 60 * 60 * 1000, sessions: 128, windowMs: 5 * 60 * 1000, attemptsPerPeer: 10, attemptsGlobal: 100, peers: 256, bodyBytes: 1024 });
const digest = value => createHash('sha256').update(value).digest();

/** Process-local, opaque sessions. Only Set-Cookie carries the bearer token. */
export function createAdminAuth({ adminCode = null, hosted = false, now = () => Date.now() } = {}) {
  if (adminCode !== null && (typeof adminCode !== 'string' || Buffer.byteLength(adminCode) > 512)) throw new Error('SAFENET_ADMIN_CODE must be a string of at most 512 bytes.');
  const enabled = Boolean(adminCode);
  const codeHash = enabled ? digest(adminCode) : null;
  const cookieName = hosted ? '__Host-safenet_admin' : 'safenet_admin';
  const sessions = new Map(), peers = new Map();
  let globalWindow = { until: 0, count: 0 };
  const router = express.Router();
  const cookieOptions = { httpOnly: true, sameSite: 'strict', path: '/', secure: hosted };

  function cookieKey(req) {
    const matches = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
    // Ambiguous or malformed cookies never select a session or revoke someone else's.
    if (matches.length !== 1) return null;
    const token = matches[0].slice(cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/u.test(token) ? digest(token).toString('hex') : null;
  }
  function prune() {
    const time = now();
    for (const [key, expiry] of sessions) if (expiry <= time) sessions.delete(key);
    for (const [peer, window] of peers) if (window.until <= time) peers.delete(peer);
  }
  function session(req) {
    prune();
    const expiry = sessions.get(cookieKey(req));
    return { enabled, authenticated: enabled && expiry !== undefined, expiresAt: enabled && expiry !== undefined ? new Date(expiry).toISOString() : null };
  }
  function limitLogin(req, res, next) {
    if (!enabled) return res.status(503).json({ error: 'Admin login is not configured.' });
    prune();
    const time = now();
    if (globalWindow.until <= time) globalWindow = { until: time + ADMIN_AUTH_LIMITS.windowMs, count: 0 };
    // Forwarding headers are untrusted. Shared reverse-proxy peers share this attempt budget.
    const peer = req.socket.remoteAddress || 'unknown';
    const window = peers.get(peer) || { until: time + ADMIN_AUTH_LIMITS.windowMs, count: 0 };
    if (globalWindow.count >= ADMIN_AUTH_LIMITS.attemptsGlobal || window.count >= ADMIN_AUTH_LIMITS.attemptsPerPeer || (!peers.has(peer) && peers.size >= ADMIN_AUTH_LIMITS.peers)) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Math.max(globalWindow.until, window.until) - time) / 1000))));
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
    globalWindow.count++;
    window.count++;
    peers.set(peer, window);
    if (!req.is('application/json')) return res.status(415).json({ error: 'Send an application/json login request.' });
    next();
  }

  router.get('/session', (req, res) => res.json(session(req)));
  router.post('/login', limitLogin, express.json({ limit: ADMIN_AUTH_LIMITS.bodyBytes, inflate: false }), (req, res) => {
    const supplied = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!timingSafeEqual(digest(supplied), codeHash)) return res.status(401).json({ error: 'Invalid admin code.' });
    prune();
    const previous = cookieKey(req);
    // A full store refuses new sessions instead of logging out another administrator.
    if (!sessions.has(previous) && sessions.size >= ADMIN_AUTH_LIMITS.sessions) {
      res.setHeader('Retry-After', '60');
      return res.status(503).json({ error: 'Admin session capacity reached. Try again later.' });
    }
    const token = randomBytes(32).toString('base64url');
    const expiry = now() + ADMIN_AUTH_LIMITS.ttlMs;
    if (previous) sessions.delete(previous);
    sessions.set(digest(token).toString('hex'), expiry);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: ADMIN_AUTH_LIMITS.ttlMs, expires: new Date(expiry) });
    res.json({ authenticated: true, expiresAt: new Date(expiry).toISOString() });
  });
  router.post('/logout', express.json({ limit: ADMIN_AUTH_LIMITS.bodyBytes, inflate: false }), (req, res) => {
    sessions.delete(cookieKey(req));
    res.clearCookie(cookieName, cookieOptions);
    res.json({ authenticated: false });
  });
  // Body-parser errors may contain the submitted body: never log or echo them.
  router.use((error, _req, res, _next) => {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ error: status === 413 ? 'Authentication JSON exceeds 1 KiB.' : 'Invalid authentication request.' });
  });
  return { enabled, session, router };
}
