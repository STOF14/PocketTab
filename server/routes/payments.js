const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { parsePaging, toAmountCents, sanitizeTags, parseDateInput, nowIso } = require('../services/utils');
const { createNotifications } = require('../services/notifications');

const router = express.Router();
router.use(authenticateToken);

function shapePayment(row) {
  return {
    ...row,
    amount: Number((Number(row.amount_cents) / 100).toFixed(2)),
    tags: row.tags_json ? JSON.parse(row.tags_json) : []
  };
}

function applyFilters(query, reqUserId, params) {
  let sql = ' WHERE (from_id = ? OR to_id = ?)';
  params.push(reqUserId, reqUserId);

  if (query.status) {
    sql += ' AND status = ?';
    params.push(String(query.status));
  }

  if (query.counterpartyId) {
    sql += ' AND (from_id = ? OR to_id = ?)';
    params.push(String(query.counterpartyId), String(query.counterpartyId));
  }

  if (query.category) {
    sql += ' AND category = ?';
    params.push(String(query.category).toLowerCase());
  }

  if (query.tag) {
    sql += " AND LOWER(COALESCE(tags_json, '')) LIKE ?";
    params.push(`%${String(query.tag).toLowerCase()}%`);
  }

  if (query.requestId) {
    sql += ' AND request_id = ?';
    params.push(String(query.requestId));
  }

  if (query.q) {
    const q = `%${String(query.q).toLowerCase()}%`;
    sql += " AND (LOWER(COALESCE(message, '')) LIKE ? OR LOWER(COALESCE(category, '')) LIKE ? OR LOWER(COALESCE(tags_json, '')) LIKE ?)";
    params.push(q, q, q);
  }

  const minAmountCents = query.minAmount !== undefined ? toAmountCents(query.minAmount) : null;
  if (query.minAmount !== undefined && (!Number.isInteger(minAmountCents) || minAmountCents < 0)) {
    return { error: 'minAmount must be a valid amount >= 0' };
  }
  if (minAmountCents !== null) {
    sql += ' AND amount_cents >= ?';
    params.push(minAmountCents);
  }

  const maxAmountCents = query.maxAmount !== undefined ? toAmountCents(query.maxAmount) : null;
  if (query.maxAmount !== undefined && (!Number.isInteger(maxAmountCents) || maxAmountCents < 0)) {
    return { error: 'maxAmount must be a valid amount >= 0' };
  }
  if (maxAmountCents !== null) {
    sql += ' AND amount_cents <= ?';
    params.push(maxAmountCents);
  }

  const fromDate = parseDateInput(query.from);
  if (query.from && !fromDate) {
    return { error: 'Invalid from date' };
  }
  if (fromDate) {
    sql += ' AND created_at >= ?';
    params.push(fromDate);
  }

  const toDate = parseDateInput(query.to);
  if (query.to && !toDate) {
    return { error: 'Invalid to date' };
  }
  if (toDate) {
    sql += ' AND created_at <= ?';
    params.push(toDate);
  }

  return { sql };
}

// GET /api/payments — List payments for current user with filters/search
router.get('/', (req, res) => {
  const paging = parsePaging(req.query);
  if (paging.error) {
    return res.status(400).json({ error: paging.error });
  }

  const whereParams = [];
  const where = applyFilters(req.query, req.userId, whereParams);
  if (where.error) {
    return res.status(400).json({ error: where.error });
  }

  const total = db.prepare(`SELECT COUNT(*) as total FROM payments ${where.sql}`).get(...whereParams).total;

  let sql =
    `SELECT id, from_id, to_id, request_id, amount_cents, message, category, tags_json, status, created_at, resolved_at
     FROM payments ${where.sql}
     ORDER BY created_at DESC`;
  const params = [...whereParams];

  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const rows = db.prepare(sql).all(...params).map(shapePayment);
  res.set('X-Total-Count', String(total));
  return res.json(rows);
});

// POST /api/payments — Send a payment (optionally linked to requestId)
router.post('/', (req, res) => {
  const { toId, amount, message, category, tags, requestId } = req.body || {};

  const amountCents = toAmountCents(amount);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  let recipientId = toId;

  if (requestId) {
    const linkedRequest = db.prepare(
      'SELECT id, from_id, to_id, amount_cents, settled_cents, status FROM requests WHERE id = ?'
    ).get(requestId);

    if (!linkedRequest) {
      return res.status(404).json({ error: 'Linked request not found' });
    }

    if (!['accepted', 'partially_settled'].includes(linkedRequest.status)) {
      return res.status(400).json({ error: 'Linked request must be accepted or partially_settled' });
    }

    if (req.userId !== linkedRequest.to_id) {
      return res.status(403).json({ error: 'Only the debtor can create a payment linked to this request' });
    }

    recipientId = linkedRequest.from_id;

    const remaining = Math.max(0, Number(linkedRequest.amount_cents) - Number(linkedRequest.settled_cents || 0));
    if (amountCents > remaining) {
      return res.status(400).json({ error: 'Payment exceeds remaining request balance' });
    }
  }

  if (!recipientId) {
    return res.status(400).json({ error: 'Recipient is required' });
  }

  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(recipientId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Target user not found' });
  }

  if (recipientId === req.userId) {
    return res.status(400).json({ error: 'Cannot pay yourself' });
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const safeMessage = message ? String(message).slice(0, 200) : null;
  const safeCategory = category ? String(category).slice(0, 40).toLowerCase() : null;
  const safeTags = JSON.stringify(sanitizeTags(tags));

  const insertPayment = db.prepare(
    `INSERT INTO payments
      (id, from_id, to_id, request_id, amount, amount_cents, message, category, tags_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`
  );

  const insertMessage = db.prepare(
    'INSERT INTO messages (id, ref_type, ref_id, user_id, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    insertPayment.run(
      id,
      req.userId,
      recipientId,
      requestId || null,
      Number((amountCents / 100).toFixed(2)),
      amountCents,
      safeMessage,
      safeCategory,
      safeTags,
      createdAt
    );

    if (safeMessage) {
      insertMessage.run(crypto.randomUUID(), 'payment', id, req.userId, safeMessage, createdAt);
    }
  });

  tx();

  createNotifications(
    [recipientId],
    'payment_sent',
    'New payment pending confirmation',
    safeMessage || 'A payment was sent to you',
    { paymentId: id, requestId: requestId || null }
  );

  const created = db.prepare(
    `SELECT id, from_id, to_id, request_id, amount_cents, message, category, tags_json, status, created_at, resolved_at
     FROM payments WHERE id = ?`
  ).get(id);

  return res.status(201).json(shapePayment(created));
});

// PATCH /api/payments/:id — Confirm or dispute a payment
router.patch('/:id', (req, res) => {
  const { status } = req.body || {};

  if (!['confirmed', 'disputed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be confirmed or disputed' });
  }

  const payment = db.prepare(
    'SELECT id, from_id, to_id, request_id, amount_cents, status FROM payments WHERE id = ?'
  ).get(req.params.id);

  if (!payment) {
    return res.status(404).json({ error: 'Payment not found' });
  }

  if (payment.to_id !== req.userId) {
    return res.status(403).json({ error: 'Only the recipient can confirm or dispute' });
  }

  if (payment.status !== 'sent') {
    return res.status(400).json({ error: 'Payment is already resolved' });
  }

  const resolvedAt = nowIso();

  const tx = db.transaction(() => {
    db.prepare('UPDATE payments SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, req.params.id);

    if (status === 'confirmed' && payment.request_id) {
      const linkedRequest = db.prepare(
        'SELECT id, amount_cents, settled_cents, status FROM requests WHERE id = ?'
      ).get(payment.request_id);

      if (linkedRequest && ['accepted', 'partially_settled'].includes(linkedRequest.status)) {
        const nextSettled = Math.min(
          Number(linkedRequest.amount_cents),
          Number(linkedRequest.settled_cents || 0) + Number(payment.amount_cents)
        );

        let nextStatus = 'partially_settled';
        let requestResolvedAt = null;
        if (nextSettled >= Number(linkedRequest.amount_cents)) {
          nextStatus = 'settled';
          requestResolvedAt = resolvedAt;
        }

        db.prepare(
          'UPDATE requests SET settled_cents = ?, status = ?, resolved_at = ? WHERE id = ?'
        ).run(nextSettled, nextStatus, requestResolvedAt, linkedRequest.id);
      }
    }
  });

  tx();

  createNotifications(
    [payment.from_id],
    status === 'confirmed' ? 'payment_confirmed' : 'payment_disputed',
    status === 'confirmed' ? 'Payment confirmed' : 'Payment disputed',
    status === 'confirmed' ? 'Your payment was confirmed' : 'Your payment was disputed',
    { paymentId: payment.id, requestId: payment.request_id || null }
  );

  const updated = db.prepare(
    `SELECT id, from_id, to_id, request_id, amount_cents, message, category, tags_json, status, created_at, resolved_at
     FROM payments WHERE id = ?`
  ).get(req.params.id);

  return res.json(shapePayment(updated));
});

module.exports = router;
