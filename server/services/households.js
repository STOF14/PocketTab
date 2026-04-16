const crypto = require('crypto');
const db = require('../db');

function createHousehold(name) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const safeName = String(name || 'Household').trim().slice(0, 80) || 'Household';
  db.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)').run(id, safeName, createdAt);
  return { id, name: safeName, created_at: createdAt };
}

function getUserHousehold(userId) {
  return db.prepare(
    `SELECT h.id, h.name, h.created_at
     FROM users u
     JOIN households h ON h.id = u.household_id
     WHERE u.id = ?`
  ).get(userId);
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

  if (invite.used_at) {
    return { error: 'Invite code already used' };
  }

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { error: 'Invite code expired' };
  }

  db.prepare('UPDATE household_invites SET used_at = ?, used_by = ? WHERE id = ?')
    .run(new Date().toISOString(), userId, invite.id);

  return { householdId: invite.household_id };
}

module.exports = {
  createHousehold,
  getUserHousehold,
  getUserWithHousehold,
  areUsersInSameHousehold,
  createInvite,
  consumeInvite
};
