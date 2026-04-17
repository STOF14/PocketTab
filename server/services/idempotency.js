const crypto = require('crypto');
const db = require('../db');
const { nowIso } = require('./utils');

const IDEMPOTENCY_TTL_HOURS = Number.parseInt(process.env.IDEMPOTENCY_TTL_HOURS || '24', 10);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize(value[key]);
    }
    return output;
  }

  return value;
}

function hashPayload(payload) {
  const json = JSON.stringify(canonicalize(payload || null));
  return crypto.createHash('sha256').update(json).digest('hex');
}

function cleanupIdempotencyRows() {
  const ttl = Number.isInteger(IDEMPOTENCY_TTL_HOURS) && IDEMPOTENCY_TTL_HOURS > 0
    ? IDEMPOTENCY_TTL_HOURS
    : 24;

  const cutoff = new Date(Date.now() - ttl * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff);
}

function inspectIdempotencyRequest(req, endpoint, payload) {
  const rawKey = req.get('Idempotency-Key');
  if (!rawKey) {
    return { enabled: false };
  }

  const idemKey = String(rawKey).trim();
  if (!idemKey || idemKey.length > 128) {
    return { error: 'Idempotency-Key must be between 1 and 128 characters', status: 400 };
  }

  const requestHash = hashPayload(payload);

  const existing = db.prepare(
    `SELECT request_hash, response_status, response_body
     FROM idempotency_keys
     WHERE user_id = ? AND endpoint = ? AND idem_key = ?`
  ).get(req.userId, endpoint, idemKey);

  if (!existing) {
    return {
      enabled: true,
      key: idemKey,
      requestHash
    };
  }

  if (existing.request_hash !== requestHash) {
    return {
      error: 'Idempotency key reuse with a different payload is not allowed',
      status: 409
    };
  }

  return {
    enabled: true,
    key: idemKey,
    requestHash,
    replay: {
      status: Number(existing.response_status),
      body: JSON.parse(existing.response_body)
    }
  };
}

function storeIdempotencyResponse(req, endpoint, idem, responseStatus, responseBody) {
  if (!idem || !idem.enabled || !idem.key) {
    return;
  }

  cleanupIdempotencyRows();

  try {
    db.prepare(
      `INSERT INTO idempotency_keys
        (id, user_id, endpoint, idem_key, request_hash, response_status, response_body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      req.userId,
      endpoint,
      idem.key,
      idem.requestHash,
      Number(responseStatus),
      JSON.stringify(responseBody),
      nowIso()
    );
  } catch (err) {
    // If two identical concurrent requests race, one insert may lose.
    if (!String(err.message || '').includes('UNIQUE constraint failed')) {
      throw err;
    }
  }
}

module.exports = {
  inspectIdempotencyRequest,
  storeIdempotencyResponse
};
