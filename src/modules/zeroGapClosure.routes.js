const express = require('express');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, fail, asyncHandler } = require('../utils/response');
const service = require('../services/zeroGapClosure.service');
const { v4: uuid } = require('uuid');

const router = express.Router();
router.use(auth, orgContext, entitlement);
const resources = {
  'approvals': ['approval', ['entity_type','entity_id','requested_by','reason'], 'settings'],
  'rfq/suppliers': ['rfqSupplier', ['rfq_id','supplier_id','status'], 'purchase'],
  'rfq/quotation-lines': ['quotationLine', ['rfq_supplier_id','item_id','quantity','unit_price','tax_rate','delivery_days','is_selected'], 'purchase'],
  'purchase-returns': ['purchaseReturn', ['return_number','supplier_id','purchase_invoice_id','warehouse_id','status','total_amount'], 'purchase'],
  'purchase-returns/lines': ['purchaseReturnLine', ['return_id','item_id','quantity','unit_price','batch_id','serial_id'], 'purchase'],
  'batches': ['batch', ['item_id','batch_no','expiry_date','quantity','warehouse_id'], 'inventory'],
  'serials': ['serial', ['item_id','serial_no','status','warehouse_id'], 'inventory'],
  'physical-counts': ['count', ['count_number','warehouse_id','status'], 'inventory'],
  'physical-counts/lines': ['countLine', ['count_id','item_id','system_qty','counted_qty'], 'inventory'],
  'warehouse-locations': ['location', ['warehouse_id','code','name','parent_id','is_active'], 'inventory'],
  'imports': ['importJob', ['entity_type','source_name','status','total_rows','processed_rows','error_json','payload_json'], 'inventory'],
  'exports': ['exportJob', ['entity_type','filter_json','status','result_json'], 'reports'],
  'sales-enquiries': ['enquiry', ['enquiry_number','customer_id','status','expected_date','notes'], 'sales'],
  'payment-allocations': ['allocation', ['payment_id','invoice_id','allocated_amount'], 'sales'],
  'sales-returns': ['salesReturn', ['return_number','sales_order_id','customer_id','warehouse_id','status','total_amount'], 'sales'],
  'credit-notes': ['creditNote', ['note_number','sales_return_id','customer_id','invoice_id','amount','status'], 'sales'],
  'production-outputs': ['output', ['production_order_id','item_id','quantity','batch_id','warehouse_id'], 'production'],
  'production-downtime': ['downtime', ['production_order_id','minutes','reason'], 'production'],
  'production-scrap': ['scrap', ['production_order_id','item_id','quantity','reason','warehouse_id'], 'production'],
  'related-documents': ['related', ['source_type','source_id','target_type','target_id','relation'], 'dashboard']
};
function bodyFor(keys, body) {
  const data = {}; for (const key of keys) if (body[key] !== undefined) data[key] = body[key];
  return data;
}
function routeFor(path, method) { return `/closure/${path}`; }

const resourceByPath = Object.fromEntries(Object.entries(resources).map(([path, [table, , module]]) => [path, { table, module }]));

router.get('/closure/:resource', asyncHandler(async (req, res, next) => {
  const definition = resourceByPath[req.params.resource];
  if (!definition) return next();
  await moduleGuard(definition.module)(req, res, async () => {
    await permission(definition.module, 'can_view')(req, res, async () => {
      const [rows] = await req.orgDb.query(`SELECT * FROM ${service.TABLES[definition.table]} ORDER BY created_at DESC LIMIT 200`);
      return ok(res, rows);
    });
  });
}));

for (const [path, [table, keys, module]] of Object.entries(resources)) {
  router.post(routeFor(path), moduleGuard(module), permission(module, 'can_create'), asyncHandler(async (req, res) => {
    const data = bodyFor(keys, req.body);
    const required = table === 'approval' ? ['entity_type','entity_id'] : [];
    for (const key of required) if (!data[key]) return fail(res, 400, 'VALIDATION_ERROR', `${key} is required`);
    if (table === 'allocation') {
      return created(res, await service.allocatePayment(req.orgDb, data.payment_id, data.invoice_id, data.allocated_amount, req.user?.sub));
    }
    const result = await service.write(req.orgDb, table, data, req.user?.sub, req.get('Idempotency-Key'));
    return created(res, result);
  }));
}

router.patch('/closure/:resource/:id/status', asyncHandler(async (req, res, next) => {
  const definition = resourceByPath[req.params.resource];
  if (!definition) return next();
  if (!['approval', 'count', 'purchaseReturn', 'salesReturn', 'creditNote'].includes(definition.table)) {
    return fail(res, 400, 'UNSUPPORTED_OPERATION', 'Status transitions are not supported for this resource');
  }
  await moduleGuard(definition.module)(req, res, async () => {
    await permission(definition.module, 'can_edit')(req, res, async () => {
      return ok(res, await service.transition(req.orgDb, definition.table, req.params.id, req.body.status, req.user?.sub), 'Status updated');
    });
  });
}));

router.post('/closure/approvals/:id/decision', moduleGuard('settings'), permission('settings', 'can_approve'), asyncHandler(async (req, res) => {
  const action = req.body.action === 'approve' ? 'approved' : 'rejected';
  return ok(res, await service.actOnApproval(req.orgDb, req.params.id, action, req.user?.sub, req.user?.role, req.body.notes), 'Approval decision recorded');
}));
router.post('/closure/purchase-returns/:id/post', moduleGuard('purchase'), permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.postReturn(req.orgDb, 'purchase', req.params.id, req.user?.sub, req.body.warehouse_id), 'Purchase return posted');
}));
router.post('/closure/sales-returns/:id/post', moduleGuard('sales'), permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.postReturn(req.orgDb, 'sales', req.params.id, req.user?.sub, req.body.warehouse_id), 'Sales return posted');
}));
router.post('/closure/credit-notes/:id/issue', moduleGuard('sales'), permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.issueCreditNote(req.orgDb, req.params.id, req.user?.sub), 'Credit note issued');
}));
router.post('/closure/payment-allocations', moduleGuard('sales'), permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  return created(res, await service.allocatePayment(req.orgDb, req.body.payment_id, req.body.invoice_id, req.body.allocated_amount, req.user?.sub));
}));
router.post('/closure/physical-counts/:id/post', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.postPhysicalCount(req.orgDb, req.params.id, req.user?.sub), 'Physical count posted');
}));
router.post('/closure/production-outputs/:id/post', moduleGuard('production'), permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.postProductionEffect(req.orgDb, 'output', req.params.id, req.user?.sub, req.body.warehouse_id), 'Production output posted');
}));
router.post('/closure/production-scrap/:id/post', moduleGuard('production'), permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.postProductionEffect(req.orgDb, 'scrap', req.params.id, req.user?.sub, req.body.warehouse_id), 'Production scrap posted');
}));
router.post('/closure/imports/:id/process', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.processImport(req.orgDb, req.params.id, req.user?.sub), 'Import processed');
}));
router.post('/closure/exports/:id/run', moduleGuard('reports'), permission('reports', 'can_view'), asyncHandler(async (req, res) => {
  return ok(res, await service.processExport(req.orgDb, req.params.id, req.user?.sub), 'Export generated');
}));

router.patch('/closure/approvals/:id', moduleGuard('settings'), permission('settings', 'can_approve'), asyncHandler(async (req, res) => {
  return ok(res, await service.transition(req.orgDb, 'approval', req.params.id, req.body.status, req.user?.sub), 'Approval updated');
}));
router.patch('/closure/physical-counts/:id', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.transition(req.orgDb, 'count', req.params.id, req.body.status, req.user?.sub), 'Physical count updated');
}));
router.patch('/closure/purchase-returns/:id', moduleGuard('purchase'), permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.transition(req.orgDb, 'purchaseReturn', req.params.id, req.body.status, req.user?.sub), 'Purchase return updated');
}));
router.post('/closure/purchase-returns/:id/match', moduleGuard('purchase'), permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.matchPurchaseReturn(req.orgDb, req.params.id, req.body.purchase_invoice_id, req.user?.sub), 'Purchase return matched');
}));
router.patch('/closure/sales-returns/:id', moduleGuard('sales'), permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.transition(req.orgDb, 'salesReturn', req.params.id, req.body.status, req.user?.sub), 'Sales return updated');
}));
router.patch('/closure/credit-notes/:id', moduleGuard('sales'), permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.transition(req.orgDb, 'creditNote', req.params.id, req.body.status, req.user?.sub), 'Credit note updated');
}));
router.get('/closure/rfq/:id/comparison', moduleGuard('purchase'), permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  return ok(res, await service.compareQuotations(req.orgDb, req.params.id));
}));
router.get('/closure/:resource/:id/related-documents', permission('dashboard', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(
    'SELECT * FROM related_documents WHERE (source_type=? AND source_id=?) OR (target_type=? AND target_id=?) ORDER BY created_at DESC',
    { replacements: [req.params.resource, req.params.id, req.params.resource, req.params.id] }
  );
  return ok(res, rows);
}));
router.post('/closure/:resource/:id/:action', asyncHandler(async (req, res, next) => {
  if (!['approve', 'reject'].includes(req.params.action)) return next();
  const definition = resourceByPath[req.params.resource];
  if (!definition || !['approval', 'count', 'purchaseReturn', 'salesReturn', 'creditNote'].includes(definition.table)) return next();
  await moduleGuard(definition.module)(req, res, async () => {
    await permission(definition.module, 'can_edit')(req, res, async () => {
      const status = req.params.action === 'approve'
        ? (definition.table === 'creditNote' ? 'issued' : definition.table === 'approval' ? 'approved' : 'posted')
        : 'cancelled';
      return ok(res, await service.transition(req.orgDb, definition.table, req.params.id, status, req.user?.sub), 'Workflow updated');
    });
  });
}));
router.post('/closure/rfq/quotation-lines/:id/select', moduleGuard('purchase'), permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  return ok(res, await service.selectQuotation(req.orgDb, req.params.id, req.user?.sub), 'Quotation selected');
}));

router.get('/closure/:resource/:id/timeline', permission('dashboard', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(
    'SELECT * FROM audit_events WHERE entity_type=? AND entity_id=? ORDER BY created_at ASC',
    { replacements: [req.params.resource.replace(/-/g, '_'), req.params.id] }
  );
  return ok(res, rows);
}));
router.post('/closure/approvals/:id/steps', moduleGuard('settings'), permission('settings', 'can_approve'), asyncHandler(async (req, res) => {
  const { step_no, approver_role } = req.body;
  if (!Number.isInteger(Number(step_no)) || !approver_role) return fail(res, 400, 'VALIDATION_ERROR', 'step_no and approver_role are required');
  const tx = await req.orgDb.transaction();
  try {
    const id = uuid();
    await req.orgDb.query('INSERT INTO approval_steps(id,approval_id,step_no,approver_role) VALUES(?,?,?,?)', { replacements: [id, req.params.id, step_no, approver_role], transaction: tx });
    await service.audit(req.orgDb, req.user?.sub, 'step.created', 'approval', req.params.id, { step_no, approver_role }, tx);
    await tx.commit(); return created(res, { id, approval_id: req.params.id, step_no, approver_role });
  } catch (e) { await tx.rollback(); throw e; }
}));

module.exports = router;
