const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { parsePaging, nowIso } = require('../services/utils');
const { getReference, canAccessReference } = require('../services/reference');

const router = express.Router();
router.use(authenticateToken);

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

const attachmentsDir = process.env.ATTACHMENTS_DIR || path.join(__dirname, '..', '..', 'uploads', 'attachments');
fs.mkdirSync(attachmentsDir, { recursive: true });

const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_ALLOWED_ATTACHMENT_MIME_TYPES = Object.freeze([
  'application/pdf',
  'application/octet-stream',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain'
]);

function getMaxAttachmentBytes() {
  const configured = Number.parseInt(process.env.MAX_ATTACHMENT_BYTES || String(DEFAULT_MAX_ATTACHMENT_BYTES), 10);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_ATTACHMENT_BYTES;
}

function getAllowedAttachmentMimeTypes() {
  const raw = String(process.env.ALLOWED_ATTACHMENT_MIME_TYPES || '').trim();
  const values = raw
    ? raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED_ATTACHMENT_MIME_TYPES;
  return new Set(values);
}

function parseMultipartAttachment(req, res, next) {
  const maxBytes = getMaxAttachmentBytes();
  const allowedMimeTypes = getAllowedAttachmentMimeTypes();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      files: 1,
      // Permit exact-boundary payloads and enforce the real cutoff after parse.
      fileSize: maxBytes + 1
    },
    fileFilter: (_req, file, cb) => {
      const normalizedMime = String(file.mimetype || '').toLowerCase();
      if (!allowedMimeTypes.has(normalizedMime)) {
        return cb(new Error('Attachment MIME type is not allowed'));
      }
      return cb(null, true);
    }
  }).single('file');

  upload(req, res, (err) => {
    if (!err) {
      return next();
    }

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `Attachment exceeds max size of ${maxBytes} bytes` });
      }
      return res.status(400).json({ error: 'Invalid multipart attachment payload' });
    }

    return res.status(400).json({ error: err.message || 'Invalid multipart attachment payload' });
  });
}

function sanitizeFilename(name) {
  const safe = String(name || 'attachment.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return safe || 'attachment.bin';
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
    return notFound(res);
  }

  if (!canAccessReference(ref, req.userId)) {
    return notFound(res);
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

// POST /api/attachments — upload multipart attachment payload
router.post('/', parseMultipartAttachment, (req, res) => {
  const { refType, refId } = req.body || {};

  if (!refType || !refId) {
    return res.status(400).json({ error: 'refType and refId are required' });
  }

  if (!['request', 'payment', 'message'].includes(refType)) {
    return res.status(400).json({ error: 'refType must be request, payment, or message' });
  }

  const ref = getReference(refType, refId);
  if (!ref) {
    return notFound(res);
  }

  if (!canAccessReference(ref, req.userId)) {
    return notFound(res);
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Attachment file is required (multipart field "file")' });
  }

  const buffer = req.file.buffer;
  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: 'Attachment payload is empty' });
  }

  const maxBytes = getMaxAttachmentBytes();
  if (buffer.length > maxBytes) {
    return res.status(400).json({ error: `Attachment exceeds max size of ${maxBytes} bytes` });
  }

  const id = crypto.randomUUID();
  const safeName = sanitizeFilename(req.file.originalname);
  const ext = path.extname(safeName) || '.bin';
  const storedName = `${id}${ext}`;
  const storedPath = path.join(attachmentsDir, storedName);
  fs.writeFileSync(storedPath, buffer);

  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO attachments
      (id, ref_type, ref_id, user_id, file_path, original_name, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, refType, refId, req.userId, storedPath, safeName, String(req.file.mimetype || '').slice(0, 120), buffer.length, createdAt);

  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  return res.status(201).json(row);
});

// GET /api/attachments/:id/download — download binary attachment
router.get('/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) {
    return notFound(res);
  }

  const ref = getReference(row.ref_type, row.ref_id);
  if (!ref || !canAccessReference(ref, req.userId)) {
    return notFound(res);
  }

  if (!fs.existsSync(row.file_path)) {
    return notFound(res);
  }

  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(row.original_name)}"`);
  return res.sendFile(path.resolve(row.file_path));
});

// DELETE /api/attachments/:id — delete attachment by owner or parent/admin
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) {
    return notFound(res);
  }

  const ref = getReference(row.ref_type, row.ref_id);
  if (!ref || !canAccessReference(ref, req.userId)) {
    return notFound(res);
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
