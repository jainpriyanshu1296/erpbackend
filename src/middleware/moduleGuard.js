const masterDb = require('../config/db');
const { MODULES, PLAN_LEVEL } = require('../config/constants');
const { fail } = require('../utils/response');
const moduleGuard = key => async (req, res, next) => {
  if (!key || key === 'dashboard') return next();
  if (!MODULES.includes(key)) return next();
  try {
    const [rows] = await masterDb.query('SELECT m.min_plan, om.is_active AS explicit_active FROM modules m LEFT JOIN org_modules om ON om.module_key=m.module_key AND om.org_id=? WHERE m.module_key=?', { replacements: [req.org.id, key] });
    const module = rows[0];
    const planAllows = !module || PLAN_LEVEL[req.org.plan || 'free'] >= PLAN_LEVEL[module.min_plan || 'free'];
    if (planAllows && module?.explicit_active !== 0) return next();
    return fail(res, 403, 'MODULE_DISABLED', 'This module is not available for the current plan');
  } catch (err) { return next(err); }
};
module.exports = moduleGuard;
