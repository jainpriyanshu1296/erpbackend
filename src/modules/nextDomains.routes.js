const express = require('express');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, asyncHandler } = require('../utils/response');
const service = require('../services/nextDomains.service');
const { v4: uuid } = require('uuid');
const router = express.Router();
const secure = (module, action) => [
  auth,
  orgContext,
  entitlement,
  moduleGuard(module),
  permission(module, action),
];
const domains = {
  employees: 'hr',
  attendance: 'hr',
  leaves: 'hr',
  quality: 'quality',
  payroll: 'payroll',
  accounts: 'finance',
  tax: 'gst',
};
for (const [path, module] of Object.entries(domains)) {
  router.get(
    `/${path}`,
    ...secure(module, 'can_view'),
    asyncHandler(async (req, res) => ok(res, await service.list(req, path))),
  );
  router.post(
    `/${path}`,
    ...secure(module, 'can_create'),
    asyncHandler(async (req, res) =>
      created(res, await service.create(req, path, req.body)),
    ),
  );
  router.patch(
    `/${path}/:id`,
    ...secure(module, 'can_edit'),
    asyncHandler(async (req, res) =>
      ok(res, await service.update(req, path, req.params.id, req.body)),
    ),
  );
  if (['quality', 'payroll', 'tax', 'leaves'].includes(path)) {
    router.post(
      `/${path}/:id/transition`,
      ...secure(module, 'can_approve'),
      asyncHandler(async (req, res) =>
        ok(
          res,
          await service.transition(req, path, req.params.id, req.body.status),
        ),
      ),
    );
  }
  const aliases = {
    '/hr/employees': 'employees',
    '/hr/attendance': 'attendance',
    '/hr/leaves': 'leaves',
    '/quality/inspections': 'quality',
    '/hr/payroll': 'payroll',
    '/finance/accounts': 'accounts',
    '/gst/tax': 'tax',
  };
  for (const [routePath, domain] of Object.entries(aliases)) {
    const module = domains[domain];
    router.get(
      routePath,
      ...secure(module, 'can_view'),
      asyncHandler(async (req, res) =>
        ok(res, await service.list(req, domain)),
      ),
    );
    router.post(
      routePath,
      ...secure(module, 'can_create'),
      asyncHandler(async (req, res) =>
        created(res, await service.create(req, domain, req.body)),
      ),
    );
    router.patch(
      `${routePath}/:id`,
      ...secure(module, 'can_edit'),
      asyncHandler(async (req, res) =>
        ok(res, await service.update(req, domain, req.params.id, req.body)),
      ),
    );
  }
}
router.post(
  '/payroll/:id/items',
  ...secure('payroll', 'can_edit'),
  asyncHandler(async (req, res) => {
    const { employee_id, gross_amount, deductions = 0 } = req.body;
    if (!employee_id || Number(gross_amount) < 0 || Number(deductions) < 0)
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: 'Valid employee and amounts are required',
      });
    const id = uuid();
    const net = Number(gross_amount) - Number(deductions);
    await req.orgDb.query(
      'INSERT INTO payroll_items(id,payroll_run_id,employee_id,gross_amount,deductions,net_amount) VALUES(?,?,?,?,?,?)',
      {
        replacements: [
          id,
          req.params.id,
          employee_id,
          gross_amount,
          deductions,
          net,
        ],
      },
    );
    await req.orgDb.query(
      'UPDATE payroll_runs SET total_amount=(SELECT COALESCE(SUM(net_amount),0) FROM payroll_items WHERE payroll_run_id=?) WHERE id=?',
      { replacements: [req.params.id, req.params.id] },
    );
    return created(res, {
      id,
      payroll_run_id: req.params.id,
      employee_id,
      net_amount: net,
    });
  }),
);
router.post(
  '/finance/journals',
  ...secure('finance', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createJournal(req, req.body)),
  ),
);
router.get(
  '/reports/analytics',
  ...secure('reports', 'can_view'),
  asyncHandler(async (req, res) => {
    const period = String(req.query.period || 'all');
    const search = String(req.query.search || '').trim();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
    const page = Math.max(1, Number(req.query.page || 1));
    const offset = (page - 1) * limit;
    const conditions = [];
    const replacements = [];
    if (period === 'month')
      conditions.push('created_at >= DATE_FORMAT(CURRENT_DATE, "%Y-%m-01")');
    if (period === 'quarter')
      conditions.push('created_at >= DATE_SUB(CURRENT_DATE, INTERVAL 3 MONTH)');
    if (period === 'year')
      conditions.push('created_at >= DATE_FORMAT(CURRENT_DATE, "%Y-01-01")');
    if (search) {
      conditions.push('report_key LIKE ?');
      replacements.push(`%${search}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    replacements.push(limit, offset);
    const [rows] = await req.orgDb.query(
      `SELECT report_key, period_start, period_end, result, generated_by, created_at
     FROM report_snapshots ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      { replacements },
    );
    return ok(res, rows);
  }),
);
module.exports = router;
