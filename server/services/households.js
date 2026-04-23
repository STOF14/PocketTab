const crypto = require('crypto');
const db = require('../db');
const { hashPin } = require('./pin-security');
const {
  normalizeHouseholdLoginId,
  generateHouseholdCode,
  generateUniqueHouseholdLoginId
} = require('./household-login');

function isHouseholdLoginIdTaken(loginId, excludedHouseholdId) {
  const normalized = normalizeHouseholdLoginId(loginId);
  if (!normalized) return false;

  const row = db.prepare('SELECT id FROM households WHERE login_id = ?').get(normalized);
  if (!row) return false;
  if (!excludedHouseholdId) return true;
  return row.id !== excludedHouseholdId;
}

function allocateUniqueHouseholdLoginId(excludedHouseholdId) {
  return generateUniqueHouseholdLoginId((candidate) => isHouseholdLoginIdTaken(candidate, excludedHouseholdId));
}

function createHousehold(name) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeName = String(name || 'Household').trim().slice(0, 80) || 'Household';
  const loginId = allocateUniqueHouseholdLoginId();
  const loginCode = generateHouseholdCode();
  const loginCodeHash = hashPin(loginCode);

  db.prepare('INSERT INTO households (id, name, login_id, login_code_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, safeName, loginId, loginCodeHash, createdAt);

  return {
    id,
    name: safeName,
    created_at: createdAt,
    login_id: loginId,
    login_code_plain: loginCode
  };
}

function getUserHousehold(userId) {
  return db.prepare(
    `SELECT h.id, h.name, h.login_id, h.created_at
     FROM users u
     JOIN households h ON h.id = u.household_id
     WHERE u.id = ?`
  ).get(userId);
}

function getHouseholdByLoginId(loginId) {
  return db.prepare(
    'SELECT id, name, login_id, login_code_hash, created_at FROM households WHERE login_id = ?'
  ).get(normalizeHouseholdLoginId(loginId));
}

function rotateHouseholdLoginCode(householdId) {
  const household = db.prepare('SELECT id, login_id FROM households WHERE id = ?').get(householdId);
  if (!household) {
    return null;
  }

  const loginCode = generateHouseholdCode();
  db.prepare('UPDATE households SET login_code_hash = ? WHERE id = ?').run(hashPin(loginCode), householdId);

  return {
    id: household.id,
    login_id: household.login_id,
    login_code_plain: loginCode
  };
}

function resetHouseholdLoginCredentials(householdId, options = {}) {
  const household = db.prepare('SELECT id, login_id FROM households WHERE id = ?').get(householdId);
  if (!household) {
    return null;
  }

  const rotateLoginId = options.rotateLoginId !== false;
  const nextLoginId = rotateLoginId
    ? allocateUniqueHouseholdLoginId(household.id)
    : household.login_id;
  const nextCode = generateHouseholdCode();

  db.prepare('UPDATE households SET login_id = ?, login_code_hash = ? WHERE id = ?')
    .run(nextLoginId, hashPin(nextCode), household.id);

  return {
    id: household.id,
    login_id: nextLoginId,
    login_code_plain: nextCode,
    login_id_rotated: rotateLoginId
  };
}

function getUserWithHousehold(userId) {
  return db.prepare('SELECT id, name, role, household_id, created_at FROM users WHERE id = ?').get(userId);
}

function areUsersInSameHousehold(userAId, userBId) {
  const rows = db.prepare('SELECT id, household_id FROM users WHERE id IN (?, ?)').all(userAId, userBId);
  if (rows.length !== 2) return false;
  return rows[0].household_id && rows[0].household_id === rows[1].household_id;
}

function createInvite(householdId, createdBy, ttlHours = 24) {
  const id = crypto.randomUUID();
  const code = crypto.randomBytes(5).toString('hex');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + Math.max(1, Number(ttlHours)) * 60 * 60 * 1000);

  db.prepare(
    `INSERT INTO household_invites (id, household_id, code, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, householdId, code, createdBy, expiresAt.toISOString(), createdAt.toISOString());

  return { id, code, household_id: householdId, expires_at: expiresAt.toISOString(), created_at: createdAt.toISOString() };
}

function consumeInvite(code, userId) {
  const invite = db.prepare(
    `SELECT id, household_id, expires_at, used_at
     FROM household_invites
     WHERE code = ?`
  ).get(code);

  if (!invite) {
    return { error: 'Invalid invite code' };
  }

  const consumedAt = new Date().toISOString();
  const consumeResult = db.prepare(
    `UPDATE household_invites
     SET used_at = ?, used_by = ?
     WHERE id = ? AND used_at IS NULL AND expires_at > ?`
  ).run(consumedAt, userId, invite.id, consumedAt);

  if (consumeResult.changes !== 1) {
    const current = db.prepare('SELECT used_at, expires_at FROM household_invites WHERE id = ?').get(invite.id);
    if (!current) {
      return { error: 'Invalid invite code' };
    }

    if (current.used_at) {
      return { error: 'Invite code already used' };
    }

    if (new Date(current.expires_at).getTime() <= Date.now()) {
      return { error: 'Invite code expired' };
    }

    return { error: 'Invite code could not be consumed' };
  }

  return { householdId: invite.household_id };
}

module.exports = {
  createHousehold,
  getUserHousehold,
  getHouseholdByLoginId,
  rotateHouseholdLoginCode,
  resetHouseholdLoginCredentials,
  getUserWithHousehold,
  areUsersInSameHousehold,
  createInvite,
  consumeInvite,
  allocateUniqueHouseholdLoginId
};
