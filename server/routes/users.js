const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();
router.use(authenticateToken);

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
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(newHash, req.userId);

  res.json({ message: 'PIN updated successfully' });
});

module.exports = router;
