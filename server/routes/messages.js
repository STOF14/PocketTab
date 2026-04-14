const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();
router.use(authenticateToken);

// GET /api/messages?refType=request&refId=xyz — Get messages for a request/payment
router.get('/', (req, res) => {
  const { refType, refId } = req.query;

  if (!refType || !refId) {
    return res.status(400).json({ error: 'refType and refId are required' });
  }

  if (!['request', 'payment'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request or payment' });
  }

  const messages = db.prepare(
    'SELECT * FROM messages WHERE ref_type = ? AND ref_id = ? ORDER BY timestamp ASC'
  ).all(refType, refId);

  res.json(messages);
});

// POST /api/messages — Send a chat message
router.post('/', (req, res) => {
  const { refType, refId, text } = req.body;

  if (!refType || !refId || !text) {
    return res.status(400).json({ error: 'refType, refId, and text are required' });
  }

  if (!['request', 'payment'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request or payment' });
  }

  const safeText = String(text).trim().slice(0, 200);
  if (!safeText) {
    return res.status(400).json({ error: 'Message text cannot be empty' });
  }

  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  db.prepare(
    'INSERT INTO messages (id, ref_type, ref_id, user_id, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, refType, refId, req.userId, safeText, timestamp);

  const newMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  res.status(201).json(newMsg);
});

module.exports = router;
