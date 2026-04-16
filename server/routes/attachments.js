const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { parsePaging, nowIso } = require('../services/utils');
const { getReference, canAccessReference } = require('../services/reference');

const router = express.Router();
router.use(authenticateToken);

const attachmentsDir = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', '..', 'uploads', 'attachments');
fs.mkdirSync(attachmentsDir, { recursive: true });

function sanitizeFilename(name) {
  const safe = String(name || 'attachment.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return safe || 'attachment.bin';
}

function decodeBase64Data(dataBase64) {
  const cleaned = String(dataBase64 || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(cleaned, 'base64');
}

// GET /api/attachments?refType=request&refId=... — list attachments for a reference
router.get('/', (req, res) => {
  const { refType, refId } = req.query;
  if (!refType || !refId) {
    return res.status(400).json({ error: 'refType and refId are required' });
  }

  if (!['request', 'payment', 'message'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request, payment, or message' });
  }

  const ref = getReference(refType, refId);
  if (!ref) {
    return res.status(404).json({ error: `${refType} not found` });
  }

  if (!canAccessReference(ref, req.userId)) {
    return res.status(403).json({ error: 'You cannot access attachments for this item' });
  }

  const paging = parsePaging(req.query);
  if (paging.error) {
    return res.status(400).json({ error: paging.error });
  }

  const total = db.prepare(
    'SELECT COUNT(*) as total FROM attachments WHERE ref_type = ? AND ref_id = ?'
  ).get(refType, refId).total;

  let sql = 'SELECT * FROM attachments WHERE ref_type = ? AND ref_id = ? ORDER BY created_at DESC';
  const params = [refType, refId];

  if (paging.limit !== null) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(paging.limit, paging.offset);
  }

  const rows = db.prepare(sql).all(...params);
  res.set('X-Total-Count', String(total));
  return res.json(rows);
});

// POST /api/attachments — upload metadata + base64 data payload
router.post('/', (req, res) => {
  const { refType, refId, fileName, mimeType, dataBase64 } = req.body || {};

  if (!refType || !refId || !fileName || !mimeType || !dataBase64) {
    return res.status(400).json({ error: 'refType, refId, fileName, mimeType, and dataBase64 are required' });
  }

  if (!['request', 'payment', 'message'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request, payment, or message' });
  }

  const ref = getReference(refType, refId);
  if (!ref) {
    return res.status(404).json({ error: `${refType} not found` });
  }

  if (!canAccessReference(ref, req.userId)) {
    return res.status(403).json({ error: 'You cannot attach files to this item' });
  }

  const buffer = decodeBase64Data(dataBase64);
  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: 'Attachment payload is empty' });
  }

  const maxBytes = Number.parseInt(process.env.MAX_ATTACHMENT_BYTES || String(5 * 1024 * 1024), 10);
  if (buffer.length > maxBytes) {
    return res.status(400).json({ error: `Attachment exceeds max size of ${maxBytes} bytes` });
  }

  const id = crypto.randomUUID();
  const safeName = sanitizeFilename(fileName);
  const ext = path.extname(safeName) || '.bin';
  const storedName = `${id}${ext}`;
  const storedPath = path.join(attachmentsDir, storedName);
  fs.writeFileSync(storedPath, buffer);

  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO attachments
      (id, ref_type, ref_id, user_id, file_path, original_name, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, refType, refId, req.userId, storedPath, safeName, String(mimeType).slice(0, 120), buffer.length, createdAt);

  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  return res.status(201).json(row);
});

// GET /api/attachments/:id/download — download binary attachment
router.get('/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const ref = getReference(row.ref_type, row.ref_id);
  if (!ref || !canAccessReference(ref, req.userId)) {
    return res.status(403).json({ error: 'You cannot access this attachment' });
  }

  if (!fs.existsSync(row.file_path)) {
    return res.status(404).json({ error: 'Attachment file missing on server' });
  }

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(row.original_name)}"`);
  return res.sendFile(path.resolve(row.file_path));
});

// DELETE /api/attachments/:id — delete attachment by owner or parent/admin
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) {
    return res.status(404).json({ error: 'Attachment not found' });
  }

  const ref = getReference(row.ref_type, row.ref_id);
  if (!ref || !canAccessReference(ref, req.userId)) {
    return res.status(403).json({ error: 'You cannot access this attachment' });
  }

  if (row.user_id !== req.userId && !['parent', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Only the uploader or parent/admin can delete this attachment' });
  }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);

  if (row.file_path && fs.existsSync(row.file_path)) {
    fs.unlinkSync(row.file_path);
  }

  return res.json({ message: 'Attachment deleted' });
});

module.exports = router;
