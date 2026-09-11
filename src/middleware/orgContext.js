const masterDb = require('../config/db');
const { getOrgDb } = require('../config/orgDb');
const { fail, asyncHandler } = require('../utils/response');
module.exports = asyncHandler(async (req, res, next) => {
  const slug = req.headers['x-org-slug'] || req.user?.orgSlug;
  if (!slug) return fail(res, 400, 'ORG_REQUIRED', 'X-Org-Slug header is required');
  const [orgs] = await masterDb.query('SELECT * FROM organizations WHERE slug = ? AND is_active = 1 AND is_suspended = 0 LIMIT 1', { replacements: [slug] });
  if (!orgs.length) return fail(res, 404, 'ORG_NOT_FOUND', 'Organization not found');
  req.org = orgs[0]; req.orgDb = getOrgDb(orgs[0].db_name); return next();
});
