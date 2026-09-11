const { v4: uuid } = require('uuid');
module.exports = function activity(req, res, next) {
  res.on('finish', () => {
    if (!req.orgDb || req.method === 'GET' || res.statusCode >= 500) return;
    req.orgDb.query('INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)', {
      replacements: [uuid(), req.user?.sub || null, req.baseUrl.split('/').filter(Boolean).pop() || 'api', `${req.method} ${req.path}`, null, req.params?.id || null, JSON.stringify({ status: res.statusCode }), req.ip]
    }).catch(() => {});
  });
  next();
};
