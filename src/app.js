require('dotenv').config();
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
const masterDb = require('./config/db');
const { MODULES } = require('./config/constants');
const { v4: uuid } = require('uuid');
const requireAdmin = (req, res, next) => {
  if (req.user?.role === 'superadmin' || req.user?.role === 'support') return next();
  return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Administrator access required' });
};
const app = express();
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin is not allowed by CORS'));
} }));
app.use(express.json({ limit: '2mb' })); app.use(express.urlencoded({ extended: true })); app.use(rateLimiter);
app.get('/health', (req, res) => ok(res, { service: 'erp-api', status: 'ok', timestamp: new Date().toISOString() }));
app.use('/api/v1/auth', authRoutes);
const protectedRouter = express.Router(); protectedRouter.use(auth, orgContext, activity);
protectedRouter.get('/org/info', (req, res) => ok(res, req.org));
protectedRouter.get('/org/modules', asyncHandler(async (req, res) => { const [rows] = await masterDb.query('SELECT m.*, COALESCE(om.is_active, 1) as is_enabled FROM modules m LEFT JOIN org_modules om ON om.module_key=m.module_key AND om.org_id=? WHERE m.min_plan <= ? OR om.is_active=1 ORDER BY m.sort_order', { replacements: [req.org.id, req.org.plan] }); return ok(res, rows); }));
protectedRouter.put('/org/modules/:key/toggle', asyncHandler(async (req, res) => {
  const { key } = req.params;
  const [mod] = await masterDb.query('SELECT * FROM modules WHERE module_key=?', { replacements: [key] });
  if (!mod.length) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Module not found' });
  const [curr] = await masterDb.query('SELECT is_active FROM org_modules WHERE org_id=? AND module_key=?', { replacements: [req.org.id, key] });
  const nextVal = curr.length ? (curr[0].is_active ? 0 : 1) : 0;
  await masterDb.query(
    'INSERT INTO org_modules(org_id, module_key, is_active) VALUES(?,?,?) ON DUPLICATE KEY UPDATE is_active=?',
    { replacements: [req.org.id, key, nextVal, nextVal] }
  );
  return ok(res, { module_key: key, is_enabled: Boolean(nextVal) }, 'Module status updated');
}));
protectedRouter.put('/org/info', asyncHandler(async (req, res) => { const keys = ['company_name','owner_name','owner_phone','gstin','address','city','state']; const set = keys.filter(k => req.body[k] !== undefined); await masterDb.query(`UPDATE organizations SET ${set.map(k => `${k}=?`).join(',')} WHERE id=?`, { replacements: [...set.map(k => req.body[k]), req.org.id] }); return ok(res, { ...req.org, ...req.body }); }));
protectedRouter.get('/dashboard/summary', asyncHandler(async (req, res) => { const [[items]] = await req.orgDb.query('SELECT COUNT(*) total FROM item_master WHERE is_active=1'); const [[vendors]] = await req.orgDb.query('SELECT COUNT(*) total FROM vendors WHERE is_active=1'); return ok(res, { items: items.total, vendors: vendors.total, plan: req.org.plan }); }));
protectedRouter.get('/dashboard/alerts', asyncHandler(async (req, res) => { const [rows] = await req.orgDb.query('SELECT * FROM notifications WHERE is_read=0 ORDER BY created_at DESC LIMIT 50'); return ok(res, rows); }));
protectedRouter.get('/billing/info', asyncHandler(async (req, res) => { const [pricing] = await masterDb.query('SELECT * FROM plan_pricing WHERE is_active=1 ORDER BY plan,duration_months'); return ok(res, { plan: req.org.plan, trial_ends_at: req.org.trial_ends_at, pricing }); }));
protectedRouter.get('/billing/invoices', asyncHandler(async (req, res) => { const [rows] = await masterDb.query('SELECT * FROM subscriptions WHERE org_id=? ORDER BY created_at DESC', { replacements: [req.org.id] }); return ok(res, rows); }));
protectedRouter.post('/billing/create-order', asyncHandler(async (req, res) => { const { createOrder } = require('./services/razorpay.service'); return ok(res, await createOrder({ amount: Number(req.body.amount || 0) * 100, currency: 'INR', receipt: `org_${req.org.id}` })); }));
protectedRouter.post('/billing/verify-payment', asyncHandler(async (req, res) => {
  const crypto = require('crypto');
  const { verifyPayment } = require('./services/razorpay.service');
  const verified = verifyPayment(req.body);
  if (!verified) return res.status(400).json({ success: false, error: 'INVALID_SIGNATURE', message: 'Payment signature verification failed' });
  if (req.body.subscription_id) {
    await masterDb.query('UPDATE subscriptions SET status="active", starts_at=NOW(), expires_at=DATE_ADD(NOW(), INTERVAL duration_months MONTH) WHERE id=? AND org_id=?', { replacements: [req.body.subscription_id, req.org.id] });
    await masterDb.query('UPDATE organizations SET plan=(SELECT plan FROM subscriptions WHERE id=?),plan_started_at=NOW(),plan_expires_at=DATE_ADD(NOW(), INTERVAL (SELECT duration_months FROM subscriptions WHERE id=?) MONTH),is_trial=0 WHERE id=?', { replacements: [req.body.subscription_id, req.body.subscription_id, req.org.id] });
  }
  return ok(res, { verified: true, activated: Boolean(req.body.subscription_id) });
}));
protectedRouter.patch('/notifications/:id/read', asyncHandler(async (req, res) => { await req.orgDb.query('UPDATE notifications SET is_read=1,read_at=NOW() WHERE id=? AND (user_id IS NULL OR user_id=?)', { replacements: [req.params.id, req.user.sub] }); return ok(res, { id: req.params.id, is_read: true }); }));
protectedRouter.post('/notifications/read-all', asyncHandler(async (req, res) => { await req.orgDb.query('UPDATE notifications SET is_read=1,read_at=NOW() WHERE user_id IS NULL OR user_id=?', { replacements: [req.user.sub] }); return ok(res, null, 'Notifications marked as read'); }));
protectedRouter.post('/inventory/stock/adjust', asyncHandler(async (req, res) => ok(res, await postStockAdjustment(req.orgDb, req.body, req.user.sub), 'Stock posted')));
protectedRouter.post('/sales/invoices/:id/payments', asyncHandler(async (req, res) => ok(res, await recordInvoicePayment(req.orgDb, req.params.id, req.body.amount, req.body, req.user.sub), 'Payment recorded')));
protectedRouter.post('/finance/gst/calculate', asyncHandler(async (req, res) => ok(res, calculateGST(req.body.items, req.org.state, req.body.customer_state || req.body.customerState))));
protectedRouter.post('/hr/payroll/calculate', asyncHandler(async (req, res) => { if (!req.body.employee) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'employee is required' }); return ok(res, calculatePayroll(req.body.employee, req.body.attendance, req.body.deductions)); }));
protectedRouter.post('/production/mrp/calculate', asyncHandler(async (req, res) => ok(res, { planned_quantity: calculateMRP(req.body.demand, req.body.on_hand, req.body.scheduled, req.body.safety_stock) })));
protectedRouter.post('/production/bom/:id/components', asyncHandler(async (req, res) => {
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
protectedRouter.post('/sales/invoices/:id/lines', asyncHandler(async (req, res) => {
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
protectedRouter.get('/reports/:table/export.xlsx', asyncHandler(async (req, res) => { const allowedReports = ['activity_log','stock_ledger','invoices','payroll_runs']; if (!allowedReports.includes(req.params.table)) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Report not found' }); const [rows] = await req.orgDb.query(`SELECT * FROM ${req.params.table} ORDER BY 1 DESC LIMIT 10000`); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition', `attachment; filename="${req.params.table}.xlsx"`).send(await excel(rows, req.params.table)); }));
protectedRouter.get('/reports/:table/export.pdf', asyncHandler(async (req, res) => { const allowedReports = ['activity_log','stock_ledger','invoices','payroll_runs']; if (!allowedReports.includes(req.params.table)) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Report not found' }); const [rows] = await req.orgDb.query(`SELECT * FROM ${req.params.table} ORDER BY 1 DESC LIMIT 1000`); res.type('application/pdf').set('Content-Disposition', `attachment; filename="${req.params.table}.pdf"`).send(await pdf(rows, req.params.table)); }));
protectedRouter.get('/masters/:type', asyncHandler(async (req, res) => { const map = { items: 'item_master', vendors: 'vendors', customers: 'customers', uom: 'uom_master', hsn: 'hsn_master', departments: 'departments', machines: 'machines', warehouses: 'warehouses' }; const table = map[req.params.type]; if (!table) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Unknown master' }); const [rows] = await req.orgDb.query(`SELECT * FROM ${table} ORDER BY 1 DESC LIMIT 500`); return ok(res, rows); }));
app.use('/api/v1', protectedRouter);
app.use('/api/v1', workflowRoutes);
const adminRouter = express.Router();
adminRouter.use(auth, requireAdmin);
adminRouter.get('/dashboard', asyncHandler(async (req, res) => { const [[organizations]] = await masterDb.query('SELECT COUNT(*) total FROM organizations'); return ok(res, { organizations: organizations.total }); }));
adminRouter.get('/organizations', asyncHandler(async (req, res) => { const [rows] = await masterDb.query('SELECT id,slug,company_name,owner_email,plan,is_active,is_suspended,created_at FROM organizations ORDER BY created_at DESC'); return ok(res, rows); }));
adminRouter.get('/modules', asyncHandler(async (req, res) => { const [rows] = await masterDb.query('SELECT * FROM modules ORDER BY sort_order'); return ok(res, rows); }));
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
adminRouter.put('/modules/:id', asyncHandler(async (req, res) => { const keys = ['module_name','min_plan','sort_order']; const set = keys.filter(k => req.body[k] !== undefined); if (!set.length) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: 'No fields to update' }); await masterDb.query(`UPDATE modules SET ${set.map(k => `${k}=?`).join(',')} WHERE id=?`, { replacements: [...set.map(k => req.body[k]), req.params.id] }); return ok(res, { id: req.params.id, ...req.body }); }));
app.use('/api/v1/admin', adminRouter);
const mounts = [
  ['inventory/items','item_master','inventory'], ['inventory/stock','stock_summary','inventory'], ['inventory/ledger','stock_ledger','inventory'], ['inventory/gate-pass','gate_pass','inventory'],
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
app.post('/api/v1/settings/company/logo', auth, orgContext, upload.single('logo'), (req, res) => ok(res, { filename: req.file?.filename }, 'Logo uploaded'));
app.use(errorHandler);
module.exports = app;
