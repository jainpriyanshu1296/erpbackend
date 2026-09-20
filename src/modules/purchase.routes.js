const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const { permission } = require('../middleware/permission');

const router = express.Router();

// ============ PURCHASE REQUISITIONS ============

router.get('/requisitions', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (pr.pr_number LIKE ? OR pr.notes LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND pr.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM purchase_requisitions pr ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT pr.*, u.name as requested_by_name
    FROM purchase_requisitions pr
    LEFT JOIN users u ON u.id = pr.requested_by
    ${where}
    ORDER BY pr.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/requisitions', permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { items, department, warehouse_id, required_date, priority, reason, notes } = req.body;
  
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.quantity) <= 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id and positive quantity');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const prId = uuid();
    const prNumber = `PR-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO purchase_requisitions(id, pr_number, requested_by, status, department, warehouse_id, required_date, priority, reason, notes, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NOW())
    `, {
      replacements: [prId, prNumber, req.user.sub, department || null, warehouse_id || null, required_date || null, priority || 'normal', reason || null, notes || null],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO purchase_requisition_items(id, requisition_id, item_id, quantity, notes)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), prId, item.item_id, item.quantity, item.notes || null],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: prId, pr_number: prNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/requisitions/:id', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [pr] = await req.orgDb.query(`
    SELECT pr.*, u.name as requested_by_name
    FROM purchase_requisitions pr
    LEFT JOIN users u ON u.id = pr.requested_by
    WHERE pr.id = ?
  `, { replacements: [req.params.id] });
  
  if (!pr.length) return fail(res, 404, 'NOT_FOUND', 'Requisition not found');
  
  const [items] = await req.orgDb.query(`
    SELECT pri.*, im.item_code, im.item_name
    FROM purchase_requisition_items pri
    LEFT JOIN item_master im ON im.id = pri.item_id
    WHERE pri.requisition_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...pr[0], items });
}));

router.put('/requisitions/:id', permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const [pr] = await req.orgDb.query('SELECT status FROM purchase_requisitions WHERE id = ?', { replacements: [req.params.id] });
  if (!pr.length) return fail(res, 404, 'NOT_FOUND', 'Requisition not found');
  
  if (pr[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft requisitions can be edited');
  }
  
  const allowed = ['department', 'warehouse_id', 'required_date', 'priority', 'reason', 'notes'];
  const keys = Object.keys(req.body).filter(k => allowed.includes(k));
  
  if (keys.length > 0) {
    await req.orgDb.query(`UPDATE purchase_requisitions SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, {
      replacements: [...keys.map(k => req.body[k]), req.params.id]
    });
  }
  
  return ok(res, { id: req.params.id }, 'Requisition updated');
}));

router.post('/requisitions/:id/submit', permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const [pr] = await req.orgDb.query('SELECT status FROM purchase_requisitions WHERE id = ?', { replacements: [req.params.id] });
  if (!pr.length) return fail(res, 404, 'NOT_FOUND', 'Requisition not found');
  
  if (pr[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft requisitions can be submitted');
  }
  
  await req.orgDb.query('UPDATE purchase_requisitions SET status = ? WHERE id = ?', {
    replacements: ['submitted', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'submitted' }, 'Requisition submitted');
}));

router.post('/requisitions/:id/approve', permission('purchase', 'can_approve'), asyncHandler(async (req, res) => {
  const [pr] = await req.orgDb.query('SELECT status FROM purchase_requisitions WHERE id = ?', { replacements: [req.params.id] });
  if (!pr.length) return fail(res, 404, 'NOT_FOUND', 'Requisition not found');
  
  if (pr[0].status !== 'submitted') {
    return fail(res, 400, 'INVALID_STATE', 'Only submitted requisitions can be approved');
  }
  
  await req.orgDb.query('UPDATE purchase_requisitions SET status = ? WHERE id = ?', {
    replacements: ['approved', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'approved' }, 'Requisition approved');
}));

router.post('/requisitions/:id/reject', permission('purchase', 'can_approve'), asyncHandler(async (req, res) => {
  const [pr] = await req.orgDb.query('SELECT status FROM purchase_requisitions WHERE id = ?', { replacements: [req.params.id] });
  if (!pr.length) return fail(res, 404, 'NOT_FOUND', 'Requisition not found');
  
  if (!['submitted', 'approved'].includes(pr[0].status)) {
    return fail(res, 400, 'INVALID_STATE', 'Only submitted or approved requisitions can be rejected');
  }
  
  await req.orgDb.query('UPDATE purchase_requisitions SET status = ?, rejection_reason = ? WHERE id = ?', {
    replacements: ['rejected', req.body.reason || null, req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'rejected' }, 'Requisition rejected');
}));

// ============ PURCHASE ORDERS ============

router.get('/orders', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (po.po_number LIKE ? OR v.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND po.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM purchase_orders po LEFT JOIN vendors v ON v.id = po.vendor_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT po.*, v.company_name, v.vendor_code
    FROM purchase_orders po
    LEFT JOIN vendors v ON v.id = po.vendor_id
    ${where}
    ORDER BY po.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/orders', permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { vendor_id, items, delivery_date, warehouse_id, payment_terms, notes } = req.body;
  
  if (!vendor_id) return fail(res, 400, 'VALIDATION_ERROR', 'vendor_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.quantity) <= 0 || Number(item.rate) < 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id, positive quantity, and non-negative rate');
    }
  }
  
  const [vendor] = await req.orgDb.query('SELECT id FROM vendors WHERE id = ?', { replacements: [vendor_id] });
  if (!vendor.length) return fail(res, 400, 'VALIDATION_ERROR', 'Vendor not found');
  
  const tx = await req.orgDb.transaction();
  try {
    const poId = uuid();
    const poNumber = `PO-${Date.now()}`;
    let totalAmount = 0;
    
    for (const item of items) {
      const qty = Number(item.quantity);
      const rate = Number(item.rate);
      const discount = Number(item.discount_percent || 0);
      const tax = Number(item.tax_percent || 0);
      
      const lineAmount = qty * rate * (1 - discount / 100);
      const lineTax = lineAmount * tax / 100;
      totalAmount += lineAmount + lineTax;
    }
    
    await req.orgDb.query(`
      INSERT INTO purchase_orders(id, po_number, vendor_id, status, delivery_date, warehouse_id, payment_terms, notes, total_amount, created_by, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, NOW())
    `, {
      replacements: [poId, poNumber, vendor_id, delivery_date || null, warehouse_id || null, payment_terms || 30, notes || null, totalAmount, req.user.sub],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO purchase_order_items(id, po_id, item_id, quantity, rate, discount_percent, tax_percent)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), poId, item.item_id, item.quantity, item.rate, item.discount_percent || 0, item.tax_percent || 0],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: poId, po_number: poNumber, status: 'draft', total_amount: totalAmount });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/orders/:id', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [po] = await req.orgDb.query(`
    SELECT po.*, v.company_name, v.vendor_code
    FROM purchase_orders po
    LEFT JOIN vendors v ON v.id = po.vendor_id
    WHERE po.id = ?
  `, { replacements: [req.params.id] });
  
  if (!po.length) return fail(res, 404, 'NOT_FOUND', 'Purchase order not found');
  
  const [items] = await req.orgDb.query(`
    SELECT poi.*, im.item_code, im.item_name
    FROM purchase_order_items poi
    LEFT JOIN item_master im ON im.id = poi.item_id
    WHERE poi.po_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...po[0], items });
}));

router.post('/orders/:id/approve', permission('purchase', 'can_approve'), asyncHandler(async (req, res) => {
  const [po] = await req.orgDb.query('SELECT status FROM purchase_orders WHERE id = ?', { replacements: [req.params.id] });
  if (!po.length) return fail(res, 404, 'NOT_FOUND', 'Purchase order not found');
  
  if (po[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft purchase orders can be approved');
  }
  
  await req.orgDb.query('UPDATE purchase_orders SET status = ? WHERE id = ?', {
    replacements: ['approved', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'approved' }, 'Purchase order approved');
}));

router.post('/orders/:id/cancel', permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const [po] = await req.orgDb.query('SELECT status FROM purchase_orders WHERE id = ?', { replacements: [req.params.id] });
  if (!po.length) return fail(res, 404, 'NOT_FOUND', 'Purchase order not found');
  
  if (!['draft', 'approved'].includes(po[0].status)) {
    return fail(res, 400, 'INVALID_STATE', 'Cannot cancel purchase order in current status');
  }
  
  await req.orgDb.query('UPDATE purchase_orders SET status = ? WHERE id = ?', {
    replacements: ['cancelled', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'cancelled' }, 'Purchase order cancelled');
}));

// ============ GRN (GOODS RECEIPT NOTE) ============

router.get('/receipts', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (g.grn_number LIKE ? OR v.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND g.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM grn g LEFT JOIN vendors v ON v.id = g.vendor_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT g.*, v.company_name, po.po_number
    FROM grn g
    LEFT JOIN vendors v ON v.id = g.vendor_id
    LEFT JOIN purchase_orders po ON po.id = g.po_id
    ${where}
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/receipts', permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { po_id, vendor_id, items, warehouse_id, received_date, notes } = req.body;
  
  if (!vendor_id) return fail(res, 400, 'VALIDATION_ERROR', 'vendor_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.received_qty) < 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id and non-negative received_qty');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const grnId = uuid();
    const grnNumber = `GRN-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO grn(id, grn_number, po_id, vendor_id, warehouse_id, status, received_date, notes, created_at)
      VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [grnId, grnNumber, po_id || null, vendor_id, warehouse_id || null, received_date || null, notes || null],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO grn_items(id, grn_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), grnId, item.item_id, item.received_qty, item.rate || 0],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: grnId, grn_number: grnNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/receipts/:id', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const [grn] = await req.orgDb.query(`
    SELECT g.*, v.company_name, po.po_number
    FROM grn g
    LEFT JOIN vendors v ON v.id = g.vendor_id
    LEFT JOIN purchase_orders po ON po.id = g.po_id
    WHERE g.id = ?
  `, { replacements: [req.params.id] });
  
  if (!grn.length) return fail(res, 404, 'NOT_FOUND', 'GRN not found');
  
  const [items] = await req.orgDb.query(`
    SELECT gi.*, im.item_code, im.item_name
    FROM grn_items gi
    LEFT JOIN item_master im ON im.id = gi.item_id
    WHERE gi.grn_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...grn[0], items });
}));

router.post('/receipts/:id/post', permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const [grn] = await req.orgDb.query('SELECT status, warehouse_id FROM grn WHERE id = ?', { replacements: [req.params.id] });
  if (!grn.length) return fail(res, 404, 'NOT_FOUND', 'GRN not found');
  
  if (grn[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft GRN can be posted');
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const warehouseId = grn[0].warehouse_id;
    if (!warehouseId) {
      await tx.rollback();
      return fail(res, 400, 'MISSING_WAREHOUSE', 'Warehouse is required');
    }
    
    const [items] = await req.orgDb.query('SELECT * FROM grn_items WHERE grn_id = ?', { replacements: [req.params.id], transaction: tx });
    
    for (const item of items) {
      
      // Update stock summary
      const [result] = await req.orgDb.query(`
        INSERT INTO stock_summary(item_id, warehouse_id, current_qty, avg_rate, total_value, last_updated)
        VALUES(?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          current_qty = current_qty + ?,
          avg_rate = (avg_rate * (current_qty) + ? * ?) / (current_qty + ?),
          total_value = total_value + ?,
          last_updated = NOW()
      `, {
        replacements: [
          item.item_id, warehouseId, item.quantity, item.rate, item.quantity * item.rate,
          item.quantity, item.rate, item.quantity, item.quantity,
          item.quantity * item.rate
        ],
        transaction: tx
      });
      
      if (!result.affectedRows) {
        await tx.rollback();
        return fail(res, 400, 'STOCK_UPDATE_FAILED', `Failed to update stock for item ${item.item_id}`);
      }
      
      // Create stock ledger entry
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_in, balance_qty, rate, amount, transaction_date)
        VALUES(?, ?, ?, 'purchase_receipt', 'grn', ?, ?, ?, ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, warehouseId, req.params.id, item.quantity, item.quantity, item.rate, item.quantity * item.rate],
        transaction: tx
      });
    }
    
    await req.orgDb.query('UPDATE grn SET status = ?, posted_at = NOW() WHERE id = ?', {
      replacements: ['posted', req.params.id],
      transaction: tx
    });
    
    await tx.commit();
    return ok(res, { id: req.params.id, status: 'posted' }, 'GRN posted and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ PURCHASE RETURNS ============

router.get('/returns', permission('purchase', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (pr.return_number LIKE ? OR v.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM purchase_returns pr LEFT JOIN vendors v ON v.id = pr.vendor_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT pr.*, v.company_name
    FROM purchase_returns pr
    LEFT JOIN vendors v ON v.id = pr.vendor_id
    ${where}
    ORDER BY pr.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/returns', permission('purchase', 'can_create'), asyncHandler(async (req, res) => {
  const { vendor_id, grn_id, items, warehouse_id, reason, notes } = req.body;
  
  if (!vendor_id) return fail(res, 400, 'VALIDATION_ERROR', 'vendor_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.return_qty) <= 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id and positive return_qty');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const returnId = uuid();
    const returnNumber = `PR-RET-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO purchase_returns(id, return_number, vendor_id, grn_id, warehouse_id, status, reason, notes, created_at)
      VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [returnId, returnNumber, vendor_id, grn_id || null, warehouse_id || null, reason || null, notes || null],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO purchase_return_items(id, return_id, item_id, quantity)
        VALUES(?, ?, ?, ?)
      `, {
        replacements: [uuid(), returnId, item.item_id, item.return_qty],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: returnId, return_number: returnNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.post('/returns/:id/post', permission('purchase', 'can_edit'), asyncHandler(async (req, res) => {
  const [ret] = await req.orgDb.query('SELECT status, warehouse_id FROM purchase_returns WHERE id = ?', { replacements: [req.params.id] });
  if (!ret.length) return fail(res, 404, 'NOT_FOUND', 'Purchase return not found');
  
  if (ret[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft returns can be posted');
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const warehouseId = ret[0].warehouse_id;
    if (!warehouseId) {
      await tx.rollback();
      return fail(res, 400, 'MISSING_WAREHOUSE', 'Warehouse is required');
    }
    
    const [items] = await req.orgDb.query('SELECT * FROM purchase_return_items WHERE return_id = ?', { replacements: [req.params.id], transaction: tx });
    
    for (const item of items) {
      
      // Check stock exists and is sufficient
      const [stock] = await req.orgDb.query('SELECT current_qty FROM stock_summary WHERE item_id = ? AND warehouse_id = ?', { replacements: [item.item_id, warehouseId], transaction: tx });
      
      if (!stock.length || stock[0].current_qty < item.quantity) {
        await tx.rollback();
        return fail(res, 400, 'INSUFFICIENT_STOCK', `Insufficient stock for item ${item.item_id}`);
      }
      
      // Decrease stock
      const [result] = await req.orgDb.query(`
        UPDATE stock_summary
        SET current_qty = current_qty - ?,
            total_value = total_value - (? * avg_rate),
            last_updated = NOW()
        WHERE item_id = ? AND warehouse_id = ?
      `, {
        replacements: [item.quantity, item.quantity, item.item_id, warehouseId],
        transaction: tx
      });
      
      if (!result.affectedRows) {
        await tx.rollback();
        return fail(res, 400, 'STOCK_UPDATE_FAILED', `Failed to decrease stock for item ${item.item_id}`);
      }
      
      // Create stock ledger entry
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_out, balance_qty, transaction_date)
        VALUES(?, ?, ?, 'purchase_return', 'purchase_return', ?, ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, warehouseId, req.params.id, item.quantity, item.quantity],
        transaction: tx
      });
    }
    
    await req.orgDb.query('UPDATE purchase_returns SET status = ?, posted_at = NOW() WHERE id = ?', {
      replacements: ['posted', req.params.id],
      transaction: tx
    });
    
    await tx.commit();
    return ok(res, { id: req.params.id, status: 'posted' }, 'Purchase return posted and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

module.exports = router;
