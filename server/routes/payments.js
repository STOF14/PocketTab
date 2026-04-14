const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();
router.use(authenticateToken);

// GET /api/payments — List all payments involving the current user
router.get('/', (req, res) => {
  const payments = db.prepare(
    'SELECT * FROM payments WHERE from_id = ? OR to_id = ? ORDER BY created_at DESC'
  ).all(req.userId, req.userId);
  res.json(payments);
});

// POST /api/payments — Send a payment
router.post('/', (req, res) => {
  const { toId, amount, message } = req.body;

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
    return res.status(400).json({ error: 'Cannot pay yourself' });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeMessage = message ? String(message).slice(0, 200) : null;

  const insertPayment = db.prepare(
    'INSERT INTO payments (id, from_id, to_id, amount, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const insertMessage = db.prepare(
    'INSERT INTO messages (id, ref_type, ref_id, user_id, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  );

  // Use a transaction to insert payment and optional message together
  const createPayment = db.transaction(() => {
    insertPayment.run(id, req.userId, toId, amountNum, safeMessage, 'sent', createdAt);
    if (safeMessage) {
      insertMessage.run(crypto.randomUUID(), 'payment', id, req.userId, safeMessage, createdAt);
    }
  });

  createPayment();

  const newPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  res.status(201).json(newPayment);
});

// PATCH /api/payments/:id — Confirm or dispute a payment
router.patch('/:id', (req, res) => {
  const { status } = req.body;

  if (!['confirmed', 'disputed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be confirmed or disputed' });
  }

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  // Only the recipient can confirm/dispute
  if (payment.to_id !== req.userId) {
    return res.status(403).json({ error: 'Only the recipient can confirm or dispute' });
  }

  if (payment.status !== 'sent') {
    return res.status(400).json({ error: 'Payment is already resolved' });
  }

  const resolvedAt = new Date().toISOString();
  db.prepare('UPDATE payments SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, req.params.id);

  const updated = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  res.json(updated);
});

module.exports = router;
