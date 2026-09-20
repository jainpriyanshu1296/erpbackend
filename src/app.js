
require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimiter = require('./middleware/rateLimiter');
const { auth } = require('./middleware/auth');
const orgContext = require('./middleware/orgContext');
const { ok, asyncHandler } = require('./utils/response');
const errorHandler = require('./middleware/error');
const activity = require('./middleware/activity');
const { postStockAdjustment, recordInvoicePayment, calculateGST, calculatePayroll, calculateMRP } = require('./services/erp.service');
const { excel, pdf } = require('./services/export.service');
const crud = require('./modules/generic');
const workflowRoutes = require('./modules/workflows');
const authRoutes = require('./modules/auth/auth.routes');
const forecastingRoutes = require('./modules/forecasting/forecasting.routes');
const smartReportsRoutes = require('./modules/reports/smart-reports.routes');
const inventoryPurchaseRoutes = require('./modules/inventoryPurchase.routes');
const { sales: salesProductionSalesRoutes, production: salesProductionProductionRoutes } = require('./modules/salesProduction.routes');
const zeroGapClosureRoutes = require('./modules/zeroGapClosure.routes');
const nextDomainsRoutes = require('./modules/nextDomains.routes');
const operationalDomainsRoutes = require('./modules/operationalDomains.routes');
const operationalDomains = require('./services/operationalDomains.service');
const publicRoutes = require('./modules/public/public.routes');
const onboardingRoutes = require('./modules/public/onboarding.routes');
const { processPaymentWebhook, createPendingOrder, verifyPendingPayment, provisionOrganization } = require('./services/onboarding.service');
const masterDb = require('./config/db');
const { MODULES } = require('./config/constants');
const { v4: uuid } = require('uuid');
const requestContext = require('./middleware/requestContext');
const { securityHeaders } = require('./middleware/security');
const entitlement = require('./middleware/entitlement');
const permission = require('./middleware/permission');
const { logApiError } = require('./middleware/errorAudit');
const requireAdmin = (req, res, next) => {
  if (req.user?.role === 'superadmin') return next();
  return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Administrator access required' });
};
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : (Number(process.env.TRUST_PROXY || 0) || 0));
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({ credentials: true, origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by CORS'));
} }));
app.use(requestContext);
app.use(securityHeaders);
app.post('/api/v1/public/onboarding/payments/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => ok(res, await processPaymentWebhook(req.body, req.get('x-razorpay-signature')), 'Webhook processed')));
app.use(express.json({ limit: '2mb' })); app.use(express.urlencoded({ extended: true })); app.use(rateLimiter);
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400 && !res.locals.errorLogged) {
      res.locals.errorLogged = true;
      logApiError(req, res);
    }
  });
  next();
});
app.get('/health/live', (req, res) => ok(res, { service: 'erp-api', status: 'ok', timestamp: new Date().toISOString() }));
app.get('/health/ready', asyncHandler(async (req, res) => {
  await masterDb.authenticate();
  return ok(res, { service: 'erp-api', status: 'ready', master_db: 'ok', timestamp: new Date().toISOString() });
}));
app.get('/health', (req, res) => ok(res, { service: 'erp-api', status: 'ok', timestamp: new Date().toISOString() }));
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/public/onboarding', onboardingRoutes);
app.use('/api/v1/auth', authRoutes);
const protectedRouter = express.Router(); protectedRouter.use(auth, orgContext, entitlement, activity);
protectedRouter.get('/org/info', permission('settings', 'can_view'), (req, res) => ok(res, req.org));
protectedRouter.get('/org/modules', permission('settings', 'can_view'), asyncHandler(async (req, res) => {
  const sql = `SELECT m.*, CASE WHEN om.is_active IS NOT NULL THEN om.is_active WHEN FIELD(m.min_plan,'free','starter','growth','pro') <= FIELD(?,'free','starter','growth','pro') THEN 1 ELSE 0 END AS is_enabled FROM modules m LEFT JOIN org_modules om ON om.module_key=m.module_key AND om.org_id=? ORDER BY m.sort_order`;
  const [rows] = await masterDb.query(sql, { replacements: [req.org.plan, req.org.id] });
  return ok(res, rows);
}));
protectedRouter.put('/org/modules/:key/toggle', permission('settings', 'can_edit'), asyncHandler(async (req, res) => {
  const { key } = req.params;
  const [mod] = await masterDb.query('SELECT * FROM modules WHERE module_key=?', { replacements: [key] });
  if (!mod.length) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Module not found' });
  const { PLAN_LEVEL } = require('./config/constants');
  if (PLAN_LEVEL[req.org.plan || 'free'] < PLAN_LEVEL[mod[0].min_plan || 'free']) {
    return res.status(403).json({ success: false, error: 'MODULE_DISABLED', message: 'Upgrade your plan to enable this module' });
  }
  const [curr] = await masterDb.query('SELECT is_active FROM org_modules WHERE org_id=? AND module_key=?', { replacements: [req.org.id, key] });
  const nextVal = curr.length ? (curr[0].is_active ? 0 : 1) : 0;
  await masterDb.query(
    'INSERT INTO org_modules(org_id, module_key, is_active) VALUES(?,?,?) ON DUPLICATE KEY UPDATE is_active=?',
    { replacements: [req.org.id, key, nextVal, nextVal] }
  );
  return ok(res, { module_key: key, is_enabled: Boolean(nextVal) }, 'Module status updated');
}));
protectedRouter.put('/org/info', permission('settings', 'can_edit'), asyncHandler(async (req, res) => { const keys = ['company_name','owner_name','owner_phone','gstin','address','city','state']; const set = keys.filter(k => req.body[k] !== undefined); await masterDb.query(`UPDATE organizations SET ${set.map(k => `${k}=?`).join(',')} WHERE id=?`, { replacements: [...set.map(k => req.body[k]), req.org.id] }); return ok(res, { ...req.org, ...req.body }); }));
protectedRouter.get('/dashboard/summary', permission('dashboard', 'can_view'), asyncHandler(async (req, res) => { const [[items]] = await req.orgDb.query('SELECT COUNT(*) total FROM item_master WHERE is_active=1'); const [[vendors]] = await req.orgDb.query('SELECT COUNT(*) total FROM vendors WHERE is_active=1'); return ok(res, { items: items.total, vendors: vendors.total, plan: req.org.plan }); }));
protectedRouter.get('/dashboard/alerts', permission('dashboard', 'can_view'), asyncHandler(async (req, res) => { const [rows] = await req.orgDb.query('SELECT * FROM notifications WHERE is_read=0 ORDER BY created_at DESC LIMIT 50'); return ok(res, rows); }));
protectedRouter.get('/billing/info', permission('finance', 'can_view'), asyncHandler(async (req, res) => { const [pricing] = await masterDb.query('SELECT * FROM plan_pricing WHERE is_active=1 ORDER BY plan,duration_months'); return ok(res, { plan: req.org.plan, trial_ends_at: req.org.trial_ends_at, pricing }); }));
protectedRouter.get('/billing/invoices', permission('finance', 'can_view'), asyncHandler(async (req, res) => { const [rows] = await masterDb.query('SELECT * FROM subscriptions WHERE org_id=? ORDER BY created_at DESC', { replacements: [req.org.id] }); return ok(res, rows); }));
protectedRouter.post('/billing/create-order', permission('finance', 'can_edit'), asyncHandler(async (req, res) => {
  const { v4: uuid } = require('uuid');
  const validPlans = ['starter', 'growth', 'pro'];
  const plan = String(req.body.plan || '');
  const durationMonths = Number(req.body.duration_months);
  if (!validPlans.includes(plan) || ![1, 12].includes(durationMonths)) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'A valid plan and duration_months (1 or 12) are required' });
  }
  const [pricing] = await masterDb.query(
    'SELECT amount FROM plan_pricing WHERE plan=? AND duration_months=? AND is_active=1 LIMIT 1',
    { replacements: [plan, durationMonths] }
  );
  if (!pricing.length) return res.status(400).json({ success: false, error: 'PRICING_UNAVAILABLE', message: 'This plan is not currently available' });
  const subscriptionId = uuid();
  const amount = Number(pricing[0].amount);
  await masterDb.query(
    'INSERT INTO subscriptions(id,org_id,plan,duration_months,amount,status) VALUES(?,?,?,?,?,"pending")',
    { replacements: [subscriptionId, req.org.id, plan, durationMonths, amount] }
  );
  const result = await createPendingOrder({ organizationId: req.org.id, subscriptionId });
  return ok(res, { subscription_id: subscriptionId, amount, currency: 'INR', order: result.order });
}));
protectedRouter.post('/billing/verify-payment', permission('finance', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await verifyPendingPayment(req.body);
  return ok(res, { verified: true, ...result });
}));
protectedRouter.patch('/notifications/:id/read', permission('dashboard', 'can_edit'), asyncHandler(async (req, res) => { await req.orgDb.query('UPDATE notifications SET is_read=1,read_at=NOW() WHERE id=? AND (user_id IS NULL OR user_id=?)', { replacements: [req.params.id, req.user.sub] }); return ok(res, { id: req.params.id, is_read: true }); }));
protectedRouter.post('/notifications/read-all', permission('dashboard', 'can_edit'), asyncHandler(async (req, res) => { await req.orgDb.query('UPDATE notifications SET is_read=1,read_at=NOW() WHERE user_id IS NULL OR user_id=?', { replacements: [req.user.sub] }); return ok(res, null, 'Notifications marked as read'); }));
protectedRouter.get('/inventory/stock', permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const where = search ? ' AND (im.item_name LIKE ? OR im.item_code LIKE ? OR w.name LIKE ?)' : '';
  const replacements = search ? [`%${search}%`, `%${search}%`, `%${search}%`, limit, (page - 1) * limit] : [limit, (page - 1) * limit];
  const [rows] = await req.orgDb.query(`
    SELECT ss.item_id, ss.warehouse_id, ss.current_qty, ss.avg_rate, ss.total_value, ss.last_updated,
           im.item_code, im.item_name, im.uom_id, w.name AS warehouse_name
    FROM stock_summary ss
    LEFT JOIN item_master im ON im.id = ss.item_id
    LEFT JOIN warehouses w ON w.id = ss.warehouse_id
    WHERE 1=1 ${where}
    ORDER BY ss.last_updated DESC LIMIT ? OFFSET ?`, { replacements });
  return ok(res, rows);
}));
protectedRouter.post('/inventory/stock/adjust', permission('inventory', 'can_edit'), asyncHandler(async (req, res) => ok(res, await postStockAdjustment(req.orgDb, req.body, req.user.sub), 'Stock posted')));
protectedRouter.post('/sales/invoices/:id/payments', permission('sales', 'can_edit'), asyncHandler(async (req, res) => ok(res, await recordInvoicePayment(req.orgDb, req.params.id, req.body.amount, { ...req.body, idempotency_key: req.get('Idempotency-Key') }, req.user.sub), 'Payment recorded')));
protectedRouter.post('/finance/gst/calculate', permission('gst', 'can_view'), asyncHandler(async (req, res) => ok(res, operationalDomains.calculateGSTAuthoritative(req.body.items, req.org.state, req.body.customer_state || req.body.customerState))));
protectedRouter.post('/hr/payroll/calculate', permission('hr', 'can_view'), asyncHandler(async (req, res) => { if (!req.body.employee) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'employee is required' }); return ok(res, calculatePayroll(req.body.employee, req.body.attendance, req.body.deductions)); }));
protectedRouter.post('/production/mrp/calculate', permission('production', 'can_view'), asyncHandler(async (req, res) => ok(res, { planned_quantity: calculateMRP(req.body.demand, req.body.on_hand, req.body.scheduled, req.body.safety_stock) })));
protectedRouter.post('/production/bom/:id/components', permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  const tx = await req.orgDb.transaction();
  try {
    await req.orgDb.query('DELETE FROM bom_components WHERE bom_id=?', { replacements: [req.params.id], transaction: tx });
    for (const component of req.body.components || []) {
      if (!component.item_id || Number(component.quantity) <= 0) throw Object.assign(new Error('Each BOM component needs item_id and positive quantity'), { status: 400, code: 'VALIDATION_ERROR' });
      await req.orgDb.query('INSERT INTO bom_components(id,bom_id,item_id,quantity,scrap_percent,rate) VALUES(?,?,?,?,?,?)', { replacements: [uuid(), req.params.id, component.item_id, component.quantity, component.scrap_percent || 0, component.rate || 0], transaction: tx });
    }
    await tx.commit(); return ok(res, { bom_id: req.params.id, component_count: (req.body.components || []).length }, 'BOM components saved');
  } catch (error) { await tx.rollback(); throw error; }
}));
protectedRouter.post('/sales/invoices/:id/lines', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const tx = await req.orgDb.transaction();
  try {
    await req.orgDb.query('DELETE FROM invoice_item_lines WHERE invoice_id=?', { replacements: [req.params.id], transaction: tx });
    let total = 0;
    for (const line of req.body.items || []) {
      const qty = Number(line.quantity), rate = Number(line.rate), discount = Number(line.discount_percent || 0), gst = Number(line.gst_rate || 0);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) throw Object.assign(new Error('Invoice line quantity and rate are invalid'), { status: 400, code: 'VALIDATION_ERROR' });
      const taxable = qty * rate * (1 - discount / 100), interstate = req.body.org_state !== req.body.customer_state, igst = interstate ? taxable * gst / 100 : 0, cgst = interstate ? 0 : taxable * gst / 200, sgst = cgst, lineTotal = taxable + igst + cgst + sgst;
      total += lineTotal;
      await req.orgDb.query('INSERT INTO invoice_item_lines(id,invoice_id,item_id,description,quantity,rate,discount_percent,gst_rate,taxable,cgst,sgst,igst,total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', { replacements: [uuid(), req.params.id, line.item_id || null, line.description || null, qty, rate, discount, gst, taxable, cgst, sgst, igst, lineTotal], transaction: tx });
    }
    await req.orgDb.query('UPDATE invoices SET total_amount=?, balance_amount=? WHERE id=?', { replacements: [total, total, req.params.id], transaction: tx });
    await tx.commit(); return ok(res, { invoice_id: req.params.id, total_amount: total }, 'Invoice lines saved');
  } catch (error) { await tx.rollback(); throw error; }
}));
protectedRouter.get('/reports/:table/export.xlsx', permission('reports', 'can_export'), asyncHandler(async (req, res) => { const allowedReports = ['activity_log','stock_ledger','invoices','payroll_runs']; if (!allowedReports.includes(req.params.table)) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Report not found' }); const [rows] = await req.orgDb.query(`SELECT * FROM ${req.params.table} ORDER BY 1 DESC LIMIT 10000`); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', `attachment; filename="${req.params.table}.xlsx"`).send(await excel(rows, req.params.table)); }));
protectedRouter.get('/reports/:table/export.pdf', permission('reports', 'can_export'), asyncHandler(async (req, res) => { const allowedReports = ['activity_log','stock_ledger','invoices','payroll_runs']; if (!allowedReports.includes(req.params.table)) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Report not found' }); const [rows] = await req.orgDb.query(`SELECT * FROM ${req.params.table} ORDER BY 1 DESC LIMIT 1000`); res.type('application/pdf').set('Content-Disposition', `attachment; filename="${req.params.table}.pdf"`).send(await pdf(rows, req.params.table)); }));
protectedRouter.get('/masters/:type', permission('dashboard', 'can_view'), asyncHandler(async (req, res) => { const map = { items: 'item_master', vendors: 'vendors', customers: 'customers', uom: 'uom_master', hsn: 'hsn_master', departments: 'departments', machines: 'machines', warehouses: 'warehouses' }; const table = map[req.params.type]; if (!table) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Unknown master' }); const [rows] = await req.orgDb.query(`SELECT * FROM ${table} ORDER BY 1 DESC LIMIT 500`); return ok(res, rows); }));
app.use('/api/v1', protectedRouter);
app.use('/api/v1', workflowRoutes);
app.use('/api/v1/forecasting', auth, orgContext, entitlement, forecastingRoutes);
app.use('/api/v1/reports', auth, orgContext, entitlement, smartReportsRoutes);
// Inventory and purchasing foundations use explicit handlers for tenant-safe filtering,
// validated workflow transitions, and transactional GRN posting.
app.use('/api/v1', inventoryPurchaseRoutes);
// Quality, HR, payroll, finance, GST and analytics foundations.
app.use('/api/v1', nextDomainsRoutes);
app.use('/api/v1', operationalDomainsRoutes);
// Batch 2 transactional Sales/Dispatch and Production workflows.
app.use('/api/v1/sales', salesProductionSalesRoutes);
// Customer APIs retain the existing top-level /customers convention.
app.use('/api/v1', salesProductionSalesRoutes);
app.use('/api/v1/production', salesProductionProductionRoutes);
app.use('/api/v1', zeroGapClosureRoutes);
const adminRouter = express.Router();
adminRouter.use(auth, requireAdmin);
adminRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const [rows] = await masterDb.query(`
    SELECT
      COUNT(*) AS organizations,
      SUM(CASE WHEN is_active=1 AND is_suspended=0 THEN 1 ELSE 0 END) AS active_organizations,
      SUM(CASE WHEN is_suspended=1 THEN 1 ELSE 0 END) AS suspended_organizations
    FROM organizations
  `);
  const metrics = rows[0] || {};
  return ok(res, {
    organizations: Number(metrics.organizations || 0),
    active_organizations: Number(metrics.active_organizations || 0),
    suspended_organizations: Number(metrics.suspended_organizations || 0)
  });
}));
adminRouter.get('/errors', asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const [rows] = await masterDb.query('SELECT * FROM api_error_logs ORDER BY created_at DESC LIMIT ?', { replacements: [limit] });
  return ok(res, rows);
}));
adminRouter.get('/organizations', asyncHandler(async (req, res) => {
  const [rows] = await masterDb.query(`
    SELECT o.id,o.slug,o.company_name,o.owner_email,o.owner_phone,o.plan,o.status,o.is_active,o.is_suspended,
           d.hostname,d.subdomain,o.created_at
    FROM organizations o
    LEFT JOIN organization_domains d ON d.organization_id=o.id AND d.is_primary=1
    ORDER BY o.created_at DESC
  `);
  return ok(res, rows);
}));
adminRouter.get('/domains', asyncHandler(async (req, res) => {
  const [rows] = await masterDb.query(`
    SELECT d.*,o.slug,o.company_name,o.status
    FROM organization_domains d INNER JOIN organizations o ON o.id=d.organization_id
    ORDER BY d.created_at DESC
  `);
  return ok(res, rows);
}));
adminRouter.post('/organizations', asyncHandler(async (req, res) => {
  const { company_name, owner_name, owner_email, owner_phone, slug, plan, password } = req.body;
  if (!company_name || !owner_email || !slug || !password) return fail(res, 400, 'VALIDATION_ERROR', 'company_name, owner_email, slug, password required');
  const validPlans = ['free','starter','growth','pro'];
  const chosenPlan = validPlans.includes(plan) ? plan : 'free';
  const result = await provisionOrganization({ company_name, owner_name, owner_email, owner_phone, slug, password, plan: chosenPlan });
  await masterDb.query('UPDATE organizations SET plan=?, is_trial=? WHERE id=?', { replacements: [chosenPlan, chosenPlan === 'free' ? 1 : 0, result.org.id] });
  return ok(res, { ...result.org, plan: chosenPlan }, 'Organization created');
}));
adminRouter.get('/modules', asyncHandler(async (req, res) => {
  const [rows] = await masterDb.query(`
    SELECT m.*,c.description,c.icon,c.category,c.is_purchasable,c.is_active AS catalog_active,c.display_order
    FROM modules m LEFT JOIN module_catalog c ON c.module_key=m.module_key ORDER BY COALESCE(c.display_order,m.sort_order)
  `);
  return ok(res, rows);
}));
adminRouter.get('/modules/:key/features', asyncHandler(async (req, res) => {
  const [rows] = await masterDb.query('SELECT * FROM module_features WHERE module_key=? ORDER BY display_order,feature_name', { replacements: [req.params.key] });
  return ok(res, rows);
}));
adminRouter.post('/modules/:key/features', asyncHandler(async (req, res) => {
  if (!req.body.feature_key || !req.body.feature_name) return fail(res, 400, 'VALIDATION_ERROR', 'feature_key and feature_name are required');
  await masterDb.query('INSERT INTO module_features(id,module_key,feature_key,feature_name,description,display_order) VALUES(?,?,?,?,?,?)', {
    replacements: [uuid(), req.params.key, req.body.feature_key, req.body.feature_name, req.body.description || null, Number(req.body.display_order || 0)]
  });
  return created(res, { module_key: req.params.key, feature_key: req.body.feature_key }, 'Feature created');
}));
adminRouter.put('/modules/:key/features/:featureId', asyncHandler(async (req, res) => {
  const fields = ['feature_name','description','is_active','display_order'].filter(key => req.body[key] !== undefined);
  if (!fields.length) return fail(res, 400, 'VALIDATION_ERROR', 'No fields to update');
  await masterDb.query(`UPDATE module_features SET ${fields.map(key => `${key}=?`).join(',')} WHERE id=? AND module_key=?`, {
    replacements: [...fields.map(key => req.body[key]), req.params.featureId, req.params.key]
  });
  return ok(res, { id: req.params.featureId }, 'Feature updated');
}));
adminRouter.get('/pricing', asyncHandler(async (req, res) => {
  const [plans] = await masterDb.query('SELECT * FROM plan_pricing ORDER BY plan,duration_months');
  const [modules] = await masterDb.query('SELECT * FROM module_pricing ORDER BY module_key,duration_months');
  return ok(res, { plans, modules });
}));
adminRouter.put('/pricing/plans/:id', asyncHandler(async (req, res) => {
  if (req.body.amount === undefined || Number(req.body.amount) < 0) return fail(res, 400, 'VALIDATION_ERROR', 'A non-negative amount is required');
  await masterDb.query('UPDATE plan_pricing SET amount=?,is_active=COALESCE(?,is_active) WHERE id=?', { replacements: [Number(req.body.amount), req.body.is_active, req.params.id] });
  return ok(res, { id: req.params.id, amount: Number(req.body.amount) }, 'Plan pricing updated');
}));
adminRouter.put('/pricing/modules/:id', asyncHandler(async (req, res) => {
  if (req.body.amount === undefined || Number(req.body.amount) < 0) return fail(res, 400, 'VALIDATION_ERROR', 'A non-negative amount is required');
  await masterDb.query('UPDATE module_pricing SET amount=?,is_active=COALESCE(?,is_active) WHERE id=?', { replacements: [Number(req.body.amount), req.body.is_active, req.params.id] });
  return ok(res, { id: req.params.id, amount: Number(req.body.amount) }, 'Module pricing updated');
}));
adminRouter.post('/organizations/:id/suspend', asyncHandler(async (req, res) => { await masterDb.query('UPDATE organizations SET is_suspended=1,suspension_reason=? WHERE id=?', { replacements: [req.body.reason || 'Suspended by administrator', req.params.id] }); return ok(res, { id: req.params.id, is_suspended: true }); }));
adminRouter.post('/organizations/:id/activate', asyncHandler(async (req, res) => { await masterDb.query('UPDATE organizations SET is_suspended=0,is_active=1 WHERE id=?', { replacements: [req.params.id] }); return ok(res, { id: req.params.id, is_suspended: false, is_active: true }); }));
adminRouter.get('/organizations/:id/modules', asyncHandler(async (req, res) => {
  const [modules] = await masterDb.query(`
    SELECT m.*, COALESCE(om.is_active, 0) AS is_active
    FROM modules m
    LEFT JOIN org_modules om ON om.module_key = m.module_key AND om.org_id = ?
    ORDER BY m.sort_order
  `, { replacements: [req.params.id] });
  return ok(res, modules);
}));
adminRouter.put('/organizations/:id/modules', asyncHandler(async (req, res) => {
  const { module_key, is_active } = req.body;
  const activeVal = is_active ? 1 : 0;
  await masterDb.query(
    'INSERT INTO org_modules(org_id, module_key, is_active) VALUES(?,?,?) ON DUPLICATE KEY UPDATE is_active=?',
    { replacements: [req.params.id, module_key, activeVal, activeVal] }
  );
  return ok(res, { org_id: req.params.id, module_key, is_active: Boolean(activeVal) }, 'Org module updated');
}));
adminRouter.put('/organizations/:id/plan', asyncHandler(async (req, res) => {
  const { plan } = req.body;
  const validPlans = ['free', 'starter', 'growth', 'pro'];
  if (!plan || !validPlans.includes(plan)) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid plan. Must be: free, starter, growth, pro');
  await masterDb.query('UPDATE organizations SET plan=?, plan_started_at=NOW(), is_trial=0 WHERE id=?', { replacements: [plan, req.params.id] });
  return ok(res, { id: req.params.id, plan }, 'Plan updated');

}));
adminRouter.put('/modules/:id', asyncHandler(async (req, res) => { const keys = ['module_name','min_plan','sort_order']; const set = keys.filter(k => req.body[k] !== undefined); if (!set.length) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'No fields to update' }); await masterDb.query(`UPDATE modules SET ${set.map(k => `${k}=?`).join(',')} WHERE id=?`, { replacements: [...set.map(k => req.body[k]), req.params.id] }); return ok(res, { id: req.params.id, ...req.body }); }));
app.use('/api/v1/admin', adminRouter);

// Dedicated user management — overrides generic CRUD for /settings/users
// POST: hash password before insert
// PUT: allow password change with hashing
const userRouter = express.Router();
userRouter.use(auth, orgContext, entitlement, activity);
const { permission: perm } = (() => { try { return { permission: require('./middleware/permission') }; } catch { return { permission: () => (req, res, next) => next() }; } })();
userRouter.get('/', perm('settings', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const [[count]] = await req.orgDb.query('SELECT COUNT(*) AS total FROM users');
  const [rows] = await req.orgDb.query('SELECT id,name,email,role,department,phone,is_active,last_login,created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?', { replacements: [limit, (page - 1) * limit] });
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));
userRouter.post('/', perm('settings', 'can_create'), asyncHandler(async (req, res) => {
  const { name, email, password, role, department, phone } = req.body;
  if (!name || !email || !password || !role) return fail(res, 400, 'VALIDATION_ERROR', 'Name, email, password and role are required');
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const [existing] = await req.orgDb.query('SELECT id FROM users WHERE email = ?', { replacements: [email] });
  if (existing.length) return fail(res, 409, 'CONFLICT', 'A user with this email already exists');
  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  await req.orgDb.query('INSERT INTO users (id,name,email,password_hash,role,department,phone,is_active) VALUES (?,?,?,?,?,?,?,1)', { replacements: [id, name, email, hash, role, department || null, phone || null] });
  return ok(res, { id, name, email, role }, 'User created successfully');
}));
userRouter.get('/:id', perm('settings', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query('SELECT id,name,email,role,department,phone,is_active,last_login,created_at FROM users WHERE id=?', { replacements: [req.params.id] });
  return rows[0] ? ok(res, rows[0]) : fail(res, 404, 'NOT_FOUND', 'User not found');
}));
userRouter.put('/:id', perm('settings', 'can_edit'), asyncHandler(async (req, res) => {
  const { password, ...rest } = req.body;
  const allowed = ['name', 'role', 'department', 'phone', 'is_active'];
  const keys = Object.keys(rest).filter(k => allowed.includes(k));
  if (password) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 12);
    keys.push('password_hash');
    rest.password_hash = hash;
  }
  if (!keys.length) return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
  await req.orgDb.query(`UPDATE users SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, { replacements: [...keys.map(k => rest[k]), req.params.id] });
  return ok(res, { id: req.params.id, ...rest }, 'User updated');
}));
userRouter.delete('/:id', perm('settings', 'can_delete'), asyncHandler(async (req, res) => {
  // Soft delete — deactivate instead of hard delete
  await req.orgDb.query('UPDATE users SET is_active=0 WHERE id=?', { replacements: [req.params.id] });
  return ok(res, null, 'User deactivated');
}));
app.use('/api/v1/settings/users', userRouter);
const mounts = [
  ['inventory/items','item_master','inventory'], ['inventory/ledger','stock_ledger','inventory'], ['inventory/gate-pass','gate_pass','inventory'],
  ['purchase/requisitions','purchase_requisitions','purchase'], ['purchase/orders','purchase_orders','purchase'], ['purchase/grn','grn','purchase'], ['vendors','vendors','purchase'],
  ['customers','customers','sales'], ['production/bom','bom','production'], ['production/work-orders','work_orders','production'], ['jobwork/orders','job_work_orders','jobwork'],
  ['quality/inspections','qc_inspections','quality'], ['sales/quotations','quotations','sales'], ['sales/orders','sales_orders','sales'], ['sales/invoices','invoices','sales'],
  ['sales/challans','delivery_challans','sales'], ['hr/employees','employees','hr'], ['hr/attendance','attendance','hr'], ['hr/leaves','leave_requests','hr'],
  ['notifications','notifications','dashboard'], ['settings/users','users','settings'], ['settings/company','company_settings','settings'], ['reports/records','activity_log','reports']
];
// Aliases keep the public API stable while exposing the complete ERP navigation.
mounts.push(
  ['inventory/import-export','stock_ledger','inventory'], ['production/job-cards','work_orders','production'],
  ['production/mrp','work_orders','production'], ['jobwork/challans','job_work_orders','jobwork'],
  ['quality/inward','qc_inspections','quality'], ['quality/in-process','qc_inspections','quality'], ['quality/final','qc_inspections','quality'],
  ['sales/einvoice','invoices','sales'], ['sales/ewaybill','invoices','sales'], ['hr/payroll','payroll_runs','hr'],
  ['finance/receivables','invoices','finance'], ['finance/payables','purchase_orders','finance'],
  ['finance/ledger','activity_log','finance'], ['finance/gst','invoices','finance'], ['finance/tally','activity_log','finance'],
  ['admin/activity-log','activity_log','settings'], ['billing/transactions','activity_log','settings']
);
for (const [route, table, module] of mounts) app.use(`/api/v1/${route}`, crud(table, module, { actions: { send: 'put', confirm: 'put', approve: 'put', reject: 'put', cancel: 'put', close: 'put', release: 'put', start: 'put', complete: 'put', post: 'put' } }));
const upload = multer({ dest: 'uploads/' });
app.post('/api/v1/settings/company/logo', auth, orgContext, entitlement, permission('settings', 'can_edit'), upload.single('logo'), (req, res) => ok(res, { filename: req.file?.filename }, 'Logo uploaded'));
app.use(errorHandler);
module.exports = app;
