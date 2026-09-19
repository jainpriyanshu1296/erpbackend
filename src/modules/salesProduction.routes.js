const express = require('express');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, created, fail, asyncHandler } = require('../utils/response');
const { v4: uuid } = require('uuid');
const { transition, dispatch, completeWorkOrder, issueMaterials, transitionJobCard } = require('../services/salesProduction.service');

const sales = express.Router();
sales.use(auth, orgContext, entitlement, moduleGuard('sales'));
sales.get('/customers', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const search = String(req.query.search || '').trim();
  const where = search ? ' WHERE company_name LIKE ? OR customer_code LIKE ? OR email LIKE ?' : '';
  const replacements = search ? [`%${search}%`, `%${search}%`, `%${search}%`, limit, offset] : [limit, offset];
  const [[count]] = await req.orgDb.query(`SELECT COUNT(*) AS total FROM customers${where}`, { replacements: search ? replacements.slice(0, 3) : [] });
  const [rows] = await req.orgDb.query(`SELECT id,customer_code,company_name,contact_person,phone,email,gstin,state,is_active,created_at FROM customers${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, { replacements });
  return ok(res, rows, 'Customers fetched', { limit, offset, total: Number(count.total || 0) });
}));
sales.get('/customers/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query('SELECT * FROM customers WHERE id=? LIMIT 1', { replacements: [req.params.id] });
  if (!rows.length) return fail(res, 404, 'NOT_FOUND', 'Customer not found');
  return ok(res, rows[0]);
}));
sales.get('/customers/:id/360', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const [[customer]] = await req.orgDb.query('SELECT * FROM customers WHERE id=? LIMIT 1', { replacements: [id] });
  if (!customer) return fail(res, 404, 'NOT_FOUND', 'Customer not found');
  const [[summary]] = await req.orgDb.query(`SELECT
    (SELECT COUNT(*) FROM quotations WHERE customer_id=?) quotations,
    (SELECT COUNT(*) FROM sales_orders WHERE customer_id=?) orders,
    (SELECT COUNT(*) FROM invoices WHERE customer_id=?) invoices,
    (SELECT COALESCE(SUM(total_amount),0) FROM invoices WHERE customer_id=?) invoiced_amount,
    (SELECT COALESCE(SUM(balance_amount),0) FROM invoices WHERE customer_id=?) outstanding_amount`, { replacements: [id, id, id, id, id] });
  const [timeline] = await req.orgDb.query(`SELECT created_at,event_type,reference_id,description FROM (
    SELECT created_at,'quotation' event_type,id reference_id,CONCAT('Quotation ',status) description FROM quotations WHERE customer_id=?
    UNION ALL SELECT created_at,'sales_order',id,CONCAT('Sales order ',status) FROM sales_orders WHERE customer_id=?
    UNION ALL SELECT created_at,'invoice',id,CONCAT('Invoice ',status) FROM invoices WHERE customer_id=?
  ) events ORDER BY created_at DESC LIMIT 100`, { replacements: [id, id, id] });
  return ok(res, { customer, summary, timeline });
}));
sales.post('/customers', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { company_name } = req.body;
  if (!company_name) return fail(res, 400, 'VALIDATION_ERROR', 'company_name is required');
  const id = req.body.id || uuid();
  await req.orgDb.query('INSERT INTO customers(id,customer_code,company_name,contact_person,phone,email,gstin,state,address,payment_terms) VALUES(?,?,?,?,?,?,?,?,?,?)', { replacements: [id, req.body.customer_code || null, company_name, req.body.contact_person || null, req.body.phone || null, req.body.email || null, req.body.gstin || null, req.body.state || null, req.body.address || null, req.body.payment_terms || 30] });
  return created(res, { id, company_name });
}));
for (const [path, table] of [['quotations', 'quotations'], ['orders', 'sales_orders'], ['invoices', 'invoices']]) {
  sales.put(`/${path}/:id/status`, permission('sales', 'can_edit'), asyncHandler(async (req, res) => ok(res, await transition(req.orgDb, table, req.params.id, req.body.status, req.user.sub), 'Status updated')));
}
sales.put('/challans/:id/dispatch', permission('sales', 'can_edit'), asyncHandler(async (req, res) => ok(res, await dispatch(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub), 'Dispatch posted')));

const production = express.Router();
production.use(auth, orgContext, entitlement, moduleGuard('production'));
production.post('/orders', permission('production', 'can_create'), asyncHandler(async (req, res) => {
  const { bom_id: bomId, item_id: itemId, planned_qty: plannedQty, sales_order_id: salesOrderId } = req.body;
  if (!bomId || !itemId || !Number.isFinite(Number(plannedQty)) || Number(plannedQty) <= 0) return fail(res, 400, 'VALIDATION_ERROR', 'bom_id, item_id and a positive planned_qty are required');
  const id = uuid();
  await req.orgDb.query('INSERT INTO production_orders(id,production_number,sales_order_id,bom_id,item_id,planned_qty,status,created_by) VALUES(?,?,?,?,?,?,?,?)', { replacements: [id, req.body.production_number || null, salesOrderId || null, bomId, itemId, Number(plannedQty), 'draft', req.user.sub] });
  return created(res, { id, bom_id: bomId, item_id: itemId, planned_qty: Number(plannedQty), status: 'draft' });
}));
production.get('/orders/:id', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const [[order]] = await req.orgDb.query('SELECT * FROM production_orders WHERE id=?', { replacements: [req.params.id] });
  if (!order) return fail(res, 404, 'NOT_FOUND', 'Production order not found');
  const [cards] = await req.orgDb.query('SELECT * FROM job_cards WHERE production_order_id=? ORDER BY created_at', { replacements: [req.params.id] });
  return ok(res, { ...order, job_cards: cards });
}));
production.put('/bom/:id/status', permission('production', 'can_edit'), asyncHandler(async (req, res) => ok(res, await transition(req.orgDb, 'bom', req.params.id, req.body.status, req.user.sub), 'BOM status updated')));
production.put('/work-orders/:id/status', permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  if (req.body.status === 'completed') return ok(res, await completeWorkOrder(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub), 'Work order completed');
  return ok(res, await transition(req.orgDb, 'work_orders', req.params.id, req.body.status, req.user.sub), 'Work order status updated');
}));
production.post('/work-orders/:id/material-issue', permission('production', 'can_edit'), asyncHandler(async (req, res) => ok(res, await issueMaterials(req.orgDb, req.params.id, req.body.warehouse_id, req.user.sub, req.body.issue_key), 'Materials issued')));
production.put('/job-cards/:id/status', permission('production', 'can_edit'), asyncHandler(async (req, res) => ok(res, await transitionJobCard(req.orgDb, req.params.id, req.body.status, req.user.sub), 'Job card status updated')));
production.post('/mrp/calculate', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const demand = Number(req.body.demand || 0), onHand = Number(req.body.on_hand || 0), scheduled = Number(req.body.scheduled || 0), safety = Number(req.body.safety_stock || 0);
  if (![demand, onHand, scheduled, safety].every(Number.isFinite) || [demand, onHand, scheduled, safety].some(v => v < 0)) return fail(res, 400, 'VALIDATION_ERROR', 'MRP quantities must be non-negative numbers');
  return ok(res, { planned_quantity: Math.max(0, demand + safety - onHand - scheduled) });
}));
production.get('/dashboard', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const [[orders]] = await req.orgDb.query('SELECT COUNT(*) total FROM work_orders');
  const [[open]] = await req.orgDb.query("SELECT COUNT(*) total FROM work_orders WHERE status IN ('released','in_progress')");
  const [[cards]] = await req.orgDb.query("SELECT COUNT(*) total FROM job_cards WHERE status NOT IN ('completed','cancelled')");
  return ok(res, { work_orders: Number(orders.total || 0), open_work_orders: Number(open.total || 0), open_job_cards: Number(cards.total || 0) });
}));

module.exports = { sales, production };
