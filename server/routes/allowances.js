const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken, requireParentOrAdmin } = require('../middleware/auth');
const { parsePaging, toAmountCents, nowIso } = require('../services/utils');
const { createNotifications } = require('../services/notifications');

const router = express.Router();
router.use(authenticateToken);

function shapeAllowance(row) {
  return {
    ...row,
    active: Boolean(row.active),
    budget: Number((Number(row.budget_cents) / 100).toFixed(2)),
    approvalThreshold: Number((Number(row.approval_threshold_cents) / 100).toFixed(2))
  };
}

// GET /api/allowances — list allowances
router.get('/', (req, res) => {
  const paging = parsePaging(req.query);
  if (paging.error) {
    return res.status(400).json({ error: paging.error });
  }

  const isPrivileged = req.userRole === 'parent' || req.userRole === 'admin';
  const where = isPrivileged
    ? 'FROM allowances a JOIN users c ON c.id = a.child_id WHERE c.household_id = ?'
    : 'FROM allowances a JOIN users c ON c.id = a.child_id WHERE a.child_id = ? AND c.household_id = ?';
  const params = isPrivileged ? [req.householdId] : [req.userId, req.householdId];

  const total = db.prepare(`SELECT COUNT(*) as total ${where}`).get(...params).total;

  let sql = `SELECT a.* ${where} ORDER BY a.created_at DESC`;
  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const rows = db.prepare(sql).all(...params).map(shapeAllowance);
  res.set('X-Total-Count', String(total));
  return res.json(rows);
});

// POST /api/allowances — create allowance rule (parent/admin)
router.post('/', requireParentOrAdmin, (req, res) => {
  const { childId, budget, period, approvalThreshold } = req.body || {};

  if (!childId || !budget || !period) {
    return res.status(400).json({ error: 'childId, budget and period are required' });
  }

  if (!['weekly', 'monthly'].includes(period)) {
    return res.status(400).json({ error: 'period must be weekly or monthly' });
  }

  const child = db.prepare('SELECT id, role, household_id FROM users WHERE id = ?').get(childId);
  if (!child) {
    return res.status(404).json({ error: 'Child user not found' });
  }
  if (child.household_id !== req.householdId) {
    return res.status(403).json({ error: 'Allowances can only target users in your household' });
  }

  if (child.role !== 'child') {
    return res.status(400).json({ error: 'Allowances can only be assigned to child users' });
  }

  const budgetCents = toAmountCents(budget);
  const thresholdCents = approvalThreshold !== undefined ? toAmountCents(approvalThreshold) : 0;

  if (!Number.isInteger(budgetCents) || budgetCents <= 0) {
    return res.status(400).json({ error: 'budget must be greater than 0' });
  }

  if (!Number.isInteger(thresholdCents) || thresholdCents < 0) {
    return res.status(400).json({ error: 'approvalThreshold must be 0 or greater' });
  }

  const createdAt = nowIso();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO allowances
      (id, parent_id, child_id, budget_cents, period, approval_threshold_cents, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, req.userId, childId, budgetCents, period, thresholdCents, createdAt, createdAt);

  createNotifications(
    [childId],
    'allowance_assigned',
    'Allowance assigned',
    `A ${period} allowance has been assigned to you`,
    { allowanceId: id, budget }
  );

  const created = db.prepare('SELECT * FROM allowances WHERE id = ?').get(id);
  return res.status(201).json(shapeAllowance(created));
});

// PATCH /api/allowances/:id — update allowance rule (parent/admin)
router.patch('/:id', requireParentOrAdmin, (req, res) => {
  const existing = db.prepare(
    `SELECT a.*
     FROM allowances a
     JOIN users c ON c.id = a.child_id
     WHERE a.id = ? AND c.household_id = ?`
  ).get(req.params.id, req.householdId);
  if (!existing) {
    return res.status(404).json({ error: 'Allowance not found' });
  }

  const updated = {
    period: req.body.period || existing.period,
    active: req.body.active !== undefined ? (req.body.active ? 1 : 0) : existing.active,
    budget_cents: existing.budget_cents,
    approval_threshold_cents: existing.approval_threshold_cents,
    updated_at: nowIso()
  };

  if (!['weekly', 'monthly'].includes(updated.period)) {
    return res.status(400).json({ error: 'period must be weekly or monthly' });
  }

  if (req.body.budget !== undefined) {
    const budgetCents = toAmountCents(req.body.budget);
    if (!Number.isInteger(budgetCents) || budgetCents <= 0) {
      return res.status(400).json({ error: 'budget must be greater than 0' });
    }
    updated.budget_cents = budgetCents;
  }

  if (req.body.approvalThreshold !== undefined) {
    const threshold = toAmountCents(req.body.approvalThreshold);
    if (!Number.isInteger(threshold) || threshold < 0) {
      return res.status(400).json({ error: 'approvalThreshold must be 0 or greater' });
    }
    updated.approval_threshold_cents = threshold;
  }

  db.prepare(
    `UPDATE allowances
       SET budget_cents = ?, period = ?, approval_threshold_cents = ?, active = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    updated.budget_cents,
    updated.period,
    updated.approval_threshold_cents,
    updated.active,
    updated.updated_at,
    req.params.id
  );

  const after = db.prepare('SELECT * FROM allowances WHERE id = ?').get(req.params.id);
  return res.json(shapeAllowance(after));
});

module.exports = router;
