const masterDb = require('../config/db');
const { fail, asyncHandler } = require('../utils/response');

// Central subscription check. Individual modules may add a module key check.
const entitlement = asyncHandler(async (req, res, next) => {
  if (
    ['superadmin', 'support'].includes(req.user?.role) &&
    String(req.originalUrl || '').startsWith('/api/v1/admin/')
  )
    return next();
  const [rows] = await masterDb.query(
    `SELECT s.status, s.expires_at, o.trial_ends_at AS org_trial_ends_at
       FROM subscriptions s RIGHT JOIN organizations o ON o.id=s.org_id
      WHERE o.id=? ORDER BY s.created_at DESC LIMIT 1`,
    { replacements: [req.org.id] },
  );
  const subscription = rows[0];
  const expiry =
    subscription?.expires_at ||
    subscription?.org_trial_ends_at ||
    req.org.trial_ends_at;
  const expired = expiry && new Date(expiry).getTime() < Date.now();
  if (
    expired ||
    !subscription ||
    !['active', 'trial', 'paid'].includes(subscription.status)
  ) {
    return fail(
      res,
      402,
      'SUBSCRIPTION_REQUIRED',
      'An active subscription is required',
    );
  }
  req.entitlement = { active: true, subscription };
  return next();
});

module.exports = entitlement;
