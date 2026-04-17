const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { parsePaging, parseDateInput, nowIso } = require('../services/utils');
const { getReference, canAccessReference } = require('../services/reference');
const { createNotifications } = require('../services/notifications');

const router = express.Router();
router.use(authenticateToken);

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

function applyFilters(query, params) {
  let sql = ' WHERE ref_type = ? AND ref_id = ?';

  if (query.q) {
    sql += ' AND LOWER(text) LIKE ?';
    params.push(`%${String(query.q).toLowerCase()}%`);
  }

  const fromDate = parseDateInput(query.from);
  if (query.from && !fromDate) {
    return { error: 'Invalid from date' };
  }
  if (fromDate) {
    sql += ' AND timestamp >= ?';
    params.push(fromDate);
  }

  const toDate = parseDateInput(query.to);
  if (query.to && !toDate) {
    return { error: 'Invalid to date' };
  }
  if (toDate) {
    sql += ' AND timestamp <= ?';
    params.push(toDate);
  }

  return { sql };
}

// GET /api/messages?refType=request&refId=xyz — Get messages for a request/payment
router.get('/', (req, res) => {
  const { refType, refId } = req.query;

  if (!refType || !refId) {
    return res.status(400).json({ error: 'refType and refId are required' });
  }

  if (!['request', 'payment'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request or payment' });
  }

  const ref = getReference(refType, refId);
  if (!ref) {
    return notFound(res);
  }

  if (!canAccessReference(ref, req.userId)) {
    return notFound(res);
  }

  const paging = parsePaging(req.query);
  if (paging.error) {
    return res.status(400).json({ error: paging.error });
  }

  const filterParams = [refType, refId];
  const filter = applyFilters(req.query, filterParams);
  if (filter.error) {
    return res.status(400).json({ error: filter.error });
  }

  const total = db.prepare(`SELECT COUNT(*) as total FROM messages ${filter.sql}`).get(...filterParams).total;

  let sql = `SELECT * FROM messages ${filter.sql} ORDER BY timestamp ASC`;
  const params = [...filterParams];
  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const messages = db.prepare(sql).all(...params);

  res.set('X-Total-Count', String(total));
  return res.json(messages);
});

// POST /api/messages — Send a chat message
router.post('/', (req, res) => {
  const { refType, refId, text } = req.body || {};

  if (!refType || !refId || !text) {
    return res.status(400).json({ error: 'refType, refId, and text are required' });
  }

  if (!['request', 'payment'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request or payment' });
  }

  const ref = getReference(refType, refId);
  if (!ref) {
    return notFound(res);
  }

  if (!canAccessReference(ref, req.userId)) {
    return notFound(res);
  }

  const safeText = String(text).trim().slice(0, 200);
  if (!safeText) {
    return res.status(400).json({ error: 'Message text cannot be empty' });
  }

  const id = crypto.randomUUID();
  const timestamp = nowIso();

  db.prepare(
    'INSERT INTO messages (id, ref_type, ref_id, user_id, text, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, refType, refId, req.userId, safeText, timestamp);

  const otherParticipantIds = [ref.from_id, ref.to_id].filter((userId) => userId && userId !== req.userId);
  createNotifications(
    otherParticipantIds,
    'new_message',
    'New message on transaction',
    safeText,
    { refType, refId, messageId: id }
  );

  const newMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return res.status(201).json(newMsg);
});

module.exports = router;
