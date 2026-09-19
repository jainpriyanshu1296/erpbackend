const { fail } = require('../utils/response');
const { v4: uuid } = require('uuid');

function auditPermission(req, allowed, moduleKey, action) {
  if (!req.orgDb) return;
  req.orgDb.query(
    'INSERT INTO activity_log(id,user_id,module,action,reference_type,reference_id,changes,ip_address) VALUES(?,?,?,?,?,?,?,?)',
    {
      replacements: [
        uuid(), req.user?.sub || null, moduleKey, `permission.${action}`,
        'authorization', null,
        JSON.stringify({ allowed, method: req.method, path: req.originalUrl }),
        req.ip
      ]
    }
  ).catch(() => {});
}

// Permissions are stored per organization so a role can be restricted without
// changing the application-wide role list.
const permission = (moduleKey, action = 'can_view') => async (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.role === 'superadmin') {
    auditPermission(req, true, moduleKey, action);
    return next();
  }
  try {
    const allowedColumn = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'].includes(action) ? action : 'can_view';
    const [rows] = await req.orgDb.query(
      `SELECT ${allowedColumn} AS allowed FROM role_permissions WHERE role=? AND module_key=? LIMIT 1`,
      { replacements: [req.user?.role, moduleKey] }
    );
    if (rows[0]?.allowed) {
      auditPermission(req, true, moduleKey, action);
      return next();
    }
    auditPermission(req, false, moduleKey, action);
    return fail(res, 403, 'FORBIDDEN', `Permission required: ${moduleKey}.${action.replace(/^can_/, '')}`);
  } catch (error) { return next(error); }
};

module.exports = permission;
