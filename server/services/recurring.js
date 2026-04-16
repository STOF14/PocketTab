const crypto = require('crypto');
const db = require('../db');
const { createNotification } = require('./notifications');
const { centsToAmount, nowIso } = require('./utils');

function nextRunAt(currentIso, frequency) {
  const d = new Date(currentIso);
  if (frequency === 'weekly') {
    d.setDate(d.getDate() + 7);
    return d.toISOString();
  }

  const month = d.getMonth();
  d.setMonth(month + 1);
  return d.toISOString();
}

function processDueRecurringRequests(limit = 25) {
  const now = nowIso();
  const due = db.prepare(
    'SELECT * FROM recurring_requests WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?'
  ).all(now, limit);

  if (due.length === 0) {
    return { generated: 0 };
  }

  const insertRequest = db.prepare(
    'INSERT INTO requests (id, from_id, to_id, amount, amount_cents, reason, category, tags_json, recurring_id, settled_cents, requires_approval, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)'
  );

  const updateRecurring = db.prepare(
    'UPDATE recurring_requests SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?'
  );

  let generated = 0;
  const tx = db.transaction(() => {
    for (const item of due) {
      const requestId = crypto.randomUUID();
      const createdAt = nowIso();
      const reason = item.reason || 'Recurring bill';
      const status = 'pending';

      insertRequest.run(
        requestId,
        item.from_id,
        item.to_id,
        centsToAmount(item.amount_cents),
        item.amount_cents,
        reason,
        item.category || null,
        item.tags_json || null,
        item.id,
        status,
        createdAt
      );

      const nextRun = nextRunAt(item.next_run_at, item.frequency);
      updateRecurring.run(nextRun, createdAt, createdAt, item.id);

      createNotification(
        item.to_id,
        'recurring_request_generated',
        'Recurring request generated',
        reason,
        {
          requestId,
          recurringId: item.id
        }
      );

      generated += 1;
    }
  });

  tx();
  return { generated };
}

module.exports = {
  processDueRecurringRequests,
  nextRunAt
};
