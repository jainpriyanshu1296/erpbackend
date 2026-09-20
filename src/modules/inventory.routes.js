const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const { permission } = require('../middleware/permission');

const router = express.Router();

// ============ STOCK TRANSFERS ============

router.get('/transfers', permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (status) {
    where += ' AND wt.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM warehouse_transfers wt ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT wt.*, wf.warehouse_name as from_warehouse, wto.warehouse_name as to_warehouse
    FROM warehouse_transfers wt
    LEFT JOIN warehouses wf ON wf.id = wt.from_warehouse_id
    LEFT JOIN warehouses wto ON wto.id = wt.to_warehouse_id
    ${where}
    ORDER BY wt.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/transfers', permission('inventory', 'can_create'), asyncHandler(async (req, res) => {
  const { from_warehouse_id, to_warehouse_id, items } = req.body;
  
  if (!from_warehouse_id || !to_warehouse_id) {
    return fail(res, 400, 'VALIDATION_ERROR', 'from_warehouse_id and to_warehouse_id are required');
  }
  
  if (from_warehouse_id === to_warehouse_id) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Cannot transfer to the same warehouse');
  }
  
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
    const transferId = uuid();
    const transferNumber = `TRF-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO warehouse_transfers(id, transfer_number, from_warehouse_id, to_warehouse_id, status, requested_by, requested_at, created_at)
      VALUES(?, ?, ?, ?, 'draft', ?, NOW(), NOW())
    `, {
      replacements: [transferId, transferNumber, from_warehouse_id, to_warehouse_id, req.user.sub],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO warehouse_transfer_items(id, transfer_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), transferId, item.item_id, item.quantity, item.rate || 0],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: transferId, transfer_number: transferNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.post('/transfers/:id/approve', permission('inventory', 'can_approve'), asyncHandler(async (req, res) => {
  const [transfer] = await req.orgDb.query('SELECT status FROM warehouse_transfers WHERE id = ?', { replacements: [req.params.id] });
  if (!transfer.length) return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
  
  if (transfer[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft transfers can be approved');
  }
  
  await req.orgDb.query('UPDATE warehouse_transfers SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?', {
    replacements: ['approved', req.user.sub, req.params.id]
  });
  
  return ok(res, { id: req.params.id, status: 'approved' }, 'Transfer approved');
}));

router.post('/transfers/:id/post', permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  const [transfer] = await req.orgDb.query('SELECT status, from_warehouse_id, to_warehouse_id FROM warehouse_transfers WHERE id = ?', { replacements: [req.params.id] });
  if (!transfer.length) return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
  
  if (transfer[0].status !== 'approved') {
    return fail(res, 400, 'INVALID_STATE', 'Only approved transfers can be posted');
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const [items] = await req.orgDb.query('SELECT * FROM warehouse_transfer_items WHERE transfer_id = ?', { replacements: [req.params.id], transaction: tx });
    
    for (const item of items) {
      // Decrease from source warehouse
      const [decreaseResult] = await req.orgDb.query(`
        UPDATE stock_summary
        SET current_qty = current_qty - ?,
            total_value = total_value - (? * avg_rate),
            last_updated = NOW()
        WHERE item_id = ? AND warehouse_id = ?
      `, {
        replacements: [item.quantity, item.quantity, item.item_id, transfer[0].from_warehouse_id],
        transaction: tx
      });
      
      if (decreaseResult.affectedRows === 0) {
        await tx.rollback();
        return fail(res, 400, 'INSUFFICIENT_STOCK', `Item ${item.item_id} not found in source warehouse`);
      }
      
      // Increase in destination warehouse
      await req.orgDb.query(`
        INSERT INTO stock_summary(item_id, warehouse_id, current_qty, avg_rate, total_value, last_updated)
        VALUES(?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          current_qty = current_qty + ?,
          total_value = total_value + ?,
          last_updated = NOW()
      `, {
        replacements: [item.item_id, transfer[0].to_warehouse_id, item.quantity, item.rate, item.quantity * item.rate, item.quantity, item.quantity * item.rate],
        transaction: tx
      });
      
      // Create ledger entries
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_out, transaction_date)
        VALUES(?, ?, ?, 'transfer_out', 'transfer', ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, transfer[0].from_warehouse_id, req.params.id, item.quantity],
        transaction: tx
      });
      
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_in, transaction_date)
        VALUES(?, ?, ?, 'transfer_in', 'transfer', ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, transfer[0].to_warehouse_id, req.params.id, item.quantity],
        transaction: tx
      });
    }
    
    await req.orgDb.query('UPDATE warehouse_transfers SET status = ?, received_by = ?, received_at = NOW() WHERE id = ?', {
      replacements: ['received', req.user.sub, req.params.id],
      transaction: tx
    });
    
    await tx.commit();
    return ok(res, { id: req.params.id, status: 'received' }, 'Transfer posted and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ STOCK ADJUSTMENTS ============

router.get('/adjustments', permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const status = req.query.status || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (status) {
    where += ' AND sa.status = ?';
    replacements.push(status);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM stock_adjustments sa ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT sa.*, w.warehouse_name
    FROM stock_adjustments sa
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    ${where}
    ORDER BY sa.created_at DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

router.post('/adjustments', permission('inventory', 'can_create'), asyncHandler(async (req, res) => {
  const { warehouse_id, items, reason } = req.body;
  
  if (!warehouse_id) return fail(res, 400, 'VALIDATION_ERROR', 'warehouse_id is required');
  if (!reason) return fail(res, 400, 'VALIDATION_ERROR', 'reason is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || item.quantity === undefined || !['increase', 'decrease'].includes(item.direction)) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id, quantity, and direction (increase/decrease)');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const adjustmentId = uuid();
    const adjustmentNumber = `ADJ-${Date.now()}`;
    
    await req.orgDb.query(`
      INSERT INTO stock_adjustments(id, adjustment_number, warehouse_id, status, reason, created_by, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, NOW())
    `, {
      replacements: [adjustmentId, adjustmentNumber, warehouse_id, reason, req.user.sub],
      transaction: tx
    });
    
    for (const item of items) {
      await req.orgDb.query(`
        INSERT INTO stock_adjustment_items(id, adjustment_id, item_id, direction, quantity, rate)
        VALUES(?, ?, ?, ?, ?, ?)
      `, {
        replacements: [uuid(), adjustmentId, item.item_id, item.direction, item.quantity, item.rate || 0],
        transaction: tx
      });
    }
    
    await tx.commit();
    return created(res, { id: adjustmentId, adjustment_number: adjustmentNumber, status: 'draft' });
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

router.post('/adjustments/:id/post', permission('inventory', 'can_edit'), asyncHandler(async (req, res) => {
  const [adjustment] = await req.orgDb.query('SELECT status, warehouse_id FROM stock_adjustments WHERE id = ?', { replacements: [req.params.id] });
  if (!adjustment.length) return fail(res, 404, 'NOT_FOUND', 'Adjustment not found');
  
  if (adjustment[0].status !== 'draft') {
    return fail(res, 400, 'INVALID_STATE', 'Only draft adjustments can be posted');
  }
  
  const tx = await req.orgDb.transaction();
  try {
    const [items] = await req.orgDb.query('SELECT * FROM stock_adjustment_items WHERE adjustment_id = ?', { replacements: [req.params.id], transaction: tx });
    
    for (const item of items) {
      const qtyChange = item.direction === 'increase' ? item.quantity : -item.quantity;
      
      // Update stock summary
      await req.orgDb.query(`
        INSERT INTO stock_summary(item_id, warehouse_id, current_qty, avg_rate, total_value, last_updated)
        VALUES(?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          current_qty = current_qty + ?,
          total_value = total_value + ?,
          last_updated = NOW()
      `, {
        replacements: [item.item_id, adjustment[0].warehouse_id, qtyChange, item.rate, qtyChange * item.rate, qtyChange, qtyChange * item.rate],
        transaction: tx
      });
      
      // Create ledger entry
      const transactionType = item.direction === 'increase' ? 'adjustment_in' : 'adjustment_out';
      const qtyIn = item.direction === 'increase' ? item.quantity : 0;
      const qtyOut = item.direction === 'decrease' ? item.quantity : 0;
      
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, reference_type, reference_id, qty_in, qty_out, transaction_date)
        VALUES(?, ?, ?, ?, 'adjustment', ?, ?, ?, NOW())
      `, {
        replacements: [uuid(), item.item_id, adjustment[0].warehouse_id, transactionType, req.params.id, qtyIn, qtyOut],
        transaction: tx
      });
    }
    
    await req.orgDb.query('UPDATE stock_adjustments SET status = ?, posted_at = NOW(), posted_by = ? WHERE id = ?', {
      replacements: ['posted', req.user.sub, req.params.id],
      transaction: tx
    });
    
    await tx.commit();
    return ok(res, { id: req.params.id, status: 'posted' }, 'Adjustment posted and inventory updated');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ STOCK LEDGER ============

router.get('/ledger', permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Number(req.query.limit || 20));
  const itemId = req.query.item_id || '';
  const warehouseId = req.query.warehouse_id || '';
  const transactionType = req.query.transaction_type || '';
  
  let where = 'WHERE 1=1';
  const replacements = [];
  
  if (itemId) {
    where += ' AND sl.item_id = ?';
    replacements.push(itemId);
  }
  if (warehouseId) {
    where += ' AND sl.warehouse_id = ?';
    replacements.push(warehouseId);
  }
  if (transactionType) {
    where += ' AND sl.transaction_type = ?';
    replacements.push(transactionType);
  }
  
  const [[count]] = await req.orgDb.query(
    `SELECT COUNT(*) AS total FROM stock_ledger sl ${where}`,
    { replacements }
  );
  
  const [rows] = await req.orgDb.query(`
    SELECT sl.*, im.item_code, im.item_name, w.warehouse_name
    FROM stock_ledger sl
    LEFT JOIN item_master im ON im.id = sl.item_id
    LEFT JOIN warehouses w ON w.id = sl.warehouse_id
    ${where}
    ORDER BY sl.transaction_date DESC
    LIMIT ? OFFSET ?
  `, { replacements: [...replacements, limit, (page - 1) * limit] });
  
  return ok(res, rows, 'Fetched successfully', { page, limit, total: Number(count.total || 0) });
}));

// ============ OPENING STOCK ============

router.post('/opening-stock', permission('inventory', 'can_create'), asyncHandler(async (req, res) => {
  const { warehouse_id, items, opening_date } = req.body;
  
  if (!warehouse_id) return fail(res, 400, 'VALIDATION_ERROR', 'warehouse_id is required');
  if (!items || !Array.isArray(items) || items.length === 0) {
    return fail(res, 400, 'VALIDATION_ERROR', 'At least one item is required');
  }
  
  for (const item of items) {
    if (!item.item_id || Number(item.quantity) < 0 || Number(item.rate) < 0) {
      return fail(res, 400, 'VALIDATION_ERROR', 'Each item must have item_id, non-negative quantity and rate');
    }
  }
  
  const tx = await req.orgDb.transaction();
  try {
    for (const item of items) {
      // Check if opening stock already exists
      const [existing] = await req.orgDb.query(`
        SELECT id FROM stock_ledger
        WHERE item_id = ? AND warehouse_id = ? AND transaction_type = 'opening_stock'
      `, { replacements: [item.item_id, warehouse_id], transaction: tx });
      
      if (existing.length) {
        await tx.rollback();
        return fail(res, 400, 'DUPLICATE_OPENING', `Opening stock already exists for item ${item.item_id}`);
      }
      
      // Set opening stock
      await req.orgDb.query(`
        INSERT INTO stock_summary(item_id, warehouse_id, current_qty, avg_rate, total_value, last_updated)
        VALUES(?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          current_qty = ?,
          avg_rate = ?,
          total_value = ?,
          last_updated = NOW()
      `, {
        replacements: [item.item_id, warehouse_id, item.quantity, item.rate, item.quantity * item.rate, item.quantity, item.rate, item.quantity * item.rate],
        transaction: tx
      });
      
      // Create ledger entry
      await req.orgDb.query(`
        INSERT INTO stock_ledger(id, item_id, warehouse_id, transaction_type, qty_in, rate, amount, transaction_date)
        VALUES(?, ?, ?, 'opening_stock', ?, ?, ?, ?)
      `, {
        replacements: [uuid(), item.item_id, warehouse_id, item.quantity, item.rate, item.quantity * item.rate, opening_date || new Date()],
        transaction: tx
      });
    }
    
    await tx.commit();
    return ok(res, { warehouse_id, items_count: items.length }, 'Opening stock posted');
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}));

// ============ REORDER RECOMMENDATIONS ============

router.get('/reorder', permission('inventory', 'can_view'), asyncHandler(async (req, res) => {
  const [items] = await req.orgDb.query(`
    SELECT im.id, im.item_code, im.item_name, im.reorder_level, im.reorder_qty,
           COALESCE(SUM(ss.current_qty), 0) as total_stock,
           im.standard_cost
    FROM item_master im
    LEFT JOIN stock_summary ss ON ss.item_id = im.id
    WHERE im.is_active = 1
    GROUP BY im.id
    HAVING total_stock <= im.reorder_level
    ORDER BY total_stock ASC
  `);
  
  return ok(res, items);
}));

module.exports = router;
