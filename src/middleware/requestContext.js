const { randomUUID } = require('crypto');
const { safeRequestId } = require('./security');

module.exports = function requestContext(req, res, next) {
  const requestId = safeRequestId(req.headers['x-request-id'] || randomUUID());
  req.requestId = requestId;
  res.setHeader('X-Request-Id', req.requestId);
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      req.apiError = {
        status: res.statusCode,
        code:
          res.locals.errorCode ||
          (res.statusCode >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
        message:
          res.locals.errorMessage || res.statusMessage || 'Request failed',
      };
    }
  });
  next();
};
