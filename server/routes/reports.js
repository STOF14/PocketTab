const express = require('express');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { parseDateInput } = require('../services/utils');

const router = express.Router();
router.use(authenticateToken);

function centsToAmount(cents) {
  return Number((Number(cents) / 100).toFixed(2));
}

function buildScopeWhere(alias, req, params) {
  const scope = req.query.scope || 'mine';
  const canSeeHousehold = req.userRole === 'admin' || req.userRole === 'parent';

  if (scope === 'household' && canSeeHousehold) {
    return '';
  }

  params.push(req.userId, req.userId);
  return ` AND (${alias}.from_id = ? OR ${alias}.to_id = ?)`;
}

function buildDateWhere(alias, req, params) {
  let sql = '';
  const from = parseDateInput(req.query.from);
  const to = parseDateInput(req.query.to);

  if (req.query.from && !from) {
    return { error: 'Invalid from date' };
  }

  if (req.query.to && !to) {
    return { error: 'Invalid to date' };
  }

  if (from) {
    sql += ` AND ${alias}.created_at >= ?`;
    params.push(from);
  }

  if (to) {
    sql += ` AND ${alias}.created_at <= ?`;
    params.push(to);
  }

  return { sql };
}

function loadTransactions(req) {
  const requestParams = [];
  let requestSql =
    `SELECT 'request' AS type, r.id, r.from_id, r.to_id, r.amount_cents,
            COALESCE(r.settled_cents, 0) AS settled_cents, r.status,
            r.reason AS note, r.category, r.tags_json, r.created_at
     FROM requests r
     WHERE 1=1`;

  requestSql += buildScopeWhere('r', req, requestParams);
  const requestDate = buildDateWhere('r', req, requestParams);
  if (requestDate.error) {
    return { error: requestDate.error };
  }
  requestSql += requestDate.sql;

  const paymentParams = [];
  let paymentSql =
    `SELECT 'payment' AS type, p.id, p.from_id, p.to_id, p.amount_cents,
            0 AS settled_cents, p.status,
            p.message AS note, p.category, p.tags_json, p.created_at
     FROM payments p
     WHERE 1=1`;

  paymentSql += buildScopeWhere('p', req, paymentParams);
  const paymentDate = buildDateWhere('p', req, paymentParams);
  if (paymentDate.error) {
    return { error: paymentDate.error };
  }
  paymentSql += paymentDate.sql;

  const requests = db.prepare(requestSql).all(...requestParams);
  const payments = db.prepare(paymentSql).all(...paymentParams);

  return { rows: [...requests, ...payments] };
}

function buildSummary(rows) {
  const summary = {
    totals: {
      requestCount: 0,
      paymentCount: 0,
      outstanding: 0,
      confirmedPayments: 0
    },
    categories: {},
    monthly: {},
    perUser: {}
  };

  for (const row of rows) {
    const month = String(row.created_at).slice(0, 7);
    if (!summary.monthly[month]) {
      summary.monthly[month] = { request: 0, payment: 0 };
    }

    if (row.type === 'request') {
      summary.totals.requestCount += 1;
      const remaining = Math.max(0, Number(row.amount_cents) - Number(row.settled_cents || 0));
      if (['accepted', 'partially_settled'].includes(row.status)) {
        summary.totals.outstanding += remaining;
      }
      summary.monthly[month].request += Number(row.amount_cents);
    } else {
      summary.totals.paymentCount += 1;
      if (row.status === 'confirmed') {
        summary.totals.confirmedPayments += Number(row.amount_cents);
      }
      summary.monthly[month].payment += Number(row.amount_cents);
    }

    const category = row.category || 'uncategorized';
    summary.categories[category] = (summary.categories[category] || 0) + Number(row.amount_cents);

    if (!summary.perUser[row.from_id]) {
      summary.perUser[row.from_id] = { sent: 0, received: 0 };
    }
    if (!summary.perUser[row.to_id]) {
      summary.perUser[row.to_id] = { sent: 0, received: 0 };
    }

    summary.perUser[row.from_id].sent += Number(row.amount_cents);
    summary.perUser[row.to_id].received += Number(row.amount_cents);
  }

  return {
    totals: {
      requestCount: summary.totals.requestCount,
      paymentCount: summary.totals.paymentCount,
      outstanding: centsToAmount(summary.totals.outstanding),
      confirmedPayments: centsToAmount(summary.totals.confirmedPayments)
    },
    categories: Object.entries(summary.categories).map(([category, cents]) => ({
      category,
      amount: centsToAmount(cents)
    })),
    monthly: Object.entries(summary.monthly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, totals]) => ({
        month,
        requestAmount: centsToAmount(totals.request),
        paymentAmount: centsToAmount(totals.payment)
      })),
    perUser: summary.perUser
  };
}

function rowsToCsv(rows) {
  const header = ['type', 'id', 'fromId', 'toId', 'amount', 'status', 'note', 'category', 'createdAt'];
  const lines = [header.join(',')];

  for (const row of rows) {
    const fields = [
      row.type,
      row.id,
      row.from_id,
      row.to_id,
      centsToAmount(row.amount_cents),
      row.status,
      row.note || '',
      row.category || '',
      row.created_at
    ].map((field) => `"${String(field).replaceAll('"', '""')}"`);

    lines.push(fields.join(','));
  }

  return lines.join('\n');
}

// GET /api/reports/summary — summary stats, category totals, monthly trend
router.get('/summary', (req, res) => {
  const loaded = loadTransactions(req);
  if (loaded.error) {
    return res.status(400).json({ error: loaded.error });
  }

  return res.json(buildSummary(loaded.rows));
});

// GET /api/reports/trends — monthly trends + categories
router.get('/trends', (req, res) => {
  const loaded = loadTransactions(req);
  if (loaded.error) {
    return res.status(400).json({ error: loaded.error });
  }

  const summary = buildSummary(loaded.rows);
  return res.json({ monthly: summary.monthly, categories: summary.categories });
});

// GET /api/reports/export.csv — export transactions CSV
router.get('/export.csv', (req, res) => {
  const loaded = loadTransactions(req);
  if (loaded.error) {
    return res.status(400).json({ error: loaded.error });
  }

  const csv = rowsToCsv(loaded.rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pockettab-report.csv"');
  return res.send(csv);
});

// GET /api/reports/export.pdf — export lightweight PDF-like report (text payload with PDF content type)
router.get('/export.pdf', (req, res) => {
  const loaded = loadTransactions(req);
  if (loaded.error) {
    return res.status(400).json({ error: loaded.error });
  }

  const summary = buildSummary(loaded.rows);
  const lines = [
    'PocketTab Report',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Requests: ${summary.totals.requestCount}`,
    `Payments: ${summary.totals.paymentCount}`,
    `Outstanding: R${summary.totals.outstanding.toFixed(2)}`,
    `Confirmed Payments: R${summary.totals.confirmedPayments.toFixed(2)}`,
    '',
    'Monthly Trends:'
  ];

  for (const item of summary.monthly) {
    lines.push(`${item.month} | Requests R${item.requestAmount.toFixed(2)} | Payments R${item.paymentAmount.toFixed(2)}`);
  }

  lines.push('', 'Categories:');
  for (const category of summary.categories) {
    lines.push(`${category.category}: R${category.amount.toFixed(2)}`);
  }

  const textPayload = lines.join('\n');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="pockettab-report.pdf"');
  return res.send(Buffer.from(textPayload, 'utf8'));
});

module.exports = router;
