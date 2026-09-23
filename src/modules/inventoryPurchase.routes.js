const express = require('express');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const service = require('./inventoryPurchase.service');

const router = express.Router();
router.use(auth, orgContext, entitlement);
router.post('/purchase/requisitions/:id/rfq',moduleGuard('purchase'),permission('purchase','can_create'),asyncHandler(async(req,res)=>created(res,await service.rfqFromRequisition(req.orgDb,req.params.id,req.user.sub))));
router.post('/purchase/rfqs/:id/order',moduleGuard('purchase'),permission('purchase','can_create'),asyncHandler(async(req,res)=>created(res,await service.orderFromRfq(req.orgDb,req.params.id,req.body.vendor_id,req.body.warehouse_id,req.user.sub))));
const listRoute = (path, table, module) => {
  router.get(path, moduleGuard(module), permission(module, 'can_view'), asyncHandler(async (req, res) => {
    const result = await service.list(req.orgDb, table, req.query);
    return ok(res, result.rows, 'Fetched successfully', result.meta);
  }));
  router.get(`${path}/:id`, moduleGuard(module), permission(module, 'can_view'), asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(`SELECT * FROM ${table} WHERE id=? LIMIT 1`, { replacements: [req.params.id] });
    return rows[0] ? ok(res, rows[0]) : fail(res, 404, 'NOT_FOUND', 'Record not found');
  }));
};
// Item Master is deliberately served by the validated implementation in app.js.
// Do not add a generic list route here: this router is mounted after the
// protected router and would otherwise leave two competing definitions.
['purchase_requisitions', 'purchase_orders', 'grn'].forEach((table) => {
  const path = table === 'purchase_requisitions' ? '/purchase/requisitions' : table === 'purchase_orders' ? '/purchase/orders' : '/purchase/grn';
  if (table === 'grn') listRoute(path, table, 'purchase');
  router.put(`${path}/:id/status`, moduleGuard('purchase'), (req,res,next) => permission('purchase', ['approved','rejected'].includes(req.body?.status) ? 'can_approve' : 'can_edit')(req,res,next), asyncHandler(async (req, res) => {
    const result = await service.transition(req.orgDb, table, req.params.id, req.body?.status, req.user?.sub);
    if (result.error === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Record not found');
    if (result.error) return fail(res, 409, result.error, `Invalid status transition from ${result.current}`);
    return ok(res, result, 'Status updated');
  }));
});
router.get('/vendors/:vendorId/items', moduleGuard('purchase'), permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(
    'SELECT vi.*, i.item_code, i.item_name FROM vendor_items vi INNER JOIN item_master i ON i.id=vi.item_id WHERE vi.vendor_id=? ORDER BY i.item_name',
    { replacements: [req.params.vendorId] }
  );
  return ok(res, rows);
}));
router.post('/vendors/:vendorId/items', moduleGuard('purchase'), permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  if (!req.body?.item_id) return fail(res, 400, 'VALIDATION_ERROR', 'item_id is required');
  await req.orgDb.query(
    `INSERT INTO vendor_items(vendor_id,item_id,vendor_item_code,preferred,last_rate)
     VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE vendor_item_code=VALUES(vendor_item_code),preferred=VALUES(preferred),last_rate=VALUES(last_rate)`,
    { replacements: [req.params.vendorId, req.body.item_id, req.body.vendor_item_code || null, req.body.preferred ? 1 : 0, req.body.last_rate || 0] }
  );
  return ok(res, { vendor_id: req.params.vendorId, item_id: req.body.item_id }, 'Vendor item saved');
}));
const operationalResources = [
  ['/inventory/reservations', 'stock_reservations', 'inventory'],
  ['/purchase/rfqs', 'rfqs', 'purchase'],
  ['/purchase/supplier-quotations', 'supplier_quotations', 'purchase']
];
for (const [path, table, module] of operationalResources) {
  router.get(path, moduleGuard(module), permission(module, 'can_view'), asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = search ? ' WHERE CAST(id AS CHAR) LIKE ? OR status LIKE ?' : '';
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(`SELECT COUNT(*) AS total FROM ${table}${where}`, { replacements: values });
    const [rows] = await req.orgDb.query(`SELECT * FROM ${table}${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, { replacements: [...values, limit, offset] });
    return ok(res, rows, 'Records fetched', { page, limit, total: Number(count.total || 0) });
  }));
  router.get(`${path}/:id`, moduleGuard(module), permission(module, 'can_view'), asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(`SELECT * FROM ${table} WHERE id=? LIMIT 1`, { replacements: [req.params.id] });
    return rows[0] ? ok(res, rows[0]) : fail(res, 404, 'NOT_FOUND', 'Record not found');
  }));
}

router.post('/purchase/rfqs', moduleGuard('purchase'), permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  if (!req.body?.rfq_number) return fail(res, 400, 'VALIDATION_ERROR', 'rfq_number is required');
  const id = req.body.id || require('uuid').v4();
  await req.orgDb.query('INSERT INTO rfqs(id,rfq_number,requested_by) VALUES(?,?,?)', { replacements: [id, req.body.rfq_number, req.user.sub] });
  return created(res, { id, rfq_number: req.body.rfq_number, status: 'draft' });
}));

router.post('/purchase/supplier-quotations', moduleGuard('purchase'), permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { quotation_number: quotationNumber, rfq_id: rfqId, vendor_id: vendorId } = req.body || {};
  if (!quotationNumber || !rfqId || !vendorId) return fail(res, 400, 'VALIDATION_ERROR', 'quotation_number, rfq_id and vendor_id are required');
  const id = req.body.id || require('uuid').v4();
  await req.orgDb.query('INSERT INTO supplier_quotations(id,quotation_number,rfq_id,vendor_id,total_amount) VALUES(?,?,?,?,?)', { replacements: [id, quotationNumber, rfqId, vendorId, Number(req.body.total_amount || 0)] });
  return created(res, { id, quotation_number: quotationNumber, rfq_id: rfqId, vendor_id: vendorId, status: 'draft' });
}));

router.put('/inventory/transfers/:id/status', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await service.transitionTransfer(req.orgDb, req.params.id, req.body?.status, req.user?.sub);
  if (result.error === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
  if (result.error) return fail(res, 409, result.error, `Invalid status transition from ${result.current}`);
  return ok(res, result, 'Transfer status updated');
}));
router.post('/inventory/transfers/:id/receive', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await service.receiveTransfer(req.orgDb, req.params.id, req.user?.sub);
  if (result.error === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
  if (result.error) return fail(res, 409, result.error, result.current ? `Invalid status transition from ${result.current}` : 'Unable to receive transfer');
  return ok(res, result, result.alreadyReceived ? 'Transfer was already received' : 'Transfer received');
}));
router.post('/inventory/reservations', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await service.reserveStock(req.orgDb, req.body || {}, req.user?.sub);
  if (result.error) return fail(res, 409, result.error, 'Unable to reserve stock');
  return ok(res, result, 'Stock reserved');
}));
router.put('/inventory/reservations/:id/:action', moduleGuard('inventory'), permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await service.changeReservation(req.orgDb, req.params.id, req.params.action, req.user?.sub);
  if (result.error === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'Reservation not found');
  if (result.error) return fail(res, 409, result.error, 'Unable to change reservation');
  return ok(res, result, 'Reservation updated');
}));
router.put('/purchase/rfqs/:id/status', moduleGuard('purchase'), permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const result = await service.transitionRfq(req.orgDb, req.params.id, req.body?.status, req.user?.sub);
  if (result.error === 'NOT_FOUND') return fail(res, 404, 'NOT_FOUND', 'RFQ not found');
  if (result.error) return fail(res, 409, result.error, `Invalid status transition from ${result.current}`);
  return ok(res, result, 'RFQ status updated');
}));
router.get('/inventory/reorder-suggestions', moduleGuard('inventory'), permission('inventory', 'can_view'), asyncHandler(async (req, res) => ok(res, await service.reorderSuggestions(req.orgDb))));
router.get('/inventory/dashboard', moduleGuard('inventory'), permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const [[stock], [transfers], [reservations], [counts]] = await Promise.all([
    req.orgDb.query('SELECT COUNT(*) AS item_locations, COALESCE(SUM(current_qty),0) AS on_hand FROM stock_summary'),
    req.orgDb.query("SELECT COUNT(*) AS pending FROM warehouse_transfers WHERE status IN ('requested','approved','in_transit')"),
    req.orgDb.query("SELECT COUNT(*) AS active FROM stock_reservations WHERE status='reserved'"),
    req.orgDb.query("SELECT COUNT(*) AS open_counts FROM physical_counts WHERE status IN ('draft','open','submitted','approved')")
  ]);
  return ok(res, { stock: stock[0], transfers: transfers[0], reservations: reservations[0], counts: counts[0] });
}));
router.get('/purchase/dashboard', moduleGuard('purchase'), permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [[rfqs], [orders], [grns]] = await Promise.all([
    req.orgDb.query("SELECT COUNT(*) AS open FROM rfqs WHERE status NOT IN ('approved','cancelled')"),
    req.orgDb.query("SELECT COUNT(*) AS open FROM purchase_orders WHERE status NOT IN ('cancelled','confirmed')"),
    req.orgDb.query("SELECT COUNT(*) AS pending_grn FROM grn WHERE status='draft'")
  ]);
  return ok(res, { rfqs: rfqs[0], purchase_orders: orders[0], grn: grns[0] });
}));

module.exports = router;
