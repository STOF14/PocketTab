const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();
router.use(authenticateToken);

// GET /api/requests — List all requests involving the current user
router.get('/', (req, res) => {
  const requests = db.prepare(
    'SELECT * FROM requests WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC'
  ).all(req.userId, req.userId);
  res.json(requests);
});

// POST /api/requests — Create a new money request
router.post('/', (req, res) => {
  const { toId, amount, reason } = req.body;

  if (!toId) {
    return res.status(400).json({ error: 'Recipient is required' });
  }

  const amountNum = parseFloat(amount);
  if (!amount || isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  // Verify target user exists
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(toId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Target user not found' });
  }

  if (toId === req.userId) {
    return res.status(400).json({ error: 'Cannot request money from yourself' });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeReason = reason ? String(reason).slice(0, 100) : null;

  db.prepare(
    'INSERT INTO requests (id, from_id, to_id, amount, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId, toId, amountNum, safeReason, 'pending', createdAt);

  const newReq = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
  res.status(201).json(newReq);
});

// PATCH /api/requests/:id — Accept or reject a request
router.patch('/:id', (req, res) => {
  const { status } = req.body;

  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be accepted or rejected' });
  }

  const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  // Only the target user can accept/reject
  if (request.to_id !== req.userId) {
    return res.status(403).json({ error: 'Only the recipient can accept or reject' });
  }

  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request is already resolved' });
  }

  const resolvedAt = new Date().toISOString();
  db.prepare('UPDATE requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, req.params.id);

  const updated = db.prepare('SELECT * FROM requests WHERE id = ?').get(req.params.id);
  res.json(updated);
});

module.exports = router;
