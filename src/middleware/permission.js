const { fail } = require('../utils/response');

// Permissions are stored per organization so a role can be restricted without
// changing the application-wide role list.
const permission = (moduleKey, action = 'can_view') => async (req, res, next) => {
  if (req.user?.role === 'admin' || req.user?.role === 'superadmin') return next();
  try {
    const allowedColumn = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'].includes(action) ? action : 'can_view';
    const [rows] = await req.orgDb.query(
      `SELECT ${allowedColumn} AS allowed FROM role_permissions WHERE role=? AND module_key=? LIMIT 1`,
      { replacements: [req.user?.role, moduleKey] }
    );
    if (rows[0]?.allowed) return next();
    return fail(res, 403, 'FORBIDDEN', `Permission required: ${moduleKey}.${action.replace(/^can_/, '')}`);
  } catch (error) { return next(error); }
};

module.exports = permission;
