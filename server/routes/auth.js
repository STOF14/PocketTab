const express = require('express');
const db = require('../db');
const { authenticateToken, issueSessionToken, revokeSession, requireRole } = require('../middleware/auth');
const crypto = require('crypto');
const { consumeInvite, createHousehold, createInvite, getUserHousehold } = require('../services/households');
const { hashPin, verifyPin, needsPinRehash } = require('../services/pin-security');

const router = express.Router();
const MAX_LOGIN_ATTEMPTS = Number.parseInt(process.env.PIN_MAX_ATTEMPTS || '5', 10);
const LOCK_MINUTES = Number.parseInt(process.env.PIN_LOCK_MINUTES || '15', 10);

function retryAfterSeconds(lockedUntilIso) {
  const remainingMs = new Date(lockedUntilIso).getTime() - Date.now();
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function toStoredRole(role) {
  return role === 'member' ? 'child' : role;
}

function toPublicRole(role) {
  return role === 'admin' ? 'admin' : 'member';
}

// GET /api/auth/users — List all users (public, for login screen)
router.get('/users', (req, res) => {
  let users = [];
  if (req.query.inviteCode) {
    const invite = db.prepare(
      'SELECT household_id FROM household_invites WHERE code = ? AND used_at IS NULL AND expires_at > ?'
    ).get(String(req.query.inviteCode).trim(), new Date().toISOString());
    users = invite
      ? db.prepare('SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC').all(invite.household_id)
      : [];
  } else if (req.query.householdId) {
    users = db.prepare(
      'SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC'
    ).all(String(req.query.householdId));
  } else {
    users = db.prepare('SELECT id, household_id, name, role, created_at FROM users ORDER BY created_at ASC').all();
  }
  res.json(users);
});

// GET /api/auth/invites/:code — validate invite and preview household/members
router.get('/invites/:code', (req, res) => {
  const code = String(req.params.code || '').trim();
  if (!code) {
    return res.status(400).json({ error: 'Invite code is required' });
  }

  const invite = db.prepare(
    `SELECT hi.id, hi.household_id, hi.expires_at, hi.used_at, h.name as household_name
     FROM household_invites hi
     JOIN households h ON h.id = hi.household_id
     WHERE hi.code = ?`
  ).get(code);

  if (!invite) {
    return res.status(404).json({ error: 'Invite code not found' });
  }

  if (invite.used_at) {
    return res.status(410).json({ error: 'Invite code already used' });
  }

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: 'Invite code expired' });
  }

  const members = db.prepare(
    'SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC'
  ).all(invite.household_id);

  return res.json({
    code,
    household: {
      id: invite.household_id,
      name: invite.household_name
    },
    expires_at: invite.expires_at,
    members
  });
});

// POST /api/auth/register — Create a new user
router.post('/register', (req, res) => {
  const { name, pin, inviteCode, createHousehold: shouldCreateHousehold, householdName } = req.body ?? {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN must be 4 digits' });
  }

  const trimmedName = name.trim().slice(0, 20);

  // Check duplicate name
  const existing = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(trimmedName);
  if (existing) {
    return res.status(400).json({ error: 'Name already taken' });
  }

  const createdAt = new Date().toISOString();
  let householdId = null;
  let inviteResolution = null;

  if (inviteCode) {
    const inviteRow = db.prepare('SELECT household_id FROM household_invites WHERE code = ?').get(String(inviteCode).trim());
    if (!inviteRow) {
      return res.status(400).json({ error: 'Invalid invite code' });
    }
    householdId = inviteRow.household_id;
  } else if (shouldCreateHousehold) {
    householdId = createHousehold(householdName || `${trimmedName}'s household`).id;
  } else {
    const firstHousehold = db.prepare('SELECT id FROM households ORDER BY created_at ASC LIMIT 1').get();
    if (firstHousehold) {
      householdId = firstHousehold.id;
    } else {
      householdId = createHousehold(householdName || `${trimmedName}'s household`).id;
    }
  }

  const id = crypto.randomUUID();
  const pinHash = hashPin(pin);
  const householdUserCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ?').get(householdId).total;
  const role = householdUserCount === 0 ? 'admin' : 'child';

  db.prepare(
    'INSERT INTO users (id, household_id, name, pin_hash, role, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
  ).run(id, householdId, trimmedName, pinHash, role, createdAt);

  if (inviteCode) {
    inviteResolution = consumeInvite(String(inviteCode).trim(), id);
    if (inviteResolution.error) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return res.status(400).json({ error: inviteResolution.error });
    }
  }

  const token = issueSessionToken(id, req);
  res.status(201).json({ token, user: { id, household_id: householdId, name: trimmedName, role, created_at: createdAt } });
});

// POST /api/auth/login — Login with user ID + PIN
router.post('/login', (req, res) => {
  const { userId, pin } = req.body ?? {};

  if (!userId || !pin) {
    return res.status(400).json({ error: 'User ID and PIN required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return res.status(423).json({
      error: 'Account is temporarily locked',
      lockedUntil: user.locked_until,
      retryAfter: retryAfterSeconds(user.locked_until)
    });
  }

  const pinCheck = verifyPin(pin, user.pin_hash);

  if (!pinCheck.matched) {
    const nextAttempts = Number(user.failed_login_attempts || 0) + 1;
    if (nextAttempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
      db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = ? WHERE id = ?').run(lockedUntil, user.id);
      return res.status(423).json({
        error: 'Too many failed attempts. Account locked temporarily.',
        lockedUntil,
        retryAfter: retryAfterSeconds(lockedUntil)
      });
    }

    db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = NULL WHERE id = ?').run(nextAttempts, user.id);
    return res.status(401).json({ error: 'Incorrect PIN', attemptsRemaining: MAX_LOGIN_ATTEMPTS - nextAttempts });
  }

  if (needsPinRehash(user.pin_hash, pinCheck.matchedWithPepper, Boolean(user.pin_hash_needs_rehash))) {
    const rehashedPin = hashPin(pin);
    db.prepare(
      'UPDATE users SET pin_hash = ?, pin_hash_needs_rehash = 0, failed_login_attempts = 0, locked_until = NULL WHERE id = ?'
    ).run(rehashedPin, user.id);
  } else {
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }

  const token = issueSessionToken(user.id, req);
  res.json({
    token,
    user: {
      id: user.id,
      household_id: user.household_id || null,
      name: user.name,
      role: user.role,
      created_at: user.created_at
    }
  });
});

// POST /api/auth/logout — Revoke current session
router.post('/logout', authenticateToken, (req, res) => {
  revokeSession(req.sessionId);
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/household — get current household details
router.get('/household', authenticateToken, (req, res) => {
  const household = getUserHousehold(req.userId);
  if (!household) {
    return res.status(404).json({ error: 'Household not found' });
  }

  const memberCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ?').get(household.id).total;
  return res.json({ ...household, memberCount });
});

// POST /api/auth/household/invites — create join invite for current household
router.post('/household/invites', authenticateToken, requireRole('admin'), (req, res) => {
  const ttlHours = Number.parseInt(req.body?.ttlHours || '24', 10);
  const invite = createInvite(req.householdId, req.userId, Number.isInteger(ttlHours) && ttlHours > 0 ? ttlHours : 24);
  return res.status(201).json(invite);
});

// PATCH /api/auth/household/members/:userId/role — admin-only role management within household
router.patch('/household/members/:userId/role', authenticateToken, requireRole('admin'), (req, res) => {
  const requestedRole = String(req.body?.role || '').trim().toLowerCase();
  if (!['admin', 'member'].includes(requestedRole)) {
    return res.status(400).json({ error: 'role must be admin or member' });
  }

  const target = db.prepare('SELECT id, household_id, role FROM users WHERE id = ?').get(req.params.userId);
  if (!target || target.household_id !== req.householdId) {
    return res.status(404).json({ error: 'Not found' });
  }

  const nextStoredRole = toStoredRole(requestedRole);
  if (target.role === 'admin' && nextStoredRole !== 'admin') {
    const adminCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ? AND role = ?').get(req.householdId, 'admin').total;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'At least one admin is required per household' });
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextStoredRole, target.id);

  const updated = db.prepare('SELECT id, role FROM users WHERE id = ?').get(target.id);
  return res.json({
    message: 'Role updated',
    member: {
      id: updated.id,
      role: toPublicRole(updated.role)
    }
  });
});

module.exports = router;
