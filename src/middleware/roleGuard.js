const { fail } = require('../utils/response');
const roleGuard =
  (...roles) =>
  (req, res, next) =>
    roles.length === 0 ||
    roles.includes(req.user?.role) ||
    req.user?.role === 'admin'
      ? next()
      : fail(res, 403, 'FORBIDDEN', 'Insufficient permissions');
module.exports = roleGuard;
