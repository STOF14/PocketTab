const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { isParentOrAdmin } = require('../services/roles');

const DEV_FALLBACK_SECRET = 'pockettab-dev-secret-change-in-production';
const isProduction = config.isProduction;
const SESSION_TTL_DAYS = config.sessionTtlDays;

if (isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required when NODE_ENV=production');
}

const JWT_SECRET = process.env.JWT_SECRET || DEV_FALLBACK_SECRET;

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || null;
}

function issueSessionToken(userId, req) {
  const jti = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const token = jwt.sign({ userId, jti }, JWT_SECRET, { expiresIn: `${SESSION_TTL_DAYS}d` });

  db.prepare(
    'INSERT INTO sessions (id, user_id, jti, token_hash, created_at, expires_at, last_seen_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    jti,
    userId,
    jti,
    tokenHash(token),
    createdAt.toISOString(),
    expiresAt.toISOString(),
    createdAt.toISOString(),
    req.get('user-agent') || null,
    getClientIp(req)
  );

  return token;
}

function revokeSession(sessionId) {
  const revokedAt = new Date().toISOString();
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(revokedAt, sessionId);
}

function revokeAllSessionsForUser(userId) {
  const revokedAt = new Date().toISOString();
  return db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(revokedAt, userId);
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded?.userId || !decoded?.jti) {
      return res.status(403).json({ error: 'Invalid session token' });
    }

    const session = db.prepare(
      `SELECT s.id, s.user_id, s.jti, s.token_hash, s.expires_at, s.revoked_at,
              u.name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.jti = ? AND s.user_id = ?`
    ).get(decoded.jti, decoded.userId);

    if (!session || session.revoked_at) {
      return res.status(403).json({ error: 'Session has been revoked' });
    }

    if (tokenHash(token) !== session.token_hash) {
      return res.status(403).json({ error: 'Invalid session token' });
    }

    const now = new Date();
    if (new Date(session.expires_at).getTime() <= now.getTime()) {
      return res.status(403).json({ error: 'Session expired' });
    }

    req.userId = session.user_id;
    req.userRole = session.role;
    req.user = {
      id: session.user_id,
      name: session.name,
      role: session.role
    };
    req.sessionId = session.id;

    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), session.id);
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireRoles(roles) {
  const allowed = new Set(roles);

  return (req, res, next) => {
    if (!req.userRole) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowed.has(req.userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

function requireParentOrAdmin(req, res, next) {
  if (!isParentOrAdmin(req.userRole)) {
    return res.status(403).json({ error: 'Parent or admin role required' });
  }

  return next();
}

module.exports = {
  authenticateToken,
  issueSessionToken,
  revokeSession,
  revokeAllSessionsForUser,
  requireRoles,
  requireParentOrAdmin,
  JWT_SECRET
};
