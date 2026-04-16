const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, requireParentOrAdmin } = require('../middleware/auth');
const { parsePaging, toAmountCents, sanitizeTags, nowIso } = require('../services/utils');
const { processDueRecurringRequests, nextRunAt } = require('../services/recurring');
const { createNotification } = require('../services/notifications');

const router = express.Router();
router.use(authenticateToken);

function parseFrequency(frequency) {
  return ['weekly', 'monthly'].includes(frequency) ? frequency : null;
}

function shapeRecurring(row) {
  return {
    ...row,
    active: Boolean(row.active),
    amount: Number((Number(row.amount_cents) / 100).toFixed(2)),
    tags: row.tags_json ? JSON.parse(row.tags_json) : []
  };
}

// GET /api/recurring — list recurring rules
router.get('/', (req, res) => {
  processDueRecurringRequests();

  const paging = parsePaging(req.query);
  if (paging.error) {
    return res.status(400).json({ error: paging.error });
  }

  const canSeeAll = req.userRole === 'admin' || req.userRole === 'parent';
  const where = canSeeAll
    ? 'FROM recurring_requests'
    : 'FROM recurring_requests WHERE from_id = ? OR to_id = ?';

  const countSql = `SELECT COUNT(*) as total ${where}`;
  const total = canSeeAll
    ? db.prepare(countSql).get().total
    : db.prepare(countSql).get(req.userId, req.userId).total;

  let sql = `SELECT * ${where} ORDER BY created_at DESC`;
  const params = canSeeAll ? [] : [req.userId, req.userId];

  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const rows = db.prepare(sql).all(...params).map(shapeRecurring);
  res.set('X-Total-Count', String(total));
  return res.json(rows);
});

// POST /api/recurring — create recurring rule (parent/admin)
router.post('/', requireParentOrAdmin, (req, res) => {
  const { fromId, toId, amount, reason, category, tags, frequency, nextRunAt: requestedNextRun } = req.body || {};
  const safeFrequency = parseFrequency(frequency);

  if (!fromId || !toId) {
    return res.status(400).json({ error: 'fromId and toId are required' });
  }

  if (fromId === toId) {
    return res.status(400).json({ error: 'fromId and toId must differ' });
  }

  const amountCents = toAmountCents(amount);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  if (!safeFrequency) {
    return res.status(400).json({ error: 'frequency must be weekly or monthly' });
  }

  const fromUser = db.prepare('SELECT id FROM users WHERE id = ?').get(fromId);
  const toUser = db.prepare('SELECT id FROM users WHERE id = ?').get(toId);
  if (!fromUser || !toUser) {
    return res.status(404).json({ error: 'fromId or toId user not found' });
  }

  const createdAt = nowIso();
  const id = crypto.randomUUID();
  const startAt = requestedNextRun && !Number.isNaN(new Date(requestedNextRun).getTime())
    ? new Date(requestedNextRun).toISOString()
    : nextRunAt(createdAt, safeFrequency);

  db.prepare(
    `INSERT INTO recurring_requests
      (id, creator_id, from_id, to_id, amount_cents, reason, category, tags_json, frequency, next_run_at, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    id,
    req.userId,
    fromId,
    toId,
    amountCents,
    reason ? String(reason).slice(0, 160) : null,
    category ? String(category).slice(0, 40).toLowerCase() : null,
    JSON.stringify(sanitizeTags(tags)),
    safeFrequency,
    startAt,
    createdAt,
    createdAt
  );

  createNotification(
    toId,
    'recurring_rule_created',
    'Recurring rule created',
    reason ? String(reason).slice(0, 160) : 'A recurring request rule was created for you',
    { recurringId: id, fromId }
  );

  const created = db.prepare('SELECT * FROM recurring_requests WHERE id = ?').get(id);
  return res.status(201).json(shapeRecurring(created));
});

// PATCH /api/recurring/:id — update recurring rule (parent/admin)
router.patch('/:id', requireParentOrAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM recurring_requests WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Recurring rule not found' });
  }

  const updates = {
    reason: req.body.reason !== undefined ? String(req.body.reason).slice(0, 160) : existing.reason,
    category: req.body.category !== undefined
      ? (req.body.category ? String(req.body.category).slice(0, 40).toLowerCase() : null)
      : existing.category,
    tags_json: req.body.tags !== undefined ? JSON.stringify(sanitizeTags(req.body.tags)) : existing.tags_json,
    active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active,
    next_run_at: req.body.nextRunAt && !Number.isNaN(new Date(req.body.nextRunAt).getTime())
      ? new Date(req.body.nextRunAt).toISOString()
      : existing.next_run_at,
    frequency: req.body.frequency ? parseFrequency(req.body.frequency) : existing.frequency
  };

  if (!updates.frequency) {
    return res.status(400).json({ error: 'frequency must be weekly or monthly' });
  }

  if (req.body.amount !== undefined) {
    const amountCents = toAmountCents(req.body.amount);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    updates.amount_cents = amountCents;
  } else {
    updates.amount_cents = existing.amount_cents;
  }

  updates.updated_at = nowIso();

  db.prepare(
    `UPDATE recurring_requests
       SET amount_cents = ?, reason = ?, category = ?, tags_json = ?, frequency = ?, next_run_at = ?, active = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    updates.amount_cents,
    updates.reason,
    updates.category,
    updates.tags_json,
    updates.frequency,
    updates.next_run_at,
    updates.active,
    updates.updated_at,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM recurring_requests WHERE id = ?').get(req.params.id);
  return res.json(shapeRecurring(updated));
});

// POST /api/recurring/run — trigger due recurring generation (parent/admin)
router.post('/run', requireParentOrAdmin, (req, res) => {
  const limit = Number.parseInt(req.body?.limit || '25', 10);
  const result = processDueRecurringRequests(Number.isInteger(limit) && limit > 0 ? limit : 25);
  return res.json(result);
});

module.exports = router;
