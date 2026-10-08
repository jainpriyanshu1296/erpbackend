const express = require('express');
const { v4: uuid } = require('uuid');
const { auth } = require('../middleware/auth');
const orgContext = require('../middleware/orgContext');
const entitlement = require('../middleware/entitlement');
const moduleGuard = require('../middleware/moduleGuard');
const permission = require('../middleware/permission');
const { ok, fail, created, asyncHandler } = require('../utils/response');
const listQuery = require('../utils/listQuery');
const service = require('./inventoryPurchase.service');

const router = express.Router();
router.use(auth, orgContext, entitlement);
router.post(
  '/purchase/requisitions/:id/rfq',
  moduleGuard('purchase'),
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) =>
    created(
      res,
      await service.rfqFromRequisition(req.orgDb, req.params.id, req.user.sub),
    ),
  ),
);
router.post(
  '/purchase/rfqs/:id/order',
  moduleGuard('purchase'),
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) =>
    created(
      res,
      await service.orderFromRfq(
        req.orgDb,
        req.params.id,
        req.body.vendor_id,
        req.body.warehouse_id,
        req.user.sub,
      ),
    ),
  ),
);
router.get(
  '/purchase/rfqs/:id/sourcing',
  moduleGuard('purchase'),
  permission('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[rfq]] = await req.orgDb.query('SELECT * FROM rfqs WHERE id=?', {
      replacements: [req.params.id],
    });
    if (!rfq) return fail(res, 404, 'NOT_FOUND', 'RFQ not found');
    const [items] = await req.orgDb.query(
      'SELECT ri.*,im.item_code,im.item_name FROM rfq_items ri JOIN item_master im ON im.id=ri.item_id WHERE ri.rfq_id=? ORDER BY im.item_code',
      { replacements: [rfq.id] },
    );
    const [suppliers] = await req.orgDb.query(
      'SELECT rs.*,v.company_name FROM rfq_suppliers rs JOIN vendors v ON v.id=rs.supplier_id WHERE rs.rfq_id=? ORDER BY v.company_name',
      { replacements: [rfq.id] },
    );
    const [lines] = await req.orgDb.query(
      'SELECT q.* FROM rfq_quotation_lines q JOIN rfq_suppliers rs ON rs.id=q.rfq_supplier_id WHERE rs.rfq_id=? ORDER BY rs.supplier_id,q.item_id',
      { replacements: [rfq.id] },
    );
    return ok(res, { rfq, items, suppliers, lines });
  }),
);
router.post(
  '/purchase/rfqs/:id/suppliers',
  moduleGuard('purchase'),
  permission('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    const vendorId = req.body?.vendor_id;
    if (!vendorId)
      return fail(res, 400, 'VALIDATION_ERROR', 'vendor_id is required');
    const result = await req.orgDb.transaction(async (transaction) => {
      const [[rfq]] = await req.orgDb.query(
        'SELECT id,status FROM rfqs WHERE id=? FOR UPDATE',
        {
          replacements: [req.params.id],
          transaction,
        },
      );
      if (!rfq) return { error: 'NOT_FOUND' };
      if (!['draft', 'requested'].includes(rfq.status))
        return { error: 'INVALID_STATE' };
      const [[vendor]] = await req.orgDb.query(
        'SELECT id FROM vendors WHERE id=? AND is_active=1',
        {
          replacements: [vendorId],
          transaction,
        },
      );
      if (!vendor) return { error: 'INVALID_VENDOR' };
      const [[existing]] = await req.orgDb.query(
        'SELECT id FROM rfq_suppliers WHERE rfq_id=? AND supplier_id=?',
        { replacements: [rfq.id, vendorId], transaction },
      );
      if (existing) return { id: existing.id, already_invited: true };
      const id = uuid();
      await req.orgDb.query(
        'INSERT INTO rfq_suppliers(id,rfq_id,supplier_id) VALUES(?,?,?)',
        { replacements: [id, rfq.id, vendorId], transaction },
      );
      await service.audit(
        req.orgDb,
        req.user.sub,
        'purchase',
        'rfq_supplier_invited',
        'rfq',
        rfq.id,
        { vendor_id: vendorId },
        transaction,
      );
      return { id, vendor_id: vendorId };
    });
    if (result.error)
      return fail(
        res,
        result.error === 'NOT_FOUND' ? 404 : 409,
        result.error,
        'Unable to invite supplier',
      );
    return ok(res, result, 'Supplier invited');
  }),
);
router.put(
  '/purchase/rfqs/:id/suppliers/:vendorId/quote',
  moduleGuard('purchase'),
  permission('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    const lines = req.body?.lines;
    if (
      !Array.isArray(lines) ||
      !lines.length ||
      new Set(lines.map((line) => line.item_id)).size !== lines.length ||
      lines.some(
        (line) =>
          !line.item_id ||
          !Number.isFinite(Number(line.quantity)) ||
          Number(line.quantity) <= 0 ||
          !Number.isFinite(Number(line.unit_price)) ||
          Number(line.unit_price) < 0 ||
          !Number.isFinite(Number(line.tax_rate || 0)) ||
          Number(line.tax_rate || 0) < 0 ||
          Number(line.tax_rate || 0) > 100 ||
          !Number.isSafeInteger(Number(line.delivery_days || 0)) ||
          Number(line.delivery_days || 0) < 0,
      )
    ) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'Quote requires unique items, positive quantities and valid pricing',
      );
    }
    const result = await req.orgDb.transaction(async (transaction) => {
      const [[rfq]] = await req.orgDb.query(
        'SELECT id,status FROM rfqs WHERE id=? FOR UPDATE',
        {
          replacements: [req.params.id],
          transaction,
        },
      );
      if (!rfq) return { error: 'NOT_FOUND' };
      if (!['requested', 'quoted', 'compared'].includes(rfq.status))
        return { error: 'INVALID_STATE' };
      const [[supplier]] = await req.orgDb.query(
        'SELECT id FROM rfq_suppliers WHERE rfq_id=? AND supplier_id=? FOR UPDATE',
        { replacements: [rfq.id, req.params.vendorId], transaction },
      );
      if (!supplier) return { error: 'SUPPLIER_NOT_INVITED' };
      const [requested] = await req.orgDb.query(
        'SELECT item_id,quantity FROM rfq_items WHERE rfq_id=?',
        {
          replacements: [rfq.id],
          transaction,
        },
      );
      const quantities = new Map(
        requested.map((item) => [item.item_id, Number(item.quantity)]),
      );
      if (
        lines.length !== quantities.size ||
        lines.some(
          (line) =>
            !quantities.has(line.item_id) ||
            Number(line.quantity) > quantities.get(line.item_id),
        )
      ) {
        return { error: 'QUOTE_ITEMS_MISMATCH' };
      }
      await req.orgDb.query(
        'DELETE FROM rfq_quotation_lines WHERE rfq_supplier_id=?',
        {
          replacements: [supplier.id],
          transaction,
        },
      );
      for (const line of lines) {
        await req.orgDb.query(
          'INSERT INTO rfq_quotation_lines(id,rfq_supplier_id,item_id,quantity,unit_price,tax_rate,delivery_days,is_selected) VALUES(?,?,?,?,?,?,?,0)',
          {
            replacements: [
              uuid(),
              supplier.id,
              line.item_id,
              Number(line.quantity),
              Number(line.unit_price),
              Number(line.tax_rate || 0),
              Number(line.delivery_days || 0),
            ],
            transaction,
          },
        );
      }
      await req.orgDb.query(
        "UPDATE rfq_suppliers SET status='quoted' WHERE id=?",
        {
          replacements: [supplier.id],
          transaction,
        },
      );
      if (rfq.status === 'requested')
        await req.orgDb.query("UPDATE rfqs SET status='quoted' WHERE id=?", {
          replacements: [rfq.id],
          transaction,
        });
      await service.audit(
        req.orgDb,
        req.user.sub,
        'purchase',
        'rfq_quote_recorded',
        'rfq',
        rfq.id,
        { vendor_id: req.params.vendorId, line_count: lines.length },
        transaction,
      );
      return { id: rfq.id, vendor_id: req.params.vendorId, status: 'quoted' };
    });
    if (result.error)
      return fail(
        res,
        result.error === 'NOT_FOUND' ? 404 : 409,
        result.error,
        'Unable to save supplier quote',
      );
    return ok(res, result, 'Supplier quote saved');
  }),
);
router.post(
  '/purchase/rfqs/:id/select',
  moduleGuard('purchase'),
  permission('purchase', 'can_approve'),
  asyncHandler(async (req, res) => {
    const vendorId = req.body?.vendor_id;
    if (!vendorId)
      return fail(res, 400, 'VALIDATION_ERROR', 'vendor_id is required');
    const result = await req.orgDb.transaction(async (transaction) => {
      const [[rfq]] = await req.orgDb.query(
        'SELECT id,status FROM rfqs WHERE id=? FOR UPDATE',
        {
          replacements: [req.params.id],
          transaction,
        },
      );
      if (!rfq) return { error: 'NOT_FOUND' };
      if (!['quoted', 'compared'].includes(rfq.status))
        return { error: 'INVALID_STATE' };
      const [[supplier]] = await req.orgDb.query(
        'SELECT id FROM rfq_suppliers WHERE rfq_id=? AND supplier_id=?',
        {
          replacements: [rfq.id, vendorId],
          transaction,
        },
      );
      if (!supplier) return { error: 'SUPPLIER_NOT_INVITED' };
      const [[counts]] = await req.orgDb.query(
        'SELECT (SELECT COUNT(*) FROM rfq_items WHERE rfq_id=?) requested,(SELECT COUNT(*) FROM rfq_quotation_lines WHERE rfq_supplier_id=?) quoted',
        { replacements: [rfq.id, supplier.id], transaction },
      );
      if (
        !Number(counts.requested) ||
        Number(counts.requested) !== Number(counts.quoted)
      )
        return { error: 'INCOMPLETE_QUOTE' };
      await req.orgDb.query(
        'UPDATE rfq_quotation_lines q JOIN rfq_suppliers s ON s.id=q.rfq_supplier_id SET q.is_selected=IF(s.supplier_id=?,1,0) WHERE s.rfq_id=?',
        { replacements: [vendorId, rfq.id], transaction },
      );
      await req.orgDb.query("UPDATE rfqs SET status='selected' WHERE id=?", {
        replacements: [rfq.id],
        transaction,
      });
      await service.audit(
        req.orgDb,
        req.user.sub,
        'purchase',
        'rfq_vendor_selected',
        'rfq',
        rfq.id,
        { vendor_id: vendorId },
        transaction,
      );
      return { id: rfq.id, vendor_id: vendorId, status: 'selected' };
    });
    if (result.error)
      return fail(
        res,
        result.error === 'NOT_FOUND' ? 404 : 409,
        result.error,
        'Unable to select supplier',
      );
    return ok(res, result, 'Supplier selected');
  }),
);
const listRoute = (path, table, module) => {
  router.get(
    path,
    moduleGuard(module),
    permission(module, 'can_view'),
    asyncHandler(async (req, res) => {
      const result = await service.list(req.orgDb, table, req.query);
      return ok(res, result.rows, 'Fetched successfully', result.meta);
    }),
  );
  router.get(
    `${path}/:id`,
    moduleGuard(module),
    permission(module, 'can_view'),
    asyncHandler(async (req, res) => {
      const [rows] = await req.orgDb.query(
        `SELECT * FROM ${table} WHERE id=? LIMIT 1`,
        { replacements: [req.params.id] },
      );
      return rows[0]
        ? ok(res, rows[0])
        : fail(res, 404, 'NOT_FOUND', 'Record not found');
    }),
  );
};
// Item Master is deliberately served by the validated implementation in app.js.
// Do not add a generic list route here: this router is mounted after the
// protected router and would otherwise leave two competing definitions.
['purchase_requisitions', 'purchase_orders', 'grn'].forEach((table) => {
  const path =
    table === 'purchase_requisitions'
      ? '/purchase/requisitions'
      : table === 'purchase_orders'
        ? '/purchase/orders'
        : '/purchase/grn';
  if (table === 'grn') {
    listRoute(path, table, 'purchase');
  }
  router.put(
    `${path}/:id/status`,
    moduleGuard('purchase'),
    (req, res, next) =>
      permission(
        'purchase',
        ['approved', 'rejected'].includes(req.body?.status)
          ? 'can_approve'
          : 'can_edit',
      )(req, res, next),
    asyncHandler(async (req, res) => {
      const result = await service.transition(
        req.orgDb,
        table,
        req.params.id,
        req.body?.status,
        req.user?.sub,
      );
      if (result.error === 'NOT_FOUND') {
        return fail(res, 404, 'NOT_FOUND', 'Record not found');
      }
      if (result.error) {
        return fail(
          res,
          409,
          result.error,
          `Invalid status transition from ${result.current}`,
        );
      }
      return ok(res, result, 'Status updated');
    }),
  );
});
router.get(
  '/vendors/:vendorId/items',
  moduleGuard('purchase'),
  permission('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [rows] = await req.orgDb.query(
      'SELECT vi.*, i.item_code, i.item_name FROM vendor_items vi INNER JOIN item_master i ON i.id=vi.item_id WHERE vi.vendor_id=? ORDER BY i.item_name',
      { replacements: [req.params.vendorId] },
    );
    return ok(res, rows);
  }),
);
router.post(
  '/vendors/:vendorId/items',
  moduleGuard('purchase'),
  permission('purchase', 'can_edit'),
  asyncHandler(async (req, res) => {
    if (!req.body?.item_id) {
      return fail(res, 400, 'VALIDATION_ERROR', 'item_id is required');
    }
    await req.orgDb.query(
      `INSERT INTO vendor_items(vendor_id,item_id,vendor_item_code,preferred,last_rate)
     VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE vendor_item_code=VALUES(vendor_item_code),preferred=VALUES(preferred),last_rate=VALUES(last_rate)`,
      {
        replacements: [
          req.params.vendorId,
          req.body.item_id,
          req.body.vendor_item_code || null,
          req.body.preferred ? 1 : 0,
          req.body.last_rate || 0,
        ],
      },
    );
    return ok(
      res,
      { vendor_id: req.params.vendorId, item_id: req.body.item_id },
      'Vendor item saved',
    );
  }),
);
const operationalResources = [
  ['/inventory/reservations', 'stock_reservations', 'inventory'],
  ['/purchase/rfqs', 'rfqs', 'purchase'],
  ['/purchase/supplier-quotations', 'supplier_quotations', 'purchase'],
];
for (const [path, table, module] of operationalResources) {
  router.get(
    path,
    moduleGuard(module),
    permission(module, 'can_view'),
    asyncHandler(async (req, res) => {
      const searchColumns = {
        stock_reservations: ['id', 'reference_id', 'item_id'],
        rfqs: ['rfq_number', 'id'],
        supplier_quotations: ['quotation_number', 'vendor_id', 'id'],
      }[table];
      const sortable = {
        stock_reservations: ['created_at', 'status', 'quantity'],
        rfqs: ['created_at', 'rfq_number', 'status'],
        supplier_quotations: [
          'created_at',
          'quotation_number',
          'status',
          'total_amount',
        ],
      }[table];
      const { page, limit, offset, search, sort, direction } = listQuery(
        req.query,
        sortable,
        'created_at',
      );
      const conditions = [];
      const values = [];
      if (search) {
        conditions.push(
          `(${searchColumns.map((column) => `${column} LIKE ?`).join(' OR ')})`,
        );
        values.push(...searchColumns.map(() => `%${search}%`));
      }
      if (typeof req.query.status === 'string' && req.query.status) {
        conditions.push('status=?');
        values.push(req.query.status);
      }
      const where = conditions.length
        ? ` WHERE ${conditions.join(' AND ')}`
        : '';
      const [[count]] = await req.orgDb.query(
        `SELECT COUNT(*) AS total FROM ${table}${where}`,
        { replacements: values },
      );
      const [rows] = await req.orgDb.query(
        `SELECT * FROM ${table}${where} ORDER BY ${sort} ${req.query.direction ? direction : 'DESC'}, id DESC LIMIT ? OFFSET ?`,
        { replacements: [...values, limit, offset] },
      );
      return ok(res, rows, 'Records fetched', {
        page,
        limit,
        total: Number(count.total || 0),
      });
    }),
  );
  router.get(
    `${path}/:id`,
    moduleGuard(module),
    permission(module, 'can_view'),
    asyncHandler(async (req, res) => {
      const [rows] = await req.orgDb.query(
        `SELECT * FROM ${table} WHERE id=? LIMIT 1`,
        { replacements: [req.params.id] },
      );
      return rows[0]
        ? ok(res, rows[0])
        : fail(res, 404, 'NOT_FOUND', 'Record not found');
    }),
  );
}

router.post(
  '/purchase/rfqs',
  moduleGuard('purchase'),
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) => {
    if (!req.body?.rfq_number) {
      return fail(res, 400, 'VALIDATION_ERROR', 'rfq_number is required');
    }
    const id = req.body.id || require('uuid').v4();
    await req.orgDb.query(
      'INSERT INTO rfqs(id,rfq_number,requested_by) VALUES(?,?,?)',
      { replacements: [id, req.body.rfq_number, req.user.sub] },
    );
    return created(res, {
      id,
      rfq_number: req.body.rfq_number,
      status: 'draft',
    });
  }),
);

router.post(
  '/purchase/supplier-quotations',
  moduleGuard('purchase'),
  permission('purchase', 'can_create'),
  asyncHandler(async (req, res) => {
    const {
      quotation_number: quotationNumber,
      rfq_id: rfqId,
      vendor_id: vendorId,
    } = req.body || {};
    if (!quotationNumber || !rfqId || !vendorId) {
      return fail(
        res,
        400,
        'VALIDATION_ERROR',
        'quotation_number, rfq_id and vendor_id are required',
      );
    }
    const id = req.body.id || require('uuid').v4();
    await req.orgDb.query(
      'INSERT INTO supplier_quotations(id,quotation_number,rfq_id,vendor_id,total_amount) VALUES(?,?,?,?,?)',
      {
        replacements: [
          id,
          quotationNumber,
          rfqId,
          vendorId,
          Number(req.body.total_amount || 0),
        ],
      },
    );
    return created(res, {
      id,
      quotation_number: quotationNumber,
      rfq_id: rfqId,
      vendor_id: vendorId,
      status: 'draft',
    });
  }),
);

router.put(
  '/inventory/transfers/:id/status',
  moduleGuard('inventory'),
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await service.transitionTransfer(
      req.orgDb,
      req.params.id,
      req.body?.status,
      req.user?.sub,
    );
    if (result.error === 'NOT_FOUND') {
      return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
    }
    if (result.error) {
      return fail(
        res,
        409,
        result.error,
        `Invalid status transition from ${result.current}`,
      );
    }
    return ok(res, result, 'Transfer status updated');
  }),
);
router.post(
  '/inventory/transfers/:id/receive',
  moduleGuard('inventory'),
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await service.receiveTransfer(
      req.orgDb,
      req.params.id,
      req.user?.sub,
    );
    if (result.error === 'NOT_FOUND') {
      return fail(res, 404, 'NOT_FOUND', 'Transfer not found');
    }
    if (result.error) {
      return fail(
        res,
        409,
        result.error,
        result.current
          ? `Invalid status transition from ${result.current}`
          : 'Unable to receive transfer',
      );
    }
    return ok(
      res,
      result,
      result.alreadyReceived
        ? 'Transfer was already received'
        : 'Transfer received',
    );
  }),
);
router.post(
  '/inventory/reservations',
  moduleGuard('inventory'),
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await service.reserveStock(
      req.orgDb,
      req.body || {},
      req.user?.sub,
    );
    if (result.error) {
      return fail(res, 409, result.error, 'Unable to reserve stock');
    }
    return ok(res, result, 'Stock reserved');
  }),
);
router.put(
  '/inventory/reservations/:id/:action',
  moduleGuard('inventory'),
  permission('inventory', 'can_edit'),
  asyncHandler(async (req, res) => {
    const result = await service.changeReservation(
      req.orgDb,
      req.params.id,
      req.params.action,
      req.user?.sub,
    );
    if (result.error === 'NOT_FOUND') {
      return fail(res, 404, 'NOT_FOUND', 'Reservation not found');
    }
    if (result.error) {
      return fail(res, 409, result.error, 'Unable to change reservation');
    }
    return ok(res, result, 'Reservation updated');
  }),
);
router.put(
  '/purchase/rfqs/:id/status',
  moduleGuard('purchase'),
  (req, res, next) =>
    permission(
      'purchase',
      req.body?.status === 'approved' ? 'can_approve' : 'can_edit',
    )(req, res, next),
  asyncHandler(async (req, res) => {
    const result = await service.transitionRfq(
      req.orgDb,
      req.params.id,
      req.body?.status,
      req.user?.sub,
    );
    if (result.error === 'NOT_FOUND') {
      return fail(res, 404, 'NOT_FOUND', 'RFQ not found');
    }
    if (result.error) {
      return fail(
        res,
        409,
        result.error,
        `Invalid status transition from ${result.current}`,
      );
    }
    return ok(res, result, 'RFQ status updated');
  }),
);
router.get(
  '/inventory/reorder-suggestions',
  moduleGuard('inventory'),
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) =>
    ok(res, await service.reorderSuggestions(req.orgDb)),
  ),
);
router.get(
  '/inventory/dashboard',
  moduleGuard('inventory'),
  permission('inventory', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[stock], [transfers], [reservations], [counts]] = await Promise.all([
      req.orgDb.query(
        'SELECT COUNT(*) AS item_locations, COALESCE(SUM(current_qty),0) AS on_hand FROM stock_summary',
      ),
      req.orgDb.query(
        "SELECT COUNT(*) AS pending FROM warehouse_transfers WHERE status IN ('requested','approved','in_transit')",
      ),
      req.orgDb.query(
        "SELECT COUNT(*) AS active FROM stock_reservations WHERE status='reserved'",
      ),
      req.orgDb.query(
        "SELECT COUNT(*) AS open_counts FROM physical_counts WHERE status IN ('draft','open','submitted','approved')",
      ),
    ]);
    return ok(res, {
      stock: stock[0],
      transfers: transfers[0],
      reservations: reservations[0],
      counts: counts[0],
    });
  }),
);
router.get(
  '/purchase/dashboard',
  moduleGuard('purchase'),
  permission('purchase', 'can_view'),
  asyncHandler(async (req, res) => {
    const [[rfqs], [orders], [grns]] = await Promise.all([
      req.orgDb.query(
        "SELECT COUNT(*) AS open FROM rfqs WHERE status NOT IN ('approved','cancelled')",
      ),
      req.orgDb.query(
        "SELECT COUNT(*) AS open FROM purchase_orders WHERE status NOT IN ('cancelled','confirmed')",
      ),
      req.orgDb.query(
        "SELECT COUNT(*) AS pending_grn FROM grn WHERE status='draft'",
      ),
    ]);
    return ok(res, { rfqs: rfqs[0], purchase_orders: orders[0], grn: grns[0] });
  }),
);

module.exports = router;
