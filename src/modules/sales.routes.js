const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const { permission } = require('../middleware/permission');

const router = express.Router();

// ============ QUOTATIONS ============

router.get('/quotations', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (q.quotation_number LIKE ? OR c.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND q.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT q.*, c.company_name, c.customer_code
    FROM quotations q
    LEFT JOIN customers c ON c.id = q.customer_id
    ${where}
    ORDER BY q.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/quotations', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, items, valid_until, notes } = req.body;
  
  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.quantity) <= 0 || Number(item.rate) < 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id, positive quantity, and non-negative rate');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const quotationId = uuid();
    const quotationNumber = `QT-${Date.now()}`;
    let totalAmount = 0;
    
    for (const item of items) {
      const qty = Number(item.quantity);
      const rate = Number(item.rate);
      const discount = Number(item.discount_percent || 0);
      const tax = Number(item.gst_rate || 18);
      
      const lineAmount = qty * rate * (1 - discount / 100);
      const lineTax = lineAmount * tax / 100;
      totalAmount += lineAmount + lineTax;
    }
    
    await req.orgDb.query(`
      INSERT INTO quotations(id, quotation_number, customer_id, status, valid_until, notes, total_amount, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, ?, NOW())
    `, {
      replacements: [quotationId, quotationNumber, customer_id, valid_until || null, notes || null, totalAmount],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO quotation_items(id, quotation_id, item_id, quantity, rate, discount_percent, gst_rate)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), quotationId, item.item_id, item.quantity, item.rate, item.discount_percent || 0, item.gst_rate || 18],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: quotationId, quotation_number: quotationNumber, status: 'draft', total_amount: totalAmount });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/quotations/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [quotation] = await req.orgDb.query(`
    SELECT q.*, c.company_name
    FROM quotations q
    LEFT JOIN customers c ON c.id = q.customer_id
    WHERE q.id = ?
  `, { replacements: [req.params.id] });
  
  if (!quotation.length) return fail(res, 404, 'NOT_FOUND', 'Quotation not found');
  
  const [items] = await req.orgDb.query(`
    SELECT qi.*, im.item_code, im.item_name
    FROM quotation_items qi
    LEFT JOIN item_master im ON im.id = qi.item_id
    WHERE qi.quotation_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...quotation[0], items });
}));

router.post('/quotations/:id/convert-to-order', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const [quotation] = await req.orgDb.query('SELECT * FROM quotations WHERE id = ?', { replacements: [req.params.id] });
  if (!quotation.length) return fail(res, 404, 'NOT_FOUND', 'Quotation not found');
  
  if (quotation[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft quotations can be converted to orders');
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const soId = uuid();
    const soNumber = `SO-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO sales_orders(id, so_number, customer_id, status, total_amount, created_at)
      VALUES(?, ?, ?, 'draft', ?, NOW())
    `, {
      replacements: [soId, soNumber, quotation[0].customer_id, quotation[0].total_amount],
      transaction: tx
    });
    
    const [items] = await req.orgDb.query('SELECT * FROM quotation_items WHERE quotation_id = ?', { replacements: [req.params.id], transaction: tx });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO sales_order_items(id, so_id, item_id, quantity, rate, discount_percent, gst_rate)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), soId, item.item_id, item.quantity, item.rate, item.discount_percent, item.gst_rate],
        transaction: tx
      });
    }
    
    await req.orgDb.query('UPDATE quotations SET status = ? WHERE id = ?', {
      replacements: ['converted', req.params.id],
      transaction: tx
    });
    
    await tx.commit();
    return created(res, { id: soId, so_number: soNumber, status: 'draft' }, 'Quotation converted to sales order');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ SALES ORDERS ============

router.get('/orders', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (search) {
    where += ' AND (so.so_number LIKE ? OR c.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    where += ' AND so.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT so.*, c.company_name, c.customer_code
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    ${where}
    ORDER BY so.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/orders', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, items, notes } = req.body;

  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }

  for (const item of items) {
    if (!item.item_id || Number(item.quantity) <= 0 || Number(item.rate) < 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id, positive quantity, and non-negative rate');
    }
  }

  const tx = await req.orgDb.transaction();
  try {
    const soId = uuid();
    const soNumber = `SO-${Date.now()}`;
    let totalAmount = 0;

    for (const item of items) {
      const qty = Number(item.quantity);
      const rate = Number(item.rate);
      const discount = Number(item.discount_percent || 0);
      const gst = Number(item.gst_rate || 18);
      const lineAmount = qty * rate * (1 - discount / 100);
      totalAmount += lineAmount + lineAmount * gst / 100;
    }

    await req.orgDb.query(`
      INSERT INTO sales_orders(id, so_number, customer_id, status, total_amount, notes, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [soId, soNumber, customer_id, totalAmount, notes || null],
      transaction: tx
    });

    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO sales_order_items(id, so_id, item_id, quantity, rate, discount_percent, gst_rate)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), soId, item.item_id, item.quantity, item.rate, item.discount_percent || 0, item.gst_rate || 18],
        transaction: tx
      });
    }

    await tx.commit();
    return created(res, { id: soId, so_number: soNumber, status: 'draft', total_amount: totalAmount });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/orders/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [order] = await req.orgDb.query(`
    SELECT so.*, c.company_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ?
  `, { replacements: [req.params.id] });
  
  if (!order.length) return fail(res, 404, 'NOT_FOUND', 'Sales order not found');
  
  const [items] = await req.orgDb.query(`
    SELECT soi.*, im.item_code, im.item_name
    FROM sales_order_items soi
    LEFT JOIN item_master im ON im.id = soi.item_id
    WHERE soi.so_id = ?
  `, { replacements: [req.params.id] });
  
  return ok(res, { ...order[0], items });
}));

router.post('/orders/:id/confirm', permission('sales', 'can_approve'), asyncHandler(async (req, res) => {
  const [order] = await req.orgDb.query('SELECT status FROM sales_orders WHERE id = ?', { replacements: [req.params.id] });
  if (!order.length) return fail(res, 404, 'NOT_FOUND', 'Sales order not found');
  
  if (order[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft orders can be confirmed');
  }
  
  await req.orgDb.query('UPDATE sales_orders SET status = ? WHERE id = ?', {
    replacements: ['confirmed', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'confirmed' }, 'Sales order confirmed');
}));

router.post('/orders/:id/cancel', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const [order] = await req.orgDb.query('SELECT status FROM sales_orders WHERE id = ?', { replacements: [req.params.id] });
  if (!order.length) return fail(res, 404, 'NOT_FOUND', 'Sales order not found');
  
  if (!['draft', 'confirmed'].includes(order[0].status)) {
    return fail(res, 400, 'INVALID_STATE', 'Cannot cancel order in current status');
  }
  
  await req.orgDb.query('UPDATE sales_orders SET status = ? WHERE id = ?', {
    replacements: ['cancelled', req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'cancelled' }, 'Sales order cancelled');
}));

// ============ DELIVERY CHALLANS ============

router.get('/delivery-challans', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (status) {
    where += ' AND dc.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM delivery_challans dc ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT dc.*, c.company_name, so.so_number
    FROM delivery_challans dc
    LEFT JOIN customers c ON c.id = dc.customer_id
    LEFT JOIN sales_orders so ON so.id = dc.so_id
    ${where}
    ORDER BY dc.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/delivery-challans', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, so_id, items, warehouse_id, delivery_date, notes } = req.body;
  
  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
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
    const challanId = uuid();
    const challanNumber = `DC-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO delivery_challans(id, challan_number, customer_id, so_id, warehouse_id, status, delivery_date, notes, created_at)
      VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [challanId, challanNumber, customer_id, so_id || null, warehouse_id || null, delivery_date || null, notes || null],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO delivery_challan_items(id, challan_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), challanId, item.item_id, item.quantity, item.rate || 0],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: challanId, challan_number: challanNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ SALES RETURNS ============

router.get('/returns', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  let where = 'WHERE 1=1';
  const replacements = [];

  if (search) {
    where += ' AND (sr.return_number LIKE ? OR c.company_name LIKE ?)';
    replacements.push(`%${search}%`, `%${search}%`);
  }

  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM sales_returns sr LEFT JOIN customers c ON c.id = sr.customer_id ${where}`,
    { replacements }
  );

  const [rows] = await req.orgDb.query(`
    SELECT sr.*, c.company_name
    FROM sales_returns sr
    LEFT JOIN customers c ON c.id = sr.customer_id
    ${where}
    ORDER BY sr.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });

  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/returns', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  const { customer_id, so_id, items, warehouse_id, reason, notes } = req.body;

  if (!customer_id) return fail(res, 400, 'VALIDATION_ERROR', 'customer_id is required');
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
    const returnNumber = `SR-RET-${Date.now()}`;

    await req.orgDb.query(`
      INSERT INTO sales_returns(id, return_number, customer_id, so_id, warehouse_id, status, reason, notes, created_at)
      VALUES(?, ?, ?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [returnId, returnNumber, customer_id, so_id || null, warehouse_id || null, reason || null, notes || null],
      transaction: tx
    });

    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO sales_return_items(id, return_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), returnId, item.item_id, item.return_qty, item.rate || 0],
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

router.get('/returns/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [ret] = await req.orgDb.query(`
    SELECT sr.*, c.company_name
    FROM sales_returns sr
    LEFT JOIN customers c ON c.id = sr.customer_id
    WHERE sr.id = ?
  `, { replacements: [req.params.id] });

  if (!ret.length) return fail(res, 404, 'NOT_FOUND', 'Sales return not found');

  const [items] = await req.orgDb.query(`
    SELECT sri.*, im.item_code, im.item_name
    FROM sales_return_items sri
    LEFT JOIN item_master im ON im.id = sri.item_id
    WHERE sri.return_id = ?
  `, { replacements: [req.params.id] });

  return ok(res, { ...ret[0], items });
}));

router.post('/returns/:id/post', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const [ret] = await req.orgDb.query('SELECT status, warehouse_id FROM sales_returns WHERE id = ?', { replacements: [req.params.id] });
  if (!ret.length) return fail(res, 404, 'NOT_FOUND', 'Sales return not found');

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
    
    const [items] = await req.orgDb.query('SELECT * FROM sales_return_items WHERE return_id = ?', { replacements: [req.params.id], transaction: tx });

    for (const item of items) {

      // Increase stock (customer returning goods)
      const [result] = await req.orgDb.query(`
        INSERT INTO stock_summary(item_id, warehouse_id, current_qty, avg_rate, total_value, last_updated)
        VALUES(?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          current_qty = current_qty + ?,
          total_value = total_value + ?,
          last_updated = NOW()
      `, {
        replacements: [item.item_id, warehouseId, item.quantity, item.rate, item.quantity * item.rate, item.quantity, item.quantity * item.rate],
        transaction: tx
      });
      
      if (!result.affectedRows) {
        await tx.rollback();
        return fail(res, 400, 'STOCK_UPDATE_FAILED', `Failed to update stock for item ${item.item_id}`);
      }

      // Create stock ledger entry
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_in, transaction_date)
        VALUES(?, ?, ?, 'sales_return', 'sales_return', ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, warehouseId, req.params.id, item.quantity],
        transaction: tx
      });
    }

    await req.orgDb.query('UPDATE sales_returns SET status = ?, posted_at = NOW() WHERE id = ?', {
      replacements: ['posted', req.params.id],
      transaction: tx
    });

    await tx.commit();
    return ok(res, { id: req.params.id, status: 'posted' }, 'Sales return posted and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.get('/invoices', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1)), limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
  const search = String(req.query.search || '').trim(), where = search ? ' WHERE i.invoice_number LIKE ? OR c.company_name LIKE ?' : '';
  const values = search ? [`%${search}%`, `%${search}%`] : [];
  const [[count]] = await req.orgDb.query(`SELECT COUNT(*) total FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id${where}`, { replacements: values });
  const [rows] = await req.orgDb.query(`SELECT i.*,c.company_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`, { replacements: [...values, limit, (page-1)*limit] });
  return ok(res, rows, 'Invoices fetched', { page, limit, total: Number(count.total || 0) });
}));
router.post('/invoices', permission('sales', 'can_create'), asyncHandler(async (req, res) => {
  if (!req.body.invoice_number || !req.body.customer_id || !req.body.invoice_date) return fail(res, 400, 'VALIDATION_ERROR', 'invoice_number, customer_id and invoice_date are required');
  const id = uuid(), total = Number(req.body.total_amount || 0); if (!Number.isFinite(total) || total < 0) return fail(res, 400, 'VALIDATION_ERROR', 'total_amount must be non-negative');
  await req.orgDb.query('INSERT INTO invoices(id,invoice_number,customer_id,invoice_date,status,total_amount,balance_amount,sales_order_id,due_date) VALUES(?,?,?,?,?,?,?,?,?)', { replacements: [id,req.body.invoice_number,req.body.customer_id,req.body.invoice_date,'draft',total,total,req.body.sales_order_id||null,req.body.due_date||null] });
  return created(res, { id, invoice_number:req.body.invoice_number, total_amount:total, balance_amount:total, status:'draft' });
}));
router.get('/invoices/:id', permission('sales', 'can_view'), asyncHandler(async (req, res) => {
  const [[invoice]] = await req.orgDb.query('SELECT i.*,c.company_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.id=?', { replacements:[req.params.id] });
  if (!invoice) return fail(res,404,'NOT_FOUND','Invoice not found');
  const [items] = await req.orgDb.query('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY id', { replacements:[req.params.id] });
  const [payments] = await req.orgDb.query('SELECT * FROM invoice_payments WHERE invoice_id=? ORDER BY created_at DESC', { replacements:[req.params.id] });
  return ok(res,{ ...invoice,items,payments });
}));

router.post('/delivery-challans/:id/dispatch', permission('sales', 'can_edit'), asyncHandler(async (req, res) => {
  const [challan] = await req.orgDb.query('SELECT status, warehouse_id, customer_id FROM delivery_challans WHERE id = ?', { replacements: [req.params.id] });
  if (!challan.length) return fail(res, 404, 'NOT_FOUND', 'Delivery challan not found');
  
  if (challan[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft challans can be dispatched');
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const warehouseId = challan[0].warehouse_id;
    if (!warehouseId) {
      await tx.rollback();
      return fail(res, 400, 'MISSING_WAREHOUSE', 'Warehouse is required');
    }
    
    const [items] = await req.orgDb.query('SELECT * FROM delivery_challan_items WHERE challan_id = ?', { replacements: [req.params.id], transaction: tx });
    
    for (const item of items) {
      
      // Check stock exists and is sufficient
      const [stock] = await req.orgDb.query('SELECT current_qty FROM stock_summary WHERE item_id = ? AND warehouse_id = ?', { replacements: [item.item_id, warehouseId], transaction: tx });
      
      if (!stock.length || stock[0].current_qty < item.quantity) {
        await tx.rollback();
        return fail(res, 400, 'INSUFFICIENT_STOCK', `Insufficient stock for item ${item.item_id}`);
      }
      
      // Decrease inventory
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
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_out, transaction_date)
        VALUES(?, ?, ?, 'sales_dispatch', 'delivery_challan', ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, warehouseId, req.params.id, item.quantity],
        transaction: tx
      });
    }
    
    await req.orgDb.query('UPDATE delivery_challans SET status = ?, dispatched_at = NOW() WHERE id = ?', {
      replacements: ['dispatched', req.params.id],
      transaction: tx
    });
    
    await tx.commit();
    return ok(res, { id: req.params.id, status: 'dispatched' }, 'Delivery challan dispatched and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

module.exports = router;
