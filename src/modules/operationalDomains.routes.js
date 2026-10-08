const router = require('express').Router();
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, asyncHandler } = require('../utils/response');
const service = require('../services/operationalDomains.service');
const { excel } = require('../services/export.service');
const secure = (mod, action) => [
  auth,
  orgContext,
  entitlement,
  moduleGuard(mod),
  permission(mod, action),
];

const page = (query) => ({
  page: Math.max(1, Number(query.page || 1)),
  limit: Math.min(100, Math.max(1, Number(query.limit || 20))),
});
const moduleSettings = (module) => ({ prefix: `${module}.%`, module });
const allowedSettings = {
  inventory: [
    'default_warehouse',
    'stock_count_frequency_days',
    'batch_tracking_enabled',
    'serial_tracking_enabled',
  ],
  production: [
    'default_warehouse',
    'require_material_issue',
    'scrap_tolerance_percent',
  ],
  purchase: [
    'approval_required',
    'over_receipt_tolerance',
    'invoice_match_tolerance',
    'default_payment_terms',
  ],
  sales: [
    'credit_limit_enforced',
    'negative_stock_allowed',
    'dispatch_requires_confirmation',
    'default_payment_terms',
  ],
  quality: [
    'incoming_qc_required',
    'in_process_qc_required',
    'final_qc_required',
    'auto_ncr_on_failure',
    'default_quarantine_warehouse',
  ],
};

const {
  requireInspectionSource,
} = require('../services/qualityInspection.service');

router.get(
  '/purchase/vendor-invoices',
  ...secure('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const where = search
      ? ' AND (fd.document_number LIKE ? OR v.company_name LIKE ?)'
      : '';
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM finance_documents fd LEFT JOIN vendors v ON v.id=fd.party_id WHERE fd.document_type='payable'${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT fd.*,fd.party_id vendor_id,fd.amount total_amount,fd.amount-COALESCE(fd.paid_amount,0) balance_amount,v.company_name FROM finance_documents fd LEFT JOIN vendors v ON v.id=fd.party_id WHERE fd.document_type='payable'${where} ORDER BY fd.document_date DESC,fd.document_number DESC LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, (current - 1) * limit] },
    );
    return ok(res, rows, 'Purchase invoices fetched', {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.get(
  '/purchase/vendor-invoices/:id',
  ...secure('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      "SELECT fd.*,fd.party_id vendor_id,fd.amount total_amount,fd.amount-COALESCE(fd.paid_amount,0) balance_amount,v.company_name FROM finance_documents fd LEFT JOIN vendors v ON v.id=fd.party_id WHERE fd.id=? AND fd.document_type='payable' LIMIT 1",
      { replacements: [req.params.id] },
    );
    if (!rows[0]) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: 'Purchase invoice not found',
      });
    }
    const [links] = await req.orgDb.query(
      "SELECT target_type,target_id,relation FROM related_documents WHERE source_type='purchase_invoice' AND source_id=? ORDER BY created_at",
      { replacements: [req.params.id] },
    );
    return ok(res, { ...rows[0], links });
  }),
);
router.post(
  '/purchase/vendor-invoices/:id/match',
  ...secure('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    if (!req.body.purchase_order_id || !req.body.grn_id) {
      throw Object.assign(
        new Error('purchase_order_id and grn_id are required'),
        { status: 400, code: 'VALIDATION_ERROR' },
      );
    }
    const tx = await req.orgDb.transaction();
    try {
      const [[invoice]] = await req.orgDb.query(
        "SELECT * FROM finance_documents WHERE id=? AND document_type='payable' FOR UPDATE",
        { replacements: [req.params.id], transaction: tx },
      );
      const [[grn]] = await req.orgDb.query(
        'SELECT * FROM grn WHERE id=? AND po_id=? FOR UPDATE',
        {
          replacements: [req.body.grn_id, req.body.purchase_order_id],
          transaction: tx,
        },
      );
      const [[po]] = await req.orgDb.query(
        'SELECT * FROM purchase_orders WHERE id=? FOR UPDATE',
        { replacements: [req.body.purchase_order_id], transaction: tx },
      );
      if (!invoice || !po || !grn) {
        throw Object.assign(
          new Error('Invoice, purchase order, or matching GRN was not found'),
          { status: 404, code: 'NOT_FOUND' },
        );
      }
      if (!['open', 'matched'].includes(invoice.status)) {
        throw Object.assign(new Error('Only an open invoice can be matched'), {
          status: 409,
          code: 'MATCH_FAILED',
        });
      }
      if (invoice.party_id !== po.vendor_id || po.vendor_id !== grn.vendor_id) {
        throw Object.assign(
          new Error('Vendor differs between invoice, PO and GRN'),
          { status: 409, code: 'MATCH_FAILED' },
        );
      }
      if (grn.status !== 'posted') {
        throw Object.assign(
          new Error('GRN must be posted before invoice matching'),
          { status: 409, code: 'MATCH_FAILED' },
        );
      }
      const [[prior]] = await req.orgDb.query(
        "SELECT target_id FROM related_documents WHERE source_type='purchase_invoice' AND source_id=? AND relation='matched_order' FOR UPDATE",
        { replacements: [req.params.id], transaction: tx },
      );
      if (prior && prior.target_id !== po.id) {
        throw Object.assign(
          new Error('Invoice is already matched to another purchase order'),
          { status: 409, code: 'MATCH_FAILED' },
        );
      }
      const tolerance = Number(req.body.tolerance || 0);
      const variance = Math.abs(
        Number(invoice.amount) - Number(po.total_amount),
      );
      if (variance > tolerance) {
        throw Object.assign(
          new Error(
            `Invoice variance ${variance.toFixed(2)} exceeds tolerance`,
          ),
          { status: 409, code: 'MATCH_FAILED' },
        );
      }
      for (const [type, id, relation] of [
        ['purchase_order', po.id, 'matched_order'],
        ['grn', grn.id, 'matched_receipt'],
      ]) {
        await req.orgDb.query(
          'INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE target_id=VALUES(target_id)',
          {
            replacements: [
              require('uuid').v4(),
              'purchase_invoice',
              req.params.id,
              type,
              id,
              relation,
              req.user?.sub || null,
            ],
            transaction: tx,
          },
        );
      }
      await req.orgDb.query(
        "UPDATE finance_documents SET status='matched' WHERE id=?",
        { replacements: [req.params.id], transaction: tx },
      );
      await tx.commit();
      return ok(res, { id: req.params.id, status: 'matched', variance });
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);
router.post(
  '/purchase/vendor-invoices/:id/pay',
  ...secure('purchase', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(res, await service.recordVendorPayment(req, req.params.id, req.body)),
  ),
);
router.get(
  '/quality/ncrs',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } =
      require('../utils/listQuery')(req.query, [
        'ncr_number',
        'severity',
        'status',
        'created_at',
      ]);
    const where = search
        ? ' WHERE ncr_number LIKE ? OR description LIKE ? OR status LIKE ?'
        : '',
      values = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM quality_ncrs${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM quality_ncrs${where} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'NCRs fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
router.get(
  '/quality/specifications',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search } = require('../utils/listQuery')(
      req.query,
      ['code'],
    );
    const where = search ? ' WHERE code LIKE ? OR name LIKE ?' : '';
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM quality_specifications${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM quality_specifications${where} ORDER BY code LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Specifications fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
router.get(
  '/quality/masters',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) => {
    const [specifications] = await req.orgDb.query(
      'SELECT * FROM quality_specifications ORDER BY code',
    );
    const [parameters] = await req.orgDb.query(
      'SELECT * FROM quality_parameters ORDER BY parameter_code',
    );
    const [sampling_plans] = await req.orgDb.query(
      'SELECT * FROM quality_sampling_plans ORDER BY plan_code',
    );
    const [acceptance_criteria] = await req.orgDb.query(
      'SELECT * FROM quality_acceptance_criteria ORDER BY criterion_code',
    );
    return ok(res, {
      specifications,
      parameters,
      sampling_plans,
      acceptance_criteria,
    });
  }),
);
for (const [path, type, sourceType] of [
  ['inward', 'incoming', 'grn'],
  ['in-process', 'in_process', 'production'],
  ['final', 'final', 'finished_goods'],
]) {
  router.get(
    `/quality/${path}`,
    ...secure('quality', 'can_view'),
    asyncHandler(async (req, res) => {
      const current = Math.max(1, Number(req.query.page || 1));
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const search = String(req.query.search || '').trim();
      const where = search
        ? ' AND (inspection_number LIKE ? OR reference_id LIKE ? OR item_id LIKE ?)'
        : '';
      const values = search
        ? [`%${search}%`, `%${search}%`, `%${search}%`]
        : [];
      const [[count]] = await req.orgDb.query(
        `SELECT COUNT(*) total FROM qc_inspections WHERE (inspection_type=? OR source_type=?)${where}`,
        { replacements: [type, sourceType, ...values] },
      );
      const [rows] = await req.orgDb.query(
        `SELECT * FROM qc_inspections WHERE (inspection_type=? OR source_type=?)${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        {
          replacements: [
            type,
            sourceType,
            ...values,
            limit,
            (current - 1) * limit,
          ],
        },
      );
      return ok(res, rows, 'Inspections fetched', {
        page: current,
        limit,
        total: Number(count.total || 0),
      });
    }),
  );
  router.post(
    `/quality/${path}`,
    ...secure('quality', 'can_create'),
    asyncHandler(async (req, res) => {
      const quantity = Number(req.body.inspected_qty);
      if (
        !req.body.reference_id ||
        !req.body.item_id ||
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        throw Object.assign(
          new Error(
            'reference_id, item_id and positive inspected_qty are required',
          ),
          { status: 400, code: 'VALIDATION_ERROR' },
        );
      }
      await requireInspectionSource(
        req.orgDb,
        type,
        req.body.reference_id,
        req.body.item_id,
      );
      const accepted = Number(req.body.accepted_qty || 0);
      const rejected = Math.max(0, quantity - accepted);
      const id = require('uuid').v4();
      const number =
        req.body.inspection_number || `QC-${Date.now()}-${id.slice(0, 6)}`;
      require('../services/qualityInspection.service').quantities(
        quantity,
        accepted,
        req.body.rejected_qty ?? rejected,
      );
      await req.orgDb.query(
        'INSERT INTO qc_inspections(id,inspection_number,inspection_type,source_type,source_id,reference_id,item_id,inspected_qty,accepted_qty,rejected_qty,overall_result,result,status,notes,inspected_by,inspected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        {
          replacements: [
            id,
            number,
            type,
            sourceType,
            req.body.reference_id,
            req.body.reference_id,
            req.body.item_id,
            quantity,
            accepted,
            rejected,
            req.body.overall_result || null,
            req.body.overall_result || null,
            'pending',
            req.body.notes || null,
            req.user?.sub || null,
            new Date(),
          ],
        },
      );
      return created(res, {
        id,
        inspection_number: number,
        inspection_type: type,
        source_type: sourceType,
        status: 'pending',
      });
    }),
  );
}
router.get(
  '/quality/rejections',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search } = require('../utils/listQuery')(
      req.query,
      ['created_at'],
    );
    const filter =
        "(rejected_qty>0 OR result IN ('failed','fail','rejected','scrap') OR overall_result IN ('fail','failed','rejected'))",
      where = search
        ? ` WHERE ${filter} AND (inspection_number LIKE ? OR item_id LIKE ?)`
        : ` WHERE ${filter}`,
      values = search ? [`%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM qc_inspections${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM qc_inspections${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Rejections fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
for (const module of [
  'inventory',
  'production',
  'purchase',
  'sales',
  'quality',
]) {
  router.get(
    `/${module}/settings`,
    ...secure(module, 'can_view'),
    asyncHandler(async (req, res) => {
      const { page, limit, offset, search, sort, direction } =
        require('../utils/listQuery')(req.query, [
          'setting_key',
          'setting_value',
          'updated_at',
        ]);
      const keys = allowedSettings[module].map((key) => `${module}.${key}`);
      const where =
        'WHERE setting_key IN (?)' +
        (search ? ' AND (setting_key LIKE ? OR setting_value LIKE ?)' : '');
      const values = [keys, ...(search ? [`%${search}%`, `%${search}%`] : [])];
      const [[count]] = await req.orgDb.query(
        `SELECT COUNT(*) total FROM company_settings ${where}`,
        { replacements: values },
      );
      const [rows] = await req.orgDb.query(
        `SELECT setting_key,setting_value,updated_at FROM company_settings ${where} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
        { replacements: [...values, limit, offset] },
      );
      return ok(res, rows, 'Settings fetched', {
        page,
        limit,
        total: Number(count.total),
      });
    }),
  );
  router.post(
    `/${module}/settings`,
    ...secure(module, 'can_edit'),
    asyncHandler(async (req, res) => {
      if (!req.body.setting_key || req.body.setting_value === undefined) {
        throw Object.assign(
          new Error('setting_key and setting_value are required'),
          { status: 400, code: 'VALIDATION_ERROR' },
        );
      }
      const rawKey = String(req.body.setting_key).replace(`${module}.`, '');
      if (!allowedSettings[module].includes(rawKey)) {
        throw Object.assign(new Error('Unsupported module setting'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      const key = `${module}.${rawKey}`;
      const value = String(req.body.setting_value).trim();
      if (rawKey.endsWith('_enabled') || rawKey.startsWith('require_')) {
        if (!['true', 'false', '1', '0'].includes(value)) {
          throw Object.assign(new Error('Use true or false for this setting'), {
            status: 400,
            code: 'VALIDATION_ERROR',
          });
        }
      }
      if (
        rawKey === 'default_warehouse' ||
        rawKey === 'default_quarantine_warehouse'
      ) {
        const [[warehouse]] = await req.orgDb.query(
          'SELECT id FROM warehouses WHERE id=? AND is_active=1',
          { replacements: [value] },
        );
        if (!warehouse) {
          throw Object.assign(new Error('Choose an active warehouse'), {
            status: 400,
            code: 'VALIDATION_ERROR',
          });
        }
      }
      if (
        rawKey === 'stock_count_frequency_days' &&
        (!Number.isSafeInteger(Number(value)) || Number(value) < 1)
      ) {
        throw Object.assign(
          new Error('Count frequency must be a positive number of days'),
          { status: 400, code: 'VALIDATION_ERROR' },
        );
      }
      if (
        rawKey === 'scrap_tolerance_percent' &&
        (!Number.isFinite(Number(value)) ||
          Number(value) < 0 ||
          Number(value) > 100)
      ) {
        throw Object.assign(
          new Error('Scrap tolerance must be between 0 and 100'),
          { status: 400, code: 'VALIDATION_ERROR' },
        );
      }
      await req.orgDb.query(
        'INSERT INTO company_settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
        { replacements: [key, String(req.body.setting_value)] },
      );
      return created(res, {
        setting_key: key,
        setting_value: String(req.body.setting_value),
      });
    }),
  );
}
router.get(
  '/purchase/reports',
  ...secure('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      `SELECT 'Purchase orders' report_type,COUNT(*) record_count,COALESCE(SUM(total_amount),0) total_amount,COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','closed') THEN total_amount ELSE 0 END),0) open_amount,'All time' period FROM purchase_orders UNION ALL SELECT 'Goods receipts',COUNT(*),0,0,'All time' FROM grn UNION ALL SELECT 'Purchase returns',COUNT(*),COALESCE(SUM(total_amount),0),0,'All time' FROM purchase_returns`,
    );
    return ok(res, rows);
  }),
);
router.get(
  '/sales/reports',
  ...secure('sales', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      `SELECT 'Sales orders' report_type,COUNT(*) record_count,COALESCE(SUM(total_amount),0) total_amount,COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','delivered') THEN total_amount ELSE 0 END),0) open_amount,'All time' period FROM sales_orders UNION ALL SELECT 'Invoices',COUNT(*),COALESCE(SUM(total_amount),0),COALESCE(SUM(balance_amount),0),'All time' FROM invoices UNION ALL SELECT 'Sales returns',COUNT(*),COALESCE(SUM(total_amount),0),0,'All time' FROM sales_returns`,
    );
    return ok(res, rows);
  }),
);
router.get(
  '/sales/receivables',
  ...secure('sales', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search } = require('../utils/listQuery')(
      req.query,
      ['invoice_date'],
    );
    const where = search
        ? ' AND (i.invoice_number LIKE ? OR c.company_name LIKE ?)'
        : '',
      values = search ? [`%${search}%`, `%${search}%`] : [];
    const from =
      ' FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.balance_amount>0';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total${from}${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT i.*,c.company_name${from}${where} ORDER BY i.invoice_date DESC,i.id LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Receivables fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
router.get(
  '/quality/reports',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      `SELECT COALESCE(inspection_type,source_type,'Unclassified') report_type,COUNT(*) record_count,SUM(CASE WHEN COALESCE(result,overall_result) IN ('pass','passed','accepted') THEN 1 ELSE 0 END) passed,SUM(CASE WHEN COALESCE(result,overall_result) IN ('fail','failed','rejected') THEN 1 ELSE 0 END) failed,(SELECT COUNT(*) FROM quality_ncrs WHERE status<>'closed') open_actions,'All time' period FROM qc_inspections GROUP BY COALESCE(inspection_type,source_type,'Unclassified')`,
    );
    return ok(res, rows);
  }),
);
router.get(
  '/purchase/reports/export.xlsx',
  ...secure('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT po.po_number,v.company_name,po.status,po.total_amount,po.created_at FROM purchase_orders po LEFT JOIN vendors v ON v.id=po.vendor_id ORDER BY po.created_at DESC LIMIT 10000',
    );
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', 'attachment; filename="purchase-report.xlsx"')
      .send(await excel(rows, 'Purchase report'));
  }),
);
router.get(
  '/sales/reports/export.xlsx',
  ...secure('sales', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT i.invoice_number,c.company_name,i.invoice_date,i.status,i.total_amount,i.balance_amount FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id ORDER BY i.invoice_date DESC LIMIT 10000',
    );
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', 'attachment; filename="sales-report.xlsx"')
      .send(await excel(rows, 'Sales report'));
  }),
);
router.get(
  '/quality/reports/export.xlsx',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT inspection_number,inspection_type,source_type,source_id,item_id,inspected_qty,accepted_qty,rejected_qty,status,result,created_at FROM qc_inspections ORDER BY created_at DESC LIMIT 10000',
    );
    res
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', 'attachment; filename="quality-report.xlsx"')
      .send(await excel(rows, 'Quality report'));
  }),
);

router.post(
  '/quality/ncrs',
  ...secure('quality', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createNcr(req, req.body)),
  ),
);
router.post(
  '/quality/inspections/:id/disposition',
  ...secure('quality', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.disposeInspection(req, {
        ...req.body,
        inspection_id: req.params.id,
      }),
    ),
  ),
);
router.post(
  '/payroll/:id/finalize',
  ...secure('payroll', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.finalizePayroll(req, req.params.id)),
  ),
);
router.post(
  '/payroll/components',
  ...secure('payroll', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.savePayrollComponent(req, req.body)),
  ),
);
router.post(
  '/payroll/overtime',
  ...secure('payroll', 'can_edit'),
  asyncHandler(async (req, res) =>
    created(res, await service.recordPayrollOvertime(req, req.body)),
  ),
);
router.post(
  '/payroll/:id/calculate',
  ...secure('payroll', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(res, await service.calculatePayroll(req, req.params.id)),
  ),
);
router.post(
  '/payroll/:id/review',
  ...secure('payroll', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionPayroll(req, req.params.id, 'review')),
  ),
);
router.post(
  '/payroll/:id/approve',
  ...secure('payroll', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionPayroll(req, req.params.id, 'approve')),
  ),
);
router.post(
  '/payroll/:id/lock',
  ...secure('payroll', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionPayroll(req, req.params.id, 'lock')),
  ),
);
router.post(
  '/payroll/:id/post-to-finance',
  ...secure('payroll', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.postPayrollToFinance(req, req.params.id, req.body)),
  ),
);
router.get(
  '/payroll/:runId/payslips/:employeeId',
  ...secure('payroll', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.getPayslip(req, req.params.runId, req.params.employeeId),
    ),
  ),
);
router.post(
  '/finance/accounts',
  ...secure('finance', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createAccount(req, req.body)),
  ),
);
router.post(
  '/finance/journals/:id/submit',
  ...secure('finance', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(res, await service.submitJournal(req, req.params.id, 'submit')),
  ),
);
router.post(
  '/finance/journals/:id/approve',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.submitJournal(req, req.params.id, 'approve')),
  ),
);
router.post(
  '/finance/journals/:id/post',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.submitJournal(req, req.params.id, 'post')),
  ),
);
router.get(
  '/finance/statements/:type',
  ...secure('finance', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(res, await service.financialStatement(req, req.params.type, req.query)),
  ),
);
for (const [path, type] of [
  ['/finance/gl', 'gl'],
  ['/finance/trial-balance', 'trial_balance'],
  ['/finance/p&l', 'profit_loss'],
  ['/finance/balance-sheet', 'balance_sheet'],
  ['/finance/ar-ageing', 'ar_ageing'],
  ['/finance/ap-ageing', 'ap_ageing'],
]) {
  router.get(
    path,
    ...secure('finance', 'can_view'),
    asyncHandler(async (req, res) =>
      ok(res, await service.financialStatement(req, type, req.query)),
    ),
  );
}
router.post(
  '/finance/periods/:periodKey/close',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.closePeriod(req, req.params.periodKey)),
  ),
);
router.post(
  '/finance/journals/:id/reverse',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.reverseJournal(req, req.params.id)),
  ),
);
router.post(
  '/finance/documents',
  ...secure('finance', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createFinanceDocument(req, req.body)),
  ),
);
router.post(
  '/purchase/vendor-invoices',
  ...secure('purchase', 'can_create'),
  asyncHandler(async (req, res) => {
    return created(
      res,
      await service.createFinanceDocument(req, {
        ...req.body,
        document_type: 'payable',
      }),
    );
  }),
);
router.post(
  '/finance/expenses/:id/approve',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionExpense(req, req.params.id, 'approve')),
  ),
);
router.post(
  '/finance/expenses/:id/reject',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionExpense(req, req.params.id, 'reject')),
  ),
);
router.post(
  '/finance/expenses/:id/post',
  ...secure('finance', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionExpense(req, req.params.id, 'post')),
  ),
);
router.post(
  '/finance/payables/:id/pay',
  ...secure('finance', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(res, await service.recordVendorPayment(req, req.params.id, req.body)),
  ),
);
router.post(
  '/finance/bank',
  ...secure('finance', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createBankTransaction(req, req.body)),
  ),
);
router.post(
  '/finance/bank/:id/reconcile',
  ...secure('finance', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(res, await service.reconcileBank(req, req.params.id)),
  ),
);
router.post(
  '/gst/calculate',
  ...secure('gst', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      service.calculateGSTAuthoritative(
        req.body.items,
        req.org.state,
        req.body.customer_state,
      ),
    ),
  ),
);
router.post(
  '/gst/:type/:sourceId',
  ...secure('gst', 'can_create'),
  asyncHandler(async (req, res) => {
    const payload = service.integrationBoundary(
      req.params.type,
      req.params.sourceId,
      req.body,
    );
    const [existing] = await req.orgDb.query(
      'SELECT id,document_type,source_id,status,request_payload,response_payload,external_reference,last_error FROM government_documents WHERE document_type=? AND source_id=?',
      { replacements: [payload.document_type, payload.source_id] },
    );
    if (existing[0]) {
      return ok(res, { ...existing[0], already_queued: true });
    }
    await req.orgDb.query(
      'INSERT INTO government_documents(id,document_type,source_id,status,request_payload) VALUES(?,?,?,?,?)',
      {
        replacements: [
          require('uuid').v4(),
          payload.document_type,
          payload.source_id,
          payload.status,
          JSON.stringify(payload.request_payload),
        ],
      },
    );
    return created(res, payload);
  }),
);
router.post(
  '/gst/snapshots',
  ...secure('gst', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.gstSnapshot(req, req.body)),
  ),
);
router.post(
  '/quality/specifications',
  ...secure('quality', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createQualitySpecification(req, req.body)),
  ),
);
router.post(
  '/quality/parameters',
  ...secure('quality', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createQualityParameter(req, req.body)),
  ),
);
router.post(
  '/quality/sampling-plans',
  ...secure('quality', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createQualitySamplingPlan(req, req.body)),
  ),
);
router.post(
  '/quality/acceptance-criteria',
  ...secure('quality', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createQualityAcceptanceCriteria(req, req.body)),
  ),
);
router.post(
  '/quality/inspections/:id/snapshots',
  ...secure('quality', 'can_view'),
  asyncHandler(async (req, res) =>
    created(
      res,
      await service.createInspectionSnapshot(
        req,
        req.params.id,
        req.body.payload || req.body,
      ),
    ),
  ),
);
router.post(
  '/quality/ncrs/:id/transition',
  ...secure('quality', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.transitionNcr(req, req.params.id, req.body)),
  ),
);
const jobWorkMasterDefinitions = {
  vendors: {
    table: 'vendors',
    columns: ['vendor_code', 'company_name', 'email', 'phone', 'is_active'],
  },
  customers: {
    table: 'customers',
    columns: ['customer_code', 'company_name', 'email', 'phone', 'is_active'],
  },
};
for (const [resource, definition] of Object.entries(jobWorkMasterDefinitions)) {
  router.get(
    `/jobwork/${resource}`,
    ...secure('jobwork', 'can_view'),
    asyncHandler(async (req, res) => {
      const { page: current, limit } = page(req.query);
      const search = String(req.query.search || '').trim();
      const active = String(req.query.status || '').trim();
      if (active && !['active', 'inactive'].includes(active)) {
        throw Object.assign(new Error('status must be active or inactive'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      const sort = definition.columns.includes(String(req.query.sort))
        ? String(req.query.sort)
        : 'company_name';
      const direction =
        String(req.query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      const conditions = [];
      const values = [];
      if (search) {
        conditions.push(
          `(${definition.columns
            .slice(0, 4)
            .map((column) => `${column} LIKE ?`)
            .join(' OR ')})`,
        );
        values.push(...definition.columns.slice(0, 4).map(() => `%${search}%`));
      }
      if (active) {
        conditions.push('is_active=?');
        values.push(active === 'active' ? 1 : 0);
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const [[count]] = await req.orgDb.query(
        `SELECT COUNT(*) total FROM ${definition.table} ${where}`,
        { replacements: values },
      );
      const [rows] = await req.orgDb.query(
        `SELECT * FROM ${definition.table} ${where} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
        { replacements: [...values, limit, (current - 1) * limit] },
      );
      return ok(res, rows, undefined, {
        page: current,
        limit,
        total: Number(count.total || 0),
      });
    }),
  );
  router.get(
    `/jobwork/${resource}/:id`,
    ...secure('jobwork', 'can_view'),
    asyncHandler(async (req, res) => {
      const [rows] = await req.orgDb.query(
        `SELECT * FROM ${definition.table} WHERE id=? LIMIT 1`,
        { replacements: [req.params.id] },
      );
      if (!rows[0]) {
        throw Object.assign(new Error('Party not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      }
      return ok(res, rows[0]);
    }),
  );
  router.post(
    `/jobwork/${resource}`,
    ...secure('jobwork', 'can_create'),
    asyncHandler(async (req, res) => {
      const codeColumn =
        resource === 'vendors' ? 'vendor_code' : 'customer_code';
      if (!req.body[codeColumn] || !req.body.company_name) {
        throw Object.assign(
          new Error(`${codeColumn} and company_name are required`),
          {
            status: 400,
            code: 'VALIDATION_ERROR',
          },
        );
      }
      const id = require('uuid').v4();
      const typeColumns = resource === 'vendors' ? ',vendor_type' : '';
      const typePlaceholder = resource === 'vendors' ? ',?' : '';
      await req.orgDb.query(
        `INSERT INTO ${definition.table}(id,${codeColumn},company_name,email,phone${typeColumns},is_active) VALUES(?,?,?,?,?${typePlaceholder},1)`,
        {
          replacements: [
            id,
            req.body[codeColumn],
            req.body.company_name,
            req.body.email || null,
            req.body.phone || null,
            ...(resource === 'vendors' ? ['jobwork'] : []),
          ],
        },
      );
      await service.recordAudit(
        req,
        'jobwork',
        `jobwork.${resource}.create`,
        resource,
        id,
        req.body,
      );
      return created(res, { id, is_active: 1 });
    }),
  );
  router.put(
    `/jobwork/${resource}/:id`,
    ...secure('jobwork', 'can_edit'),
    asyncHandler(async (req, res) => {
      const allowed = ['company_name', 'email', 'phone'];
      const keys = Object.keys(req.body).filter((key) => allowed.includes(key));
      if (!keys.length) {
        throw Object.assign(new Error('No editable party fields supplied'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      const [[existing]] = await req.orgDb.query(
        `SELECT id FROM ${definition.table} WHERE id=?`,
        { replacements: [req.params.id] },
      );
      if (!existing) {
        throw Object.assign(new Error('Party not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      }
      await req.orgDb.query(
        `UPDATE ${definition.table} SET ${keys.map((key) => `${key}=?`).join(',')} WHERE id=?`,
        {
          replacements: [
            ...keys.map((key) => req.body[key] || null),
            req.params.id,
          ],
        },
      );
      await service.recordAudit(
        req,
        'jobwork',
        `jobwork.${resource}.update`,
        resource,
        req.params.id,
        req.body,
      );
      return ok(res, { id: req.params.id });
    }),
  );
  router.patch(
    `/jobwork/${resource}/:id/status`,
    ...secure('jobwork', 'can_edit'),
    asyncHandler(async (req, res) => {
      if (!['active', 'inactive'].includes(req.body.status)) {
        throw Object.assign(new Error('status must be active or inactive'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
      const isActive = req.body.status === 'active' ? 1 : 0;
      const [[existing]] = await req.orgDb.query(
        `SELECT id FROM ${definition.table} WHERE id=?`,
        { replacements: [req.params.id] },
      );
      if (!existing) {
        throw Object.assign(new Error('Party not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      }
      await req.orgDb.query(
        `UPDATE ${definition.table} SET is_active=? WHERE id=?`,
        {
          replacements: [isActive, req.params.id],
        },
      );
      await service.recordAudit(
        req,
        'jobwork',
        `jobwork.${resource}.status`,
        resource,
        req.params.id,
        { is_active: isActive },
      );
      return ok(res, { id: req.params.id, is_active: isActive });
    }),
  );
}
router.get(
  '/jobwork/orders',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const orderType = String(req.query.order_type || '').trim();
    const sortColumns = {
      jw_number: 'o.jw_number',
      order_type: 'o.order_type',
      party_name: 'COALESCE(v.company_name,c.company_name)',
      item_name: 'i.item_name',
      process_name: 'o.process_name',
      quantity: 'o.quantity',
      expected_return_date: 'o.expected_return_date',
      status: 'o.status',
      created_at: 'o.created_at',
    };
    const sort = sortColumns[String(req.query.sort)] || sortColumns.created_at;
    const direction =
      String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const conditions = [];
    const values = [];
    if (search) {
      conditions.push(
        '(o.jw_number LIKE ? OR o.process_name LIKE ? OR v.company_name LIKE ? OR c.company_name LIKE ?)',
      );
      values.push(...Array(4).fill(`%${search}%`));
    }
    if (status) {
      conditions.push('o.status=?');
      values.push(status);
    }
    if (orderType) {
      conditions.push('o.order_type=?');
      values.push(orderType);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const joins =
      'LEFT JOIN vendors v ON v.id=o.vendor_id LEFT JOIN customers c ON c.id=o.customer_id LEFT JOIN item_master i ON i.id=o.item_id';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM job_work_orders o ${joins} ${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT o.*,COALESCE(v.company_name,c.company_name) party_name,i.item_code,i.item_name
       FROM job_work_orders o ${joins} ${where}
       ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, (current - 1) * limit] },
    );
    return ok(res, rows, undefined, {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.post(
  '/jobwork/orders',
  ...secure('jobwork', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createJobWorkOrder(req, req.body)),
  ),
);
router.get(
  '/jobwork/orders/:id',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      `SELECT o.*,COALESCE(v.company_name,c.company_name) party_name,i.item_code,i.item_name,w.warehouse_name
       FROM job_work_orders o
       LEFT JOIN vendors v ON v.id=o.vendor_id
       LEFT JOIN customers c ON c.id=o.customer_id
       LEFT JOIN item_master i ON i.id=o.item_id
       LEFT JOIN warehouses w ON w.id=o.warehouse_id
       WHERE o.id=? LIMIT 1`,
      { replacements: [req.params.id] },
    );
    if (!rows[0]) {
      throw Object.assign(new Error('Job work order not found'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    const [challans] = await req.orgDb.query(
      'SELECT * FROM job_work_challans WHERE job_work_order_id=? ORDER BY created_at',
      { replacements: [req.params.id] },
    );
    const [finishedGoods] = await req.orgDb.query(
      `SELECT f.* FROM job_work_finished_goods_receipts f
       INNER JOIN job_work_challans c ON c.id=f.challan_id
       WHERE c.job_work_order_id=? ORDER BY f.created_at`,
      { replacements: [req.params.id] },
    );
    const [bills] = await req.orgDb.query(
      `SELECT b.*,d.document_number,d.amount,d.status finance_status
       FROM job_work_bills b
       INNER JOIN finance_documents d ON d.id=b.finance_document_id
       WHERE b.job_work_order_id=? ORDER BY b.created_at`,
      { replacements: [req.params.id] },
    );
    return ok(res, {
      ...rows[0],
      challans,
      finished_goods: finishedGoods,
      bills,
    });
  }),
);
router.put(
  '/jobwork/orders/:id',
  ...secure('jobwork', 'can_edit'),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateJobWorkOrder(req, req.params.id, req.body)),
  ),
);
for (const action of ['submit', 'complete', 'cancel']) {
  router.post(
    `/jobwork/orders/:id/${action}`,
    ...secure('jobwork', action === 'submit' ? 'can_edit' : 'can_approve'),
    asyncHandler(async (req, res) =>
      ok(res, await service.transitionJobWorkOrder(req, req.params.id, action)),
    ),
  );
}
router.get(
  '/jobwork/challans',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const sortColumns = {
      challan_number: 'c.challan_number',
      jw_number: 'o.jw_number',
      warehouse_id: 'c.warehouse_id',
      outward_date: 'c.outward_date',
      status: 'c.status',
      created_at: 'c.created_at',
    };
    const sort = sortColumns[String(req.query.sort)] || sortColumns.created_at;
    const direction =
      String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const conditions = [];
    const values = [];
    if (search) {
      conditions.push('(c.challan_number LIKE ? OR o.jw_number LIKE ?)');
      values.push(`%${search}%`, `%${search}%`);
    }
    if (status) {
      conditions.push('c.status=?');
      values.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM job_work_challans c INNER JOIN job_work_orders o ON o.id=c.job_work_order_id ${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT c.*,o.jw_number FROM job_work_challans c
       INNER JOIN job_work_orders o ON o.id=c.job_work_order_id ${where}
       ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, (current - 1) * limit] },
    );
    return ok(res, rows, undefined, {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.get(
  '/jobwork/challans/:id',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      `SELECT c.*,o.jw_number,w.warehouse_name FROM job_work_challans c
       INNER JOIN job_work_orders o ON o.id=c.job_work_order_id
       LEFT JOIN warehouses w ON w.id=c.warehouse_id WHERE c.id=? LIMIT 1`,
      { replacements: [req.params.id] },
    );
    if (!rows[0])
      throw Object.assign(new Error('Job work challan not found'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    const [items] = await req.orgDb.query(
      'SELECT ci.*,i.item_code,i.item_name FROM job_work_challan_items ci LEFT JOIN item_master i ON i.id=ci.item_id WHERE ci.challan_id=?',
      { replacements: [req.params.id] },
    );
    const [receipts] = await req.orgDb.query(
      'SELECT * FROM job_work_receipts WHERE challan_id=? ORDER BY created_at',
      { replacements: [req.params.id] },
    );
    const [consumption] = await req.orgDb.query(
      'SELECT * FROM job_work_consumptions WHERE challan_id=? ORDER BY created_at',
      { replacements: [req.params.id] },
    );
    const [finishedGoods] = await req.orgDb.query(
      'SELECT * FROM job_work_finished_goods_receipts WHERE challan_id=? ORDER BY created_at',
      { replacements: [req.params.id] },
    );
    return ok(res, {
      ...rows[0],
      items,
      receipts,
      consumption,
      finished_goods: finishedGoods,
    });
  }),
);
router.put(
  '/jobwork/challans/:id',
  ...secure('jobwork', 'can_edit'),
  asyncHandler(async (req, res) => {
    const [[challan]] = await req.orgDb.query(
      'SELECT status FROM job_work_challans WHERE id=?',
      { replacements: [req.params.id] },
    );
    if (!challan) {
      throw Object.assign(new Error('Job work challan not found'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    if (challan.status === 'cancelled') {
      throw Object.assign(new Error('Cancelled challans cannot be edited'), {
        status: 409,
        code: 'INVALID_STATUS',
      });
    }
    await req.orgDb.query(
      'UPDATE job_work_challans SET notes=? WHERE id=? AND status<>"cancelled"',
      {
        replacements: [req.body.notes || null, req.params.id],
      },
    );
    await service.recordAudit(
      req,
      'jobwork',
      'jobwork.challan.update',
      'job_work_challan',
      req.params.id,
      req.body,
    );
    return ok(res, { id: req.params.id, notes: req.body.notes || null });
  }),
);
router.post(
  '/jobwork/challans',
  ...secure('jobwork', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.issueJobWorkChallan(req, req.body)),
  ),
);
router.post(
  '/jobwork/receipts',
  ...secure('jobwork', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.receiveJobWorkMaterial(req, req.body)),
  ),
);
router.get(
  '/jobwork/receipts',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const conditions = [];
    const values = [];
    if (search) {
      conditions.push('(r.receipt_number LIKE ? OR c.challan_number LIKE ?)');
      values.push(`%${search}%`, `%${search}%`);
    }
    if (status) {
      conditions.push('r.status=?');
      values.push(status);
    }
    const sortColumns = {
      receipt_number: 'r.receipt_number',
      challan_number: 'c.challan_number',
      receipt_date: 'r.receipt_date',
      requires_qc: 'r.requires_qc',
      status: 'r.status',
      created_at: 'r.created_at',
    };
    const sort = sortColumns[String(req.query.sort)] || sortColumns.created_at;
    const direction =
      String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM job_work_receipts r
       INNER JOIN job_work_challans c ON c.id=r.challan_id ${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT r.*,c.challan_number,c.job_work_order_id
       FROM job_work_receipts r
       INNER JOIN job_work_challans c ON c.id=r.challan_id ${where}
       ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, (current - 1) * limit] },
    );
    return ok(res, rows, 'Job work receipts fetched', {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.get(
  '/jobwork/receipts/:id',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      `SELECT r.*,c.challan_number,o.jw_number,w.warehouse_name
       FROM job_work_receipts r
       INNER JOIN job_work_challans c ON c.id=r.challan_id
       INNER JOIN job_work_orders o ON o.id=c.job_work_order_id
       LEFT JOIN warehouses w ON w.id=r.warehouse_id
       WHERE r.id=? LIMIT 1`,
      { replacements: [req.params.id] },
    );
    if (!rows[0])
      throw Object.assign(new Error('Job work receipt not found'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    const [items] = await req.orgDb.query(
      'SELECT ri.*,i.item_code,i.item_name FROM job_work_receipt_items ri LEFT JOIN item_master i ON i.id=ri.item_id WHERE ri.receipt_id=?',
      { replacements: [req.params.id] },
    );
    const [inspections] = await req.orgDb.query(
      "SELECT id,inspection_number,status,result FROM qc_inspections WHERE source_type='job_work_receipt' AND source_id=?",
      { replacements: [req.params.id] },
    );
    return ok(res, { ...rows[0], items, inspections });
  }),
);
router.put(
  '/jobwork/receipts/:id',
  ...secure('jobwork', 'can_edit'),
  asyncHandler(async (req, res) => {
    const [[receipt]] = await req.orgDb.query(
      'SELECT status FROM job_work_receipts WHERE id=?',
      { replacements: [req.params.id] },
    );
    if (!receipt) {
      throw Object.assign(new Error('Job work receipt not found'), {
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    if (receipt.status === 'cancelled') {
      throw Object.assign(new Error('Cancelled receipts cannot be edited'), {
        status: 409,
        code: 'INVALID_STATUS',
      });
    }
    await req.orgDb.query(
      'UPDATE job_work_receipts SET notes=? WHERE id=? AND status<>"cancelled"',
      {
        replacements: [req.body.notes || null, req.params.id],
      },
    );
    await service.recordAudit(
      req,
      'jobwork',
      'jobwork.receipt.update',
      'job_work_receipt',
      req.params.id,
      req.body,
    );
    return ok(res, { id: req.params.id, notes: req.body.notes || null });
  }),
);
router.post(
  '/jobwork/challans/:id/cancel',
  ...secure('jobwork', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.cancelJobWorkStockDocument(req, 'challan', req.params.id),
    ),
  ),
);
router.post(
  '/jobwork/receipts/:id/cancel',
  ...secure('jobwork', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.cancelJobWorkStockDocument(req, 'receipt', req.params.id),
    ),
  ),
);
router.get(
  '/jobwork/pending-material',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const orderStatus = String(req.query.status || '').trim();
    const sortColumns = [
      'challan_number',
      'item_id',
      'outward_quantity',
      'received_quantity',
      'consumed_quantity',
      'pending_quantity',
    ];
    const sort = sortColumns.includes(String(req.query.sort))
      ? String(req.query.sort)
      : 'challan_number';
    const direction =
      String(req.query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const searchWhere = search
      ? ' AND (c.challan_number LIKE ? OR ci.item_id LIKE ?)'
      : '';
    const statusWhere = orderStatus ? ' AND o.status=?' : '';
    const filterValues = [
      ...(search ? [`%${search}%`, `%${search}%`] : []),
      ...(orderStatus ? [orderStatus] : []),
    ];
    const [rows] = await req.orgDb.query(
      `SELECT c.id challan_id,c.challan_number,c.job_work_order_id,
        ci.item_id,ci.quantity outward_quantity,
        COALESCE(receipts.quantity,0) received_quantity,
        COALESCE(consumption.quantity,0) consumed_quantity,
        ci.quantity-COALESCE(receipts.quantity,0)-COALESCE(consumption.quantity,0) pending_quantity
       FROM job_work_challans c
       INNER JOIN job_work_challan_items ci ON ci.challan_id=c.id
       INNER JOIN job_work_orders o ON o.id=c.job_work_order_id
       LEFT JOIN (
         SELECT r.challan_id,ri.item_id,SUM(ri.quantity) quantity
         FROM job_work_receipts r
         INNER JOIN job_work_receipt_items ri ON ri.receipt_id=r.id
         WHERE r.status='posted' GROUP BY r.challan_id,ri.item_id
       ) receipts ON receipts.challan_id=c.id AND receipts.item_id=ci.item_id
       LEFT JOIN (
         SELECT challan_id,item_id,SUM(quantity) quantity
         FROM job_work_consumptions WHERE status='posted'
         GROUP BY challan_id,item_id
       ) consumption ON consumption.challan_id=c.id AND consumption.item_id=ci.item_id
       WHERE c.status IN ('posted','completed')${searchWhere}${statusWhere}
       HAVING pending_quantity > 0
       ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...filterValues, limit, (current - 1) * limit] },
    );
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM (
        SELECT ci.id FROM job_work_challans c
        INNER JOIN job_work_challan_items ci ON ci.challan_id=c.id
        INNER JOIN job_work_orders o ON o.id=c.job_work_order_id
        LEFT JOIN (
          SELECT r.challan_id,ri.item_id,SUM(ri.quantity) quantity
          FROM job_work_receipts r
          INNER JOIN job_work_receipt_items ri ON ri.receipt_id=r.id
          WHERE r.status='posted' GROUP BY r.challan_id,ri.item_id
        ) receipts ON receipts.challan_id=c.id AND receipts.item_id=ci.item_id
        LEFT JOIN (
          SELECT challan_id,item_id,SUM(quantity) quantity
          FROM job_work_consumptions WHERE status='posted'
          GROUP BY challan_id,item_id
        ) consumption ON consumption.challan_id=c.id AND consumption.item_id=ci.item_id
        WHERE c.status IN ('posted','completed')${searchWhere}${statusWhere}
        HAVING ci.quantity-COALESCE(receipts.quantity,0)-COALESCE(consumption.quantity,0)>0
      ) pending`,
      { replacements: filterValues },
    );
    return ok(res, rows, 'Pending job work material fetched', {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.get(
  '/jobwork/dashboard',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[orders]] = await req.orgDb.query(
      'SELECT COUNT(*) total,SUM(status="sent") active FROM job_work_orders',
    );
    const [[challans]] = await req.orgDb.query(
      'SELECT COUNT(*) total,SUM(status="posted") open FROM job_work_challans',
    );
    const [[pending]] = await req.orgDb.query(
      `SELECT COALESCE(SUM(ci.quantity)-SUM(COALESCE(receipts.quantity,0))-SUM(COALESCE(consumption.quantity,0)),0) quantity
       FROM job_work_challan_items ci
       INNER JOIN job_work_challans c ON c.id=ci.challan_id
       LEFT JOIN (
         SELECT ri.item_id,r.challan_id,SUM(ri.quantity) quantity
         FROM job_work_receipt_items ri
         INNER JOIN job_work_receipts r ON r.id=ri.receipt_id
         WHERE r.status='posted' GROUP BY r.challan_id,ri.item_id
       ) receipts ON receipts.challan_id=c.id AND receipts.item_id=ci.item_id
       LEFT JOIN (
         SELECT challan_id,item_id,SUM(quantity) quantity
         FROM job_work_consumptions WHERE status='posted'
         GROUP BY challan_id,item_id
       ) consumption ON consumption.challan_id=c.id AND consumption.item_id=ci.item_id
       WHERE c.status IN ('posted','completed')`,
    );
    return ok(res, {
      orders: Number(orders.total || 0),
      active_orders: Number(orders.active || 0),
      outward_challans: Number(challans.total || 0),
      open_challans: Number(challans.open || 0),
      pending_quantity: Number(pending.quantity || 0),
    });
  }),
);
router.post(
  '/jobwork/consumption',
  ...secure('jobwork', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.recordJobWorkConsumption(req, req.body)),
  ),
);
router.post(
  '/jobwork/finished-goods',
  ...secure('jobwork', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.receiveJobWorkFinishedGoods(req, req.body)),
  ),
);
router.post(
  '/jobwork/billing',
  ...secure('jobwork', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createJobWorkBill(req, req.body)),
  ),
);
router.post(
  '/jobwork/consumption/:id/cancel',
  ...secure('jobwork', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.cancelJobWorkConsumption(req, req.params.id)),
  ),
);
router.post(
  '/jobwork/finished-goods/:id/cancel',
  ...secure('jobwork', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.cancelJobWorkStockDocument(req, 'finished', req.params.id),
    ),
  ),
);
const jobWorkLists = {
  consumption: {
    table: 'job_work_consumptions',
    search: ['challan_id', 'item_id', 'notes'],
    sort: [
      'challan_id',
      'item_id',
      'quantity',
      'consumed_on',
      'status',
      'created_at',
    ],
    select:
      'job_work_consumptions.*,job_work_challans.challan_number,item_master.item_code,item_master.item_name',
    joins:
      ' LEFT JOIN job_work_challans ON job_work_challans.id=job_work_consumptions.challan_id LEFT JOIN item_master ON item_master.id=job_work_consumptions.item_id',
  },
  'finished-goods': {
    table: 'job_work_finished_goods_receipts',
    search: ['receipt_number', 'challan_id', 'item_id'],
    sort: [
      'receipt_number',
      'challan_id',
      'item_id',
      'quantity',
      'status',
      'created_at',
    ],
    select:
      'job_work_finished_goods_receipts.*,job_work_challans.challan_number,item_master.item_code,item_master.item_name,warehouses.warehouse_name',
    joins:
      ' LEFT JOIN job_work_challans ON job_work_challans.id=job_work_finished_goods_receipts.challan_id LEFT JOIN item_master ON item_master.id=job_work_finished_goods_receipts.item_id LEFT JOIN warehouses ON warehouses.id=job_work_finished_goods_receipts.warehouse_id',
  },
  billing: {
    table: 'job_work_bills',
    search: ['job_work_order_id', 'finance_document_id', 'bill_type'],
    searchExpressions: [
      'finance_documents.document_number',
      'finance_documents.party_id',
    ],
    sort: [
      'job_work_order_id',
      'finance_document_id',
      'bill_type',
      'created_at',
    ],
    sortExpressions: {
      document_number: 'finance_documents.document_number',
      amount: 'finance_documents.amount',
      finance_status: 'finance_documents.status',
    },
    select:
      'job_work_bills.*,finance_documents.document_number,finance_documents.document_date,finance_documents.amount,finance_documents.status finance_status',
    joins:
      ' LEFT JOIN finance_documents ON finance_documents.id=job_work_bills.finance_document_id',
  },
};
for (const [resource, definition] of Object.entries(jobWorkLists)) {
  router.get(
    `/jobwork/${resource}`,
    ...secure('jobwork', 'can_view'),
    asyncHandler(async (req, res) => {
      const { page: current, limit } = page(req.query);
      const search = String(req.query.search || '').trim();
      const status = String(req.query.status || '').trim();
      const requestedSort = String(req.query.sort);
      const sort = definition.sort.includes(requestedSort)
        ? `${definition.table}.${requestedSort}`
        : definition.sortExpressions?.[requestedSort] ||
          `${definition.table}.created_at`;
      const direction =
        String(req.query.direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const conditions = [];
      const values = [];
      if (search) {
        const searchColumns = [
          ...definition.search.map((column) => `${definition.table}.${column}`),
          ...(definition.searchExpressions || []),
        ];
        conditions.push(
          `(${searchColumns.map((column) => `${column} LIKE ?`).join(' OR ')})`,
        );
        values.push(...searchColumns.map(() => `%${search}%`));
      }
      if (status && resource !== 'billing') {
        conditions.push(`${definition.table}.status=?`);
        values.push(status);
      }
      if (status && resource === 'billing') {
        conditions.push(`${definition.table}.bill_type=?`);
        values.push(status);
      }
      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const joins = definition.joins || '';
      const [[count]] = await req.orgDb.query(
        `SELECT COUNT(*) total FROM ${definition.table}${joins} ${where}`,
        { replacements: values },
      );
      const [rows] = await req.orgDb.query(
        `SELECT ${definition.select || `${definition.table}.*`} FROM ${definition.table}${joins} ${where} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
        { replacements: [...values, limit, (current - 1) * limit] },
      );
      return ok(res, rows, `Job work ${resource} fetched`, {
        page: current,
        limit,
        total: Number(count.total || 0),
      });
    }),
  );
  router.get(
    `/jobwork/${resource}/:id`,
    ...secure('jobwork', 'can_view'),
    asyncHandler(async (req, res) => {
      const joins = definition.joins || '';
      const [rows] = await req.orgDb.query(
        `SELECT ${definition.select || `${definition.table}.*`} FROM ${definition.table}${joins} WHERE ${definition.table}.id=? LIMIT 1`,
        { replacements: [req.params.id] },
      );
      if (!rows[0]) {
        throw Object.assign(new Error('Job work record not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      }
      if (resource === 'finished-goods') {
        const [inspections] = await req.orgDb.query(
          "SELECT id,inspection_number,status,result FROM qc_inspections WHERE source_type='job_work_finished_goods_receipt' AND source_id=?",
          { replacements: [req.params.id] },
        );
        return ok(res, { ...rows[0], inspections });
      }
      return ok(res, rows[0]);
    }),
  );
}
router.get(
  '/jobwork/reports',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const sortColumns = [
      'jw_number',
      'process_name',
      'party_name',
      'issued_quantity',
      'returned_quantity',
      'consumed_quantity',
      'pending_quantity',
    ];
    const sort = sortColumns.includes(String(req.query.sort))
      ? String(req.query.sort)
      : 'jw_number';
    const direction =
      String(req.query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const filters = [];
    const filterValues = [];
    if (search) {
      filters.push(
        '(report.jw_number LIKE ? OR report.process_name LIKE ? OR report.party_name LIKE ?)',
      );
      filterValues.push(...Array(3).fill(`%${search}%`));
    }
    if (status) {
      filters.push('report.status=?');
      filterValues.push(status);
    }
    const reportWhere = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const reportSql = `SELECT o.id,o.jw_number,o.process_name,o.status,COALESCE(v.company_name,c.company_name) party_name,
      COALESCE(SUM(ci.quantity),0) issued_quantity,
      COALESCE(SUM(receipts.quantity),0) returned_quantity,
      COALESCE(SUM(consumption.quantity),0) consumed_quantity,
      COALESCE(SUM(ci.quantity),0)-COALESCE(SUM(receipts.quantity),0)-COALESCE(SUM(consumption.quantity),0) pending_quantity
      FROM job_work_orders o
      LEFT JOIN vendors v ON v.id=o.vendor_id
      LEFT JOIN customers c ON c.id=o.customer_id
      LEFT JOIN job_work_challans ch ON ch.job_work_order_id=o.id AND ch.status IN ('posted','completed')
      LEFT JOIN job_work_challan_items ci ON ci.challan_id=ch.id
      LEFT JOIN (
        SELECT r.challan_id,ri.item_id,SUM(ri.quantity) quantity
        FROM job_work_receipts r
        INNER JOIN job_work_receipt_items ri ON ri.receipt_id=r.id
        WHERE r.status='posted' GROUP BY r.challan_id,ri.item_id
      ) receipts ON receipts.challan_id=ch.id AND receipts.item_id=ci.item_id
      LEFT JOIN (
        SELECT challan_id,item_id,SUM(quantity) quantity
        FROM job_work_consumptions WHERE status='posted'
        GROUP BY challan_id,item_id
      ) consumption ON consumption.challan_id=ch.id AND consumption.item_id=ci.item_id
      GROUP BY o.id,v.company_name,c.company_name`;
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM (${reportSql}) report ${reportWhere}`,
      { replacements: filterValues },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM (${reportSql}) report ${reportWhere} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...filterValues, limit, (current - 1) * limit] },
    );
    return ok(res, rows, undefined, {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.get(
  '/jobwork/settings',
  ...secure('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page: current, limit } = page(req.query);
    const search = String(req.query.search || '').trim();
    const sort = ['setting_key', 'setting_value'].includes(
      String(req.query.sort),
    )
      ? String(req.query.sort)
      : 'setting_key';
    const direction =
      String(req.query.direction).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const searchCondition = search
      ? ' AND (setting_key LIKE ? OR setting_value LIKE ?)'
      : '';
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM company_settings WHERE setting_key LIKE 'jobwork.%'${searchCondition}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT setting_key,setting_value FROM company_settings
       WHERE setting_key LIKE 'jobwork.%'${searchCondition}
       ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, (current - 1) * limit] },
    );
    return ok(res, rows, undefined, {
      page: current,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.put(
  '/jobwork/settings',
  ...secure('jobwork', 'can_edit'),
  asyncHandler(async (req, res) => {
    const allowed = [
      'default_warehouse',
      'require_inward_qc',
      'default_return_days',
    ];
    if (!allowed.includes(req.body.setting_key)) {
      throw Object.assign(new Error('Unsupported Job Work setting'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (req.body.setting_value === undefined || req.body.setting_value === '') {
      throw Object.assign(new Error('setting_value is required'), {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (
      req.body.setting_key === 'default_return_days' &&
      (!Number.isSafeInteger(Number(req.body.setting_value)) ||
        Number(req.body.setting_value) < 1)
    ) {
      throw Object.assign(
        new Error('Default return days must be a positive integer'),
        {
          status: 400,
          code: 'VALIDATION_ERROR',
        },
      );
    }
    if (
      req.body.setting_key === 'require_inward_qc' &&
      !['true', 'false', '1', '0'].includes(String(req.body.setting_value))
    ) {
      throw Object.assign(
        new Error('require_inward_qc must be true or false'),
        {
          status: 400,
          code: 'VALIDATION_ERROR',
        },
      );
    }
    if (req.body.setting_key === 'default_warehouse') {
      const [[warehouse]] = await req.orgDb.query(
        'SELECT id FROM warehouses WHERE id=? AND is_active=1',
        { replacements: [req.body.setting_value] },
      );
      if (!warehouse) {
        throw Object.assign(new Error('Choose an active warehouse'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }
    }
    const key = `jobwork.${req.body.setting_key}`;
    await req.orgDb.query(
      'INSERT INTO company_settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
      { replacements: [key, String(req.body.setting_value)] },
    );
    await service.recordAudit(
      req,
      'jobwork',
      'jobwork.settings.update',
      'company_setting',
      key,
      req.body,
    );
    return ok(res, {
      setting_key: key,
      setting_value: String(req.body.setting_value),
    });
  }),
);
router.post(
  '/hr/departments',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createDepartment(req, req.body)),
  ),
);
router.post(
  '/hr/designations',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createHrMaster(req, 'designation', req.body)),
  ),
);
router.post(
  '/hr/employment-types',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(
      res,
      await service.createHrMaster(req, 'employment_type', req.body),
    ),
  ),
);
router.post(
  '/hr/document-types',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createHrMaster(req, 'document_type', req.body)),
  ),
);
router.post(
  '/hr/locations',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createLocation(req, req.body)),
  ),
);
router.post(
  '/hr/grades',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createGrade(req, req.body)),
  ),
);
router.post(
  '/hr/shifts',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createShift(req, req.body)),
  ),
);
router.post(
  '/hr/calendars',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createCalendar(req, req.body)),
  ),
);
router.post(
  '/hr/attendance/corrections',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createAttendanceCorrection(req, req.body)),
  ),
);
router.post(
  '/hr/attendance/corrections/:id/approve',
  ...secure('hr', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(
      res,
      await service.approveAttendanceCorrection(req, req.params.id, req.body),
    ),
  ),
);
router.get(
  '/hr/employees/:id/360',
  ...secure('hr', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(res, await service.getEmployee360(req, req.params.id)),
  ),
);
router.post(
  '/hr/leave/policies',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createLeavePolicy(req, req.body)),
  ),
);
router.post(
  '/hr/leave/accrual-rules',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createLeaveAccrualRule(req, req.body)),
  ),
);
router.post(
  '/hr/leave/holidays',
  ...secure('hr', 'can_create'),
  asyncHandler(async (req, res) =>
    created(res, await service.createHoliday(req, req.body)),
  ),
);
router.post(
  '/hr/leave/validate',
  ...secure('hr', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(res, await service.validateLeaveRequest(req, req.body)),
  ),
);
router.post(
  '/hr/leave/:id/approve',
  ...secure('hr', 'can_approve'),
  asyncHandler(async (req, res) =>
    ok(res, await service.approveLeaveRequest(req, req.params.id, req.body)),
  ),
);
router.post(
  '/hr/leave/balance-transactions',
  ...secure('hr', 'can_edit'),
  asyncHandler(async (req, res) =>
    created(res, await service.recordLeaveBalanceTransaction(req, req.body)),
  ),
);
router.get(
  '/reports/analytics/:key',
  ...secure('reports', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(res, await service.report(req, req.params.key, req.query)),
  ),
);
module.exports = router;
