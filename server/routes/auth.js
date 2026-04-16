const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticateToken, issueSessionToken, revokeSession } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();
const MAX_LOGIN_ATTEMPTS = Number.parseInt(process.env.PIN_MAX_ATTEMPTS || '5', 10);
const LOCK_MINUTES = Number.parseInt(process.env.PIN_LOCK_MINUTES || '15', 10);

// GET /api/auth/users — List all users (public, for login screen)
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, name, role, created_at FROM users ORDER BY created_at ASC').all();
  res.json(users);
});

// POST /api/auth/register — Create a new user
router.post('/register', (req, res) => {
  const { name, pin } = req.body;

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }

  const trimmedName = name.trim().slice(0, 20);

  // Check duplicate name
  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(trimmedName);
  if (existing) {
    return res.status(400).json({ error: 'Name already taken' });
  }

  const id = crypto.randomUUID();
  const pinHash = bcrypt.hashSync(pin, 10);
  const createdAt = new Date().toISOString();
  const userCount = db.prepare('SELECT COUNT(*) as total FROM users').get().total;
  const role = userCount === 0 ? 'admin' : 'child';

  db.prepare(
    'INSERT INTO users (id, name, pin_hash, role, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(id, trimmedName, pinHash, role, createdAt);

  const token = issueSessionToken(id, req);
  res.status(201).json({ token, user: { id, name: trimmedName, role, created_at: createdAt } });
});

// POST /api/auth/login — Login with user ID + PIN
router.post('/login', (req, res) => {
  const { userId, pin } = req.body;

  if (!userId || !pin) {
    return res.status(400).json({ error: 'User ID and PIN required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return res.status(423).json({ error: 'Account is temporarily locked', lockedUntil: user.locked_until });
  }

  if (!bcrypt.compareSync(pin, user.pin_hash)) {
    const nextAttempts = Number(user.failed_login_attempts || 0) + 1;
    if (nextAttempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?').run(lockedUntil, user.id);
      return res.status(423).json({ error: 'Too many failed attempts. Account locked temporarily.', lockedUntil });
    }

    db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = NULL WHERE id = ?').run(nextAttempts, user.id);
    return res.status(401).json({ error: 'Incorrect PIN', attemptsRemaining: MAX_LOGIN_ATTEMPTS - nextAttempts });
  }

  db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

  const token = issueSessionToken(user.id, req);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, created_at: user.created_at } });
});

// POST /api/auth/logout — Revoke current session
router.post('/logout', authenticateToken, (req, res) => {
  revokeSession(req.sessionId);
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;
