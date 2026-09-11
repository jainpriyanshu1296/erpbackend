const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, fail, asyncHandler } = require('../utils/response');
const { nextNumber } = require('../services/erp.service');
const { generateSalesXml, generatePurchaseXml, generateMastersXml } = require('../services/tally-export.service');
const permission = require('../middleware/permission');
const activity = require('../middleware/activity');

const invalid = message => Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR' });
const workflow = express.Router();
workflow.use(require('../middleware/auth').auth, require('../middleware/orgContext'), activity);

async function lines(db, table, foreignKey, id, transaction) {
  const [rows] = await db.query(`SELECT * FROM ${table} WHERE ${foreignKey}=? ORDER BY id`, { replacements: [id], transaction });
  return rows;
}

workflow.post('/purchase/requisitions/:id/submit', permission('purchase', 'can_approve'), asyncHandler(async (req, res) => {
  const [result] = await req.orgDb.query(
    "UPDATE purchase_requisitions SET status='submitted' WHERE id=? AND status IN ('pending','draft')",
    { replacements: [req.params.id] }
  );
  if (!result.affectedRows) return fail(res, 409, 'INVALID_STATE', 'Requisition is not pending');
  return ok(res, { id: req.params.id, status: 'submitted' });
}));

workflow.post('/purchase/requisitions/:id/items', permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw invalid('At least one requisition item is required');
  const tx = await req.orgDb.transaction();
  try {
    const [requisitions] = await req.orgDb.query('SELECT status FROM purchase_requisitions WHERE id=? FOR UPDATE', { replacements: [req.params.id], transaction: tx });
    if (!requisitions.length) throw Object.assign(new Error('Requisition not found'), { status: 404, code: 'NOT_FOUND' });
    if (!['draft', 'pending'].includes(requisitions[0].status)) throw Object.assign(new Error('Only draft or pending requisitions can be edited'), { status: 409, code: 'INVALID_STATE' });
    await req.orgDb.query('DELETE FROM purchase_requisition_items WHERE requisition_id=?', { replacements: [req.params.id], transaction: tx });
    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0) throw invalid('Each requisition item needs a positive quantity');
      await req.orgDb.query('INSERT INTO purchase_requisition_items(id,requisition_id,item_id,quantity,rate) VALUES(?,?,?,?,?)', {
        replacements: [uuid(), req.params.id, item.item_id, quantity, Number(item.rate || 0)], transaction: tx
      });
    }
    await tx.commit();
    return ok(res, { requisition_id: req.params.id, item_count: items.length }, 'Requisition items saved');
  } catch (error) { await tx.rollback(); throw error; }
}));

workflow.post('/purchase/orders/from-requisition', permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { requisition_id: requisitionId, vendor_id: vendorId, warehouse_id: warehouseId, items } = req.body;
  const tx = await req.orgDb.transaction();
  try {
    const [pr] = await req.orgDb.query('SELECT * FROM purchase_requisitions WHERE id=? FOR UPDATE', { replacements: [requisitionId], transaction: tx });
    if (!pr.length || !['submitted', 'approved'].includes(pr[0].status)) throw invalid('Only a submitted requisition can create an order');
    const source = items?.length ? items : await lines(req.orgDb, 'purchase_requisition_items', 'requisition_id', requisitionId, tx);
    if (!vendorId || !warehouseId || !source.length) throw invalid('vendor_id, warehouse_id and requisition items are required');
    const id = uuid(), number = await nextNumber(req.orgDb, 'purchase_order', 'PO-', 5, tx);
    let total = 0;
    await req.orgDb.query("INSERT INTO purchase_orders(id,po_number,vendor_id,warehouse_id,requisition_id,status,total_amount,created_by) VALUES(?,?,?,?,?,'draft',?,?)",
      { replacements: [id, number, vendorId, warehouseId, requisitionId, 0, req.user.sub], transaction: tx });
    for (const item of source) {
      const quantity = Number(item.quantity), rate = Number(item.rate || 0);
      if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0) throw invalid('Each order item needs a positive quantity');
      total += quantity * rate;
      await req.orgDb.query('INSERT INTO purchase_order_items(id,order_id,item_id,quantity,rate,requisition_item_id) VALUES(?,?,?,?,?,?)',
        { replacements: [uuid(), id, item.item_id, quantity, rate, item.id || null], transaction: tx });
    }
    await req.orgDb.query('UPDATE purchase_orders SET total_amount=? WHERE id=?', { replacements: [total, id], transaction: tx });
    await req.orgDb.query("UPDATE purchase_requisitions SET status='ordered' WHERE id=?", { replacements: [requisitionId], transaction: tx });
    await tx.commit();
    return ok(res, { id, po_number: number, requisition_id: requisitionId, status: 'draft', total_amount: total }, 'Purchase order created');
  } catch (error) { await tx.rollback(); throw error; }
}));

workflow.post('/purchase/orders/:id/approve', permission('purchase', 'can_approve'), asyncHandler(async (req, res) => {
  const [result] = await req.orgDb.query("UPDATE purchase_orders SET status='approved' WHERE id=? AND status='draft'", { replacements: [req.params.id] });
  if (!result.affectedRows) return fail(res, 409, 'INVALID_STATE', 'Only draft orders can be approved');
  return ok(res, { id: req.params.id, status: 'approved' });
}));

workflow.post('/purchase/grn/from-order', permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { order_id: orderId, items } = req.body;
  if (!orderId || !Array.isArray(items) || !items.length) throw invalid('order_id and GRN items are required');
  const tx = await req.orgDb.transaction();
  try {
    const [orders] = await req.orgDb.query("SELECT id,vendor_id,warehouse_id,status FROM purchase_orders WHERE id=? FOR UPDATE", { replacements: [orderId], transaction: tx });
    if (!orders.length) throw Object.assign(new Error('Purchase order not found'), { status: 404, code: 'NOT_FOUND' });
    if (!['approved', 'part_received'].includes(orders[0].status)) throw Object.assign(new Error('Only approved purchase orders can receive goods'), { status: 409, code: 'INVALID_STATE' });
    const grnId = uuid();
    const grnNumber = await nextNumber(req.orgDb, 'grn', 'GRN-', 5, tx);
    await req.orgDb.query("INSERT INTO grn(id,grn_number,po_id,vendor_id,status) VALUES(?,?,?,?, 'draft')", {
      replacements: [grnId, grnNumber, orderId, orders[0].vendor_id], transaction: tx
    });
    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!item.po_item_id || !item.item_id || !Number.isFinite(quantity) || quantity <= 0) throw invalid('Each GRN item needs po_item_id, item_id and positive quantity');
      await req.orgDb.query('INSERT INTO grn_items(id,grn_id,po_item_id,item_id,quantity,rate) VALUES(?,?,?,?,?,?)', {
        replacements: [uuid(), grnId, item.po_item_id, item.item_id, quantity, Number(item.rate || 0)], transaction: tx
      });
    }
    await tx.commit();
    return ok(res, { id: grnId, grn_number: grnNumber, po_id: orderId, status: 'draft' }, 'GRN created');
  } catch (error) { await tx.rollback(); throw error; }
}));

workflow.post('/purchase/grn/:id/post', permission('purchase', 'can_approve'), asyncHandler(async (req, res) => {
  const { warehouse_id: warehouseId, items } = req.body;
  const tx = await req.orgDb.transaction();
  try {
    const [grns] = await req.orgDb.query('SELECT g.*,p.status po_status,p.warehouse_id FROM grn g JOIN purchase_orders p ON p.id=g.po_id WHERE g.id=? FOR UPDATE', { replacements: [req.params.id], transaction: tx });
    if (!grns.length || !['approved', 'part_received'].includes(grns[0].po_status)) throw invalid('GRN must reference an approved purchase order');
    if (grns[0].status === 'posted') throw Object.assign(new Error('GRN has already been posted'), { status: 409, code: 'ALREADY_POSTED' });
    const received = items?.length ? items : await lines(req.orgDb, 'grn_items', 'grn_id', req.params.id, tx);
    if (!received.length) throw invalid('GRN items are required');
    const warehouse = warehouseId || grns[0].warehouse_id;
    if (!warehouse) throw invalid('A warehouse is required before posting the GRN');
    if (items?.length) {
      await req.orgDb.query('DELETE FROM grn_items WHERE grn_id=?', { replacements: [req.params.id], transaction: tx });
      for (const item of received) {
        await req.orgDb.query('INSERT INTO grn_items(id,grn_id,po_item_id,item_id,quantity,rate) VALUES(?,?,?,?,?,?)', {
          replacements: [uuid(), req.params.id, item.po_item_id || null, item.item_id, item.quantity, Number(item.rate || 0)], transaction: tx
        });
      }
    }
    for (const item of received) {
      const quantity = Number(item.quantity), rate = Number(item.rate || 0);
      if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0) throw invalid('Each GRN item needs a positive quantity');
      const [ordered] = await req.orgDb.query('SELECT quantity FROM purchase_order_items WHERE id=? AND order_id=? FOR UPDATE', { replacements: [item.po_item_id, grns[0].po_id], transaction: tx });
      if (!ordered.length) throw invalid(`GRN item ${item.item_id} is not part of the purchase order`);
      const [[receivedBefore]] = await req.orgDb.query(
        "SELECT COALESCE(SUM(gi.quantity),0) AS quantity FROM grn_items gi JOIN grn g ON g.id=gi.grn_id WHERE gi.po_item_id=? AND g.status='posted' AND g.id<>?",
        { replacements: [item.po_item_id, req.params.id], transaction: tx }
      );
      if (Number(receivedBefore.quantity) + quantity > Number(ordered[0].quantity)) {
        throw Object.assign(new Error(`Received quantity exceeds ordered quantity for item ${item.item_id}`), { status: 409, code: 'OVER_RECEIPT' });
      }
      const [summary] = await req.orgDb.query('SELECT current_qty,avg_rate FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE', { replacements: [item.item_id, warehouse], transaction: tx });
      const current = Number(summary[0]?.current_qty || 0), oldRate = Number(summary[0]?.avg_rate || 0);
      const next = current + quantity, avg = next ? ((current * oldRate) + (quantity * rate)) / next : rate;
      await req.orgDb.query('INSERT INTO stock_summary(item_id,warehouse_id,current_qty,avg_rate,total_value) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_qty=?,avg_rate=?,total_value=?',
        { replacements: [item.item_id, warehouse, next, avg, next * avg, next, avg, next * avg], transaction: tx });
      await req.orgDb.query('INSERT INTO stock_ledger(id,item_id,warehouse_id,transaction_type,reference_type,reference_id,qty_in,balance_qty,rate,amount,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        { replacements: [uuid(), item.item_id, warehouse, 'purchase_receipt', 'grn', req.params.id, quantity, next, rate, quantity * rate, req.user.sub], transaction: tx });
    }
    await req.orgDb.query("UPDATE grn SET status='posted',received_date=COALESCE(received_date,CURDATE()) WHERE id=?", { replacements: [req.params.id], transaction: tx });
    const [[remaining]] = await req.orgDb.query(
      "SELECT COUNT(*) AS count FROM purchase_order_items poi LEFT JOIN (SELECT po_item_id,SUM(quantity) quantity FROM grn_items gi JOIN grn g ON g.id=gi.grn_id WHERE g.status='posted' GROUP BY po_item_id) received ON received.po_item_id=poi.id WHERE poi.order_id=? AND COALESCE(received.quantity,0)<poi.quantity",
      { replacements: [grns[0].po_id], transaction: tx }
    );
    await req.orgDb.query("UPDATE purchase_orders SET status=? WHERE id=?", { replacements: [Number(remaining.count) === 0 ? 'received' : 'part_received', grns[0].po_id], transaction: tx });
    await tx.commit();
    return ok(res, { id: req.params.id, status: 'posted' }, 'GRN posted and stock updated');
  } catch (error) { await tx.rollback(); throw error; }
}));

workflow.post('/sales/orders/from-quotation', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { quotation_id: quotationId } = req.body;
  const tx = await req.orgDb.transaction();
  try {
    const [quote] = await req.orgDb.query("SELECT * FROM quotations WHERE id=? AND status IN ('accepted','approved') FOR UPDATE", { replacements: [quotationId], transaction: tx });
    if (!quote.length) throw invalid('Only an accepted quotation can create an order');
    const source = await lines(req.orgDb, 'quotation_items', 'quotation_id', quotationId, tx);
    if (!source.length) throw invalid('Quotation has no items');
    const id = uuid(), number = await nextNumber(req.orgDb, 'sales_order', 'SO-', 5, tx);
    await req.orgDb.query("INSERT INTO sales_orders(id,so_number,quotation_id,customer_id,status,total_amount) VALUES(?,?,?,?,'confirmed',?)",
      { replacements: [id, number, quotationId, quote[0].customer_id, quote[0].total_amount || 0], transaction: tx });
    for (const item of source) await req.orgDb.query('INSERT INTO sales_order_items(id,order_id,item_id,quantity,rate,quotation_item_id) VALUES(?,?,?,?,?,?)',
      { replacements: [uuid(), id, item.item_id, item.quantity, item.rate, item.id], transaction: tx });
    await req.orgDb.query("UPDATE quotations SET status='converted' WHERE id=?", { replacements: [quotationId], transaction: tx });
    await tx.commit(); return ok(res, { id, so_number: number, quotation_id: quotationId, status: 'confirmed' }, 'Sales order created');
  } catch (error) { await tx.rollback(); throw error; }
}));

workflow.post('/sales/invoices/from-order', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { order_id: orderId } = req.body;
  const tx = await req.orgDb.transaction();
  try {
    const [order] = await req.orgDb.query("SELECT * FROM sales_orders WHERE id=? AND status IN ('confirmed','approved') FOR UPDATE", { replacements: [orderId], transaction: tx });
    if (!order.length) throw invalid('Only a confirmed sales order can be invoiced');
    const id = uuid(), number = await nextNumber(req.orgDb, 'invoice', 'INV-', 5, tx);
    await req.orgDb.query("INSERT INTO invoices(id,invoice_number,order_id,customer_id,invoice_date,status,total_amount,balance_amount) VALUES(?,?,?, ?,CURDATE(),'draft',?,?)",
      { replacements: [id, number, orderId, order[0].customer_id, order[0].total_amount || 0, order[0].total_amount || 0], transaction: tx });
    await req.orgDb.query("UPDATE sales_orders SET status='invoiced' WHERE id=?", { replacements: [orderId], transaction: tx });
    await tx.commit(); return ok(res, { id, invoice_number: number, order_id: orderId, status: 'draft' }, 'Invoice created');
  } catch (error) { await tx.rollback(); throw error; }
}));

// ─────────────────────────────────────────────────────────────
// WORK ORDER ROUTING OPERATIONS (Shop Floor Stages)
// ─────────────────────────────────────────────────────────────
workflow.get('/production/work-orders/:id/operations', permission('production', 'can_view'), asyncHandler(async (req, res) => {
  const [ops] = await req.orgDb.query(
    'SELECT * FROM wo_routing_operations WHERE wo_id=? ORDER BY sequence_no ASC, created_at ASC',
    { replacements: [req.params.id] }
  );
  return ok(res, ops);
}));

workflow.post('/production/work-orders/:id/operations', permission('production', 'can_create'), asyncHandler(async (req, res) => {
  const { stage_name, sequence_no = 1, machine_id, operator_id, description } = req.body;
  if (!stage_name) throw invalid('stage_name is required');
  const opId = uuid();
  await req.orgDb.query(
    `INSERT INTO wo_routing_operations(id, wo_id, sequence_no, stage_name, machine_id, operator_id, description, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'pending')`,
    { replacements: [opId, req.params.id, Number(sequence_no), stage_name, machine_id || null, operator_id || null, description || null] }
  );
  return ok(res, { id: opId, wo_id: req.params.id, stage_name, status: 'pending' }, 'Operation created');
}));

workflow.put('/production/work-orders/:id/operations/:opId', permission('production', 'can_edit'), asyncHandler(async (req, res) => {
  const { status, completed_qty, rejected_qty, notes } = req.body;
  const updates = [];
  const vals = [];

  if (status) {
    updates.push('status=?');
    vals.push(status);
    if (status === 'in_progress') {
      updates.push('actual_start=COALESCE(actual_start, NOW())');
    } else if (status === 'completed') {
      updates.push('actual_end=NOW()');
    }
  }
  if (completed_qty !== undefined) {
    updates.push('completed_qty=?');
    vals.push(Number(completed_qty));
  }
  if (rejected_qty !== undefined) {
    updates.push('rejected_qty=?');
    vals.push(Number(rejected_qty));
  }
  if (notes !== undefined) {
    updates.push('notes=?');
    vals.push(notes);
  }

  if (!updates.length) throw invalid('No updates provided');

  vals.push(req.params.opId, req.params.id);
  await req.orgDb.query(
    `UPDATE wo_routing_operations SET ${updates.join(', ')} WHERE id=? AND wo_id=?`,
    { replacements: vals }
  );
  return ok(res, { id: req.params.opId, status }, 'Operation updated');
}));

// ─────────────────────────────────────────────────────────────
// JOB WORK SECTION 143 (1-YEAR GST AGING AUDIT)
// ─────────────────────────────────────────────────────────────
workflow.get('/jobwork/compliance/aging', permission('jobwork', 'can_view'), asyncHandler(async (req, res) => {
  const [rows] = await req.orgDb.query(`
    SELECT j.*,
           v.company_name AS vendor_name,
           v.gstin AS vendor_gstin,
           COALESCE(j.dispatch_date, DATE(j.created_at)) AS dispatch_date_calc,
           DATEDIFF(CURDATE(), COALESCE(j.dispatch_date, DATE(j.created_at))) AS days_elapsed,
           GREATEST(0, (CASE WHEN j.challan_type='capital_goods' THEN 1095 ELSE 365 END) - DATEDIFF(CURDATE(), COALESCE(j.dispatch_date, DATE(j.created_at)))) AS days_remaining,
           CASE
             WHEN j.status IN ('completed', 'cancelled') THEN 'compliant'
             WHEN DATEDIFF(CURDATE(), COALESCE(j.dispatch_date, DATE(j.created_at))) >= (CASE WHEN j.challan_type='capital_goods' THEN 1095 ELSE 365 END) THEN 'overdue_deemed_supply'
             WHEN DATEDIFF(CURDATE(), COALESCE(j.dispatch_date, DATE(j.created_at))) >= 300 THEN 'warning_aging'
             ELSE 'compliant'
           END AS compliance_risk
    FROM job_work_orders j
    LEFT JOIN vendors v ON v.id = j.vendor_id
    ORDER BY days_elapsed DESC
  `);
  return ok(res, rows);
}));

// ─────────────────────────────────────────────────────────────
// TALLY PRIME XML EXPORTS (Sales, Purchases, Masters)
// ─────────────────────────────────────────────────────────────
workflow.get('/finance/tally/sales.xml', permission('finance', 'can_export'), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const vals = [];
  if (from) { where.push('i.invoice_date >= ?'); vals.push(from); }
  if (to) { where.push('i.invoice_date <= ?'); vals.push(to); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [invoices] = await req.orgDb.query(`
    SELECT i.*, c.company_name AS customer_name, c.gstin AS customer_gstin
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    ${whereClause}
    ORDER BY i.invoice_date ASC
  `, { replacements: vals });

  const invoiceIds = invoices.map(i => i.id);
  const linesMap = {};

  if (invoiceIds.length) {
    const [lines] = await req.orgDb.query(
      `SELECT * FROM invoice_item_lines WHERE invoice_id IN (?)`,
      { replacements: [invoiceIds] }
    );
    for (const l of lines) {
      if (!linesMap[l.invoice_id]) linesMap[l.invoice_id] = [];
      linesMap[l.invoice_id].push(l);
    }
  }

  const xml = generateSalesXml(req.org.company_name, invoices, linesMap);
  res.type('application/xml').set('Content-Disposition', 'attachment; filename="tally_sales_vouchers.xml"').send(xml);
}));

workflow.get('/finance/tally/purchases.xml', permission('finance', 'can_export'), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const vals = [];
  if (from) { where.push('po.created_at >= ?'); vals.push(from); }
  if (to) { where.push('po.created_at <= ?'); vals.push(to); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [orders] = await req.orgDb.query(`
    SELECT po.*, v.company_name AS vendor_name, v.gstin AS vendor_gstin
    FROM purchase_orders po
    LEFT JOIN vendors v ON v.id = po.vendor_id
    ${whereClause}
    ORDER BY po.created_at ASC
  `, { replacements: vals });

  const xml = generatePurchaseXml(req.org.company_name, orders);
  res.type('application/xml').set('Content-Disposition', 'attachment; filename="tally_purchase_vouchers.xml"').send(xml);
}));

workflow.get('/finance/tally/masters.xml', permission('finance', 'can_export'), asyncHandler(async (req, res) => {
  const [customers] = await req.orgDb.query('SELECT * FROM customers WHERE is_active=1');
  const [vendors] = await req.orgDb.query('SELECT * FROM vendors WHERE is_active=1');
  const xml = generateMastersXml(req.org.company_name, customers, vendors);
  res.type('application/xml').set('Content-Disposition', 'attachment; filename="tally_masters.xml"').send(xml);
}));

module.exports = workflow;
