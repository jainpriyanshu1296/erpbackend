const router = require('express').Router();
const { asyncHandler, ok } = require('../../utils/response');
const masterDb = require('../../config/db');
const { tenantSubdomain } = require('../../config/domain');

router.get(
  '/content/landing',
  asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return ok(res, await require('../../services/cms.service').read(true));
  }),
);

router.get(
  '/modules',
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(`
    SELECT m.module_key AS \`key\`, m.module_name AS name, m.min_plan,
           c.description, c.icon, c.category, c.is_purchasable, c.is_active AS active,
           c.display_order,
           JSON_ARRAYAGG(JSON_OBJECT('duration_months', p.duration_months, 'amount', p.amount, 'currency', p.currency)) AS pricing
    FROM modules m
    LEFT JOIN module_catalog c ON c.module_key=m.module_key
    LEFT JOIN module_pricing p ON p.module_key=m.module_key AND p.is_active=1
    WHERE COALESCE(c.is_active, 1)=1
    GROUP BY m.module_key, m.module_name, m.min_plan, c.description, c.icon, c.category,
             c.is_purchasable, c.is_active, c.display_order
    ORDER BY COALESCE(c.display_order, m.sort_order), m.module_name
  `);
    return ok(res, rows);
  }),
);

router.get(
  '/pricing',
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(`
    SELECT plan, duration_months, amount, 'INR' AS currency
    FROM plan_pricing
    WHERE is_active=1
    ORDER BY FIELD(plan,'free','starter','growth','pro'), duration_months
  `);
    return ok(res, rows);
  }),
);

router.get(
  '/tenant',
  asyncHandler(async (req, res) => {
    const subdomain = tenantSubdomain(req);
    if (!subdomain) return ok(res, { resolved: false });
    const [rows] = await masterDb.query(
      `
    SELECT o.id, o.slug, o.company_name, o.plan, o.status, d.hostname
    FROM organizations o
    INNER JOIN organization_domains d ON d.organization_id=o.id
    WHERE d.subdomain=? AND d.is_active=1 LIMIT 1
  `,
      { replacements: [subdomain] },
    );
    return ok(
      res,
      rows[0] ? { resolved: true, organization: rows[0] } : { resolved: false },
    );
  }),
);

module.exports = router;
