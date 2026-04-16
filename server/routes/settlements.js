const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { buildNetTransfers } = require('../services/settlementEngine');

const router = express.Router();
router.use(authenticateToken);

function centsToAmount(cents) {
  return Number((Number(cents) / 100).toFixed(2));
}

// GET /api/settlements/net — compute net balances + suggested minimal transfers
router.get('/net', (req, res) => {
  const scope = req.query.scope || 'household';
  const canSeeHousehold = req.userRole === 'admin' || req.userRole === 'parent';

  if (scope === 'household' && !canSeeHousehold) {
    return res.status(403).json({ error: 'Only parent/admin can view household settlement' });
  }

  const requests = scope === 'household'
    ? db.prepare(
      `SELECT id, from_id, to_id, amount_cents, COALESCE(settled_cents, 0) as settled_cents
       FROM requests
       WHERE status IN ('accepted', 'partially_settled')`
    ).all()
    : db.prepare(
      `SELECT id, from_id, to_id, amount_cents, COALESCE(settled_cents, 0) as settled_cents
       FROM requests
       WHERE status IN ('accepted', 'partially_settled')
         AND (from_id = ? OR to_id = ?)`
    ).all(req.userId, req.userId);

  const balancesByUser = {};

  for (const reqRow of requests) {
    const remaining = Math.max(0, Number(reqRow.amount_cents) - Number(reqRow.settled_cents));
    if (remaining <= 0) {
      continue;
    }

    balancesByUser[reqRow.from_id] = (balancesByUser[reqRow.from_id] || 0) + remaining;
    balancesByUser[reqRow.to_id] = (balancesByUser[reqRow.to_id] || 0) - remaining;
  }

  const userIds = Object.keys(balancesByUser);
  const users = userIds.length > 0
    ? db.prepare(`SELECT id, name, role FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`).all(...userIds)
    : [];

  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const balances = userIds.map((userId) => ({
    userId,
    name: userMap[userId]?.name || 'Unknown',
    role: userMap[userId]?.role || null,
    net_cents: balancesByUser[userId],
    net: centsToAmount(balancesByUser[userId])
  }));

  const transfers = buildNetTransfers(balancesByUser).map((item) => ({
    ...item,
    fromName: userMap[item.fromId]?.name || 'Unknown',
    toName: userMap[item.toId]?.name || 'Unknown',
    amount: centsToAmount(item.amount_cents)
  }));

  return res.json({
    scope,
    balances,
    suggestedTransfers: transfers,
    currency: 'ZAR'
  });
});

module.exports = router;
