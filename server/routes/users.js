const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const {
  authenticateToken,
  requireParentOrAdmin,
  requireRoles,
  revokeAllSessionsForUser,
  revokeSession
} = require('../middleware/auth');
const { createNotifications, getParentAndAdminIds } = require('../services/notifications');
const { isAdmin } = require('../services/roles');
const crypto = require('crypto');

const router = express.Router();
router.use(authenticateToken);

const VALID_ROLES = new Set(['admin', 'parent', 'child']);

// GET /api/users/me — current authenticated profile
router.get('/me', (req, res) => {
  const me = db.prepare(
    'SELECT id, name, role, failed_login_attempts, locked_until, created_at FROM users WHERE id = ?'
  ).get(req.userId);

  if (!me) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json(me);
});

// GET /api/users/members — list household members (parent/admin only)
router.get('/members', requireParentOrAdmin, (req, res) => {
  const members = db.prepare(
    'SELECT id, name, role, created_at FROM users ORDER BY created_at ASC'
  ).all();

  return res.json(members);
});

// PATCH /api/users/:id/role — assign role (admin only)
router.patch('/:id/role', requireRoles(['admin']), (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
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
  const { oldPin, newPin } = req.body;

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

  if (!bcrypt.compareSync(oldPin, user.pin_hash)) {
    return res.status(401).json({ error: 'Current PIN is incorrect' });
  }

  const newHash = bcrypt.hashSync(newPin, 10);
  db.prepare('UPDATE users SET pin_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(newHash, req.userId);
  revokeAllSessionsForUser(req.userId);

  res.json({ message: 'PIN updated successfully' });
});

// POST /api/users/pin-recovery-request — Child requests help from parent/admin
router.post('/pin-recovery-request', (req, res) => {
  const { note } = req.body || {};
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(
    'INSERT INTO pin_reset_requests (id, user_id, requested_by, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.userId, req.userId, note ? String(note).slice(0, 200) : null, 'pending', createdAt);

  const targets = getParentAndAdminIds(req.userId);
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

  const user = db.prepare('SELECT id, role, name FROM users WHERE id = ?').get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.role === 'admin' && !isAdmin(req.userRole)) {
    return res.status(403).json({ error: 'Only an admin can reset another admin PIN' });
  }

  const hash = bcrypt.hashSync(newPin, 10);
  db.prepare('UPDATE users SET pin_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(hash, req.params.id);
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
  const session = db.prepare('SELECT id, user_id, revoked_at FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
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
router.delete('/reset-all', requireParentOrAdmin, (req, res) => {
  if (process.env.ALLOW_DATA_RESET !== 'true') {
    return res.status(403).json({ error: 'Data reset is disabled on this server' });
  }

  const { confirmation } = req.body || {};
  if (confirmation !== 'RESET EVERYTHING') {
    return res.status(400).json({ error: 'Invalid reset confirmation text' });
  }

  const wipeAll = db.transaction(() => {
    db.prepare('DELETE FROM attachments').run();
    db.prepare('DELETE FROM pin_reset_requests').run();
    db.prepare('DELETE FROM notifications').run();
    db.prepare('DELETE FROM recurring_requests').run();
    db.prepare('DELETE FROM allowances').run();
    db.prepare('DELETE FROM sessions').run();
    db.prepare('DELETE FROM messages').run();
    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM users').run();
  });

  wipeAll();
  res.json({ message: 'All data has been reset' });
});

module.exports = router;
