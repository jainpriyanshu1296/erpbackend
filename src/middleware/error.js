const { fail } = require('../utils/response');
module.exports = (err, req, res, next) => { console.error(err); if (res.headersSent) return next(err); return fail(res, err.status || 500, err.code || 'INTERNAL_ERROR', process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message); };
