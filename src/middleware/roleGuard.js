const { fail } = require('../utils/response');

const roleGuard =
  (...roles) =>
  (req, res, next) => {
    if (
      roles.length === 0 ||
      roles.includes(req.user?.role) ||
      req.user?.role === 'admin'
    ) {
      return next();
    }

    return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
  };

module.exports = roleGuard;
