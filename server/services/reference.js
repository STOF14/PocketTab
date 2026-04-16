const db = require('../db');

function getReference(refType, refId) {
  if (refType === 'request') {
    return db.prepare('SELECT id, from_id, to_id FROM requests WHERE id = ?').get(refId);
  }

  if (refType === 'payment') {
    return db.prepare('SELECT id, from_id, to_id FROM payments WHERE id = ?').get(refId);
  }

  if (refType === 'message') {
    const message = db.prepare('SELECT id, ref_type, ref_id FROM messages WHERE id = ?').get(refId);
    if (!message) {
      return null;
    }

    const parent = getReference(message.ref_type, message.ref_id);
    if (!parent) {
      return null;
    }

    return {
      id: message.id,
      from_id: parent.from_id,
      to_id: parent.to_id,
      parent_ref_type: message.ref_type,
      parent_ref_id: message.ref_id
    };
  }

  return null;
}

function canAccessReference(reference, userId) {
  return reference && (reference.from_id === userId || reference.to_id === userId);
}

module.exports = {
  getReference,
  canAccessReference
};
