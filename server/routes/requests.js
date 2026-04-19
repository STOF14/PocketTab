const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, requireParentOrAdmin } = require('../middleware/auth');
const { parsePaging, toAmountCents, sanitizeTags, parseDateInput, nowIso } = require('../services/utils');
const { requiresApprovalForChildRequest } = require('../services/allowances');
const { createNotifications, getParentAndAdminIds } = require('../services/notifications');
const { requireSameHousehold } = require('../middleware/household');

const router = express.Router();
router.use(authenticateToken);

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

function shapeRequest(row) {
  return {
    ...row,
    amount: Number((Number(row.amount_cents) / 100).toFixed(2)),
    settled: Number((Number(row.settled_cents || 0) / 100).toFixed(2)),
    remaining: Number((Math.max(0, Number(row.amount_cents) - Number(row.settled_cents || 0)) / 100).toFixed(2)),
    requires_approval: Boolean(row.requires_approval),
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

  if (query.q) {
    const q = `%${String(query.q).toLowerCase()}%`;
    sql += " AND (LOWER(COALESCE(reason, '')) LIKE ? OR LOWER(COALESCE(category, '')) LIKE ? OR LOWER(COALESCE(tags_json, '')) LIKE ?)";
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

// GET /api/requests — List requests for current user with filters/search
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

  const total = db.prepare(`SELECT COUNT(*) as total FROM requests ${where.sql}`).get(...whereParams).total;

  let sql =
    `SELECT id, from_id, to_id, amount_cents, settled_cents, reason, category, tags_json, recurring_id,
            requires_approval, approved_by, approved_at, status, created_at, resolved_at
     FROM requests ${where.sql}
     ORDER BY created_at DESC`;
  const params = [...whereParams];

  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const rows = db.prepare(sql).all(...params).map(shapeRequest);
  res.set('X-Total-Count', String(total));
  return res.json(rows);
});

// POST /api/requests — Create a new money request
router.post('/', requireSameHousehold((req) => req.body?.toId), (req, res) => {
  const { toId, amount, reason, category, tags } = req.body || {};

  if (!toId) {
    return res.status(400).json({ error: 'Recipient is required' });
  }

  const amountCents = toAmountCents(amount);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  const targetUser = db.prepare('SELECT id, household_id FROM users WHERE id = ?').get(toId);
  if (!targetUser) {
    return res.status(404).json({ error: 'Target user not found' });
  }

  if (toId === req.userId) {
    return res.status(400).json({ error: 'Cannot request money from yourself' });
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const safeReason = reason ? String(reason).slice(0, 160) : null;
  const safeCategory = category ? String(category).slice(0, 40).toLowerCase() : null;
  const safeTags = JSON.stringify(sanitizeTags(tags));
  const needsApproval = requiresApprovalForChildRequest(req.userRole, req.userId, amountCents);
  const status = needsApproval ? 'pending_approval' : 'pending';

  db.prepare(
    `INSERT INTO requests
      (id, from_id, to_id, amount_cents, reason, category, tags_json, settled_cents, requires_approval, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(id, req.userId, toId, amountCents, safeReason, safeCategory, safeTags, needsApproval ? 1 : 0, status, createdAt);

  if (needsApproval) {
    createNotifications(
      getParentAndAdminIds(req.userId, req.householdId),
      'request_approval_needed',
      'Child request needs approval',
      `${req.user.name} created a request requiring approval`,
      { requestId: id, amount: Number((amountCents / 100).toFixed(2)) }
    );
  } else {
    createNotifications(
      [toId],
      'request_created',
      'New money request',
      safeReason || 'You have a new money request',
      { requestId: id }
    );
  }

  const created = db.prepare(
    `SELECT id, from_id, to_id, amount_cents, settled_cents, reason, category, tags_json, recurring_id,
            requires_approval, approved_by, approved_at, status, created_at, resolved_at
     FROM requests WHERE id = ?`
  ).get(id);

  return res.status(201).json(shapeRequest(created));
});

// POST /api/requests/:id/approve-child — parent/admin approves a child request
router.post('/:id/approve-child', requireParentOrAdmin, (req, res) => {
  const request = db.prepare(
    `SELECT r.id, r.from_id, r.to_id, r.requires_approval, r.status
     FROM requests r
     JOIN users u ON u.id = r.from_id
     WHERE r.id = ? AND u.household_id = ?`
  ).get(req.params.id, req.householdId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (!request.requires_approval || request.status !== 'pending_approval') {
    return res.status(400).json({ error: 'Request is not pending approval' });
  }

  const approvedAt = nowIso();
  db.prepare(
    'UPDATE requests SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?'
  ).run('pending', req.userId, approvedAt, req.params.id);

  createNotifications(
    [request.to_id, request.from_id],
    'request_approved',
    'Request approved',
    'A child request has been approved and is now pending recipient action',
    { requestId: request.id }
  );

  const updated = db.prepare(
    `SELECT id, from_id, to_id, amount_cents, settled_cents, reason, category, tags_json, recurring_id,
            requires_approval, approved_by, approved_at, status, created_at, resolved_at
     FROM requests WHERE id = ?`
  ).get(req.params.id);

  return res.json(shapeRequest(updated));
});

// POST /api/requests/:id/reject-child — parent/admin rejects a child request
router.post('/:id/reject-child', requireParentOrAdmin, (req, res) => {
  const request = db.prepare(
    `SELECT r.id, r.from_id, r.requires_approval, r.status
     FROM requests r
     JOIN users u ON u.id = r.from_id
     WHERE r.id = ? AND u.household_id = ?`
  ).get(req.params.id, req.householdId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (!request.requires_approval || request.status !== 'pending_approval') {
    return res.status(400).json({ error: 'Request is not pending approval' });
  }

  const resolvedAt = nowIso();
  db.prepare(
    'UPDATE requests SET status = ?, resolved_at = ?, approved_by = ?, approved_at = ? WHERE id = ?'
  ).run('rejected', resolvedAt, req.userId, resolvedAt, req.params.id);

  createNotifications(
    [request.from_id],
    'request_rejected',
    'Request rejected',
    'Your request was rejected during approval',
    { requestId: request.id }
  );

  const updated = db.prepare(
    `SELECT id, from_id, to_id, amount_cents, settled_cents, reason, category, tags_json, recurring_id,
            requires_approval, approved_by, approved_at, status, created_at, resolved_at
     FROM requests WHERE id = ?`
  ).get(req.params.id);

  return res.json(shapeRequest(updated));
});

// PATCH /api/requests/:id — Accept or reject a request (recipient action)
router.patch('/:id', (req, res) => {
  const { status } = req.body || {};

  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be accepted or rejected' });
  }

  const request = db.prepare(
    `SELECT r.id, r.from_id, r.to_id, r.status
     FROM requests r
     JOIN users u ON u.id = r.from_id
     WHERE r.id = ? AND u.household_id = ?`
  ).get(req.params.id, req.householdId);

  if (!request) {
    return notFound(res);
  }

  if (request.to_id !== req.userId) {
    return notFound(res);
  }

  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request is not awaiting recipient action' });
  }

  const resolvedAt = nowIso();
  db.prepare('UPDATE requests SET status = ?, resolved_at = ? WHERE id = ?').run(status, resolvedAt, req.params.id);

  createNotifications(
    [request.from_id],
    status === 'accepted' ? 'request_accepted' : 'request_rejected',
    status === 'accepted' ? 'Request accepted' : 'Request rejected',
    status === 'accepted' ? 'Your request was accepted' : 'Your request was rejected',
    { requestId: request.id }
  );

  const updated = db.prepare(
    `SELECT id, from_id, to_id, amount_cents, settled_cents, reason, category, tags_json, recurring_id,
            requires_approval, approved_by, approved_at, status, created_at, resolved_at
     FROM requests WHERE id = ?`
  ).get(req.params.id);

  return res.json(shapeRequest(updated));
});

module.exports = router;
