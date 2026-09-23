const express = require('express');
const { v4: uuid } = require('uuid');
const { postInvoiceEffect } = require('../services/accounting.service');
const { ok, fail, asyncHandler } = require('../utils/response');
const { nextNumber } = require('../services/erp.service');
const {
  generateSalesXml,
  generatePurchaseXml,
  generateMastersXml,
} = require('../services/tally-export.service');
const {
  handleSalesOrderConfirmed,
  handleWorkOrderCompleted,
  handleQcInspectionResult,
  handleDeliveryChallanSaved,
  getAutomationRules,
  saveAutomationRules,
} = require('../services/automation.service');
const {
  generateEinvoice,
  cancelEinvoice,
} = require('../services/einvoice.service');
const {
  generateEwayBill,
  cancelEwayBill,
} = require('../services/ewaybill.service');
const {
  getWhatsAppSettings,
  saveWhatsAppSettings,
  sendPoToVendor,
  sendInvoiceToCustomer,
} = require('../services/whatsapp.service');
const {
  generateItemQr,
  generateWorkOrderQr,
  verifyDispatchScan,
} = require('../services/qr.service');
const permission = require('../middleware/permission');
const activity = require('../middleware/activity');

const invalid = (message) =>
  Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR' });
const workflow = express.Router();
workflow.use(
  require('../middleware/auth').auth,
  require('../middleware/orgContext'),
  require('../middleware/entitlement'),
  activity,
);

async function lines(db, table, foreignKey, id, transaction) {
  const [rows] = await db.query(
    `SELECT * FROM ${table} WHERE ${foreignKey}=? ORDER BY id`,
    { replacements: [id], transaction },
  );
  return rows;
}

workflow.post(
  '/purchase/requisitions/:id/submit',
  permission('purchase', 'can_approve'),
  asyncHandler(async (req, res) => {
    const [result] = await req.orgDb.query(
      "UPDATE purchase_requisitions SET status='submitted' WHERE id=? AND status IN ('pending','draft')",
      { replacements: [req.params.id] },
    );
    if (!result.affectedRows)
      return fail(res, 409, 'INVALID_STATE', 'Requisition is not pending');
    return ok(res, { id: req.params.id, status: 'submitted' });
  }),
);

workflow.post(
  '/purchase/requisitions/:id/items',
  permission('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length)
      throw invalid('At least one requisition item is required');
    const tx = await req.orgDb.transaction();
    try {
      const [requisitions] = await req.orgDb.query(
        'SELECT status FROM purchase_requisitions WHERE id=? FOR UPDATE',
        { replacements: [req.params.id], transaction: tx },
      );
      if (!requisitions.length)
        throw Object.assign(new Error('Requisition not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      if (!['draft', 'pending'].includes(requisitions[0].status))
        throw Object.assign(
          new Error('Only draft or pending requisitions can be edited'),
          { status: 409, code: 'INVALID_STATE' },
        );
      await req.orgDb.query(
        'DELETE FROM purchase_requisition_items WHERE requisition_id=?',
        { replacements: [req.params.id], transaction: tx },
      );
      for (const item of items) {
        const quantity = Number(item.quantity);
        if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0)
          throw invalid('Each requisition item needs a positive quantity');
        await req.orgDb.query(
          'INSERT INTO purchase_requisition_items(id,requisition_id,item_id,quantity,rate) VALUES(?,?,?,?,?)',
          {
            replacements: [
              uuid(),
              req.params.id,
              item.item_id,
              quantity,
              Number(item.rate || 0),
            ],
            transaction: tx,
          },
        );
      }
      await tx.commit();
      return ok(
        res,
        { requisition_id: req.params.id, item_count: items.length },
        'Requisition items saved',
      );
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);

workflow.post(
  '/purchase/orders/from-requisition',
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) => {
    const {
      requisition_id: requisitionId,
      vendor_id: vendorId,
      warehouse_id: warehouseId,
      items,
    } = req.body;
    const tx = await req.orgDb.transaction();
    try {
      const [pr] = await req.orgDb.query(
        'SELECT * FROM purchase_requisitions WHERE id=? FOR UPDATE',
        { replacements: [requisitionId], transaction: tx },
      );
      if (!pr.length || !['submitted', 'approved'].includes(pr[0].status))
        throw invalid('Only a submitted requisition can create an order');
      const source = items?.length
        ? items
        : await lines(
            req.orgDb,
            'purchase_requisition_items',
            'requisition_id',
            requisitionId,
            tx,
          );
      if (!vendorId || !warehouseId || !source.length)
        throw invalid(
          'vendor_id, warehouse_id and requisition items are required',
        );
      const id = uuid(),
        number = await nextNumber(req.orgDb, 'purchase_order', 'PO-', 5, tx);
      let total = 0;
      await req.orgDb.query(
        "INSERT INTO purchase_orders(id,po_number,vendor_id,warehouse_id,requisition_id,status,total_amount,created_by) VALUES(?,?,?,?,?,'draft',?,?)",
        {
          replacements: [
            id,
            number,
            vendorId,
            warehouseId,
            requisitionId,
            0,
            req.user.sub,
          ],
          transaction: tx,
        },
      );
      for (const item of source) {
        const quantity = Number(item.quantity),
          rate = Number(item.rate || 0);
        if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0)
          throw invalid('Each order item needs a positive quantity');
        total += quantity * rate;
        await req.orgDb.query(
          'INSERT INTO purchase_order_items(id,order_id,item_id,quantity,rate,requisition_item_id) VALUES(?,?,?,?,?,?)',
          {
            replacements: [
              uuid(),
              id,
              item.item_id,
              quantity,
              rate,
              item.id || null,
            ],
            transaction: tx,
          },
        );
      }
      await req.orgDb.query(
        'UPDATE purchase_orders SET total_amount=? WHERE id=?',
        { replacements: [total, id], transaction: tx },
      );
      await req.orgDb.query(
        "UPDATE purchase_requisitions SET status='ordered' WHERE id=?",
        { replacements: [requisitionId], transaction: tx },
      );
      await tx.commit();
      return ok(
        res,
        {
          id,
          po_number: number,
          requisition_id: requisitionId,
          status: 'draft',
          total_amount: total,
        },
        'Purchase order created',
      );
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);

workflow.post(
  '/purchase/orders/:id/approve',
  permission('purchase', 'can_approve'),
  asyncHandler(async (req, res) => {
    const [result] = await req.orgDb.query(
      "UPDATE purchase_orders SET status='approved' WHERE id=? AND status='draft'",
      { replacements: [req.params.id] },
    );
    if (!result.affectedRows)
      return fail(
        res,
        409,
        'INVALID_STATE',
        'Only draft orders can be approved',
      );
    return ok(res, { id: req.params.id, status: 'approved' });
  }),
);

workflow.post(
  '/purchase/grn/from-order',
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) => {
    const { order_id: orderId, items } = req.body;
    if (!orderId || !Array.isArray(items) || !items.length)
      throw invalid('order_id and GRN items are required');
    const tx = await req.orgDb.transaction();
    try {
      const [orders] = await req.orgDb.query(
        'SELECT id,vendor_id,warehouse_id,status FROM purchase_orders WHERE id=? FOR UPDATE',
        { replacements: [orderId], transaction: tx },
      );
      if (!orders.length)
        throw Object.assign(new Error('Purchase order not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      if (!['approved', 'part_received'].includes(orders[0].status))
        throw Object.assign(
          new Error('Only approved purchase orders can receive goods'),
          { status: 409, code: 'INVALID_STATE' },
        );
      const grnId = uuid();
      const grnNumber = await nextNumber(req.orgDb, 'grn', 'GRN-', 5, tx);
      await req.orgDb.query(
        "INSERT INTO grn(id,grn_number,po_id,vendor_id,status) VALUES(?,?,?,?, 'draft')",
        {
          replacements: [grnId, grnNumber, orderId, orders[0].vendor_id],
          transaction: tx,
        },
      );
      for (const item of items) {
        const quantity = Number(item.quantity);
        if (
          !item.po_item_id ||
          !item.item_id ||
          !Number.isFinite(quantity) ||
          quantity <= 0
        )
          throw invalid(
            'Each GRN item needs po_item_id, item_id and positive quantity',
          );
        await req.orgDb.query(
          'INSERT INTO grn_items(id,grn_id,po_item_id,item_id,quantity,rate) VALUES(?,?,?,?,?,?)',
          {
            replacements: [
              uuid(),
              grnId,
              item.po_item_id,
              item.item_id,
              quantity,
              Number(item.rate || 0),
            ],
            transaction: tx,
          },
        );
      }
      await tx.commit();
      return ok(
        res,
        { id: grnId, grn_number: grnNumber, po_id: orderId, status: 'draft' },
        'GRN created',
      );
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);

workflow.post(
  '/purchase/grn/:id/post',
  permission('purchase', 'can_approve'),
  asyncHandler(async (req, res) => {
    const result = await require('./inventoryPurchase.service').postGrn(
      req.orgDb,
      req.params.id,
      req.user.sub,
      req.body,
    );
    if (result.error)
      return fail(
        res,
        result.error === 'NOT_FOUND' ? 404 : 409,
        result.error,
        'Receipt cannot be posted',
      );
    return ok(
      res,
      result,
      'Receipt posted; Incoming QC releases accepted stock',
    );
  }),
);

workflow.post(
  '/sales/orders/from-quotation',
  permission('sales', 'can_create'),
  asyncHandler(async (req, res) => {
    const result =
      await require('../services/salesProduction.service').createSalesOrderFromQuotation(
        req.orgDb,
        req.body.quotation_id,
      );
    if (!result.already_converted)
      handleSalesOrderConfirmed(req.orgDb, result.id, req.user.sub).catch(
        (err) => console.error('[AUTOMATION ERROR]:', err.message),
      );
    return ok(
      res,
      result,
      result.already_converted
        ? 'Sales order already exists'
        : 'Sales order created',
    );
  }),
);

workflow.post(
  '/sales/invoices/from-order',
  permission('sales', 'can_create'),
  asyncHandler(async (req, res) => {
    const service = require('../services/invoice.service');
    if (!service.salesOrderId(req.body)) throw invalid('so_id is required');
    return ok(
      res,
      await service.createInvoice(req.orgDb, req.body, req.user.sub),
      'Invoice created',
    );
  }),
);

// ─────────────────────────────────────────────────────────────
// WORK ORDER ROUTING OPERATIONS (Shop Floor Stages)
// ─────────────────────────────────────────────────────────────
workflow.get(
  '/production/work-orders/:id/operations',
  permission('production', 'can_view'),
  asyncHandler(async (req, res) => {
    const [ops] = await req.orgDb.query(
      'SELECT * FROM wo_routing_operations WHERE wo_id=? ORDER BY sequence_no ASC, created_at ASC',
      { replacements: [req.params.id] },
    );
    return ok(res, ops);
  }),
);

workflow.post(
  '/production/work-orders/:id/operations',
  permission('production', 'can_create'),
  asyncHandler(async (req, res) => {
    const {
      stage_name,
      sequence_no = 1,
      machine_id,
      operator_id,
      description,
    } = req.body;
    if (!stage_name) throw invalid('stage_name is required');
    const opId = uuid();
    await req.orgDb.query(
      `INSERT INTO wo_routing_operations(id, wo_id, sequence_no, stage_name, machine_id, operator_id, description, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'pending')`,
      {
        replacements: [
          opId,
          req.params.id,
          Number(sequence_no),
          stage_name,
          machine_id || null,
          operator_id || null,
          description || null,
        ],
      },
    );
    return ok(
      res,
      { id: opId, wo_id: req.params.id, stage_name, status: 'pending' },
      'Operation created',
    );
  }),
);

workflow.put(
  '/production/work-orders/:id/operations/:opId',
  permission('production', 'can_edit'),
  asyncHandler(async (req, res) => {
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
      { replacements: vals },
    );
    return ok(res, { id: req.params.opId, status }, 'Operation updated');
  }),
);

// ─────────────────────────────────────────────────────────────
// JOB WORK SECTION 143 (1-YEAR GST AGING AUDIT)
// ─────────────────────────────────────────────────────────────
workflow.get(
  '/jobwork/compliance/aging',
  permission('jobwork', 'can_view'),
  asyncHandler(async (req, res) => {
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
  }),
);

// ─────────────────────────────────────────────────────────────
// TALLY PRIME XML EXPORTS (Sales, Purchases, Masters)
// ─────────────────────────────────────────────────────────────
workflow.get(
  '/finance/tally/sales.xml',
  permission('finance', 'can_export'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const where = [];
    const vals = [];
    if (from) {
      where.push('i.invoice_date >= ?');
      vals.push(from);
    }
    if (to) {
      where.push('i.invoice_date <= ?');
      vals.push(to);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [invoices] = await req.orgDb.query(
      `
    SELECT i.*, c.company_name AS customer_name, c.gstin AS customer_gstin
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
    ${whereClause}
    ORDER BY i.invoice_date ASC
  `,
      { replacements: vals },
    );

    const invoiceIds = invoices.map((i) => i.id);
    const linesMap = {};

    if (invoiceIds.length) {
      const [lines] = await req.orgDb.query(
        `SELECT * FROM invoice_item_lines WHERE invoice_id IN (?)`,
        { replacements: [invoiceIds] },
      );
      for (const l of lines) {
        if (!linesMap[l.invoice_id]) linesMap[l.invoice_id] = [];
        linesMap[l.invoice_id].push(l);
      }
    }

    const xml = generateSalesXml(req.org.company_name, invoices, linesMap);
    res
      .type('application/xml')
      .set(
        'Content-Disposition',
        'attachment; filename="tally_sales_vouchers.xml"',
      )
      .send(xml);
  }),
);

workflow.get(
  '/finance/tally/purchases.xml',
  permission('finance', 'can_export'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const where = [];
    const vals = [];
    if (from) {
      where.push('po.created_at >= ?');
      vals.push(from);
    }
    if (to) {
      where.push('po.created_at <= ?');
      vals.push(to);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [orders] = await req.orgDb.query(
      `
    SELECT po.*, v.company_name AS vendor_name, v.gstin AS vendor_gstin
    FROM purchase_orders po
    LEFT JOIN vendors v ON v.id = po.vendor_id
    ${whereClause}
    ORDER BY po.created_at ASC
  `,
      { replacements: vals },
    );

    const xml = generatePurchaseXml(req.org.company_name, orders);
    res
      .type('application/xml')
      .set(
        'Content-Disposition',
        'attachment; filename="tally_purchase_vouchers.xml"',
      )
      .send(xml);
  }),
);

workflow.get(
  '/finance/tally/masters.xml',
  permission('finance', 'can_export'),
  asyncHandler(async (req, res) => {
    const [customers] = await req.orgDb.query(
      'SELECT * FROM customers WHERE is_active=1',
    );
    const [vendors] = await req.orgDb.query(
      'SELECT * FROM vendors WHERE is_active=1',
    );
    const xml = generateMastersXml(req.org.company_name, customers, vendors);
    res
      .type('application/xml')
      .set('Content-Disposition', 'attachment; filename="tally_masters.xml"')
      .send(xml);
  }),
);

// ─────────────────────────────────────────────────────────────
// PROCESS AUTOMATION HOOKS & CONFIGURATION
// ─────────────────────────────────────────────────────────────

// Explicit Sales Order confirmation (triggers auto-WO and shortfall PR)
workflow.post(
  '/sales/orders/:id/confirm',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    await req.orgDb.query(
      "UPDATE sales_orders SET status = 'confirmed' WHERE id = ?",
      { replacements: [req.params.id] },
    );
    const autoResult = await handleSalesOrderConfirmed(
      req.orgDb,
      req.params.id,
      req.user.sub,
    );
    return ok(
      res,
      { id: req.params.id, status: 'confirmed', automation: autoResult },
      'Sales order confirmed and automations executed',
    );
  }),
);

// Explicit Work Order completion (triggers auto-backflushing of raw materials)
workflow.post(
  '/production/work-orders/:id/complete',
  permission('production', 'can_edit'),
  asyncHandler(async (req, res) => {
    return ok(
      res,
      await require('../services/salesProduction.service').completeWorkOrder(
        req.orgDb,
        req.params.id,
        req.body.warehouse_id,
        req.user.sub,
      ),
      'Work order completed',
    );
  }),
);

// Organization Automation Rules
workflow.get(
  '/settings/automations',
  permission('settings', 'can_view'),
  asyncHandler(async (req, res) => {
    const rules = await getAutomationRules(req.orgDb);
    return ok(res, rules);
  }),
);

workflow.put(
  '/settings/automations',
  permission('settings', 'can_edit'),
  asyncHandler(async (req, res) => {
    const updated = await saveAutomationRules(req.orgDb, req.body);
    return ok(res, updated, 'Automation rules updated successfully');
  }),
);

// QC Inspection Result Process (triggers auto-split and debit note)
workflow.post(
  '/quality/inspections/:id/process-result',
  permission('quality', 'can_edit'),
  asyncHandler(async (req, res) => {
    return ok(
      res,
      await require('../services/qualityInspection.service').processResult(
        req.orgDb,
        req.params.id,
        req.body,
        req.user.sub,
      ),
      'QC result processed',
    );
  }),
);

// Delivery Challan Save (triggers auto-invoice drafting)
workflow.post(
  '/sales/challans/create-and-invoice',
  permission('sales', 'can_create'),
  asyncHandler(async (req, res) => {
    const { customer_id, so_id, vehicle_number, items } = req.body;
    const challanId = uuid();
    const challanNumber = await nextNumber(
      req.orgDb,
      'delivery_challan',
      'DC-',
      5,
    );

    const tx = await req.orgDb.transaction();
    try {
      await req.orgDb.query(
        `
      INSERT INTO delivery_challans (id, challan_number, customer_id, so_id, challan_date, vehicle_number)
      VALUES (?, ?, ?, ?, CURDATE(), ?)
    `,
        {
          replacements: [
            challanId,
            challanNumber,
            customer_id,
            so_id || null,
            vehicle_number || null,
          ],
          transaction: tx,
        },
      );

      for (const item of items || []) {
        await req.orgDb.query(
          `
        INSERT INTO delivery_challan_items (id, challan_id, order_item_id, item_id, quantity, rate)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
          {
            replacements: [
              uuid(),
              challanId,
              item.order_item_id || null,
              item.item_id,
              item.quantity,
              item.rate || 0,
            ],
            transaction: tx,
          },
        );
      }

      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }

    const invoiceResult = await handleDeliveryChallanSaved(
      req.orgDb,
      challanId,
      req.user.sub,
    );
    return ok(
      res,
      {
        challan_id: challanId,
        challan_number: challanNumber,
        invoice: invoiceResult,
      },
      'Delivery challan created',
    );
  }),
);

// ─────────────────────────────────────────────────────────────
// GST E-INVOICE (IRN) ENDPOINTS
// ─────────────────────────────────────────────────────────────
workflow.post(
  '/sales/invoices/:id/generate-irn',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    const [invs] = await req.orgDb.query(
      'SELECT * FROM invoices WHERE id = ?',
      { replacements: [req.params.id] },
    );
    if (!invs.length) return fail(res, 404, 'NOT_FOUND', 'Invoice not found');
    const invoice = invs[0];

    const [custs] = await req.orgDb.query(
      'SELECT * FROM customers WHERE id = ?',
      { replacements: [invoice.customer_id] },
    );
    const buyer = custs[0] || {};

    const [lines] = await req.orgDb.query(
      `
    SELECT iil.*, im.item_name, im.hsn_code, im.uom_id, u.uom_code
    FROM invoice_item_lines iil
    LEFT JOIN item_master im ON im.id = iil.item_id
    LEFT JOIN uom_master u ON u.id = im.uom_id
    WHERE iil.invoice_id = ?
  `,
      { replacements: [req.params.id] },
    );

    const seller = {
      gstin: req.org.gstin || '23AAAAA0000A1Z5',
      company_name: req.org.company_name,
      address: req.org.address,
      city: req.org.city || 'Indore',
      state: req.org.state || 'Madhya Pradesh',
    };

    const einvResult = await generateEinvoice({
      invoice,
      seller,
      buyer,
      lines,
    });

    await req.orgDb.query(
      `
    UPDATE invoices
    SET irn = ?, signed_qr_code = ?, ack_no = ?, ack_date = ?, einvoice_status = 'generated'
    WHERE id = ?
  `,
      {
        replacements: [
          einvResult.irn,
          einvResult.signed_qr_code,
          einvResult.ack_no,
          einvResult.ack_date,
          req.params.id,
        ],
      },
    );

    return ok(res, einvResult, 'E-Invoice IRN generated successfully');
  }),
);

workflow.post(
  '/sales/invoices/:id/cancel-irn',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    const [invs] = await req.orgDb.query(
      'SELECT irn FROM invoices WHERE id = ?',
      { replacements: [req.params.id] },
    );
    if (!invs.length || !invs[0].irn)
      return fail(res, 400, 'NO_IRN', 'Invoice does not have an active IRN');

    const cancelResult = await cancelEinvoice({
      irn: invs[0].irn,
      reason: req.body.reason,
      remark: req.body.remark,
    });
    await req.orgDb.query(
      "UPDATE invoices SET einvoice_status = 'cancelled' WHERE id = ?",
      { replacements: [req.params.id] },
    );

    return ok(res, cancelResult, 'E-Invoice IRN cancelled successfully');
  }),
);

// ─────────────────────────────────────────────────────────────
// GST E-WAY BILL ENDPOINTS
// ─────────────────────────────────────────────────────────────
workflow.post(
  '/sales/challans/:id/generate-ewaybill',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    const [challans] = await req.orgDb.query(
      'SELECT * FROM delivery_challans WHERE id = ?',
      { replacements: [req.params.id] },
    );
    if (!challans.length)
      return fail(res, 404, 'NOT_FOUND', 'Delivery challan not found');
    const challan = challans[0];

    const [custs] = await req.orgDb.query(
      'SELECT * FROM customers WHERE id = ?',
      { replacements: [challan.customer_id] },
    );
    const buyer = custs[0] || {};

    const [items] = await req.orgDb.query(
      'SELECT * FROM delivery_challan_items WHERE challan_id = ?',
      { replacements: [req.params.id] },
    );

    const seller = {
      gstin: req.org.gstin || '23AAAAA0000A1Z5',
      company_name: req.org.company_name,
      address: req.org.address,
    };

    const vehicle = req.body.vehicle_number || challan.vehicle_number;
    const ewbResult = await generateEwayBill({
      challan,
      items,
      seller,
      buyer,
      vehicleNumber: vehicle,
      distanceKm: req.body.distance_km || 150,
    });

    await req.orgDb.query(
      `
    UPDATE delivery_challans
    SET eway_bill_no = ?, eway_bill_date = ?, valid_until = ?, vehicle_number = ?, eway_bill_status = 'generated'
    WHERE id = ?
  `,
      {
        replacements: [
          ewbResult.eway_bill_no,
          ewbResult.eway_bill_date,
          ewbResult.valid_until,
          ewbResult.vehicle_number,
          req.params.id,
        ],
      },
    );

    return ok(res, ewbResult, 'E-Way Bill generated successfully');
  }),
);

workflow.post(
  '/sales/challans/:id/cancel-ewaybill',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    const [ch] = await req.orgDb.query(
      'SELECT eway_bill_no FROM delivery_challans WHERE id = ?',
      { replacements: [req.params.id] },
    );
    if (!ch.length || !ch[0].eway_bill_no)
      return fail(res, 400, 'NO_EWB', 'Challan has no active E-Way Bill');

    const cancelResult = await cancelEwayBill({
      ewayBillNo: ch[0].eway_bill_no,
    });
    await req.orgDb.query(
      "UPDATE delivery_challans SET eway_bill_status = 'cancelled' WHERE id = ?",
      { replacements: [req.params.id] },
    );

    return ok(res, cancelResult, 'E-Way Bill cancelled successfully');
  }),
);

// ─────────────────────────────────────────────────────────────
// WHATSAPP SETTINGS & DIRECT DISPATCH ENDPOINTS
// ─────────────────────────────────────────────────────────────
workflow.get(
  '/settings/whatsapp',
  permission('settings', 'can_view'),
  asyncHandler(async (req, res) => {
    return ok(res, await getWhatsAppSettings(req.orgDb));
  }),
);

workflow.put(
  '/settings/whatsapp',
  permission('settings', 'can_edit'),
  asyncHandler(async (req, res) => {
    const updated = await saveWhatsAppSettings(req.orgDb, req.body);
    return ok(res, updated, 'WhatsApp settings saved');
  }),
);

workflow.post(
  '/purchase/orders/:id/send-whatsapp',
  permission('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await sendPoToVendor(req.orgDb, req.params.id);
    return ok(res, result, 'WhatsApp message sent to vendor');
  }),
);

workflow.post(
  '/sales/invoices/:id/send-whatsapp',
  permission('sales', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await sendInvoiceToCustomer(req.orgDb, req.params.id);
    return ok(res, result, 'WhatsApp message sent to customer');
  }),
);

// ─────────────────────────────────────────────────────────────
// BARCODE & QR CODE WORKFLOWS
// ─────────────────────────────────────────────────────────────
workflow.get(
  '/inventory/items/:id/qr',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [items] = await req.orgDb.query(
      'SELECT * FROM item_master WHERE id = ?',
      { replacements: [req.params.id] },
    );
    if (!items.length) return fail(res, 404, 'NOT_FOUND', 'Item not found');
    return ok(res, generateItemQr(items[0]));
  }),
);

workflow.get(
  '/production/work-orders/:id/qr',
  permission('production', 'can_view'),
  asyncHandler(async (req, res) => {
    const [wos] = await req.orgDb.query(
      'SELECT * FROM work_orders WHERE id = ?',
      { replacements: [req.params.id] },
    );
    if (!wos.length) return fail(res, 404, 'NOT_FOUND', 'Work order not found');
    return ok(res, generateWorkOrderQr(wos[0]));
  }),
);

workflow.post(
  '/sales/challans/verify-scan',
  permission('sales', 'can_view'),
  asyncHandler(async (req, res) => {
    const { so_id, scanned_code } = req.body;
    const [items] = await req.orgDb.query(
      `
    SELECT soi.item_id, soi.quantity, im.item_name, im.item_code
    FROM sales_order_items soi
    JOIN item_master im ON im.id = soi.item_id
    WHERE soi.so_id = ?
  `,
      { replacements: [so_id] },
    );

    const result = verifyDispatchScan({
      expectedItems: items,
      scannedCode: scanned_code,
    });
    return ok(res, result);
  }),
);

module.exports = workflow;
