const masterDb = require('../config/db');
const { v4: uuid } = require('uuid');

function logApiError(req, res, error) {
  const status = error?.status || res.statusCode;
  if (!status || status < 400) return;
  const payload = {
    id: uuid(),
    request_id: req.requestId || null,
    method: req.method,
    path: req.originalUrl,
    status_code: status,
    error_code:
      error?.code ||
      res.locals.errorCode ||
      (status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR'),
    message:
      error?.message ||
      res.locals.errorMessage ||
      res.statusMessage ||
      'Request failed',
    stack: status >= 500 ? error?.stack || null : null,
    organization_id: req.org?.id || req.user?.orgId || null,
    user_id: req.user?.sub || null,
    hostname: req.hostname || null,
    ip_address: req.ip || null,
    user_agent: req.get('user-agent') || null,
  };
  console.error(JSON.stringify({ type: 'api_error', ...payload }));
  masterDb
    .query(
      `INSERT INTO api_error_logs
      (id,request_id,method,path,status_code,error_code,message,stack,organization_id,user_id,hostname,ip_address,user_agent)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      { replacements: Object.values(payload) },
    )
    .catch((logError) => {
      console.error(
        JSON.stringify({
          type: 'api_error_log_failure',
          request_id: req.requestId,
          message: logError.message,
        }),
      );
    });
}

module.exports = { logApiError };
