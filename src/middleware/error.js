const { fail } = require('../utils/response');
const { logApiError } = require('./errorAudit');
module.exports = (err, req, res, next) => {
  if (!res.locals.errorLogged) {
    res.locals.errorLogged = true;
    logApiError(req, res, err);
  }
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  return fail(res, status, err.code || 'INTERNAL_ERROR', process.env.NODE_ENV === 'production' && status >= 500 ? 'Internal server error' : err.message, status < 500 ? err.details : undefined);
};
