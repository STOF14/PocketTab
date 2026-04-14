const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { generateToken } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();

// GET /api/auth/users — List all users (public, for login screen)
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, name, created_at FROM users ORDER BY created_at ASC').all();
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

  // Check user limit
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (count >= 5) {
    return res.status(400).json({ error: 'Maximum 5 users reached' });
  }

  // Check duplicate name
  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(trimmedName);
  if (existing) {
    return res.status(400).json({ error: 'Name already taken' });
  }

  const id = crypto.randomUUID();
  const pinHash = bcrypt.hashSync(pin, 10);
  const createdAt = new Date().toISOString();

  db.prepare('INSERT INTO users (id, name, pin_hash, created_at) VALUES (?, ?, ?, ?)').run(id, trimmedName, pinHash, createdAt);

  const token = generateToken(id);
  res.status(201).json({ token, user: { id, name: trimmedName, created_at: createdAt } });
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

  if (!bcrypt.compareSync(pin, user.pin_hash)) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  const token = generateToken(user.id);
  res.json({ token, user: { id: user.id, name: user.name, created_at: user.created_at } });
});

module.exports = router;
