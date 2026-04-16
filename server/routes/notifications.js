const express = require('express');
const db = require('../db');
const { authenticateToken, requireParentOrAdmin } = require('../middleware/auth');
const { parsePaging } = require('../services/utils');
const { parseNotificationRow, createNotification } = require('../services/notifications');

const router = express.Router();
router.use(authenticateToken);

// GET /api/notifications — list notifications with optional unread filter
router.get('/', (req, res) => {
  const paging = parsePaging(req.query);
  if (paging.error) {
    return res.status(400).json({ error: paging.error });
  }

  const unreadOnly = req.query.unreadOnly === 'true';
  const where = unreadOnly
    ? 'FROM notifications WHERE user_id = ? AND is_read = 0'
    : 'FROM notifications WHERE user_id = ?';

  const total = db.prepare(`SELECT COUNT(*) as total ${where}`).get(req.userId).total;

  let sql = `SELECT * ${where} ORDER BY created_at DESC`;
  const params = [req.userId];

  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const rows = db.prepare(sql).all(...params).map(parseNotificationRow);
  res.set('X-Total-Count', String(total));
  return res.json(rows);
});

// PATCH /api/notifications/:id/read — mark one notification as read
router.patch('/:id/read', (req, res) => {
  const existing = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!existing) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  const readAt = new Date().toISOString();
  db.prepare('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ?').run(readAt, req.params.id);

  const updated = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  return res.json(parseNotificationRow(updated));
});

// PATCH /api/notifications/read-all — mark all unread as read
router.patch('/read-all', (req, res) => {
  const readAt = new Date().toISOString();
  const result = db.prepare(
    'UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0'
  ).run(readAt, req.userId);

  return res.json({ message: 'All notifications marked as read', updated: result.changes });
});

// POST /api/notifications/reminders/run — generate pending-item reminders
router.post('/reminders/run', requireParentOrAdmin, (req, res) => {
  const rawStaleHours = req.body?.staleHours ?? 24;
  const staleHours = Number.parseInt(String(rawStaleHours), 10);
  if (!Number.isInteger(staleHours) || staleHours < 0) {
    return res.status(400).json({ error: 'staleHours must be an integer >= 0' });
  }
  const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();

  const pendingRequests = db.prepare(
    `SELECT r.id, r.from_id, r.to_id, r.reason
     FROM requests r
     JOIN users u ON u.id = r.from_id
     WHERE u.household_id = ? AND r.status IN ('pending', 'pending_approval') AND r.created_at <= ?`
  ).all(req.householdId, cutoff);

  const pendingPayments = db.prepare(
    `SELECT p.id, p.from_id, p.to_id, p.message
     FROM payments p
     JOIN users u ON u.id = p.from_id
     WHERE u.household_id = ? AND p.status = 'sent' AND p.created_at <= ?`
  ).all(req.householdId, cutoff);

  let created = 0;

  for (const item of pendingRequests) {
    createNotification(
      item.to_id,
      'request_reminder',
      'Pending request reminder',
      item.reason || 'A request is waiting for your action',
      { requestId: item.id }
    );
    created += 1;
  }

  for (const item of pendingPayments) {
    createNotification(
      item.to_id,
      'payment_reminder',
      'Pending payment confirmation',
      item.message || 'A payment is waiting for your confirmation',
      { paymentId: item.id }
    );
    created += 1;
  }

  return res.json({ message: 'Reminders generated', created });
});

module.exports = router;
