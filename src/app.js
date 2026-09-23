require('dotenv').config();
const { validateEnv } = require('./config/env');
validateEnv();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const rateLimiter = require('./middleware/rateLimiter');
const { auth } = require('./middleware/auth');
const orgContext = require('./middleware/orgContext');
const { ok, fail, created, asyncHandler } = require('./utils/response');
const errorHandler = require('./middleware/error');
const activity = require('./middleware/activity');
const {
  postStockAdjustment,
  recordInvoicePayment,
  calculateGST,
  calculatePayroll,
  calculateMRP,
} = require('./services/erp.service');
const { excel, pdf } = require('./services/export.service');
const crud = require('./modules/generic');
const workflowRoutes = require('./modules/workflows');
const authRoutes = require('./modules/auth/auth.routes');
const forecastingRoutes = require('./modules/forecasting/forecasting.routes');
const smartReportsRoutes = require('./modules/reports/smart-reports.routes');
const inventoryPurchaseRoutes = require('./modules/inventoryPurchase.routes');
const {
  sales: salesProductionSalesRoutes,
  production: salesProductionProductionRoutes,
} = require('./modules/salesProduction.routes');
const zeroGapClosureRoutes = require('./modules/zeroGapClosure.routes');
const nextDomainsRoutes = require('./modules/nextDomains.routes');
const operationalDomainsRoutes = require('./modules/operationalDomains.routes');
const operationalDomains = require('./services/operationalDomains.service');
const purchaseRoutes = require('./modules/purchase.routes');
const inventoryRoutes = require('./modules/inventory.routes');
const salesRoutes = require('./modules/sales.routes');
const publicRoutes = require('./modules/public/public.routes');
const onboardingRoutes = require('./modules/public/onboarding.routes');
const {
  processPaymentWebhook,
  createPendingOrder,
  verifyPendingPayment,
  provisionOrganization,
} = require('./services/onboarding.service');
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
  return res.status(403).json({
    success: false,
    error: 'FORBIDDEN',
    message: 'Administrator access required',
  });
};
const app = express();
app.set(
  'trust proxy',
  process.env.TRUST_PROXY === 'true'
    ? true
    : Number(process.env.TRUST_PROXY || 0) || 0,
);
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS'));
    },
  }),
);
app.use(requestContext);
app.use(securityHeaders);
app.post(
  '/api/v1/public/onboarding/payments/webhook',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await processPaymentWebhook(req.body, req.get('x-razorpay-signature')),
      'Webhook processed',
    ),
  ),
);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(rateLimiter);
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400 && !res.locals.errorLogged) {
      res.locals.errorLogged = true;
      logApiError(req, res);
    }
  });
  next();
});
app.get('/health/live', (req, res) =>
  ok(res, {
    service: 'erp-api',
    status: 'ok',
    timestamp: new Date().toISOString(),
  }),
);
app.get(
  '/health/ready',
  asyncHandler(async (req, res) => {
    await masterDb.authenticate();
    return ok(res, {
      service: 'erp-api',
      status: 'ready',
      master_db: 'ok',
      timestamp: new Date().toISOString(),
    });
  }),
);
app.get('/health', (req, res) =>
  ok(res, {
    service: 'erp-api',
    status: 'ok',
    timestamp: new Date().toISOString(),
  }),
);
app.use('/api/v1/public', publicRoutes);
app.use('/api/v1/public/onboarding', onboardingRoutes);
app.use('/api/v1/auth', authRoutes);
const protectedRouter = express.Router();
protectedRouter.use(auth, orgContext, entitlement, activity);
protectedRouter.get(
  '/org/info',
  permission('settings', 'can_view'),
  (req, res) => ok(res, req.org),
);
protectedRouter.get(
  '/org/modules',
  permission('settings', 'can_view'),
  asyncHandler(async (req, res) => {
    const sql = `SELECT m.*, CASE WHEN om.is_active IS NOT NULL THEN om.is_active WHEN FIELD(m.min_plan,'free','starter','growth','pro') <= FIELD(?,'free','starter','growth','pro') THEN 1 ELSE 0 END AS is_enabled FROM modules m LEFT JOIN org_modules om ON om.module_key=m.module_key AND om.org_id=? ORDER BY m.sort_order`;
    const [rows] = await masterDb.query(sql, {
      replacements: [req.org.plan, req.org.id],
    });
    return ok(res, rows);
  }),
);
protectedRouter.put(
  '/org/modules/:key/toggle',
  permission('settings', 'can_edit'),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const [mod] = await masterDb.query(
      'SELECT * FROM modules WHERE module_key=?',
      { replacements: [key] },
    );
    if (!mod.length)
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: 'Module not found',
      });
    const { PLAN_LEVEL } = require('./config/constants');
    if (
      PLAN_LEVEL[req.org.plan || 'free'] < PLAN_LEVEL[mod[0].min_plan || 'free']
    ) {
      return res.status(403).json({
        success: false,
        error: 'MODULE_DISABLED',
        message: 'Upgrade your plan to enable this module',
      });
    }
    const [curr] = await masterDb.query(
      'SELECT is_active FROM org_modules WHERE org_id=? AND module_key=?',
      { replacements: [req.org.id, key] },
    );
    const nextVal = curr.length ? (curr[0].is_active ? 0 : 1) : 0;
    await masterDb.query(
      'INSERT INTO org_modules(org_id, module_key, is_active) VALUES(?,?,?) ON DUPLICATE KEY UPDATE is_active=?',
      { replacements: [req.org.id, key, nextVal, nextVal] },
    );
    return ok(
      res,
      { module_key: key, is_enabled: Boolean(nextVal) },
      'Module status updated',
    );
  }),
);
protectedRouter.put(
  '/org/info',
  permission('settings', 'can_edit'),
  asyncHandler(async (req, res) => {
    const keys = [
      'company_name',
      'owner_name',
      'owner_phone',
      'gstin',
      'address',
      'city',
      'state',
    ];
    const set = keys.filter((k) => req.body[k] !== undefined);
    await masterDb.query(
      `UPDATE organizations SET ${set.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...set.map((k) => req.body[k]), req.org.id] },
    );
    return ok(res, { ...req.org, ...req.body });
  }),
);
protectedRouter.get(
  '/dashboard/alerts',
  permission('dashboard', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT * FROM notifications WHERE is_read=0 ORDER BY created_at DESC LIMIT 50',
    );
    return ok(res, rows);
  }),
);
protectedRouter.get(
  '/billing/info',
  permission('finance', 'can_view'),
  asyncHandler(async (req, res) => {
    const [pricing] = await masterDb.query(
      'SELECT * FROM plan_pricing WHERE is_active=1 ORDER BY plan,duration_months',
    );
    return ok(res, {
      plan: req.org.plan,
      trial_ends_at: req.org.trial_ends_at,
      pricing,
    });
  }),
);
protectedRouter.get(
  '/billing/invoices',
  permission('finance', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(
      'SELECT * FROM subscriptions WHERE org_id=? ORDER BY created_at DESC',
      { replacements: [req.org.id] },
    );
    return ok(res, rows);
  }),
);
protectedRouter.post(
  '/billing/create-order',
  permission('finance', 'can_edit'),
  asyncHandler(async (req, res) => {
    const { v4: uuid } = require('uuid');
    const validPlans = ['starter', 'growth', 'pro'];
    const plan = String(req.body.plan || '');
    const durationMonths = Number(req.body.duration_months);
    if (!validPlans.includes(plan) || ![1, 12].includes(durationMonths)) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'A valid plan and duration_months (1 or 12) are required',
      });
    }
    const [pricing] = await masterDb.query(
      'SELECT amount FROM plan_pricing WHERE plan=? AND duration_months=? AND is_active=1 LIMIT 1',
      { replacements: [plan, durationMonths] },
    );
    if (!pricing.length)
      return res.status(400).json({
        success: false,
        error: 'PRICING_UNAVAILABLE',
        message: 'This plan is not currently available',
      });
    const subscriptionId = uuid();
    const amount = Number(pricing[0].amount);
    await masterDb.query(
      'INSERT INTO subscriptions(id,org_id,plan,duration_months,amount,status) VALUES(?,?,?,?,?,"pending")',
      {
        replacements: [
          subscriptionId,
          req.org.id,
          plan,
          durationMonths,
          amount,
        ],
      },
    );
    const result = await createPendingOrder({
      organizationId: req.org.id,
      subscriptionId,
    });
    return ok(res, {
      subscription_id: subscriptionId,
      amount,
      currency: 'INR',
      order: result.order,
    });
  }),
);
protectedRouter.post(
  '/billing/verify-payment',
  permission('finance', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await verifyPendingPayment(req.body);
    return ok(res, { verified: true, ...result });
  }),
);
protectedRouter.patch(
  '/notifications/:id/read',
  permission('dashboard', 'can_edit'),
  asyncHandler(async (req, res) => {
    await req.orgDb.query(
      'UPDATE notifications SET is_read=1,read_at=NOW() WHERE id=? AND (user_id IS NULL OR user_id=?)',
      { replacements: [req.params.id, req.user.sub] },
    );
    return ok(res, { id: req.params.id, is_read: true });
  }),
);
protectedRouter.post(
  '/notifications/read-all',
  permission('dashboard', 'can_edit'),
  asyncHandler(async (req, res) => {
    await req.orgDb.query(
      'UPDATE notifications SET is_read=1,read_at=NOW() WHERE user_id IS NULL OR user_id=?',
      { replacements: [req.user.sub] },
    );
    return ok(res, null, 'Notifications marked as read');
  }),
);
protectedRouter.get(
  '/inventory/stock',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } =
      require('./utils/listQuery')(req.query, [
        'item_name',
        'item_code',
        'current_qty',
        'total_value',
        'last_updated',
      ]);
    const clauses = [],
      values = [];
    if (search) {
      clauses.push(
        '(im.item_name LIKE ? OR im.item_code LIKE ? OR w.warehouse_name LIKE ?)',
      );
      values.push(...Array(3).fill('%' + search + '%'));
    }
    if (req.query.warehouse_id) {
      clauses.push('ss.warehouse_id=?');
      values.push(req.query.warehouse_id);
    }
    if (req.query.item_id) {
      clauses.push('ss.item_id=?');
      values.push(req.query.item_id);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const from =
      ' FROM stock_summary ss LEFT JOIN item_master im ON im.id=ss.item_id LEFT JOIN warehouses w ON w.id=ss.warehouse_id';
    const [[count]] = await req.orgDb.query(
      'SELECT COUNT(*) total' + from + where,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      'SELECT ss.*,im.item_code,im.item_name,im.uom_id,w.warehouse_name' +
        from +
        where +
        ' ORDER BY ' +
        sort +
        ' ' +
        direction +
        ',ss.item_id,ss.warehouse_id LIMIT ? OFFSET ?',
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Stock fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
protectedRouter.post(
  '/inventory/stock/adjust',
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await postStockAdjustment(req.orgDb, req.body, req.user.sub),
      'Stock posted',
    ),
  ),
);
protectedRouter.post(
  '/sales/invoices/:id/payments',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await recordInvoicePayment(
        req.orgDb,
        req.params.id,
        req.body.amount,
        { ...req.body, idempotency_key: req.get('Idempotency-Key') },
        req.user.sub,
      ),
      'Payment recorded',
    ),
  ),
);
protectedRouter.post(
  '/finance/gst/calculate',
  permission('gst', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      operationalDomains.calculateGSTAuthoritative(
        req.body.items,
        req.org.state,
        req.body.customer_state || req.body.customerState,
      ),
    ),
  ),
);
protectedRouter.post(
  '/hr/payroll/calculate',
  permission('hr', 'can_view'),
  asyncHandler(async (req, res) => {
    if (!req.body.employee)
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'employee is required',
      });
    return ok(
      res,
      calculatePayroll(
        req.body.employee,
        req.body.attendance,
        req.body.deductions,
      ),
    );
  }),
);
protectedRouter.post(
  '/production/mrp/calculate',
  permission('production', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(res, {
      planned_quantity: calculateMRP(
        req.body.demand,
        req.body.on_hand,
        req.body.scheduled,
        req.body.safety_stock,
      ),
    }),
  ),
);
protectedRouter.post(
  '/production/bom/:id/components',
  permission('production', 'can_edit'),
  asyncHandler(async (req, res) => {
    const tx = await req.orgDb.transaction();
    try {
      const [[bom]] = await req.orgDb.query(
        'SELECT id FROM bom WHERE id=? FOR UPDATE',
        { replacements: [req.params.id], transaction: tx },
      );
      if (!bom)
        throw Object.assign(new Error('BOM not found'), { status: 404 });
      const [[used]] = await req.orgDb.query(
        'SELECT id FROM work_orders WHERE bom_id=? LIMIT 1',
        { replacements: [req.params.id], transaction: tx },
      );
      if (used)
        throw Object.assign(
          new Error(
            'Create a new BOM version before changing components used in production',
          ),
          { status: 409 },
        );
      if (!Array.isArray(req.body.components) || !req.body.components.length)
        throw Object.assign(new Error('BOM components are required'), {
          status: 400,
        });
      await req.orgDb.query('DELETE FROM bom_components WHERE bom_id=?', {
        replacements: [req.params.id],
        transaction: tx,
      });
      for (const component of req.body.components || []) {
        if (
          !component.item_id ||
          !Number.isFinite(Number(component.quantity)) ||
          Number(component.quantity) <= 0 ||
          !Number.isFinite(Number(component.scrap_percent || 0)) ||
          Number(component.scrap_percent || 0) < 0 ||
          !Number.isFinite(Number(component.rate || 0)) ||
          Number(component.rate || 0) < 0
        )
          throw Object.assign(
            new Error(
              'Each BOM component needs an item, positive quantity, and non-negative rate and scrap',
            ),
            { status: 400, code: 'VALIDATION_ERROR' },
          );
        const [[item]] = await req.orgDb.query(
          'SELECT id FROM item_master WHERE id=? AND is_active=1',
          { replacements: [component.item_id], transaction: tx },
        );
        if (!item)
          throw Object.assign(
            new Error('BOM component must be an active item'),
            { status: 400 },
          );
        await req.orgDb.query(
          'INSERT INTO bom_components(id,bom_id,item_id,quantity,scrap_percent,rate) VALUES(?,?,?,?,?,?)',
          {
            replacements: [
              uuid(),
              req.params.id,
              component.item_id,
              component.quantity,
              component.scrap_percent || 0,
              component.rate || 0,
            ],
            transaction: tx,
          },
        );
      }
      await tx.commit();
      return ok(
        res,
        {
          bom_id: req.params.id,
          component_count: (req.body.components || []).length,
        },
        'BOM components saved',
      );
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);
protectedRouter.post(
  '/sales/invoices/:id/lines',
  permission('sales', 'can_edit'),
  (req, res) =>
    fail(
      res,
      409,
      'IMMUTABLE_INVOICE_LINES',
      'Invoice lines are created with the invoice and cannot be replaced independently',
    ),
);
protectedRouter.get(
  '/reports/:table/export.xlsx',
  permission('reports', 'can_export'),
  asyncHandler(async (req, res) => {
    const allowedReports = [
      'activity_log',
      'stock_ledger',
      'invoices',
      'payroll_runs',
    ];
    if (!allowedReports.includes(req.params.table))
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: 'Report not found',
      });
    const [rows] = await req.orgDb.query(
      `SELECT * FROM ${req.params.table} ORDER BY 1 DESC LIMIT 10000`,
    );
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set(
        'Content-Disposition',
        `attachment; filename="${req.params.table}.xlsx"`,
      )
      .send(await excel(rows, req.params.table));
  }),
);
protectedRouter.get(
  '/reports/:table/export.pdf',
  permission('reports', 'can_export'),
  asyncHandler(async (req, res) => {
    const allowedReports = [
      'activity_log',
      'stock_ledger',
      'invoices',
      'payroll_runs',
    ];
    if (!allowedReports.includes(req.params.table))
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: 'Report not found',
      });
    const [rows] = await req.orgDb.query(
      `SELECT * FROM ${req.params.table} ORDER BY 1 DESC LIMIT 1000`,
    );
    res
      .type('application/pdf')
      .set(
        'Content-Disposition',
        `attachment; filename="${req.params.table}.pdf"`,
      )
      .send(await pdf(rows, req.params.table));
  }),
);
protectedRouter.get(
  '/masters/:type',
  permission('dashboard', 'can_view'),
  asyncHandler(async (req, res) => {
    const map = {
      items: 'item_master',
      vendors: 'vendors',
      customers: 'customers',
      uom: 'uom_master',
      hsn: 'hsn_master',
      departments: 'departments',
      machines: 'machines',
      warehouses: 'warehouses',
    };
    const table = map[req.params.type];
    if (!table) return fail(res, 404, 'NOT_FOUND', 'Unknown master');
    // warehouses: return warehouse_name aliased as name for frontend compatibility
    if (req.params.type === 'warehouses') {
      const search = `%${String(req.query.search || '').trim()}%`;
      const [rows] = await req.orgDb.query(
        'SELECT id, warehouse_code, warehouse_name, warehouse_name AS name, address, is_default, is_active FROM warehouses WHERE is_active=1 AND (warehouse_name LIKE ? OR warehouse_code LIKE ?) ORDER BY warehouse_name LIMIT 500',
        { replacements: [search, search] },
      );
      return ok(res, rows);
    }
    const searchColumns = {
      items: ['item_name', 'item_code'],
      vendors: ['company_name', 'vendor_code'],
      customers: ['company_name', 'customer_code'],
      uom: ['uom_name', 'uom_code'],
    }[req.params.type];
    const search = `%${String(req.query.search || '').trim()}%`;
    const where = searchColumns
      ? ` WHERE is_active=1 AND (${searchColumns.map((column) => `${column} LIKE ?`).join(' OR ')})`
      : '';
    const [rows] = await req.orgDb.query(
      `SELECT * FROM ${table}${where} ORDER BY 1 DESC LIMIT 500`,
      { replacements: searchColumns ? searchColumns.map(() => search) : [] },
    );
    return ok(res, rows);
  }),
);

// --- Dedicated HR endpoints with correct column mapping ---
protectedRouter.get(
  '/hr/employees',
  permission('hr', 'can_view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 20));
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = search
      ? ' WHERE (name LIKE ? OR employee_code LIKE ? OR email LIKE ? OR designation LIKE ?)'
      : '';
    const replacements = search
      ? [
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          `%${search}%`,
          limit,
          (page - 1) * limit,
        ]
      : [limit, (page - 1) * limit];
    const countReplacements = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`]
      : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM employees${where}`,
      { replacements: countReplacements },
    );
    const [rows] = await req.orgDb.query(
      `SELECT id, employee_code, name, email, mobile, designation, department_id, joining_date, employment_type, status, salary, salary_type, basic_salary, is_active, created_at FROM employees${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      { replacements },
    );
    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
protectedRouter.post(
  '/hr/employees',
  permission('hr', 'can_create'),
  asyncHandler(async (req, res) => {
    const { employee_code, name } = req.body;
    if (!employee_code || !name)
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'employee_code and name are required',
      );
    const id = req.body.id || uuid();
    const fields = [
      'id',
      'employee_code',
      'name',
      'email',
      'mobile',
      'designation',
      'department_id',
      'joining_date',
      'employment_type',
      'status',
      'salary',
      'salary_type',
      'basic_salary',
      'is_active',
    ];
    const values = [
      id,
      employee_code,
      name,
      req.body.email || null,
      req.body.mobile || null,
      req.body.designation || null,
      req.body.department_id || null,
      req.body.joining_date || null,
      req.body.employment_type || 'permanent',
      req.body.status || 'active',
      req.body.salary || 0,
      req.body.salary_type || 'monthly',
      req.body.basic_salary || req.body.salary || 0,
      1,
    ];
    await req.orgDb.query(
      `INSERT INTO employees(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
      { replacements: values },
    );
    return created(res, { id, employee_code, name });
  }),
);
protectedRouter.get(
  '/hr/employees/:id',
  permission('hr', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT * FROM employees WHERE id=? LIMIT 1',
      { replacements: [req.params.id] },
    );
    return rows[0]
      ? ok(res, rows[0])
      : fail(res, 404, 'NOT_FOUND', 'Employee not found');
  }),
);
protectedRouter.put(
  '/hr/employees/:id',
  permission('hr', 'can_edit'),
  asyncHandler(async (req, res) => {
    const allowed = [
      'name',
      'email',
      'mobile',
      'designation',
      'department_id',
      'joining_date',
      'employment_type',
      'status',
      'salary',
      'salary_type',
      'basic_salary',
      'is_active',
      'manager_id',
    ];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    await req.orgDb.query(
      `UPDATE employees SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...keys.map((k) => req.body[k]), req.params.id] },
    );
    return ok(res, { id: req.params.id, ...req.body }, 'Employee updated');
  }),
);

// --- Dedicated Warehouses endpoints ---
protectedRouter.get(
  '/inventory/warehouses',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } =
      require('./utils/listQuery')(req.query, [
        'warehouse_name',
        'warehouse_code',
        'city',
        'is_active',
      ]);
    const filters = [],
      values = [];
    if (search) {
      filters.push(
        '(warehouse_name LIKE ? OR warehouse_code LIKE ? OR city LIKE ?)',
      );
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (req.query.is_active !== undefined) {
      if (!['0', '1'].includes(req.query.is_active))
        return fail(res, 400, 'VALIDATION_ERROR', 'Invalid active filter');
      filters.push('is_active=?');
      values.push(Number(req.query.is_active));
    }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM warehouses${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT *,warehouse_name AS name FROM warehouses${where} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Warehouses fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
protectedRouter.get(
  '/inventory/warehouses/:id',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[row]] = await req.orgDb.query(
      'SELECT * FROM warehouses WHERE id=?',
      { replacements: [req.params.id] },
    );
    return row
      ? ok(res, row)
      : fail(res, 404, 'NOT_FOUND', 'Warehouse not found');
  }),
);
protectedRouter.post(
  '/inventory/warehouses',
  permission('inventory', 'can_create'),
  asyncHandler(async (req, res) => {
    if (!req.body.warehouse_name)
      return fail(res, 400, 'VALIDATION_ERROR', 'warehouse_name is required');
    const id = req.body.id || uuid();
    await req.orgDb.query(
      'INSERT INTO warehouses(id,warehouse_code,warehouse_name,address,city,is_default,is_active) VALUES(?,?,?,?,?,?,1)',
      {
        replacements: [
          id,
          req.body.warehouse_code || null,
          req.body.warehouse_name,
          req.body.address || null,
          req.body.city || null,
          req.body.is_default ? 1 : 0,
        ],
      },
    );
    return created(res, { id, warehouse_name: req.body.warehouse_name });
  }),
);
protectedRouter.put(
  '/inventory/warehouses/:id',
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    if (
      req.body.warehouse_name !== undefined &&
      (typeof req.body.warehouse_name !== 'string' ||
        !req.body.warehouse_name.trim())
    )
      return fail(res, 400, 'VALIDATION_ERROR', 'Warehouse name is required');
    for (const field of ['is_active', 'is_default'])
      if (
        req.body[field] !== undefined &&
        ![0, 1, '0', '1', true, false].includes(req.body[field])
      )
        return fail(res, 400, 'VALIDATION_ERROR', `Invalid ${field}`);
    const [[existing]] = await req.orgDb.query(
      'SELECT id FROM warehouses WHERE id=?',
      { replacements: [req.params.id] },
    );
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'Warehouse not found');
    const allowed = [
      'warehouse_code',
      'warehouse_name',
      'address',
      'city',
      'is_default',
      'is_active',
    ];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    await req.orgDb.query(
      `UPDATE warehouses SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...keys.map((k) => req.body[k]), req.params.id] },
    );
    return ok(res, { id: req.params.id, ...req.body }, 'Warehouse updated');
  }),
);

// --- Dedicated Items endpoint with full fields ---
async function validateItem(db, body, creating) {
  for (const key of ['item_code', 'item_name']) {
    if (
      (creating || body[key] !== undefined) &&
      (typeof body[key] !== 'string' || !body[key].trim())
    )
      return `${key} is required`;
  }
  if (
    body.item_type !== undefined &&
    ![
      'raw_material',
      'finished_good',
      'semi_finished',
      'consumable',
      'service',
    ].includes(body.item_type)
  )
    return 'Invalid item type';
  for (const key of [
    'gst_rate',
    'reorder_level',
    'reorder_qty',
    'standard_cost',
  ]) {
    if (
      body[key] !== undefined &&
      body[key] !== '' &&
      (!Number.isFinite(Number(body[key])) ||
        Number(body[key]) < 0 ||
        (key === 'gst_rate' && Number(body[key]) > 100))
    )
      return `Invalid ${key}`;
  }
  if (
    body.is_active !== undefined &&
    body.is_active !== '' &&
    ![0, 1, '0', '1'].includes(body.is_active)
  )
    return 'is_active must be 0 or 1';
  if (body.uom_id) {
    const [units] = await db.query(
      'SELECT id FROM uom_master WHERE id=? AND is_active=1 LIMIT 1',
      { replacements: [body.uom_id] },
    );
    if (!units.length) return 'Choose an active UOM';
  }
  if (body.category) {
    if (typeof body.category !== 'string' || body.category.length > 30)
      return 'Category must contain at most 30 characters';
    const [[category]] = await db.query(
      'SELECT setting_value FROM company_settings WHERE setting_key=?',
      { replacements: [`inventory.category.${body.category.trim()}`] },
    );
    if (category && category.setting_value === '0')
      return 'Choose an active item group';
  }
  return null;
}
protectedRouter.get(
  '/inventory/items',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      return fail(res, 400, 'VALIDATION_ERROR', 'Invalid page or limit');
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const type =
      typeof req.query.item_type === 'string' ? req.query.item_type.trim() : '';
    const active = req.query.is_active;
    if (active !== undefined && !['0', '1'].includes(active))
      return fail(res, 400, 'VALIDATION_ERROR', 'Invalid active filter');
    const where = ` WHERE 1=1${search ? ' AND (item_name LIKE ? OR item_code LIKE ? OR category LIKE ?)' : ''}${type ? ' AND item_type=?' : ''}${active !== undefined ? ' AND is_active=?' : ''}`;
    const filters = [
      ...(search ? [`%${search}%`, `%${search}%`, `%${search}%`] : []),
      ...(type ? [type] : []),
      ...(active !== undefined ? [Number(active)] : []),
    ];
    const sort = ['item_name', 'item_code', 'item_type', 'created_at'].includes(
      req.query.sort,
    )
      ? req.query.sort
      : 'item_name';
    const direction = req.query.direction === 'desc' ? 'DESC' : 'ASC';
    const replacements = [...filters, limit, (page - 1) * limit];
    const countReplacements = filters;
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM item_master${where}`,
      { replacements: countReplacements },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM item_master${where} ORDER BY ${sort} ${direction}, id ASC LIMIT ? OFFSET ?`,
      { replacements },
    );
    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
protectedRouter.post(
  '/inventory/items',
  permission('inventory', 'can_create'),
  asyncHandler(async (req, res) => {
    const validationError = await validateItem(req.orgDb, req.body, true);
    if (validationError)
      return fail(res, 400, 'VALIDATION_ERROR', validationError);
    const id = uuid();
    const fields = [
      'id',
      'item_code',
      'item_name',
      'category',
      'item_type',
      'uom_id',
      'hsn_code',
      'gst_rate',
      'reorder_level',
      'reorder_qty',
      'standard_cost',
      'description',
      'is_active',
      'created_by',
    ];
    const values = [
      id,
      req.body.item_code.trim(),
      req.body.item_name.trim(),
      req.body.category || null,
      req.body.item_type || 'raw_material',
      req.body.uom_id || null,
      req.body.hsn_code || null,
      req.body.gst_rate === '' || req.body.gst_rate == null
        ? 18
        : Number(req.body.gst_rate),
      req.body.reorder_level || 0,
      req.body.reorder_qty || 0,
      req.body.standard_cost || 0,
      req.body.description || null,
      req.body.is_active === '' || req.body.is_active == null
        ? 1
        : Number(req.body.is_active),
      req.user.sub,
    ];
    await req.orgDb.query(
      `INSERT INTO item_master(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`,
      { replacements: values },
    );
    return created(res, {
      id,
      item_code: req.body.item_code,
      item_name: req.body.item_name,
    });
  }),
);
protectedRouter.put(
  '/inventory/items/:id',
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    const validationError = await validateItem(req.orgDb, req.body, false);
    if (validationError)
      return fail(res, 400, 'VALIDATION_ERROR', validationError);
    const [existing] = await req.orgDb.query(
      'SELECT id FROM item_master WHERE id=? LIMIT 1',
      { replacements: [req.params.id] },
    );
    if (!existing.length) return fail(res, 404, 'NOT_FOUND', 'Item not found');
    const allowed = [
      'item_code',
      'item_name',
      'category',
      'item_type',
      'uom_id',
      'hsn_code',
      'gst_rate',
      'reorder_level',
      'reorder_qty',
      'standard_cost',
      'description',
      'is_active',
    ];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    const numeric = [
      'gst_rate',
      'reorder_level',
      'reorder_qty',
      'standard_cost',
      'is_active',
    ];
    const values = keys.map((key) =>
      numeric.includes(key)
        ? Number(req.body[key])
        : typeof req.body[key] === 'string'
          ? req.body[key].trim() || null
          : req.body[key],
    );
    await req.orgDb.query(
      `UPDATE item_master SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...values, req.params.id] },
    );
    return ok(res, { id: req.params.id, ...req.body }, 'Item updated');
  }),
);
protectedRouter.get(
  '/inventory/items/:id',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT * FROM item_master WHERE id=? LIMIT 1',
      { replacements: [req.params.id] },
    );
    return rows[0]
      ? ok(res, rows[0])
      : fail(res, 404, 'NOT_FOUND', 'Item not found');
  }),
);

// --- Dedicated Vendors endpoint ---
protectedRouter.get(
  '/vendors',
  permission('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 20));
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = search
      ? ' WHERE (company_name LIKE ? OR vendor_code LIKE ? OR email LIKE ?)'
      : '';
    const replacements = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`, limit, (page - 1) * limit]
      : [limit, (page - 1) * limit];
    const countReplacements = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`]
      : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM vendors${where}`,
      { replacements: countReplacements },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM vendors${where} ORDER BY company_name LIMIT ? OFFSET ?`,
      { replacements },
    );
    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
protectedRouter.post(
  '/vendors',
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) => {
    if (!req.body.company_name)
      return fail(res, 400, 'VALIDATION_ERROR', 'company_name is required');
    const id = req.body.id || uuid();
    await req.orgDb.query(
      'INSERT INTO vendors(id,vendor_code,company_name,contact_person,phone,email,gstin,state,address,payment_terms,vendor_type) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      {
        replacements: [
          id,
          req.body.vendor_code || null,
          req.body.company_name,
          req.body.contact_person || null,
          req.body.phone || null,
          req.body.email || null,
          req.body.gstin || null,
          req.body.state || null,
          req.body.address || null,
          req.body.payment_terms || 30,
          req.body.vendor_type || 'material',
        ],
      },
    );
    return created(res, { id, company_name: req.body.company_name });
  }),
);
protectedRouter.put(
  '/vendors/:id',
  permission('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    const allowed = [
      'vendor_code',
      'company_name',
      'contact_person',
      'phone',
      'email',
      'gstin',
      'state',
      'address',
      'payment_terms',
      'vendor_type',
      'is_active',
    ];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    await req.orgDb.query(
      `UPDATE vendors SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...keys.map((k) => req.body[k]), req.params.id] },
    );
    return ok(res, { id: req.params.id, ...req.body }, 'Vendor updated');
  }),
);
protectedRouter.get(
  '/vendors/:id',
  permission('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT * FROM vendors WHERE id=? LIMIT 1',
      { replacements: [req.params.id] },
    );
    return rows[0]
      ? ok(res, rows[0])
      : fail(res, 404, 'NOT_FOUND', 'Vendor not found');
  }),
);

// --- Dedicated Customers endpoint ---
protectedRouter.get(
  '/customers',
  permission('sales', 'can_view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 20));
    const search =
      typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = search
      ? ' WHERE (company_name LIKE ? OR customer_code LIKE ? OR email LIKE ?)'
      : '';
    const replacements = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`, limit, (page - 1) * limit]
      : [limit, (page - 1) * limit];
    const countReplacements = search
      ? [`%${search}%`, `%${search}%`, `%${search}%`]
      : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM customers${where}`,
      { replacements: countReplacements },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM customers${where} ORDER BY company_name LIMIT ? OFFSET ?`,
      { replacements },
    );
    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
protectedRouter.post(
  '/customers',
  permission('sales', 'can_create'),
  asyncHandler(async (req, res) => {
    if (!req.body.company_name)
      return fail(res, 400, 'VALIDATION_ERROR', 'company_name is required');
    const id = req.body.id || uuid();
    await req.orgDb.query(
      'INSERT INTO customers(id,customer_code,company_name,contact_person,phone,email,gstin,state,address,payment_terms) VALUES(?,?,?,?,?,?,?,?,?,?)',
      {
        replacements: [
          id,
          req.body.customer_code || null,
          req.body.company_name,
          req.body.contact_person || null,
          req.body.phone || null,
          req.body.email || null,
          req.body.gstin || null,
          req.body.state || null,
          req.body.address || null,
          req.body.payment_terms || 30,
        ],
      },
    );
    return created(res, { id, company_name: req.body.company_name });
  }),
);
protectedRouter.put(
  '/customers/:id',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    const allowed = [
      'customer_code',
      'company_name',
      'contact_person',
      'phone',
      'email',
      'gstin',
      'state',
      'address',
      'payment_terms',
      'credit_limit',
      'is_active',
    ];
    const keys = Object.keys(req.body).filter((k) => allowed.includes(k));
    if (!keys.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    await req.orgDb.query(
      `UPDATE customers SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...keys.map((k) => req.body[k]), req.params.id] },
    );
    return ok(res, { id: req.params.id, ...req.body }, 'Customer updated');
  }),
);
protectedRouter.get(
  '/customers/:id',
  permission('sales', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT * FROM customers WHERE id=? LIMIT 1',
      { replacements: [req.params.id] },
    );
    return rows[0]
      ? ok(res, rows[0])
      : fail(res, 404, 'NOT_FOUND', 'Customer not found');
  }),
);

// --- Enhanced dashboard summary ---
protectedRouter.get(
  '/dashboard/summary',
  permission('dashboard', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[items]] = await req.orgDb.query(
      'SELECT COUNT(*) total FROM item_master WHERE is_active=1',
    );
    const [[vendors]] = await req.orgDb.query(
      'SELECT COUNT(*) total FROM vendors WHERE is_active=1',
    );
    const [[customers]] = await req.orgDb.query(
      'SELECT COUNT(*) total FROM customers WHERE is_active=1',
    );
    const [[openOrders]] = await req.orgDb.query(
      "SELECT COUNT(*) total FROM purchase_orders WHERE status NOT IN ('cancelled','confirmed')",
    );
    const [[openSales]] = await req.orgDb.query(
      "SELECT COUNT(*) total FROM sales_orders WHERE status NOT IN ('cancelled','delivered')",
    );
    const [[stockValue]] = await req.orgDb.query(
      'SELECT COALESCE(SUM(total_value),0) total FROM stock_summary',
    );
    const [[openWO]] = await req.orgDb.query(
      "SELECT COUNT(*) total FROM work_orders WHERE status IN ('released','in_progress')",
    );
    const [[pendingInvoices]] = await req.orgDb.query(
      'SELECT COALESCE(SUM(balance_amount),0) total FROM invoices WHERE balance_amount > 0',
    );
    return ok(res, {
      items: items.total,
      vendors: vendors.total,
      customers: customers.total,
      plan: req.org.plan,
      open_purchase_orders: openOrders.total,
      open_sales_orders: openSales.total,
      stock_value: Number(stockValue.total || 0),
      open_work_orders: openWO.total,
      pending_receivables: Number(pendingInvoices.total || 0),
    });
  }),
);
app.use('/api/v1', workflowRoutes);
app.use(
  '/api/v1/forecasting',
  auth,
  orgContext,
  entitlement,
  forecastingRoutes,
);
app.use('/api/v1/reports', auth, orgContext, entitlement, smartReportsRoutes);
// Inventory and purchasing foundations use explicit handlers for tenant-safe filtering,
// validated workflow transitions, and transactional GRN posting.
app.use('/api/v1', inventoryPurchaseRoutes);
// Purchase, Inventory, and Sales module routes
app.use('/api/v1/purchase', auth, orgContext, entitlement, purchaseRoutes);
app.use('/api/v1/inventory', auth, orgContext, entitlement, inventoryRoutes);
app.use('/api/v1/sales', auth, orgContext, entitlement, salesRoutes);
// Quality, HR, payroll, finance, GST and analytics foundations.
app.use('/api/v1', nextDomainsRoutes);
app.use('/api/v1', operationalDomainsRoutes);
// Batch 2 transactional Sales/Dispatch and Production workflows.
app.use('/api/v1/sales', salesProductionSalesRoutes);
app.use('/api/v1/production', salesProductionProductionRoutes);
app.use('/api/v1', zeroGapClosureRoutes);
const adminRouter = express.Router();
adminRouter.use(auth, requireAdmin);
adminRouter.get(
  '/content/landing',
  asyncHandler(async (req, res) =>
    ok(res, await require('./services/cms.service').read()),
  ),
);
adminRouter.put(
  '/content/landing',
  asyncHandler(async (req, res) =>
    ok(
      res,
      await require('./services/cms.service').save(req.body, req.user.sub),
    ),
  ),
);
adminRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
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
      suspended_organizations: Number(metrics.suspended_organizations || 0),
    });
  }),
);
adminRouter.get(
  '/errors',
  asyncHandler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const [rows] = await masterDb.query(
      'SELECT * FROM api_error_logs ORDER BY created_at DESC LIMIT ?',
      { replacements: [limit] },
    );
    return ok(res, rows);
  }),
);
adminRouter.get(
  '/organizations',
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(`
    SELECT o.id,o.slug,o.company_name,o.owner_email,o.owner_phone,o.plan,o.status,o.is_active,o.is_suspended,
           d.hostname,d.subdomain,o.created_at
    FROM organizations o
    LEFT JOIN organization_domains d ON d.organization_id=o.id AND d.is_primary=1
    ORDER BY o.created_at DESC
  `);
    return ok(res, rows);
  }),
);
adminRouter.get(
  '/domains',
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(`
    SELECT d.*,o.slug,o.company_name,o.status
    FROM organization_domains d INNER JOIN organizations o ON o.id=d.organization_id
    ORDER BY d.created_at DESC
  `);
    return ok(res, rows);
  }),
);
adminRouter.post(
  '/organizations',
  asyncHandler(async (req, res) => {
    const {
      company_name,
      owner_name,
      owner_email,
      owner_phone,
      slug,
      plan,
      password,
    } = req.body;
    require('./utils/provisioningValidation').validateIdentity(req.body);
    const selection =
      await require('./services/onboarding.service').validateSelection({
        ...req.body,
        subdomain: slug,
      });
    const chosenPlan = selection.plan;
    const result = await provisionOrganization({
      company_name,
      owner_name,
      owner_email,
      owner_phone,
      slug: selection.subdomain,
      password,
      plan: chosenPlan,
      duration_months: selection.durationMonths,
    });
    return ok(res, { ...result.org, plan: chosenPlan }, 'Organization created');
  }),
);
adminRouter.post(
  '/organizations/:id/retry-provisioning',
  asyncHandler(async (req, res) => {
    const result =
      await require('./services/onboarding.service').retryProvisionOrganization(
        req.params.id,
      );
    return ok(res, result.org, 'Organization provisioning completed');
  }),
);
adminRouter.get(
  '/modules',
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(`
    SELECT m.*,c.description,c.icon,c.category,c.is_purchasable,c.is_active AS catalog_active,c.display_order
    FROM modules m LEFT JOIN module_catalog c ON c.module_key=m.module_key ORDER BY COALESCE(c.display_order,m.sort_order)
  `);
    return ok(res, rows);
  }),
);
adminRouter.get(
  '/modules/:key/features',
  asyncHandler(async (req, res) => {
    const [rows] = await masterDb.query(
      'SELECT * FROM module_features WHERE module_key=? ORDER BY display_order,feature_name',
      { replacements: [req.params.key] },
    );
    return ok(res, rows);
  }),
);
adminRouter.post(
  '/modules/:key/features',
  asyncHandler(async (req, res) => {
    if (!req.body.feature_key || !req.body.feature_name)
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'feature_key and feature_name are required',
      );
    await masterDb.query(
      'INSERT INTO module_features(id,module_key,feature_key,feature_name,description,display_order) VALUES(?,?,?,?,?,?)',
      {
        replacements: [
          uuid(),
          req.params.key,
          req.body.feature_key,
          req.body.feature_name,
          req.body.description || null,
          Number(req.body.display_order || 0),
        ],
      },
    );
    return created(
      res,
      { module_key: req.params.key, feature_key: req.body.feature_key },
      'Feature created',
    );
  }),
);
adminRouter.put(
  '/modules/:key/features/:featureId',
  asyncHandler(async (req, res) => {
    const fields = [
      'feature_name',
      'description',
      'is_active',
      'display_order',
    ].filter((key) => req.body[key] !== undefined);
    if (!fields.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No fields to update');
    await masterDb.query(
      `UPDATE module_features SET ${fields.map((key) => `${key}=?`).join(',')} WHERE id=? AND module_key=?`,
      {
        replacements: [
          ...fields.map((key) => req.body[key]),
          req.params.featureId,
          req.params.key,
        ],
      },
    );
    return ok(res, { id: req.params.featureId }, 'Feature updated');
  }),
);
adminRouter.get(
  '/pricing',
  asyncHandler(async (req, res) => {
    const [plans] = await masterDb.query(
      'SELECT * FROM plan_pricing ORDER BY plan,duration_months',
    );
    const [modules] = await masterDb.query(
      'SELECT * FROM module_pricing ORDER BY module_key,duration_months',
    );
    return ok(res, { plans, modules });
  }),
);
adminRouter.put(
  '/pricing/plans/:id',
  asyncHandler(async (req, res) => {
    if (req.body.amount === undefined || Number(req.body.amount) < 0)
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'A non-negative amount is required',
      );
    await masterDb.query(
      'UPDATE plan_pricing SET amount=?,is_active=COALESCE(?,is_active) WHERE id=?',
      {
        replacements: [
          Number(req.body.amount),
          req.body.is_active,
          req.params.id,
        ],
      },
    );
    return ok(
      res,
      { id: req.params.id, amount: Number(req.body.amount) },
      'Plan pricing updated',
    );
  }),
);
adminRouter.put(
  '/pricing/modules/:id',
  asyncHandler(async (req, res) => {
    if (req.body.amount === undefined || Number(req.body.amount) < 0)
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'A non-negative amount is required',
      );
    await masterDb.query(
      'UPDATE module_pricing SET amount=?,is_active=COALESCE(?,is_active) WHERE id=?',
      {
        replacements: [
          Number(req.body.amount),
          req.body.is_active,
          req.params.id,
        ],
      },
    );
    return ok(
      res,
      { id: req.params.id, amount: Number(req.body.amount) },
      'Module pricing updated',
    );
  }),
);
adminRouter.post(
  '/organizations/:id/suspend',
  asyncHandler(async (req, res) => {
    await masterDb.query(
      'UPDATE organizations SET is_suspended=1,suspension_reason=? WHERE id=?',
      {
        replacements: [
          req.body.reason || 'Suspended by administrator',
          req.params.id,
        ],
      },
    );
    return ok(res, { id: req.params.id, is_suspended: true });
  }),
);
adminRouter.post(
  '/organizations/:id/activate',
  asyncHandler(async (req, res) => {
    await masterDb.query(
      'UPDATE organizations SET is_suspended=0,is_active=1 WHERE id=?',
      { replacements: [req.params.id] },
    );
    return ok(res, { id: req.params.id, is_suspended: false, is_active: true });
  }),
);
adminRouter.get(
  '/organizations/:id/modules',
  asyncHandler(async (req, res) => {
    const [modules] = await masterDb.query(
      `
    SELECT m.*, COALESCE(om.is_active, 0) AS is_active
    FROM modules m
    LEFT JOIN org_modules om ON om.module_key = m.module_key AND om.org_id = ?
    ORDER BY m.sort_order
  `,
      { replacements: [req.params.id] },
    );
    return ok(res, modules);
  }),
);
adminRouter.put(
  '/organizations/:id/modules',
  asyncHandler(async (req, res) => {
    const { module_key, is_active } = req.body;
    const activeVal = is_active ? 1 : 0;
    await masterDb.query(
      'INSERT INTO org_modules(org_id, module_key, is_active) VALUES(?,?,?) ON DUPLICATE KEY UPDATE is_active=?',
      { replacements: [req.params.id, module_key, activeVal, activeVal] },
    );
    return ok(
      res,
      { org_id: req.params.id, module_key, is_active: Boolean(activeVal) },
      'Org module updated',
    );
  }),
);
adminRouter.put(
  '/organizations/:id/plan',
  asyncHandler(async (req, res) => {
    const { plan } = req.body;
    const validPlans = ['free', 'starter', 'growth', 'pro'];
    if (!plan || !validPlans.includes(plan))
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'Invalid plan. Must be: free, starter, growth, pro',
      );
    await masterDb.query(
      'UPDATE organizations SET plan=?, plan_started_at=NOW(), is_trial=0 WHERE id=?',
      { replacements: [plan, req.params.id] },
    );
    return ok(res, { id: req.params.id, plan }, 'Plan updated');
  }),
);
adminRouter.put(
  '/modules/:id',
  asyncHandler(async (req, res) => {
    const keys = ['module_name', 'min_plan', 'sort_order'];
    const set = keys.filter((k) => req.body[k] !== undefined);
    if (!set.length)
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'No fields to update',
      });
    await masterDb.query(
      `UPDATE modules SET ${set.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...set.map((k) => req.body[k]), req.params.id] },
    );
    return ok(res, { id: req.params.id, ...req.body });
  }),
);
app.use('/api/v1/admin', adminRouter);
// Keep the catch-all tenant router behind the dedicated Super Admin router;
// otherwise orgContext tries to resolve an organization for admin-only tokens.
app.use('/api/v1', protectedRouter);

// Dedicated user management — overrides generic CRUD for /settings/users
// POST: hash password before insert
// PUT: allow password change with hashing
const userRouter = express.Router();
userRouter.use(auth, orgContext, entitlement, activity);
const { permission: perm } = (() => {
  try {
    return { permission: require('./middleware/permission') };
  } catch {
    return { permission: () => (req, res, next) => next() };
  }
})();
userRouter.get(
  '/',
  perm('settings', 'can_view'),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const [[count]] = await req.orgDb.query(
      'SELECT COUNT(*) AS total FROM users',
    );
    const [rows] = await req.orgDb.query(
      'SELECT id,name,email,role,department,phone,is_active,last_login,created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?',
      { replacements: [limit, (page - 1) * limit] },
    );
    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
userRouter.post(
  '/',
  perm('settings', 'can_create'),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, department, phone } = req.body;
    if (!name || !email || !password || !role)
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'Name, email, password and role are required',
      );
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const [existing] = await req.orgDb.query(
      'SELECT id FROM users WHERE email = ?',
      { replacements: [email] },
    );
    if (existing.length)
      return fail(
        res,
        409,
        'CONFLICT',
        'A user with this email already exists',
      );
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    await req.orgDb.query(
      'INSERT INTO users (id,name,email,password_hash,role,department,phone,is_active) VALUES (?,?,?,?,?,?,?,1)',
      {
        replacements: [
          id,
          name,
          email,
          hash,
          role,
          department || null,
          phone || null,
        ],
      },
    );
    return ok(res, { id, name, email, role }, 'User created successfully');
  }),
);
userRouter.get(
  '/:id',
  perm('settings', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT id,name,email,role,department,phone,is_active,last_login,created_at FROM users WHERE id=?',
      { replacements: [req.params.id] },
    );
    return rows[0]
      ? ok(res, rows[0])
      : fail(res, 404, 'NOT_FOUND', 'User not found');
  }),
);
userRouter.put(
  '/:id',
  perm('settings', 'can_edit'),
  asyncHandler(async (req, res) => {
    const { password, ...rest } = req.body;
    const allowed = ['name', 'role', 'department', 'phone', 'is_active'];
    const keys = Object.keys(rest).filter((k) => allowed.includes(k));
    if (password) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(password, 12);
      keys.push('password_hash');
      rest.password_hash = hash;
    }
    if (!keys.length)
      return fail(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    await req.orgDb.query(
      `UPDATE users SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`,
      { replacements: [...keys.map((k) => rest[k]), req.params.id] },
    );
    return ok(res, { id: req.params.id, ...rest }, 'User updated');
  }),
);
userRouter.delete(
  '/:id',
  perm('settings', 'can_delete'),
  asyncHandler(async (req, res) => {
    // Soft delete — deactivate instead of hard delete
    await req.orgDb.query('UPDATE users SET is_active=0 WHERE id=?', {
      replacements: [req.params.id],
    });
    return ok(res, null, 'User deactivated');
  }),
);
app.use('/api/v1/settings/users', userRouter);
const mounts = [
  ['inventory/ledger', 'stock_ledger', 'inventory'],
  ['inventory/gate-pass', 'gate_pass', 'inventory'],
  ['jobwork/orders', 'job_work_orders', 'jobwork'],
  ['quality/inspections', 'qc_inspections', 'quality'],
  ['hr/attendance', 'attendance', 'hr'],
  ['hr/leaves', 'leave_requests', 'hr'],
  ['notifications', 'notifications', 'dashboard'],
  ['settings/company', 'company_settings', 'settings'],
  ['reports/records', 'activity_log', 'reports'],
];
// Aliases keep the public API stable while exposing the complete ERP navigation.
mounts.push(
  ['inventory/import-export', 'stock_ledger', 'inventory'],
  ['production/mrp', 'work_orders', 'production'],
  ['jobwork/challans', 'job_work_orders', 'jobwork'],
  ['quality/inward', 'qc_inspections', 'quality'],
  ['quality/in-process', 'qc_inspections', 'quality'],
  ['quality/final', 'qc_inspections', 'quality'],
  ['sales/einvoice', 'invoices', 'sales'],
  ['sales/ewaybill', 'invoices', 'sales'],
  ['hr/payroll', 'payroll_runs', 'hr'],
  ['finance/receivables', 'invoices', 'finance'],
  ['finance/payables', 'purchase_orders', 'finance'],
  ['finance/ledger', 'activity_log', 'finance'],
  ['finance/gst', 'invoices', 'finance'],
  ['finance/tally', 'activity_log', 'finance'],
  ['admin/activity-log', 'activity_log', 'settings'],
  ['billing/transactions', 'activity_log', 'settings'],
);
for (const [route, table, module] of mounts)
  app.use(
    `/api/v1/${route}`,
    crud(table, module, {
      create: route !== 'quality/inspections',
      actions: {
        send: 'put',
        confirm: 'put',
        approve: 'put',
        reject: 'put',
        cancel: 'put',
        close: 'put',
        release: 'put',
        start: 'put',
        complete: 'put',
        post: 'put',
      },
    }),
  );
const upload = multer({ dest: 'uploads/' });
app.post(
  '/api/v1/settings/company/logo',
  auth,
  orgContext,
  entitlement,
  permission('settings', 'can_edit'),
  upload.single('logo'),
  (req, res) => ok(res, { filename: req.file?.filename }, 'Logo uploaded'),
);
app.use(errorHandler);
module.exports = app;
