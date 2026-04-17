const { areUsersInSameHousehold, getUserWithHousehold } = require('../services/households');

function requireSameHousehold(getTargetUserId) {
  return (req, res, next) => {
    const targetUserId = getTargetUserId(req);

    if (!targetUserId || targetUserId === req.userId) {
      return next();
    }

    const targetUser = getUserWithHousehold(targetUserId);
    if (!targetUser) {
      return next();
    }

    if (!areUsersInSameHousehold(req.userId, targetUserId)) {
      return res.status(403).json({ error: 'Users must belong to the same household' });
    }

    return next();
  };
}

module.exports = {
  requireSameHousehold
};