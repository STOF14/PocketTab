function isAdmin(role) {
  return role === 'admin';
}

function isParent(role) {
  return role === 'parent';
}

function isChild(role) {
  return role === 'child';
}

function isParentOrAdmin(role) {
  return isParent(role) || isAdmin(role);
}

module.exports = {
  isAdmin,
  isParent,
  isChild,
  isParentOrAdmin
};
