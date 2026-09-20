const router = require('express').Router();
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, asyncHandler } = require('../utils/response');
const service = require('../services/operationalDomains.service');
const { excel } = require('../services/export.service');
const secure = (mod, action) => [auth, orgContext, entitlement, moduleGuard(mod), permission(mod, action)];

const page = query => ({ page: Math.max(1, Number(query.page || 1)), limit: Math.min(100, Math.max(1, Number(query.limit || 20))) });
const moduleSettings = module => ({ prefix: `${module}.%`, module });
const allowedSettings = {
  purchase: ['approval_required','over_receipt_tolerance','invoice_match_tolerance','default_payment_terms'],
  sales: ['credit_limit_enforced','negative_stock_allowed','dispatch_requires_confirmation','default_payment_terms'],
  quality: ['incoming_qc_required','in_process_qc_required','final_qc_required','auto_ncr_on_failure','default_quarantine_warehouse']
};

router.get('/purchase/vendor-invoices', ...secure('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const { page: current, limit } = page(req.query); const search = String(req.query.search || '').trim();
  const where = search ? ' AND (fd.document_number LIKE ? OR v.company_name LIKE ?)' : '';
  const values = search ? [`%${search}%`, `%${search}%`] : [];
  const [[count]] = await req.orgDb.query(`SELECT COUNT(*) total FROM finance_documents fd LEFT JOIN vendors v ON v.id=fd.party_id WHERE fd.document_type='payable'${where}`, { replacements: values });
  const [rows] = await req.orgDb.query(`SELECT fd.*,fd.party_id vendor_id,fd.amount total_amount,fd.amount-COALESCE(fd.paid_amount,0) balance_amount,v.company_name FROM finance_documents fd LEFT JOIN vendors v ON v.id=fd.party_id WHERE fd.document_type='payable'${where} ORDER BY fd.document_date DESC,fd.document_number DESC LIMIT ? OFFSET ?`, { replacements: [...values, limit, (current - 1) * limit] });
  return ok(res, rows, 'Purchase invoices fetched', { page: current, limit, total: Number(count.total || 0) });
}));
router.get('/purchase/vendor-invoices/:id', ...secure('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query("SELECT fd.*,fd.party_id vendor_id,fd.amount total_amount,fd.amount-COALESCE(fd.paid_amount,0) balance_amount,v.company_name FROM finance_documents fd LEFT JOIN vendors v ON v.id=fd.party_id WHERE fd.id=? AND fd.document_type='payable' LIMIT 1", { replacements:[req.params.id] });
  if (!rows[0]) return res.status(404).json({ success:false,error:'NOT_FOUND',message:'Purchase invoice not found' });
  const [links] = await req.orgDb.query("SELECT target_type,target_id,relation FROM related_documents WHERE source_type='purchase_invoice' AND source_id=? ORDER BY created_at", { replacements:[req.params.id] });
  return ok(res, { ...rows[0], links });
}));
router.post('/purchase/vendor-invoices/:id/match', ...secure('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  if (!req.body.purchase_order_id || !req.body.grn_id) throw Object.assign(new Error('purchase_order_id and grn_id are required'), { status:400,code:'VALIDATION_ERROR' });
  const tx = await req.orgDb.transaction();
  try {
    const [[invoice]] = await req.orgDb.query("SELECT * FROM finance_documents WHERE id=? AND document_type='payable' FOR UPDATE", { replacements:[req.params.id],transaction:tx });
    const [[grn]] = await req.orgDb.query('SELECT * FROM grn WHERE id=? AND po_id=? FOR UPDATE', { replacements:[req.body.grn_id,req.body.purchase_order_id],transaction:tx });
    const [[po]] = await req.orgDb.query('SELECT * FROM purchase_orders WHERE id=? FOR UPDATE', { replacements:[req.body.purchase_order_id],transaction:tx });
    if (!invoice || !po || !grn) throw Object.assign(new Error('Invoice, purchase order, or matching GRN was not found'), { status:404,code:'NOT_FOUND' });
    if (invoice.party_id !== po.vendor_id || po.vendor_id !== grn.vendor_id) throw Object.assign(new Error('Vendor differs between invoice, PO and GRN'), { status:409,code:'MATCH_FAILED' });
    if (grn.status !== 'posted') throw Object.assign(new Error('GRN must be posted before invoice matching'), { status:409,code:'MATCH_FAILED' });
    const tolerance = Number(req.body.tolerance || 0), variance = Math.abs(Number(invoice.amount)-Number(po.total_amount));
    if (variance > tolerance) throw Object.assign(new Error(`Invoice variance ${variance.toFixed(2)} exceeds tolerance`), { status:409,code:'MATCH_FAILED' });
    for (const [type,id,relation] of [['purchase_order',po.id,'matched_order'],['grn',grn.id,'matched_receipt']]) await req.orgDb.query('INSERT INTO related_documents(id,source_type,source_id,target_type,target_id,relation,created_by) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE target_id=VALUES(target_id)', { replacements:[require('uuid').v4(),'purchase_invoice',req.params.id,type,id,relation,req.user?.sub||null],transaction:tx });
    await req.orgDb.query("UPDATE finance_documents SET status='matched' WHERE id=?", { replacements:[req.params.id],transaction:tx });
    await tx.commit(); return ok(res,{ id:req.params.id,status:'matched',variance });
  } catch (error) { await tx.rollback(); throw error; }
}));
router.post('/purchase/vendor-invoices/:id/pay', ...secure('purchase', 'can_edit'), asyncHandler(async (req, res) => ok(res, await service.recordVendorPayment(req, req.params.id, req.body))));
router.get('/quality/ncrs', ...secure('quality', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query('SELECT * FROM quality_ncrs ORDER BY ncr_number DESC LIMIT 500'); return ok(res, rows);
}));
router.get('/quality/specifications', ...secure('quality', 'can_view'), asyncHandler(async (req, res) => { const [rows] = await req.orgDb.query('SELECT * FROM quality_specifications ORDER BY code LIMIT 500'); return ok(res, rows); }));
router.get('/quality/masters', ...secure('quality', 'can_view'), asyncHandler(async (req, res) => {
  const [specifications] = await req.orgDb.query('SELECT * FROM quality_specifications ORDER BY code');
  const [parameters] = await req.orgDb.query('SELECT * FROM quality_parameters ORDER BY parameter_code');
  const [sampling_plans] = await req.orgDb.query('SELECT * FROM quality_sampling_plans ORDER BY plan_code');
  const [acceptance_criteria] = await req.orgDb.query('SELECT * FROM quality_acceptance_criteria ORDER BY criterion_code');
  return ok(res,{ specifications,parameters,sampling_plans,acceptance_criteria });
}));
for (const [path, type, sourceType] of [['inward','incoming','grn'],['in-process','in_process','production'],['final','final','finished_goods']]) {
  router.get(`/quality/${path}`, ...secure('quality', 'can_view'), asyncHandler(async (req, res) => {
    const current = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(1, Number(req.query.limit || 20))), search = String(req.query.search || '').trim();
    const where = search ? ' AND (inspection_number LIKE ? OR reference_id LIKE ? OR item_id LIKE ?)' : '', values = search ? [`%${search}%`,`%${search}%`,`%${search}%`] : [];
    const [[count]] = await req.orgDb.query(`SELECT COUNT(*) total FROM qc_inspections WHERE (inspection_type=? OR source_type=?)${where}`, { replacements: [type, sourceType, ...values] });
    const [rows] = await req.orgDb.query(`SELECT * FROM qc_inspections WHERE (inspection_type=? OR source_type=?)${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, { replacements: [type, sourceType, ...values, limit, (current-1)*limit] });
    return ok(res, rows, 'Inspections fetched', { page: current, limit, total: Number(count.total || 0) });
  }));
  router.post(`/quality/${path}`, ...secure('quality', 'can_create'), asyncHandler(async (req, res) => {
    const quantity = Number(req.body.inspected_qty); if (!req.body.reference_id || !req.body.item_id || !Number.isFinite(quantity) || quantity <= 0) throw Object.assign(new Error('reference_id, item_id and positive inspected_qty are required'), { status: 400, code: 'VALIDATION_ERROR' });
    const accepted = Number(req.body.accepted_qty || 0), rejected = Math.max(0, quantity-accepted), id = require('uuid').v4(), number = req.body.inspection_number || `QC-${Date.now()}-${id.slice(0,6)}`;
    await req.orgDb.query('INSERT INTO qc_inspections(id,inspection_number,inspection_type,source_type,source_id,reference_id,item_id,inspected_qty,accepted_qty,rejected_qty,overall_result,result,status,notes,inspected_by,inspected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', { replacements: [id,number,type,sourceType,req.body.reference_id,req.body.reference_id,req.body.item_id,quantity,accepted,rejected,req.body.overall_result||null,req.body.overall_result||null,'pending',req.body.notes||null,req.user?.sub||null,new Date()] });
    return created(res, { id, inspection_number:number, inspection_type:type, source_type:sourceType, status:'pending' });
  }));
}
router.get('/quality/rejections', ...secure('quality', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query("SELECT * FROM qc_inspections WHERE rejected_qty>0 OR result IN ('failed','rejected','scrap') OR overall_result IN ('fail','failed','rejected') ORDER BY created_at DESC LIMIT 500"); return ok(res, rows);
}));
for (const module of ['purchase','sales','quality']) {
  router.get(`/${module}/settings`, ...secure(module, 'can_view'), asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query('SELECT setting_key,setting_value,updated_at FROM company_settings WHERE setting_key LIKE ? ORDER BY setting_key', { replacements: [moduleSettings(module).prefix] }); return ok(res, rows);
  }));
  router.post(`/${module}/settings`, ...secure(module, 'can_edit'), asyncHandler(async (req, res) => {
    if (!req.body.setting_key || req.body.setting_value === undefined) throw Object.assign(new Error('setting_key and setting_value are required'), { status: 400, code: 'VALIDATION_ERROR' });
    const rawKey = String(req.body.setting_key).replace(`${module}.`,'');
    if (!allowedSettings[module].includes(rawKey)) throw Object.assign(new Error('Unsupported module setting'), { status:400,code:'VALIDATION_ERROR' });
    const key = `${module}.${rawKey}`;
    await req.orgDb.query('INSERT INTO company_settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)', { replacements: [key, String(req.body.setting_value)] });
    return created(res, { setting_key: key, setting_value: String(req.body.setting_value) });
  }));
}
router.get('/purchase/reports', ...secure('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(`SELECT 'Purchase orders' report_type,COUNT(*) record_count,COALESCE(SUM(total_amount),0) total_amount,COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','closed') THEN total_amount ELSE 0 END),0) open_amount,'All time' period FROM purchase_orders UNION ALL SELECT 'Goods receipts',COUNT(*),0,0,'All time' FROM grn UNION ALL SELECT 'Purchase returns',COUNT(*),COALESCE(SUM(total_amount),0),0,'All time' FROM purchase_returns`); return ok(res, rows);
}));
router.get('/sales/reports', ...secure('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(`SELECT 'Sales orders' report_type,COUNT(*) record_count,COALESCE(SUM(total_amount),0) total_amount,COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','delivered') THEN total_amount ELSE 0 END),0) open_amount,'All time' period FROM sales_orders UNION ALL SELECT 'Invoices',COUNT(*),COALESCE(SUM(total_amount),0),COALESCE(SUM(balance_amount),0),'All time' FROM invoices UNION ALL SELECT 'Sales returns',COUNT(*),COALESCE(SUM(total_amount),0),0,'All time' FROM sales_returns`); return ok(res, rows);
}));
router.get('/sales/receivables', ...secure('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query('SELECT i.*,c.company_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.balance_amount>0 ORDER BY i.invoice_date DESC LIMIT 500'); return ok(res, rows);
}));
router.get('/quality/reports', ...secure('quality', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(`SELECT COALESCE(inspection_type,source_type,'Unclassified') report_type,COUNT(*) record_count,SUM(CASE WHEN COALESCE(result,overall_result) IN ('pass','passed','accepted') THEN 1 ELSE 0 END) passed,SUM(CASE WHEN COALESCE(result,overall_result) IN ('fail','failed','rejected') THEN 1 ELSE 0 END) failed,(SELECT COUNT(*) FROM quality_ncrs WHERE status<>'closed') open_actions,'All time' period FROM qc_inspections GROUP BY COALESCE(inspection_type,source_type,'Unclassified')`); return ok(res, rows);
}));
router.get('/purchase/reports/export.xlsx', ...secure('purchase', 'can_view'), asyncHandler(async (req,res) => { const [rows]=await req.orgDb.query("SELECT po.po_number,v.company_name,po.status,po.total_amount,po.created_at FROM purchase_orders po LEFT JOIN vendors v ON v.id=po.vendor_id ORDER BY po.created_at DESC LIMIT 10000"); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition','attachment; filename="purchase-report.xlsx"').send(await excel(rows,'Purchase report')); }));
router.get('/sales/reports/export.xlsx', ...secure('sales', 'can_view'), asyncHandler(async (req,res) => { const [rows]=await req.orgDb.query("SELECT i.invoice_number,c.company_name,i.invoice_date,i.status,i.total_amount,i.balance_amount FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id ORDER BY i.invoice_date DESC LIMIT 10000"); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition','attachment; filename="sales-report.xlsx"').send(await excel(rows,'Sales report')); }));
router.get('/quality/reports/export.xlsx', ...secure('quality', 'can_view'), asyncHandler(async (req,res) => { const [rows]=await req.orgDb.query("SELECT inspection_number,inspection_type,source_type,source_id,item_id,inspected_qty,accepted_qty,rejected_qty,status,result,created_at FROM qc_inspections ORDER BY created_at DESC LIMIT 10000"); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition','attachment; filename="quality-report.xlsx"').send(await excel(rows,'Quality report')); }));

router.post('/quality/ncrs', ...secure('quality', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createNcr(req, req.body))));
router.post('/quality/inspections/:id/disposition', ...secure('quality', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.disposeInspection(req, { ...req.body, inspection_id: req.params.id }))));
router.post('/payroll/:id/finalize', ...secure('payroll', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.finalizePayroll(req, req.params.id))));
router.post('/payroll/components', ...secure('payroll', 'can_create'), asyncHandler(async (req, res) => created(res, await service.savePayrollComponent(req, req.body))));
router.post('/payroll/overtime', ...secure('payroll', 'can_edit'), asyncHandler(async (req, res) => created(res, await service.recordPayrollOvertime(req, req.body))));
router.post('/payroll/:id/calculate', ...secure('payroll', 'can_edit'), asyncHandler(async (req, res) => ok(res, await service.calculatePayroll(req, req.params.id))));
router.post('/payroll/:id/review', ...secure('payroll', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionPayroll(req, req.params.id, 'review'))));
router.post('/payroll/:id/approve', ...secure('payroll', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionPayroll(req, req.params.id, 'approve'))));
router.post('/payroll/:id/lock', ...secure('payroll', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionPayroll(req, req.params.id, 'lock'))));
router.post('/payroll/:id/post-to-finance', ...secure('payroll', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.postPayrollToFinance(req, req.params.id, req.body))));
router.get('/payroll/:runId/payslips/:employeeId', ...secure('payroll', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.getPayslip(req, req.params.runId, req.params.employeeId))));
router.post('/finance/accounts', ...secure('finance', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createAccount(req, req.body))));
router.post('/finance/journals/:id/submit', ...secure('finance', 'can_edit'), asyncHandler(async (req, res) => ok(res, await service.submitJournal(req, req.params.id, 'submit'))));
router.post('/finance/journals/:id/approve', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.submitJournal(req, req.params.id, 'approve'))));
router.post('/finance/journals/:id/post', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.submitJournal(req, req.params.id, 'post'))));
router.get('/finance/statements/:type', ...secure('finance', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.financialStatement(req, req.params.type, req.query))));
for (const [path, type] of [['/finance/gl', 'gl'], ['/finance/trial-balance', 'trial_balance'], ['/finance/p&l', 'profit_loss'], ['/finance/balance-sheet', 'balance_sheet'], ['/finance/ar-ageing', 'ar_ageing'], ['/finance/ap-ageing', 'ap_ageing']]) {
  router.get(path, ...secure('finance', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.financialStatement(req, type, req.query))));
}
router.post('/finance/periods/:periodKey/close', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.closePeriod(req, req.params.periodKey))));
router.post('/finance/journals/:id/reverse', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.reverseJournal(req, req.params.id))));
router.post('/finance/documents', ...secure('finance', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createFinanceDocument(req, req.body))));
router.post('/purchase/vendor-invoices', ...secure('purchase', 'can_create'), asyncHandler(async (req, res) => {
  return created(res, await service.createFinanceDocument(req, { ...req.body, document_type: 'payable' }));
}));
router.post('/finance/expenses/:id/approve', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionExpense(req, req.params.id, 'approve'))));
router.post('/finance/expenses/:id/reject', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionExpense(req, req.params.id, 'reject'))));
router.post('/finance/expenses/:id/post', ...secure('finance', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionExpense(req, req.params.id, 'post'))));
router.post('/finance/payables/:id/pay', ...secure('finance', 'can_edit'), asyncHandler(async (req, res) => ok(res, await service.recordVendorPayment(req, req.params.id, req.body))));
router.post('/finance/bank', ...secure('finance', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createBankTransaction(req, req.body))));
router.post('/finance/bank/:id/reconcile', ...secure('finance', 'can_edit'), asyncHandler(async (req, res) => ok(res, await service.reconcileBank(req, req.params.id))));
router.post('/gst/calculate', ...secure('gst', 'can_view'), asyncHandler(async (req, res) => ok(res, service.calculateGSTAuthoritative(req.body.items, req.org.state, req.body.customer_state))));
router.post('/gst/:type/:sourceId', ...secure('gst', 'can_create'), asyncHandler(async (req, res) => {
  const payload = service.integrationBoundary(req.params.type, req.params.sourceId, req.body);
  const [existing] = await req.orgDb.query('SELECT id,document_type,source_id,status,request_payload,response_payload,external_reference,last_error FROM government_documents WHERE document_type=? AND source_id=?', { replacements: [payload.document_type, payload.source_id] });
  if (existing[0]) return ok(res, { ...existing[0], already_queued: true });
  await req.orgDb.query('INSERT INTO government_documents(id,document_type,source_id,status,request_payload) VALUES(?,?,?,?,?)', { replacements: [require('uuid').v4(), payload.document_type, payload.source_id, payload.status, JSON.stringify(payload.request_payload)] });
  return created(res, payload);
}));
router.post('/gst/snapshots', ...secure('gst', 'can_create'), asyncHandler(async (req, res) => created(res, await service.gstSnapshot(req, req.body))));
router.post('/quality/specifications', ...secure('quality', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createQualitySpecification(req, req.body))));
router.post('/quality/parameters', ...secure('quality', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createQualityParameter(req, req.body))));
router.post('/quality/sampling-plans', ...secure('quality', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createQualitySamplingPlan(req, req.body))));
router.post('/quality/acceptance-criteria', ...secure('quality', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createQualityAcceptanceCriteria(req, req.body))));
router.post('/quality/inspections/:id/snapshots', ...secure('quality', 'can_view'), asyncHandler(async (req, res) => created(res, await service.createInspectionSnapshot(req, req.params.id, req.body.payload || req.body))));
router.post('/quality/ncrs/:id/transition', ...secure('quality', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.transitionNcr(req, req.params.id, req.body))));
router.post('/hr/departments', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createDepartment(req, req.body))));
router.post('/hr/designations', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createHrMaster(req, 'designation', req.body))));
router.post('/hr/employment-types', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createHrMaster(req, 'employment_type', req.body))));
router.post('/hr/document-types', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createHrMaster(req, 'document_type', req.body))));
router.post('/hr/locations', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createLocation(req, req.body))));
router.post('/hr/grades', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createGrade(req, req.body))));
router.post('/hr/shifts', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createShift(req, req.body))));
router.post('/hr/calendars', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createCalendar(req, req.body))));
router.post('/hr/attendance/corrections', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createAttendanceCorrection(req, req.body))));
router.post('/hr/attendance/corrections/:id/approve', ...secure('hr', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.approveAttendanceCorrection(req, req.params.id, req.body))));
router.get('/hr/employees/:id/360', ...secure('hr', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.getEmployee360(req, req.params.id))));
router.post('/hr/leave/policies', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createLeavePolicy(req, req.body))));
router.post('/hr/leave/accrual-rules', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createLeaveAccrualRule(req, req.body))));
router.post('/hr/leave/holidays', ...secure('hr', 'can_create'), asyncHandler(async (req, res) => created(res, await service.createHoliday(req, req.body))));
router.post('/hr/leave/validate', ...secure('hr', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.validateLeaveRequest(req, req.body))));
router.post('/hr/leave/:id/approve', ...secure('hr', 'can_approve'), asyncHandler(async (req, res) => ok(res, await service.approveLeaveRequest(req, req.params.id, req.body))));
router.post('/hr/leave/balance-transactions', ...secure('hr', 'can_edit'), asyncHandler(async (req, res) => created(res, await service.recordLeaveBalanceTransaction(req, req.body))));
router.get('/reports/analytics/:key', ...secure('reports', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.report(req, req.params.key, req.query))));
module.exports = router;
