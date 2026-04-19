const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const {
  authenticateToken,
  requireParentOrAdmin,
  requireRoles,
  clearSessionCookie,
  revokeAllSessionsForUser,
  revokeSession
} = require('../middleware/auth');
const { createNotifications, getParentAndAdminIds } = require('../services/notifications');
const { isAdmin } = require('../services/roles');
const crypto = require('crypto');
const { hashPin, verifyPin } = require('../services/pin-security');

const router = express.Router();
router.use(authenticateToken);

const VALID_ROLES = new Set(['admin', 'parent', 'child']);
const MAX_HOUSEHOLD_RESET_USERS = 5000;
const attachmentsDir = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', '..', 'uploads', 'attachments');

function safeSecretMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function logResetAudit(req, payload) {
  console.warn(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'warn',
    type: 'household_data_reset',
    requestId: req.requestId || null,
    actorUserId: req.userId,
    householdId: req.householdId,
    ...payload
  }));
}

// GET /api/users/me — current authenticated profile
router.get('/me', (req, res) => {
  const me = db.prepare(
    'SELECT id, household_id, name, role, failed_login_attempts, locked_until, created_at FROM users WHERE id = ?'
  ).get(req.userId);

  if (!me) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json(me);
});

// GET /api/users/members — list household members (parent/admin only)
router.get('/members', requireParentOrAdmin, (req, res) => {
  const members = db.prepare(
    'SELECT id, household_id, name, role, created_at FROM users WHERE household_id = ? ORDER BY created_at ASC'
  ).all(req.householdId);

  return res.json(members);
});

// PATCH /api/users/:id/role — assign role (admin only)
router.patch('/:id/role', requireRoles(['admin']), (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const user = db.prepare('SELECT id, role, household_id FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.household_id !== req.householdId) {
    return res.status(403).json({ error: 'Cannot update role for user outside your household' });
  }

  if (user.role === 'admin' && role !== 'admin') {
    const adminCount = db.prepare('SELECT COUNT(*) as total FROM users WHERE household_id = ? AND role = ?')
      .get(req.householdId, 'admin').total;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'At least one admin is required per household' });
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);

  return res.json({
    message: 'Role updated',
    userId: req.params.id,
    previousRole: user.role,
    role
  });
});

// PATCH /api/users/pin — Change the current user's PIN
router.patch('/pin', (req, res) => {
  const { oldPin, newPin } = req.body ?? {};

  if (!oldPin || !newPin) {
    return res.status(400).json({ error: 'Old and new PIN required' });
  }

  if (!/^\d{4}$/.test(newPin)) {
    return res.status(400).json({ error: 'New PIN must be 4 digits' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!verifyPin(oldPin, user.pin_hash).matched) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }

  const newHash = hashPin(newPin);
  db.prepare(
    'UPDATE users SET pin_hash = ?, pin_hash_needs_rehash = 0, failed_login_attempts = 0, locked_until = NULL WHERE id = ?'
  ).run(newHash, req.userId);
  revokeAllSessionsForUser(req.userId);
  clearSessionCookie(res);

  res.json({
    message: 'PIN updated successfully. Session revoked for security.',
    sessionRevoked: true,
    nextAction: 'clear_token_and_redirect_to_login'
  });
});

// POST /api/users/pin-recovery-request — Child requests help from parent/admin
router.post('/pin-recovery-request', (req, res) => {
  const { note } = req.body || {};
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    'INSERT INTO pin_reset_requests (id, user_id, requested_by, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId, req.userId, note ? String(note).slice(0, 200) : null, 'pending', createdAt);

  const targets = getParentAndAdminIds(req.userId, req.householdId);
  createNotifications(
    targets,
    'pin_recovery_requested',
    'PIN recovery requested',
    `${req.user.name} requested PIN recovery assistance`,
    { userId: req.userId, requestId: id }
  );

  return res.status(201).json({ message: 'PIN recovery request submitted', requestId: id });
});

// POST /api/users/:id/pin-reset — Parent/admin resets a member PIN
router.post('/:id/pin-reset', requireParentOrAdmin, (req, res) => {
  const { newPin } = req.body || {};
  if (!newPin || !/^\d{4}$/.test(newPin)) {
    return res.status(400).json({ error: 'New PIN must be 4 digits' });
  }

  const user = db.prepare('SELECT id, role, name, household_id FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.household_id !== req.householdId) {
    return res.status(403).json({ error: 'Cannot reset PIN for user outside your household' });
  }

  if (user.role === 'admin' && !isAdmin(req.userRole)) {
    return res.status(403).json({ error: 'Only an admin can reset another admin PIN' });
  }

  const hash = hashPin(newPin);
  db.prepare(
    'UPDATE users SET pin_hash = ?, pin_hash_needs_rehash = 0, failed_login_attempts = 0, locked_until = NULL WHERE id = ?'
  ).run(hash, req.params.id);
  revokeAllSessionsForUser(req.params.id);

  db.prepare(
    "UPDATE pin_reset_requests SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE user_id = ? AND status = 'pending'"
  ).run(new Date().toISOString(), req.userId, req.params.id);

  createNotifications(
    [req.params.id],
    'pin_reset_completed',
    'Your PIN was reset',
    `A ${req.userRole} reset your PIN. Please sign in with the new PIN.`,
    { byUserId: req.userId }
  );

  return res.json({ message: `PIN reset for ${user.name}` });
});

// GET /api/users/sessions — list active sessions for current user (or target user if admin)
router.get('/sessions', (req, res) => {
  const targetUserId = req.query.userId && isAdmin(req.userRole) ? req.query.userId : req.userId;
  const target = db.prepare('SELECT id, household_id FROM users WHERE id = ?').get(targetUserId);
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (target.household_id !== req.householdId) {
    return res.status(403).json({ error: 'Cannot view sessions for user outside your household' });
  }

  const sessions = db.prepare(
    `SELECT id, user_id, created_at, expires_at, revoked_at, last_seen_at, user_agent, ip
     FROM sessions
     WHERE user_id = ?
     ORDER BY created_at DESC`
  ).all(targetUserId);

  return res.json(sessions);
});

// DELETE /api/users/sessions/:id — revoke session (self or admin)
router.delete('/sessions/:id', (req, res) => {
  const session = db.prepare(
    `SELECT s.id, s.user_id, s.revoked_at, u.household_id
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (session.household_id !== req.householdId) {
    return res.status(403).json({ error: 'Cannot revoke session outside your household' });
  }

  if (session.user_id !== req.userId && !isAdmin(req.userRole)) {
    return res.status(403).json({ error: 'Cannot revoke another user session' });
  }

  if (session.revoked_at) {
    return res.json({ message: 'Session already revoked' });
  }

  revokeSession(session.id);
  return res.json({ message: 'Session revoked' });
});

// DELETE /api/users/reset-all — Reset all app data (explicitly enabled only)
router.delete('/reset-all', requireRoles(['admin']), (req, res) => {
  if (process.env.ALLOW_DATA_RESET !== 'true') {
    return res.status(403).json({ error: 'Data reset is disabled on this server' });
  }

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DATA_RESET_HTTP !== 'true') {
    return res.status(403).json({ error: 'HTTP data reset is disabled in production. Use CLI tooling.' });
  }

  const { confirmation, resetSecret } = req.body || {};
  const configuredResetSecret = process.env.DATA_RESET_SECRET;
  if (!configuredResetSecret) {
    return res.status(403).json({ error: 'Data reset secret is not configured on this server' });
  }

  if (!safeSecretMatch(resetSecret, configuredResetSecret)) {
    return res.status(403).json({ error: 'Invalid reset secret' });
  }

  if (confirmation !== 'RESET EVERYTHING') {
    return res.status(400).json({ error: 'Invalid reset confirmation text' });
  }

  const householdUserIds = db.prepare('SELECT id FROM users WHERE household_id = ?').all(req.householdId).map((row) => row.id);
  if (householdUserIds.length === 0) {
    return res.status(400).json({ error: 'No household members found to reset' });
  }
  if (householdUserIds.length > MAX_HOUSEHOLD_RESET_USERS) {
    return res.status(400).json({ error: `Household reset limit exceeded (${MAX_HOUSEHOLD_RESET_USERS} users)` });
  }
  const placeholders = householdUserIds.map(() => '?').join(', ');
  const attachmentRows = db.prepare(`SELECT id, file_path FROM attachments WHERE user_id IN (${placeholders})`).all(...householdUserIds);

  logResetAudit(req, {
    action: 'attempt',
    userCount: householdUserIds.length,
    attachmentCount: attachmentRows.length
  });

  const wipeAll = db.transaction(() => {
    db.prepare('DELETE FROM household_invites WHERE household_id = ?').run(req.householdId);
    db.prepare(`DELETE FROM attachments WHERE user_id IN (${placeholders})`).run(...householdUserIds);
    db.prepare(`DELETE FROM pin_reset_requests WHERE user_id IN (${placeholders}) OR requested_by IN (${placeholders}) OR resolved_by IN (${placeholders})`)
      .run(...householdUserIds, ...householdUserIds, ...householdUserIds);
    db.prepare(`DELETE FROM notifications WHERE user_id IN (${placeholders})`).run(...householdUserIds);
    db.prepare(`DELETE FROM recurring_requests WHERE creator_id IN (${placeholders}) OR from_id IN (${placeholders}) OR to_id IN (${placeholders})`)
      .run(...householdUserIds, ...householdUserIds, ...householdUserIds);
    db.prepare(`DELETE FROM allowances WHERE parent_id IN (${placeholders}) OR child_id IN (${placeholders})`)
      .run(...householdUserIds, ...householdUserIds);
    db.prepare(`DELETE FROM sessions WHERE user_id IN (${placeholders})`).run(...householdUserIds);
    db.prepare(`DELETE FROM messages WHERE user_id IN (${placeholders})`).run(...householdUserIds);
    db.prepare(`DELETE FROM payments WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`)
      .run(...householdUserIds, ...householdUserIds);
    db.prepare(`DELETE FROM requests WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`)
      .run(...householdUserIds, ...householdUserIds);
    db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...householdUserIds);
  });

  wipeAll();

  let filesRemoved = 0;
  for (const attachment of attachmentRows) {
    const candidatePath = attachment.file_path;
    if (typeof candidatePath !== 'string' || candidatePath.trim() === '') {
      continue;
    }

    const resolvedAttachmentPath = path.resolve(candidatePath);
    const resolvedAttachmentsDir = path.resolve(attachmentsDir);
    const isWithinAttachmentsDir = resolvedAttachmentPath === resolvedAttachmentsDir
      || resolvedAttachmentPath.startsWith(`${resolvedAttachmentsDir}${path.sep}`);
    if (!isWithinAttachmentsDir) {
      continue;
    }

    if (!fs.existsSync(resolvedAttachmentPath)) {
      continue;
    }

    try {
      fs.unlinkSync(resolvedAttachmentPath);
      filesRemoved += 1;
    } catch (err) {
      console.warn(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'attachment_unlink_failed',
        requestId: req.requestId || null,
        attachmentId: attachment.id,
        path: resolvedAttachmentPath,
        message: err.message
      }));
    }
  }

  clearSessionCookie(res);
  logResetAudit(req, {
    action: 'success',
    userCount: householdUserIds.length,
    attachmentCount: attachmentRows.length,
    filesRemoved
  });

  res.json({ message: 'All data has been reset', usersRemoved: householdUserIds.length, filesRemoved });
});

module.exports = router;
