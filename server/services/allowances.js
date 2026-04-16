const db = require('../db');

function getActiveAllowanceForChild(childId) {
  return db.prepare(
    'SELECT * FROM allowances WHERE child_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1'
  ).get(childId);
}

function requiresApprovalForChildRequest(userRole, userId, amountCents) {
  if (userRole !== 'child') {
    return false;
  }

  const allowance = getActiveAllowanceForChild(userId);
  if (!allowance) {
    return false;
  }

  return amountCents > Number(allowance.approval_threshold_cents || 0);
}

module.exports = {
  getActiveAllowanceForChild,
  requiresApprovalForChildRequest
};
