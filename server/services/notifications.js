const crypto = require('crypto');
const db = require('../db');

function nowIso() {
  return new Date().toISOString();
}

function normalizeIds(userIds) {
  return [...new Set((userIds || []).filter(Boolean))];
}

function createNotification(userId, type, title, body, meta = null) {
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const safeMeta = meta ? JSON.stringify(meta) : null;

  db.prepare(
    'INSERT INTO notifications (id, user_id, type, title, body, meta_json, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(id, userId, String(type).slice(0, 60), String(title).slice(0, 160), body ? String(body).slice(0, 500) : null, safeMeta, createdAt);

  return id;
}

function createNotifications(userIds, type, title, body, meta = null) {
  const ids = normalizeIds(userIds);
  if (ids.length === 0) {
    return [];
  }

  const insert = db.prepare(
    'INSERT INTO notifications (id, user_id, type, title, body, meta_json, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
  );

  const createdAt = nowIso();
  const safeType = String(type).slice(0, 60);
  const safeTitle = String(title).slice(0, 160);
  const safeBody = body ? String(body).slice(0, 500) : null;
  const safeMeta = meta ? JSON.stringify(meta) : null;

  const inserted = [];
  const tx = db.transaction(() => {
    for (const userId of ids) {
      const id = crypto.randomUUID();
      insert.run(id, userId, safeType, safeTitle, safeBody, safeMeta, createdAt);
      inserted.push(id);
    }
  });

  tx();
  return inserted;
}

function getParentAndAdminIds(excludeUserId = null) {
  const rows = db.prepare("SELECT id FROM users WHERE role IN ('parent', 'admin')").all();
  return rows
    .map((row) => row.id)
    .filter((id) => id && id !== excludeUserId);
}

function parseNotificationRow(row) {
  return {
    ...row,
    is_read: Boolean(row.is_read),
    meta: row.meta_json ? JSON.parse(row.meta_json) : null
  };
}

module.exports = {
  createNotification,
  createNotifications,
  getParentAndAdminIds,
  parseNotificationRow
};
