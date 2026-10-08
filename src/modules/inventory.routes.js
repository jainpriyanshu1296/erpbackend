const express = require('express');
const { v4: uuid } = require('uuid');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const permission = require('../middleware/permission');

const router = express.Router();
router.use(require('../middleware/moduleGuard')('inventory'));
const listQuery = require('../utils/listQuery');

// Category membership remains item_master.category. Empty and inactive groups
// are stored in the existing tenant settings namespace.
const categorySource = `(SELECT SUBSTRING(setting_key,20) category,CAST(setting_value AS UNSIGNED) is_active FROM company_settings WHERE setting_key LIKE 'inventory.category.%' UNION ALL SELECT DISTINCT category,1 FROM item_master im WHERE category IS NOT NULL AND category<>'' AND NOT EXISTS(SELECT 1 FROM company_settings cs WHERE cs.setting_key=CONCAT('inventory.category.',im.category))) categories`;
router.get(
  '/categories',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } = listQuery(
      req.query,
      ['category', 'is_active'],
    );
    const filters = search ? ['category LIKE ?'] : [],
      values = search ? [`%${search}%`] : [];
    if (req.query.is_active !== undefined) {
      if (!['0', '1'].includes(req.query.is_active)) {
        return fail(res, 400, 'VALIDATION_ERROR', 'Invalid active filter');
      }
      filters.push('is_active=?');
      values.push(Number(req.query.is_active));
    }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM ${categorySource}${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT category id,category,is_active FROM ${categorySource}${where} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Item groups fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
for (const method of ['post', 'put', 'patch']) {
  router[method](
    method === 'post' ? '/categories' : '/categories/:id',
    permission('inventory', method === 'post' ? 'can_create' : 'can_edit'),
    asyncHandler(async (req, res) => {
      const category =
        typeof req.body.category === 'string' ? req.body.category.trim() : '';
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,29}$/.test(category) ||
        (req.body.is_active !== undefined &&
          req.body.is_active !== '' &&
          ![0, 1, '0', '1'].includes(req.body.is_active))
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Category must contain 1–30 letters, numbers, spaces, underscores or hyphens',
        );
      }
      const active =
        req.body.is_active === '' || req.body.is_active === undefined
          ? 1
          : Number(req.body.is_active);
      const tx = await req.orgDb.transaction();
      try {
        const [[old]] = await req.orgDb.query(
          `SELECT category FROM ${categorySource} WHERE category=?`,
          { replacements: [req.params.id || category], transaction: tx },
        );
        if (method === 'post' && old) {
          throw Object.assign(new Error('Category already exists'), {
            status: 409,
            code: 'CONFLICT',
          });
        }
        if (method !== 'post' && !old) {
          throw Object.assign(new Error('Category not found'), {
            status: 404,
            code: 'NOT_FOUND',
          });
        }
        if (method !== 'post' && req.params.id !== category) {
          const [[target]] = await req.orgDb.query(
            `SELECT category FROM ${categorySource} WHERE category=?`,
            { replacements: [category], transaction: tx },
          );
          if (target) {
            throw Object.assign(new Error('Category already exists'), {
              status: 409,
              code: 'CONFLICT',
            });
          }
          await req.orgDb.query(
            'UPDATE item_master SET category=? WHERE category=?',
            { replacements: [category, req.params.id], transaction: tx },
          );
          await req.orgDb.query(
            'DELETE FROM company_settings WHERE setting_key=?',
            {
              replacements: [`inventory.category.${req.params.id}`],
              transaction: tx,
            },
          );
        }
        await req.orgDb.query(
          'INSERT INTO company_settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
          {
            replacements: [`inventory.category.${category}`, String(active)],
            transaction: tx,
          },
        );
        await tx.commit();
        return ok(res, { id: category, category, is_active: active });
      } catch (cause) {
        await tx.rollback();
        throw cause;
      }
    }),
  );
}

router.get(
  '/categories/:id',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[row]] = await req.orgDb.query(
      `SELECT category id,category,is_active FROM ${categorySource} WHERE category=?`,
      { replacements: [req.params.id] },
    );
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Category not found');
    return ok(res, row);
  }),
);
router.delete(
  '/categories/:id',
  permission('inventory', 'can_delete'),
  asyncHandler(async (req, res) => {
    const result = await req.orgDb.transaction(async (transaction) => {
      const [[row]] = await req.orgDb.query(
        `SELECT category FROM ${categorySource} WHERE category=?`,
        { replacements: [req.params.id], transaction },
      );
      if (!row)
        throw Object.assign(new Error('Category not found'), {
          status: 404,
          code: 'NOT_FOUND',
        });
      await req.orgDb.query(
        'INSERT INTO company_settings(setting_key,setting_value) VALUES(?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)',
        {
          replacements: [`inventory.category.${req.params.id}`, '0'],
          transaction,
        },
      );
      await require('./inventoryPurchase.service').audit(
        req.orgDb,
        req.user.sub,
        'inventory',
        'category.deactivated',
        'category',
        req.params.id,
        {},
        transaction,
      );
      return { id: req.params.id, is_active: 0 };
    });
    return ok(res, result);
  }),
);
router.get(
  '/uom',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } = listQuery(
      req.query,
      ['uom_code', 'uom_name', 'id'],
    );
    const filters = [],
      values = [];
    if (search) {
      filters.push('(uom_code LIKE ? OR uom_name LIKE ?)');
      values.push(`%${search}%`, `%${search}%`);
    }
    if (req.query.is_active !== undefined) {
      if (!['0', '1'].includes(req.query.is_active)) {
        return fail(res, 400, 'VALIDATION_ERROR', 'Invalid active filter');
      }
      filters.push('is_active=?');
      values.push(Number(req.query.is_active));
    }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM uom_master${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT * FROM uom_master${where} ORDER BY ${sort} ${direction},id LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Units fetched', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);
router.get(
  '/uom/:id',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[row]] = await req.orgDb.query(
      'SELECT * FROM uom_master WHERE id=?',
      { replacements: [req.params.id] },
    );
    return row ? ok(res, row) : fail(res, 404, 'NOT_FOUND', 'Unit not found');
  }),
);
for (const method of ['post', 'put', 'patch']) {
  router[method](
    method === 'post' ? '/uom' : '/uom/:id',
    permission('inventory', method === 'post' ? 'can_create' : 'can_edit'),
    asyncHandler(async (req, res) => {
      const { uom_code: code, uom_name: name } = req.body;
      if (
        typeof code !== 'string' ||
        !code.trim() ||
        code.length > 20 ||
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 100 ||
        (req.body.is_active !== undefined &&
          req.body.is_active !== '' &&
          ![0, 1, '0', '1'].includes(req.body.is_active))
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Unit code, name and valid active state are required',
        );
      }
      const active =
        req.body.is_active === undefined || req.body.is_active === ''
          ? 1
          : Number(req.body.is_active);
      if (method !== 'post') {
        const [[existing]] = await req.orgDb.query(
          'SELECT id FROM uom_master WHERE id=?',
          { replacements: [req.params.id] },
        );
        if (!existing) {
          return fail(res, 404, 'NOT_FOUND', 'Unit not found');
        }
        await req.orgDb.query(
          'UPDATE uom_master SET uom_code=?,uom_name=?,is_active=? WHERE id=?',
          { replacements: [code.trim(), name.trim(), active, req.params.id] },
        );
        return ok(res, {
          id: req.params.id,
          uom_code: code.trim(),
          uom_name: name.trim(),
          is_active: active,
        });
      }
      await req.orgDb.query(
        'INSERT INTO uom_master(uom_code,uom_name,is_active) VALUES(?,?,?)',
        { replacements: [code.trim(), name.trim(), active] },
      );
      const [[inserted]] = await req.orgDb.query(
        'SELECT id FROM uom_master WHERE uom_code=?',
        { replacements: [code.trim()] },
      );
      return created(res, {
        id: inserted.id,
        uom_code: code.trim(),
        uom_name: name.trim(),
        is_active: active,
      });
    }),
  );
}

router.get(
  '/reports',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } = listQuery(
      req.query,
      ['item_code', 'item_name', 'current_qty', 'total_value'],
    );
    const where = search
      ? ' WHERE im.item_code LIKE ? OR im.item_name LIKE ?'
      : '';
    const values = search ? [`%${search}%`, `%${search}%`] : [];
    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) total FROM item_master im${where}`,
      { replacements: values },
    );
    const [rows] = await req.orgDb.query(
      `SELECT im.id,im.item_code,im.item_name,im.reorder_level,COALESCE(SUM(ss.current_qty),0) current_qty,COALESCE(SUM(ss.total_value),0) total_value FROM item_master im LEFT JOIN stock_summary ss ON ss.item_id=im.id${where} GROUP BY im.id ORDER BY ${sort} ${direction},im.id LIMIT ? OFFSET ?`,
      { replacements: [...values, limit, offset] },
    );
    return ok(res, rows, 'Stock valuation', {
      page,
      limit,
      total: Number(count.total),
    });
  }),
);

// ============ STOCK TRANSFERS ============

router.get(
  '/transfers',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } = listQuery(
      req.query,
      ['created_at', 'transfer_number', 'status'],
      'created_at',
    );
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const sortColumn = {
      created_at: 'wt.created_at',
      transfer_number: 'wt.transfer_number',
      status: 'wt.status',
    }[sort];

    let where = 'WHERE 1=1';
    const replacements = [];

    if (status) {
      where += ' AND wt.status = ?';
      replacements.push(status);
    }
    if (search) {
      where += ' AND (wt.transfer_number LIKE ? OR wt.id LIKE ?)';
      replacements.push(`%${search}%`, `%${search}%`);
    }

    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM warehouse_transfers wt ${where}`,
      { replacements },
    );

    const [rows] = await req.orgDb.query(
      `
    SELECT wt.*, wf.warehouse_name as from_warehouse, wto.warehouse_name as to_warehouse
    FROM warehouse_transfers wt
    LEFT JOIN warehouses wf ON wf.id = wt.from_warehouse_id
    LEFT JOIN warehouses wto ON wto.id = wt.to_warehouse_id
    ${where}
    ORDER BY ${sortColumn} ${req.query.direction ? direction : 'DESC'}, wt.id DESC
    LIMIT ? OFFSET ?
  `,
      { replacements: [...replacements, limit, offset] },
    );

    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);
router.get(
  '/transfers/:id',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[transfer]] = await req.orgDb.query(
      'SELECT * FROM warehouse_transfers WHERE id=?',
      { replacements: [req.params.id] },
    );
    if (!transfer) {
      return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
    }
    const [items] = await req.orgDb.query(
      'SELECT wti.*,im.item_code,im.item_name FROM warehouse_transfer_items wti JOIN item_master im ON im.id=wti.item_id WHERE wti.transfer_id=? ORDER BY wti.id',
      { replacements: [req.params.id] },
    );
    return ok(res, { ...transfer, items });
  }),
);

router.post(
  '/transfers',
  permission('inventory', 'can_create'),
  asyncHandler(async (req, res) => {
    const { from_warehouse_id, to_warehouse_id, items } = req.body;

    if (!from_warehouse_id || !to_warehouse_id) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'from_warehouse_id and to_warehouse_id are required',
      );
    }

    if (from_warehouse_id === to_warehouse_id) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'Cannot transfer to the same warehouse',
      );
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'At least one item is required',
      );
    }

    for (const item of items) {
      if (
        !item.item_id ||
        !Number.isFinite(Number(item.quantity)) ||
        Number(item.quantity) <= 0
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Each item must have item_id and positive quantity',
        );
      }
    }

    const tx = await req.orgDb.transaction();
    try {
      const transferId = uuid();
      const transferNumber = `TRF-${Date.now()}-${transferId.slice(0, 8)}`;
      const [warehouses] = await req.orgDb.query(
        'SELECT id FROM warehouses WHERE id IN (?,?) AND is_active=1',
        {
          replacements: [from_warehouse_id, to_warehouse_id],
          transaction: tx,
        },
      );
      if (warehouses.length !== 2) {
        throw Object.assign(new Error('Choose two active warehouses'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      const itemIds = [...new Set(items.map((item) => item.item_id))];
      const [activeItems] = await req.orgDb.query(
        `SELECT id FROM item_master WHERE id IN (${itemIds.map(() => '?').join(',')}) AND is_active=1`,
        { replacements: itemIds, transaction: tx },
      );
      if (activeItems.length !== itemIds.length) {
        throw Object.assign(new Error('Choose active Item Master records'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      await req.orgDb.query(
        `
      INSERT INTO warehouse_transfers(id, transfer_number, from_warehouse_id, to_warehouse_id, status, requested_by, requested_at, created_at)
      VALUES(?, ?, ?, ?, 'draft', ?, NOW(), NOW())
    `,
        {
          replacements: [
            transferId,
            transferNumber,
            from_warehouse_id,
            to_warehouse_id,
            req.user.sub,
          ],
          transaction: tx,
        },
      );

      for (const item of items) {
        await req.orgDb.query(
          `
        INSERT INTO warehouse_transfer_items(id, transfer_id, item_id, quantity, rate)
        VALUES(?, ?, ?, ?, ?)
      `,
          {
            replacements: [
              uuid(),
              transferId,
              item.item_id,
              item.quantity,
              item.rate || 0,
            ],
            transaction: tx,
          },
        );
      }

      await tx.commit();
      return created(res, {
        id: transferId,
        transfer_number: transferNumber,
        status: 'draft',
      });
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);

router.post(
  '/transfers/:id/approve',
  permission('inventory', 'can_approve'),
  asyncHandler(async (req, res) => {
    const result = await req.orgDb.transaction(async (transaction) => {
      const [[transfer]] = await req.orgDb.query(
        'SELECT status FROM warehouse_transfers WHERE id=? FOR UPDATE',
        { replacements: [req.params.id], transaction },
      );
      if (!transfer) return 'NOT_FOUND';
      if (transfer.status !== 'draft') return 'INVALID_STATE';

      await req.orgDb.query(
        'UPDATE warehouse_transfers SET status=?,approved_by=?,approved_at=NOW() WHERE id=?',
        {
          replacements: ['approved', req.user.sub, req.params.id],
          transaction,
        },
      );
      await req.orgDb.query(
        'INSERT INTO audit_events(id,user_id,module,event_type,entity_type,entity_id,payload) VALUES(?,?,?,?,?,?,?)',
        {
          replacements: [
            uuid(),
            req.user.sub,
            'inventory',
            'inventory.transfer.approve',
            'warehouse_transfer',
            req.params.id,
            JSON.stringify({ from: 'draft', to: 'approved' }),
          ],
          transaction,
        },
      );
      return 'approved';
    });
    if (result === 'NOT_FOUND') {
      return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
    }
    if (result === 'INVALID_STATE') {
      return fail(
        res,
        409,
        'INVALID_STATE',
        'Only draft transfers can be approved',
      );
    }
    return ok(
      res,
      { id: req.params.id, status: 'approved' },
      'Transfer approved',
    );
  }),
);

router.post(
  '/transfers/:id/post',
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await require('./inventoryPurchase.service').receiveTransfer(
      req.orgDb,
      req.params.id,
      req.user.sub,
    );
    if (result.error) {
      return fail(
        res,
        result.error === 'NOT_FOUND' ? 404 : 409,
        result.error,
        'Unable to post transfer',
      );
    }
    return ok(
      res,
      result,
      result.alreadyReceived
        ? 'Transfer was already posted'
        : 'Transfer posted',
    );
  }),
);

// ============ STOCK ADJUSTMENTS ============

router.get(
  '/adjustments',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } = listQuery(
      req.query,
      ['created_at', 'adjustment_number', 'status'],
      'created_at',
    );
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const sortColumn = {
      created_at: 'sa.created_at',
      adjustment_number: 'sa.adjustment_number',
      status: 'sa.status',
    }[sort];

    let where = 'WHERE 1=1';
    const replacements = [];

    if (status) {
      where += ' AND sa.status = ?';
      replacements.push(status);
    }
    if (search) {
      where += ' AND (sa.adjustment_number LIKE ? OR sa.reason LIKE ?)';
      replacements.push(`%${search}%`, `%${search}%`);
    }

    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM stock_adjustments sa ${where}`,
      { replacements },
    );

    const [rows] = await req.orgDb.query(
      `
    SELECT sa.*, w.warehouse_name
    FROM stock_adjustments sa
    LEFT JOIN warehouses w ON w.id = sa.warehouse_id
    ${where}
    ORDER BY ${sortColumn} ${req.query.direction ? direction : 'DESC'}, sa.id DESC
    LIMIT ? OFFSET ?
  `,
      { replacements: [...replacements, limit, offset] },
    );

    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);

router.post(
  '/adjustments',
  permission('inventory', 'can_create'),
  asyncHandler(async (req, res) => {
    const { warehouse_id, items, reason } = req.body;

    if (!warehouse_id) {
      return fail(res, 400, 'VALIDATION_ERROR', 'warehouse_id is required');
    }
    if (!reason) {
      return fail(res, 400, 'VALIDATION_ERROR', 'reason is required');
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'At least one item is required',
      );
    }

    for (const item of items) {
      if (
        !item.item_id ||
        !Number.isFinite(Number(item.quantity)) ||
        Number(item.quantity) <= 0 ||
        !Number.isFinite(Number(item.rate || 0)) ||
        Number(item.rate || 0) < 0 ||
        !['increase', 'decrease', 'in', 'out'].includes(item.direction)
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Each item must have item_id, quantity, and direction (increase/decrease)',
        );
      }
    }

    const tx = await req.orgDb.transaction();
    try {
      const adjustmentId = uuid();
      const adjustmentNumber = `ADJ-${Date.now()}`;

      await req.orgDb.query(
        `
      INSERT INTO stock_adjustments(id, adjustment_number, warehouse_id, status, reason, created_by, created_at)
      VALUES(?, ?, ?, 'draft', ?, ?, NOW())
    `,
        {
          replacements: [
            adjustmentId,
            adjustmentNumber,
            warehouse_id,
            reason,
            req.user.sub,
          ],
          transaction: tx,
        },
      );

      for (const item of items) {
        await req.orgDb.query(
          `
        INSERT INTO stock_adjustment_items(id, adjustment_id, item_id, direction, quantity, rate)
        VALUES(?, ?, ?, ?, ?, ?)
      `,
          {
            replacements: [
              uuid(),
              adjustmentId,
              item.item_id,
              ['increase', 'in'].includes(item.direction) ? 'in' : 'out',
              item.quantity,
              item.rate || 0,
            ],
            transaction: tx,
          },
        );
      }

      await tx.commit();
      return created(res, {
        id: adjustmentId,
        adjustment_number: adjustmentNumber,
        status: 'draft',
      });
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);

router.post(
  '/adjustments/:id/post',
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    return ok(
      res,
      await require('../services/erp.service').postStockAdjustment(
        req.orgDb,
        { id: req.params.id },
        req.user.sub,
      ),
      'Adjustment posted',
    );
  }),
);

// ============ STOCK LEDGER ============

router.get(
  '/ledger',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const { page, limit, offset, search, sort, direction } = listQuery(
      req.query,
      ['transaction_date', 'transaction_type', 'qty_in', 'qty_out'],
      'transaction_date',
    );
    const sortColumn = {
      transaction_date: 'sl.transaction_date',
      transaction_type: 'sl.transaction_type',
      qty_in: 'sl.qty_in',
      qty_out: 'sl.qty_out',
    }[sort];
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
    if (search) {
      where +=
        ' AND (im.item_code LIKE ? OR im.item_name LIKE ? OR w.warehouse_name LIKE ? OR sl.reference_id LIKE ?)';
      replacements.push(...Array(4).fill(`%${search}%`));
    }

    const [[count]] = await req.orgDb.query(
      `SELECT COUNT(*) AS total FROM stock_ledger sl LEFT JOIN item_master im ON im.id=sl.item_id LEFT JOIN warehouses w ON w.id=sl.warehouse_id ${where}`,
      { replacements },
    );

    const [rows] = await req.orgDb.query(
      `
    SELECT sl.*, im.item_code, im.item_name, w.warehouse_name
    FROM stock_ledger sl
    LEFT JOIN item_master im ON im.id = sl.item_id
    LEFT JOIN warehouses w ON w.id = sl.warehouse_id
    ${where}
    ORDER BY ${sortColumn} ${req.query.direction ? direction : 'DESC'}, sl.id DESC
    LIMIT ? OFFSET ?
  `,
      { replacements: [...replacements, limit, offset] },
    );

    return ok(res, rows, 'Fetched successfully', {
      page,
      limit,
      total: Number(count.total || 0),
    });
  }),
);

// ============ OPENING STOCK ============

router.post(
  '/opening-stock',
  permission('inventory', 'can_create'),
  asyncHandler(async (req, res) => {
    const { warehouse_id, items } = req.body;

    if (!warehouse_id) {
      return fail(res, 400, 'VALIDATION_ERROR', 'warehouse_id is required');
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'At least one item is required',
      );
    }

    for (const item of items) {
      if (
        !item.item_id ||
        !Number.isFinite(Number(item.quantity)) ||
        Number(item.quantity) <= 0 ||
        !Number.isFinite(Number(item.rate)) ||
        Number(item.rate) < 0
      ) {
        return fail(
          res,
          400,
          'VALIDATION_ERROR',
          'Each item must have item_id, positive quantity and non-negative rate',
        );
      }
    }

    const tx = await req.orgDb.transaction();
    try {
      const [[warehouse]] = await req.orgDb.query(
        'SELECT id FROM warehouses WHERE id=? AND is_active=1',
        { replacements: [warehouse_id], transaction: tx },
      );
      if (!warehouse) {
        throw Object.assign(new Error('Choose an active warehouse'), {
          status: 400,
          code: 'VALIDATION_ERROR',
        });
      }

      const seen = new Set();
      for (const item of items) {
        if (seen.has(item.item_id)) {
          throw Object.assign(new Error('Each item may appear only once'), {
            status: 400,
            code: 'VALIDATION_ERROR',
          });
        }
        seen.add(item.item_id);

        const [[activeItem]] = await req.orgDb.query(
          'SELECT id FROM item_master WHERE id=? AND is_active=1',
          { replacements: [item.item_id], transaction: tx },
        );
        if (!activeItem) {
          throw Object.assign(new Error('Choose active Item Master records'), {
            status: 400,
            code: 'VALIDATION_ERROR',
          });
        }
        const [[movement]] = await req.orgDb.query(
          'SELECT id FROM stock_ledger WHERE item_id=? AND warehouse_id=? LIMIT 1',
          { replacements: [item.item_id, warehouse_id], transaction: tx },
        );
        const [[balance]] = await req.orgDb.query(
          'SELECT current_qty FROM stock_summary WHERE item_id=? AND warehouse_id=? FOR UPDATE',
          { replacements: [item.item_id, warehouse_id], transaction: tx },
        );
        if (movement || balance) {
          throw Object.assign(
            new Error('Opening stock cannot replace an existing stock history'),
            { status: 409, code: 'STOCK_ALREADY_INITIALIZED' },
          );
        }

        await require('../services/zeroGapClosure.service').applyStockEffect(
          req.orgDb,
          {
            operationKey: `opening-stock:${warehouse_id}:${item.item_id}`,
            referenceType: 'opening_stock',
            referenceId: warehouse_id,
            itemId: item.item_id,
            warehouseId: warehouse_id,
            quantity: item.quantity,
            rate: item.rate,
            direction: 'in',
            userId: req.user.sub,
            transaction: tx,
          },
        );
      }

      await req.orgDb.query(
        `INSERT INTO audit_events(id,user_id,module,event_type,entity_type,entity_id,payload)
         VALUES(?,?,?,?,?,?,?)`,
        {
          replacements: [
            uuid(),
            req.user.sub,
            'inventory',
            'inventory.opening_stock.post',
            'warehouse',
            warehouse_id,
            JSON.stringify({ item_count: items.length }),
          ],
          transaction: tx,
        },
      );

      await tx.commit();
      return ok(
        res,
        { warehouse_id, items_count: items.length },
        'Opening stock posted',
      );
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }),
);

// ============ REORDER RECOMMENDATIONS ============

router.get(
  '/reorder',
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
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
  }),
);

module.exports = router;
