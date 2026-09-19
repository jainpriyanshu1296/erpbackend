const masterDb = require('../config/db');
const { getOrgDb } = require('../config/orgDb');
const { fail, asyncHandler } = require('../utils/response');
const { tenantSubdomain, requestHost } = require('../config/domain');
module.exports = asyncHandler(async (req, res, next) => {
  if (['superadmin', 'support'].includes(req.user?.role) && req.path.startsWith('/admin')) return next();
  const subdomain = tenantSubdomain(req);
  if (!subdomain) return fail(res, 400, 'TENANT_DOMAIN_REQUIRED', 'A tenant subdomain is required');
  const query = `SELECT o.*, d.hostname FROM organizations o
       INNER JOIN organization_domains d ON d.organization_id=o.id
       WHERE d.subdomain=? AND d.is_active=1 LIMIT 1`;
  const [orgs] = await masterDb.query(query, { replacements: [subdomain] });
  if (!orgs.length) return fail(res, 404, 'ORG_NOT_FOUND', 'Organization not found');
  const org = orgs[0];
  const expired = (org.plan_expires_at && new Date(org.plan_expires_at).getTime() <= Date.now())
    || (org.is_trial && org.trial_ends_at && new Date(org.trial_ends_at).getTime() <= Date.now());
  if (!org.is_active || org.is_suspended || expired || ['suspended', 'cancelled', 'expired'].includes(org.status)) {
    return fail(res, 403, 'ORG_UNAVAILABLE', 'This organization is not available');
  }
  if (req.user?.orgId && String(req.user.orgId) !== String(org.id)) {
    return fail(res, 403, 'TENANT_ACCESS_DENIED', `Authenticated user does not belong to ${requestHost(req)}`);
  }
  if (req.user?.orgSlug && req.user.orgSlug !== org.slug) {
    return fail(res, 403, 'TENANT_ACCESS_DENIED', 'Authenticated user does not belong to this tenant');
  }
  req.org = org;
  req.orgDb = getOrgDb(org.db_name);
  return next();
});
