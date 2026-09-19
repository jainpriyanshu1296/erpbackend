const { fail } = require('../utils/response');
const { logApiError } = require('./errorAudit');
module.exports = (err, req, res, next) => {
  if (!res.locals.errorLogged) {
    res.locals.errorLogged = true;
    logApiError(req, res, err);
  }
  if (res.headersSent) return next(err);
  return fail(res, err.status || 500, err.code || 'INTERNAL_ERROR', process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message);
};
